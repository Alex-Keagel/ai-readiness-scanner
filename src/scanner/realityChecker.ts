import * as vscode from 'vscode';
import { FileContent, ProjectContext } from '../scoring/types';
import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';

export interface RealityCheck {
  category: 'path' | 'command' | 'tech-stack' | 'structure' | 'stale';
  status: 'valid' | 'invalid' | 'warning';
  claim: string;
  reality: string;
  file: string;
  line?: number;
}

export interface RealityReport {
  totalChecks: number;
  valid: number;
  invalid: number;
  warnings: number;
  checks: RealityCheck[];
  accuracyScore: number; // 0-100
}

const EXCLUDE_GLOB = '**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/vendor/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/target/**,**/coverage/**';

// Paths that are common false positives (not real file references)
const PATH_SKIP_PATTERNS = [
  /^https?:\/\//,
  /^mailto:/,
  /^ftp:\/\//,
  /^\w+:\/\//,
  /^[a-z]+\/[a-z]+$/, // MIME types like text/plain
  /^application\//,
  /^[A-Z][a-z]+\/[A-Z]/, // PascalCase/PascalCase (class references)
  /^node_modules\//,
  /^\.git\//,
  /^\d+\.\d+/, // version numbers like 3.0/stable
  /^[a-z]+\/\*/, // glob-only patterns
  /^[a-z]+\.[a-z]+\.[a-z]/i, // API references: context.globalState, vscode.Uri.joinPath
  /^[A-Z][a-zA-Z]*\.[a-z]/,  // Class.method: Promise.all, Array.from, Object.entries
  /\.[a-z]+\(/,  // Method calls: .get(, .map(, .filter(
  /^[a-z]+</, // Generic types: Record<, Map<, Set<
  /^[a-z]+\?\./,  // Optional chaining: report?.insights
  /^\d/, // Starts with number
  /^[@#]/, // Decorators or anchors
  /\{[^}]*\}/, // Contains template literals: ${var}
  /^[a-z]+\.[A-Z][a-z]+$/, // module.ClassName: vscode.Uri, crypto.Hash
  /^[a-z]+s\/[a-z]+s$/, // Plural/plural patterns: classes/interfaces, functions/variables
];

// Common words/patterns that look like paths but aren't
const FALSE_POSITIVE_WORDS = new Set([
  'if/else', 'and/or', 'true/false', 'yes/no', 'on/off',
  'input/output', 'read/write', 'get/set', 'push/pull',
  'client/server', 'start/stop', 'open/close', 'up/down',
  'left/right', 'before/after', 'above/below',
  'async/await', 'import/export', 'req/res',
  'try/catch', 'classes/interfaces', 'functions/variables',
  'request/response', 'success/failure', 'create/update',
  'add/remove', 'enable/disable', 'show/hide',
  'source/target', 'key/value', 'name/value',
  'dev/prod', 'staging/production', 'local/remote',
]);

export class RealityChecker {
  private copilotClient?: CopilotClient;

  constructor(copilotClient?: CopilotClient) {
    this.copilotClient = copilotClient;
  }

  async validateFiles(
    instructionFiles: FileContent[],
    workspaceUri: vscode.Uri,
    context: ProjectContext
  ): Promise<RealityReport> {
    // Validate all files in parallel
    const allChecks = await Promise.all(
      instructionFiles.map(async (file) => {
        const fileChecks: RealityCheck[] = [];
        fileChecks.push(...await this.checkPaths(file, workspaceUri));
        fileChecks.push(...this.checkCommands(file, context));
        fileChecks.push(...this.checkTechStack(file, context));
        fileChecks.push(...this.checkStaleness(file));
        return fileChecks;
      })
    );
    const checks = allChecks.flat();

    const valid = checks.filter(c => c.status === 'valid').length;
    const invalid = checks.filter(c => c.status === 'invalid').length;
    const warnings = checks.filter(c => c.status === 'warning').length;
    const total = checks.length;
    const accuracyScore = total > 0 ? Math.round((valid / total) * 100) : 100;

    return { totalChecks: total, valid, invalid, warnings, checks, accuracyScore };
  }

  private async checkPaths(file: FileContent, workspaceUri: vscode.Uri): Promise<RealityCheck[]> {
    const checks: RealityCheck[] = [];
    const lines = file.content.split('\n');
    const extractedPaths = new Set<{ path: string; line: number }>();

    // General path regex: word/word patterns
    const generalPathRe = /(?:^|\s|`|"|'|\()([a-zA-Z0-9_.\-/]+\/[a-zA-Z0-9_.\-/]+)(?:\s|$|`|"|'|\)|,)/gm;
    // Explicit relative paths: ./something or src/something
    const explicitPathRe = /(?:^|\s|`|"|')(\.\/?[a-zA-Z0-9_.\-/]+\/[a-zA-Z0-9_.\-/]*)(?:\s|$|`|"|')/gm;
    // After prepositions: "in src/api/" or "at config/settings.json" or "see docs/readme.md"
    const prepositionPathRe = /(?:in|at|see|from|under)\s+[`"']?([a-zA-Z0-9_.\-/]+\/[a-zA-Z0-9_.\-/]+)[`"']?/gi;
    // Memory bank domain mappings: key: ['src/Something/']
    const domainMappingRe = /\w+:\s*\[\s*'([^']+\/[^']*)'\s*(?:,\s*'([^']+\/[^']*)'\s*)*\]/g;
    // YAML frontmatter: applyTo: or paths:
    const yamlPathRe = /(?:applyTo|paths):\s*(.+)/gi;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];

      for (const re of [generalPathRe, explicitPathRe, prepositionPathRe]) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(line)) !== null) {
          const p = match[1].replace(/^\.\//, '').replace(/\/+$/, '');
          if (p && p.includes('/') && !this.isSkippable(p)) {
            extractedPaths.add({ path: p, line: lineNum });
          }
        }
      }

      // Domain mappings
      domainMappingRe.lastIndex = 0;
      let domMatch;
      while ((domMatch = domainMappingRe.exec(line)) !== null) {
        for (let g = 1; g < domMatch.length; g++) {
          if (domMatch[g]) {
            const p = domMatch[g].replace(/\/+$/, '');
            if (p) {
              extractedPaths.add({ path: p, line: lineNum });
            }
          }
        }
      }

      // YAML paths
      yamlPathRe.lastIndex = 0;
      let yamlMatch;
      while ((yamlMatch = yamlPathRe.exec(line)) !== null) {
        const values = yamlMatch[1].split(',').map(v => v.trim().replace(/^['"`]|['"`]$/g, ''));
        for (const v of values) {
          const p = v.replace(/\/+$/, '').replace(/^\.\//,'');
          if (p && p.includes('/') && !this.isSkippable(p)) {
            extractedPaths.add({ path: p, line: lineNum });
          }
        }
      }
    }

    // Deduplicate by path string
    const uniquePaths = new Map<string, number>();
    for (const entry of extractedPaths) {
      if (!uniquePaths.has(entry.path)) {
        uniquePaths.set(entry.path, entry.line);
      }
    }

    // LLM-first: classify ALL extracted paths before disk check
    // Fast model determines which are real file/dir references vs code/English
    let confirmedPaths = uniquePaths;
    if (uniquePaths.size > 0 && this.copilotClient?.isAvailable()) {
      try {
        const allPathStrs = [...uniquePaths.keys()];
        const prompt = `You are analyzing strings extracted from a developer instruction/config file for an AI coding agent. Classify each as:
- "file_path": a reference to an actual file or directory in the repository (e.g., src/api/routes.ts, .github/copilot-instructions.md, deploy/)
- "not_path": NOT a file reference — could be an API identifier (context.globalState), English phrase (classes/interfaces), code concept (try/catch), or anything that is not a real filesystem path

Strings to classify:
${allPathStrs.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Respond ONLY as JSON array: [{"str":"exact string","type":"file_path"|"not_path"}]`;

        const response = await this.copilotClient.analyzeFast(prompt);
        const match = response.match(/\[[\s\S]*\]/);
        if (match) {
          const classifications = JSON.parse(match[0]) as { str: string; type: string }[];
          const notPaths = new Set(classifications.filter(c => c.type === 'not_path').map(c => c.str));
          if (notPaths.size > 0) {
            confirmedPaths = new Map();
            for (const [p, line] of uniquePaths) {
              if (!notPaths.has(p)) {
                confirmedPaths.set(p, line);
              }
            }
            logger.info(`Reality checker: LLM filtered ${notPaths.size}/${allPathStrs.length} non-path extractions, ${confirmedPaths.size} paths to verify on disk`);
          }
        }
      } catch (err) {
        logger.debug('Reality checker: LLM pre-classification failed, checking all paths on disk', err);
      }
    }

    // Check confirmed paths on disk
    const pathCheckPromises = [...confirmedPaths.entries()].map(async ([pathStr, lineNum]) => {
      const searchPattern = pathStr.endsWith('/') ? pathStr + '**' : pathStr + '**';
      try {
        const found = await vscode.workspace.findFiles(
          new vscode.RelativePattern(workspaceUri, searchPattern),
          EXCLUDE_GLOB,
          1
        );
        return {
          category: 'path' as const,
          status: (found.length > 0 ? 'valid' : 'invalid') as 'valid' | 'invalid',
          claim: pathStr,
          reality: found.length > 0 ? 'exists' : 'not found on disk',
          file: file.relativePath,
          line: lineNum,
        };
      } catch (err) {
        logger.warn('Failed to validate path pattern', { error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    });
    const pathResults = await Promise.all(pathCheckPromises);
    checks.push(...pathResults.filter((r): r is RealityCheck => r !== null));

    return checks;
  }

  private isSkippable(path: string): boolean {
    if (FALSE_POSITIVE_WORDS.has(path.toLowerCase())) {
      return true;
    }
    for (const pattern of PATH_SKIP_PATTERNS) {
      if (pattern.test(path)) {
        return true;
      }
    }
    // Skip very short segments (likely not real paths)
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2 && segments.every(s => s.length < 3)) {
      return true;
    }
    // Skip dotted identifiers that aren't file paths (e.g., context.globalState, vscode.workspace)
    // Real paths use / not . as separators. If the extracted "path" has segments with dots
    // that don't look like file extensions, it's likely an API reference.
    for (const seg of segments) {
      const dots = seg.split('.');
      if (dots.length >= 2) {
        const lastDot = dots[dots.length - 1];
        const fileExts = new Set(['md', 'ts', 'js', 'tsx', 'jsx', 'py', 'cs', 'json', 'yml', 'yaml', 'toml', 'xml', 'bicep', 'ps1', 'sh', 'cfg', 'conf', 'txt', 'html', 'css', 'lock', 'props', 'targets', 'sln', 'csproj', 'tproj', 'config', 'iml']);
        if (!fileExts.has(lastDot.toLowerCase()) && /^[a-z]/.test(dots[0])) {
          return true; // e.g., context.globalState, workspace.fs, config.get
        }
      }
    }
    return false;
  }

  private checkCommands(file: FileContent, context: ProjectContext): RealityCheck[] {
    const checks: RealityCheck[] = [];
    const lines = file.content.split('\n');
    const pm = context.packageManager.toLowerCase();

    // Command patterns: in code blocks or after action words
    const commandPatterns: { re: RegExp; tool: string; ecosystem: string[] }[] = [
      { re: /\bnpm\s+(test|run\s+\w+|install|ci|start|build)\b/g, tool: 'npm', ecosystem: ['npm', 'node'] },
      { re: /\byarn\s+(test|run\s+\w+|install|add|build|start)\b/g, tool: 'yarn', ecosystem: ['yarn', 'node'] },
      { re: /\bpnpm\s+(test|run\s+\w+|install|add|build|start)\b/g, tool: 'pnpm', ecosystem: ['pnpm', 'node'] },
      { re: /\bpip\s+(install|freeze|list)\b/g, tool: 'pip', ecosystem: ['pip', 'python'] },
      { re: /\buv\s+(sync|run|pip|lock|add)\b/g, tool: 'uv', ecosystem: ['uv', 'python'] },
      { re: /\bpoetry\s+(install|run|add|build)\b/g, tool: 'poetry', ecosystem: ['poetry', 'python'] },
      { re: /\bcargo\s+(build|test|run|clippy|fmt)\b/g, tool: 'cargo', ecosystem: ['cargo', 'rust'] },
      { re: /\bgo\s+(build|test|run|mod|vet)\b/g, tool: 'go', ecosystem: ['go'] },
      { re: /\bdotnet\s+(build|test|run|publish|restore)\b/g, tool: 'dotnet', ecosystem: ['dotnet', 'csharp'] },
      { re: /\bmake\b(?:\s+(\w+))?/g, tool: 'make', ecosystem: ['make'] },
    ];

    // Test runner patterns
    const testRunners: { re: RegExp; tool: string; configFiles: string[] }[] = [
      { re: /\bjest\b/g, tool: 'jest', configFiles: ['jest.config.js', 'jest.config.ts', 'jest.config.mjs'] },
      { re: /\bvitest\b/g, tool: 'vitest', configFiles: ['vitest.config.ts', 'vitest.config.js', 'vite.config.ts'] },
      { re: /\bpytest\b/g, tool: 'pytest', configFiles: ['pytest.ini', 'pyproject.toml', 'setup.cfg'] },
      { re: /\bmocha\b/g, tool: 'mocha', configFiles: ['.mocharc.yml', '.mocharc.json', '.mocharc.js'] },
    ];

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];

      for (const { re, tool, ecosystem } of commandPatterns) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(line)) !== null) {
          const command = match[0];
          const toolMatchesPM = ecosystem.some(e => pm.includes(e)) || pm.includes(tool);

          // Special case: make is ecosystem-agnostic
          if (tool === 'make') {
            checks.push({
              category: 'command',
              status: 'valid',
              claim: command,
              reality: 'build tool reference (ecosystem-agnostic)',
              file: file.relativePath,
              line: lineNum,
            });
            continue;
          }

          if (toolMatchesPM) {
            checks.push({
              category: 'command',
              status: 'valid',
              claim: command,
              reality: `matches package manager: ${pm}`,
              file: file.relativePath,
              line: lineNum,
            });
          } else if (pm && pm !== 'unknown') {
            checks.push({
              category: 'command',
              status: 'invalid',
              claim: command,
              reality: `project uses ${pm}, not ${tool}`,
              file: file.relativePath,
              line: lineNum,
            });
          }
        }
      }

      for (const { re, tool } of testRunners) {
        re.lastIndex = 0;
        if (re.test(line)) {
          // Check if the test runner is plausible for this project
          const languages = context.languages.map(l => l.toLowerCase());
          const isPythonRunner = tool === 'pytest';
          const isJSRunner = ['jest', 'vitest', 'mocha'].includes(tool);

          if (isPythonRunner && !languages.some(l => l.includes('python'))) {
            checks.push({
              category: 'command',
              status: 'invalid',
              claim: tool,
              reality: `${tool} referenced but project languages are: ${context.languages.join(', ')}`,
              file: file.relativePath,
              line: lineNum,
            });
          } else if (isJSRunner && !languages.some(l => l.includes('typescript') || l.includes('javascript'))) {
            checks.push({
              category: 'command',
              status: 'invalid',
              claim: tool,
              reality: `${tool} referenced but project languages are: ${context.languages.join(', ')}`,
              file: file.relativePath,
              line: lineNum,
            });
          } else {
            checks.push({
              category: 'command',
              status: 'valid',
              claim: tool,
              reality: `test runner matches project languages`,
              file: file.relativePath,
              line: lineNum,
            });
          }
        }
      }
    }

    return checks;
  }

  private checkTechStack(file: FileContent, context: ProjectContext): RealityCheck[] {
    const checks: RealityCheck[] = [];
    const content = file.content.toLowerCase();
    const languages = context.languages.map(l => l.toLowerCase());
    const frameworks = context.frameworks.map(f => f.toLowerCase());
    const projectType = context.projectType;

    // Language claims
    const languageClaims: { pattern: RegExp; language: string }[] = [
      { pattern: /\btypescript\s+project\b/i, language: 'typescript' },
      { pattern: /\bpython\s+project\b/i, language: 'python' },
      { pattern: /\bgo\s+project\b|\bgolang\s+project\b/i, language: 'go' },
      { pattern: /\brust\s+project\b/i, language: 'rust' },
      { pattern: /\bjava\s+project\b/i, language: 'java' },
      { pattern: /\bc#\s+project\b|\bcsharp\s+project\b|\.net\s+project\b/i, language: 'csharp' },
      { pattern: /\bruby\s+project\b/i, language: 'ruby' },
    ];

    for (const { pattern, language } of languageClaims) {
      if (pattern.test(file.content)) {
        const matches = languages.some(l => l.includes(language));
        checks.push({
          category: 'tech-stack',
          status: matches ? 'valid' : 'invalid',
          claim: `${language} project`,
          reality: matches
            ? `correct — ${language} detected`
            : `project languages are: ${context.languages.join(', ')}`,
          file: file.relativePath,
        });
      }
    }

    // Framework claims
    const frameworkClaims: { pattern: RegExp; name: string }[] = [
      { pattern: /\breact\b/i, name: 'react' },
      { pattern: /\bnext\.?js\b/i, name: 'next' },
      { pattern: /\bangular\b/i, name: 'angular' },
      { pattern: /\bvue\b/i, name: 'vue' },
      { pattern: /\bfastapi\b/i, name: 'fastapi' },
      { pattern: /\bdjango\b/i, name: 'django' },
      { pattern: /\bflask\b/i, name: 'flask' },
      { pattern: /\bexpress\b/i, name: 'express' },
      { pattern: /\bspring\b/i, name: 'spring' },
      { pattern: /\brails\b/i, name: 'rails' },
    ];

    for (const { pattern, name } of frameworkClaims) {
      if (pattern.test(file.content)) {
        // Only flag as tech-stack check if the content is making a strong claim
        // Look for "uses React", "built with Django", "X framework"
        const strongClaimRe = new RegExp(`(?:uses?|built\\s+with|powered\\s+by|based\\s+on|\\bframework\\b.*?)\\s*${name}`, 'i');
        if (strongClaimRe.test(file.content) || content.includes(`${name} project`)) {
          const matches = frameworks.some(f => f.toLowerCase().includes(name));
          checks.push({
            category: 'tech-stack',
            status: matches ? 'valid' : 'warning',
            claim: `uses ${name}`,
            reality: matches
              ? `correct — ${name} detected`
              : `${name} not detected in project frameworks: ${context.frameworks.join(', ') || 'none'}`,
            file: file.relativePath,
          });
        }
      }
    }

    // Project type claims
    const typeClaims: { pattern: RegExp; type: string }[] = [
      { pattern: /\bmonorepo\b/i, type: 'monorepo' },
      { pattern: /\blibrary\b/i, type: 'library' },
      { pattern: /\bservice\b/i, type: 'service' },
    ];

    for (const { pattern, type } of typeClaims) {
      // Only check strong claims like "this is a monorepo" or "monorepo structure"
      const strongRe = new RegExp(`(?:this\\s+is\\s+a|this\\s+project\\s+is|structured\\s+as)\\s+(?:a\\s+)?${type}`, 'i');
      if (strongRe.test(file.content)) {
        const matches = projectType === type;
        checks.push({
          category: 'tech-stack',
          status: matches ? 'valid' : 'warning',
          claim: `project is a ${type}`,
          reality: matches
            ? `correct — detected as ${type}`
            : `project detected as: ${projectType}`,
          file: file.relativePath,
        });
      }
    }

    return checks;
  }

  private checkStaleness(file: FileContent): RealityCheck[] {
    const checks: RealityCheck[] = [];
    const lines = file.content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];

      // TODO/FIXME/PLACEHOLDER markers
      const markerRe = /\b(TODO|FIXME|PLACEHOLDER|UPDATE\s+THIS|NEEDS?\s+UPDATE|DEPRECATED)\b/i;
      const markerMatch = markerRe.exec(line);
      if (markerMatch) {
        checks.push({
          category: 'stale',
          status: 'warning',
          claim: markerMatch[0],
          reality: 'stale content marker found',
          file: file.relativePath,
          line: lineNum,
        });
      }

      // Dates more than 1 year old
      const dateRe = /\b(20[0-2]\d[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01]))\b/;
      const dateMatch = dateRe.exec(line);
      if (dateMatch) {
        try {
          const d = new Date(dateMatch[1].replace(/\//g, '-'));
          const oneYearAgo = new Date();
          oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
          if (d < oneYearAgo) {
            checks.push({
              category: 'stale',
              status: 'warning',
              claim: dateMatch[1],
              reality: `date is more than 1 year old`,
              file: file.relativePath,
              line: lineNum,
            });
          }
        } catch (err) { logger.warn('Failed to parse date in staleness check', { error: err instanceof Error ? err.message : String(err) }); }
      }
    }

    // Empty sections: heading followed immediately by another heading or end of content
    const headingRe = /^(#{1,6})\s+(.+)$/gm;
    let prevHeadingEnd = -1;
    let prevHeadingText = '';
    let prevHeadingLine = 0;
    let match;
    while ((match = headingRe.exec(file.content)) !== null) {
      if (prevHeadingEnd >= 0) {
        const between = file.content.slice(prevHeadingEnd, match.index).trim();
        if (between.length === 0) {
          checks.push({
            category: 'stale',
            status: 'warning',
            claim: `section "${prevHeadingText}"`,
            reality: 'empty section (heading with no content)',
            file: file.relativePath,
            line: prevHeadingLine,
          });
        }
      }
      prevHeadingEnd = match.index + match[0].length;
      prevHeadingText = match[2];
      prevHeadingLine = file.content.slice(0, match.index).split('\n').length;
    }
    // Check last heading to end of file
    if (prevHeadingEnd >= 0) {
      const after = file.content.slice(prevHeadingEnd).trim();
      if (after.length === 0) {
        checks.push({
          category: 'stale',
          status: 'warning',
          claim: `section "${prevHeadingText}"`,
          reality: 'empty section (heading with no content)',
          file: file.relativePath,
          line: prevHeadingLine,
        });
      }
    }

    return checks;
  }

  /** Format a reality report as a text summary for LLM prompts */
  formatForPrompt(report: RealityReport): string {
    if (report.totalChecks === 0) {
      return 'Reality validation: No checkable claims found in instruction files.';
    }

    const lines: string[] = [
      `Reality validation results (automated checks):`,
      `- Total checks: ${report.totalChecks} (${report.valid} valid, ${report.invalid} invalid, ${report.warnings} warnings)`,
      `- Accuracy score: ${report.accuracyScore}%`,
    ];

    const invalidChecks = report.checks.filter(c => c.status === 'invalid');
    if (invalidChecks.length > 0) {
      lines.push(`- Invalid claims:`);
      for (const c of invalidChecks.slice(0, 10)) {
        lines.push(`  • [${c.category}] "${c.claim}" in ${c.file}: ${c.reality}`);
      }
      if (invalidChecks.length > 10) {
        lines.push(`  ... and ${invalidChecks.length - 10} more`);
      }
    }

    const warningChecks = report.checks.filter(c => c.status === 'warning');
    if (warningChecks.length > 0) {
      lines.push(`- Warnings:`);
      for (const w of warningChecks.slice(0, 5)) {
        lines.push(`  • [${w.category}] "${w.claim}" in ${w.file}: ${w.reality}`);
      }
      if (warningChecks.length > 5) {
        lines.push(`  ... and ${warningChecks.length - 5} more`);
      }
    }

    return lines.join('\n');
  }
}
