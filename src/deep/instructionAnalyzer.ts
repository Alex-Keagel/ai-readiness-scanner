import * as vscode from 'vscode';
import { AITool, AI_TOOLS } from '../scoring/types';
import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';
import { InstructionFile, InstructionClaim, InstructionProfile } from './types';

const INSTRUCTION_PATTERNS: Record<string, { globs: string[]; tool: AITool | 'shared'; type: InstructionFile['type'] }[]> = {
  copilot: [
    { globs: ['.github/copilot-instructions.md'], tool: 'copilot', type: 'root-instruction' },
    { globs: ['.github/instructions/**/*.md'], tool: 'copilot', type: 'scoped-instruction' },
    { globs: ['.github/agents/*.agent.md'], tool: 'copilot', type: 'agent' },
    { globs: ['.github/skills/**/SKILL.md'], tool: 'copilot', type: 'skill' },
    { globs: ['.github/prompts/*.prompt.md'], tool: 'copilot', type: 'workflow' },
    { globs: ['.github/playbooks/**/*.md'], tool: 'copilot', type: 'workflow' },
  ],
  cline: [
    { globs: ['.clinerules/default-rules.md'], tool: 'cline', type: 'root-instruction' },
    { globs: ['.clinerules/core/**/*.md', '.clinerules/domains/**/*.md'], tool: 'cline', type: 'scoped-instruction' },
    { globs: ['.clinerules/workflows/**/*.md'], tool: 'cline', type: 'workflow' },
    { globs: ['.clinerules/safe-commands*'], tool: 'cline', type: 'rules' },
    { globs: ['memory-bank/**/*.md'], tool: 'cline', type: 'memory' },
  ],
  cursor: [
    { globs: ['.cursorrules', '.cursor/rules/**/*.md'], tool: 'cursor', type: 'root-instruction' },
  ],
  claude: [
    { globs: ['CLAUDE.md', '.claude/CLAUDE.md', '.claude/rules/**/*.md'], tool: 'claude', type: 'root-instruction' },
  ],
  roo: [
    { globs: ['.roo/rules/**/*.md', '.roorules', '.roomodes'], tool: 'roo', type: 'root-instruction' },
  ],
  windsurf: [
    { globs: ['.windsurf/rules/**/*.md', 'AGENTS.md'], tool: 'windsurf', type: 'root-instruction' },
    { globs: ['.windsurf/skills/**/*.md'], tool: 'windsurf', type: 'skill' },
  ],
  aider: [
    { globs: ['.aider.conf.yml', '.aiderignore'], tool: 'aider', type: 'config' },
  ],
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class InstructionAnalyzer {
  constructor(private copilotClient?: CopilotClient) {}

  async analyze(workspaceUri: vscode.Uri, selectedTool?: AITool): Promise<InstructionProfile> {
    const timer = logger.time('InstructionAnalyzer');
    const files: InstructionFile[] = [];

    // Discover instruction files
    const patterns = selectedTool ? (INSTRUCTION_PATTERNS[selectedTool] || []) : Object.values(INSTRUCTION_PATTERNS).flat();

    for (const pat of patterns) {
      for (const glob of pat.globs) {
        try {
          const found = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceUri, glob),
            '**/node_modules/**', 50
          );
          for (const uri of found) {
            try {
              const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
              const relPath = vscode.workspace.asRelativePath(uri, false);
              files.push({
                path: relPath,
                content,
                tool: pat.tool,
                type: pat.type,
                scope: this.extractScope(content),
                tokens: estimateTokens(content),
              });
            } catch { /* skip unreadable */ }
          }
        } catch { /* skip bad glob */ }
      }
    }

    logger.info(`InstructionAnalyzer: found ${files.length} instruction files`);

    // Extract claims — regex for basic, LLM for deep understanding
    const claims = await this.extractClaims(files);

    const profile: InstructionProfile = {
      files,
      claims,
      coveredPaths: new Set(claims.filter(c => c.category === 'path-reference').map(c => c.claim)),
      coveredWorkflows: claims.filter(c => c.category === 'workflow').map(c => c.claim),
      mentionedTechStack: claims.filter(c => c.category === 'tech-stack').map(c => c.claim),
      totalTokens: files.reduce((s, f) => s + f.tokens, 0),
    };

    timer?.end?.();
    return profile;
  }

  private async extractClaims(files: InstructionFile[]): Promise<InstructionClaim[]> {
    const claims: InstructionClaim[] = [];

    // Phase 1: Regex-based extraction (fast, deterministic)
    for (const file of files) {
      claims.push(...this.extractRegexClaims(file));
    }

    // Phase 2: LLM-based deep extraction (understands semantics)
    if (this.copilotClient?.isAvailable() && files.length > 0) {
      try {
        const llmClaims = await this.extractLLMClaims(files);
        claims.push(...llmClaims);
      } catch (err) {
        logger.debug('InstructionAnalyzer: LLM claim extraction failed, using regex only', err);
      }
    }

    return claims;
  }

  private extractRegexClaims(file: InstructionFile): InstructionClaim[] {
    const claims: InstructionClaim[] = [];
    const lines = file.content.split('\n');

    // Common false positives that look like paths but aren't
    const FALSE_PATHS = new Set([
      'try/catch', 'async/await', 'if/else', 'and/or', 'true/false',
      'input/output', 'read/write', 'get/set', 'push/pull', 'import/export',
      'client/server', 'start/stop', 'open/close', 'request/response',
      'success/failure', 'create/update', 'add/remove', 'enable/disable',
      'key/value', 'source/target', 'dev/prod', 'yes/no', 'on/off',
    ]);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Path references: backtick-wrapped paths, or paths after prepositions
      const pathPatterns = [
        /`([a-zA-Z0-9_.\-/]+\/[a-zA-Z0-9_.\-/]+[a-zA-Z0-9])`/g,
        /(?:in|at|see|from|under|edit|modify|create)\s+`?([a-zA-Z0-9_.\-/]+\/[a-zA-Z0-9_.\-/]+)`?/gi,
      ];
      for (const pat of pathPatterns) {
        pat.lastIndex = 0;
        let m;
        while ((m = pat.exec(line)) !== null) {
          const p = m[1].replace(/^\.\//, '');
          if (p.includes('/') && p.length > 3 && !FALSE_PATHS.has(p.toLowerCase()) && !p.match(/^[a-z]+\.[a-z]+\./i)) {
            claims.push({ category: 'path-reference', claim: p, sourceFile: file.path, sourceLine: i + 1, confidence: 0.9 });
          }
        }
      }

      // Tech stack mentions
      const techPatterns = [
        /(?:uses?|built with|powered by|requires?|depends on)\s+([A-Z][\w\s,.]+?)(?:\.|,|$)/gi,
        /(?:framework|library|runtime|language):\s*(.+)/gi,
      ];
      for (const pat of techPatterns) {
        pat.lastIndex = 0;
        const m = pat.exec(line);
        if (m) {
          claims.push({ category: 'tech-stack', claim: m[1].trim(), sourceFile: file.path, sourceLine: i + 1, confidence: 0.7 });
        }
      }

      // Command references
      const cmdPatterns = [
        /`((?:npm|npx|yarn|pnpm|uv|pip|dotnet|cargo|go|make|pwsh|bash)\s+[^`]+)`/g,
        /(?:run|execute|invoke)\s+`([^`]+)`/gi,
      ];
      for (const pat of cmdPatterns) {
        pat.lastIndex = 0;
        let m;
        while ((m = pat.exec(line)) !== null) {
          claims.push({ category: 'command', claim: m[1], sourceFile: file.path, sourceLine: i + 1, confidence: 0.95 });
        }
      }

      // Convention claims (rules, patterns, do/don't)
      if (/^[-*]\s*(always|never|must|should|do not|don't|prefer|avoid)\b/i.test(line)) {
        claims.push({ category: 'convention', claim: line.replace(/^[-*]\s*/, '').trim(), sourceFile: file.path, sourceLine: i + 1, confidence: 0.8 });
      }
    }

    return claims;
  }

  private async extractLLMClaims(files: InstructionFile[]): Promise<InstructionClaim[]> {
    // Send instruction content to LLM for deep semantic extraction
    const contentSummary = files
      .slice(0, 5) // Top 5 most important files
      .map(f => `FILE: ${f.path} (${f.type})\n${f.content.slice(0, 3000)}`)
      .join('\n\n---\n\n');

    const prompt = `Analyze these AI coding agent instruction files and extract structured claims about the codebase they describe.

${contentSummary}

For each instruction file, extract:
1. **Architecture claims**: what modules/components exist, how they connect, what the data flow is
2. **Workflow claims**: what development workflows are described (build, test, deploy, etc.)
3. **Coverage claims**: which directories/files are mentioned and which are conspicuously absent
4. **Quality observations**: are instructions specific or vague? Do they reference real file paths?

Respond as JSON:
{
  "architectureClaims": [{"claim":"...", "sourceFile":"...", "confidence": 0.0-1.0}],
  "workflowClaims": [{"claim":"...", "sourceFile":"...", "confidence": 0.0-1.0}],
  "uncoveredAreas": ["description of what's missing from instructions"],
  "qualityIssues": ["specific quality problem"]
}`;

    const response = await this.copilotClient!.analyze(prompt, undefined, 60_000);
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) return [];

    try {
      const parsed = JSON.parse(match[0]);
      const claims: InstructionClaim[] = [];

      for (const ac of (parsed.architectureClaims || [])) {
        claims.push({ category: 'architecture', claim: ac.claim, sourceFile: ac.sourceFile || files[0].path, sourceLine: 0, confidence: ac.confidence || 0.7 });
      }
      for (const wc of (parsed.workflowClaims || [])) {
        claims.push({ category: 'workflow', claim: wc.claim, sourceFile: wc.sourceFile || files[0].path, sourceLine: 0, confidence: wc.confidence || 0.7 });
      }

      logger.info(`InstructionAnalyzer: LLM extracted ${claims.length} semantic claims, ${(parsed.uncoveredAreas || []).length} uncovered areas`);
      return claims;
    } catch {
      return [];
    }
  }

  private extractScope(content: string): string | undefined {
    const match = content.match(/(?:applyTo|paths|glob):\s*['"]?([^'"\n]+)/i);
    return match?.[1]?.trim();
  }
}
