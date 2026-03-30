import * as vscode from 'vscode';
import { AITool, AI_TOOLS, ProjectContext } from './types';
import { logger } from '../logging';

// ─── Result Interfaces ──────────────────────────────────────────────

export interface ContextAuditResult {
  mcpHealth: MCPHealthResult;
  skillQuality: SkillQualityResult;
  contextEfficiency: ContextEfficiencyResult;
  toolSecurity: ToolSecurityResult;
  hookCoverage: HookCoverageResult;
  skillCoverage: SkillCoverageResult;
}

export interface MCPHealthResult {
  score: number;
  servers: { name: string; status: 'healthy' | 'misconfigured' | 'unused'; issues: string[] }[];
  totalTools: number;
  estimatedTokenCost: number;
}

export interface SkillQualityResult {
  score: number;
  skills: { name: string; path: string; score: number; issues: string[] }[];
}

export interface ContextEfficiencyResult {
  score: number;
  totalTokens: number;
  budgetPct: number;
  breakdown: { category: string; tokens: number; pct: number }[];
  redundancies: string[];
}

export interface ToolSecurityResult {
  score: number;
  issues: { agent: string; severity: 'critical' | 'warning' | 'info'; issue: string }[];
}

export interface HookCoverageResult {
  score: number;
  hasPostTask: boolean;
  hasMemoryUpdate: boolean;
  hasSafeCommands: boolean;
  hasPreCommit: boolean;
}

export interface SkillCoverageResult {
  score: number;
  coveredAreas: string[];
  gaps: { area: string; suggestion: string }[];
}

// ─── Helpers ────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

async function readFileText(uri: vscode.Uri): Promise<string | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf-8');
  } catch {
    return null;
  }
}

async function findFiles(workspaceUri: vscode.Uri, pattern: string): Promise<vscode.Uri[]> {
  const relPattern = new vscode.RelativePattern(workspaceUri, pattern);
  return vscode.workspace.findFiles(relPattern, '**/node_modules/**', 500);
}

function parseYamlFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) { return {}; }
  const result: Record<string, unknown> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)/);
    if (kv) {
      const value = kv[2].trim();
      if (value.startsWith('[') && value.endsWith(']')) {
        result[kv[1]] = value.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
      } else {
        result[kv[1]] = value.replace(/^['"]|['"]$/g, '');
      }
    }
  }
  return result;
}

// ─── MCP Health Audit ───────────────────────────────────────────────

export async function auditMCPHealth(workspaceUri: vscode.Uri): Promise<MCPHealthResult> {
  const endTimer = logger.time('auditMCPHealth');
  const configPatterns = ['.vscode/mcp.json', '.mcp.json', '.clinerules/mcp-config/**/*.json'];
  const allFiles: vscode.Uri[] = [];
  for (const pat of configPatterns) {
    const found = await findFiles(workspaceUri, pat);
    allFiles.push(...found);
  }

  const servers: MCPHealthResult['servers'] = [];
  let totalTools = 0;

  for (const file of allFiles) {
    const text = await readFileText(file);
    if (!text) { continue; }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.warn('Invalid JSON in MCP config', { path: file.fsPath });
      continue;
    }

    const mcpServers = (parsed.mcpServers ?? parsed.servers ?? parsed) as Record<string, unknown>;
    if (typeof mcpServers !== 'object' || mcpServers === null) { continue; }

    for (const [name, config] of Object.entries(mcpServers)) {
      if (typeof config !== 'object' || config === null) { continue; }
      const serverConfig = config as Record<string, unknown>;
      const issues: string[] = [];

      // Check command exists
      const command = serverConfig.command as string | undefined;
      if (!command || command.trim() === '') {
        issues.push('Missing or empty command');
      }

      // Check env vars for hardcoded secrets
      const env = serverConfig.env as Record<string, string> | undefined;
      if (env && typeof env === 'object') {
        for (const [key, val] of Object.entries(env)) {
          if (typeof val === 'string' && !val.includes('${env:') && !val.includes('${input:') && val.length > 0) {
            // Heuristic: keys with TOKEN, KEY, SECRET, PASSWORD suggest secrets
            if (/token|key|secret|password|api/i.test(key)) {
              issues.push(`Env var "${key}" appears hardcoded — use \${env:...} or \${input:...}`);
            }
          }
        }
      }

      // Check filesystem scope
      const args = serverConfig.args as string[] | undefined;
      if (Array.isArray(args)) {
        const joinedArgs = args.join(' ');
        if ((joinedArgs.includes(' / ') || joinedArgs.match(/\s\/$/)) && !joinedArgs.includes('${workspaceFolder}')) {
          issues.push('Args reference root filesystem "/" — scope to ${workspaceFolder}');
        }
        if (joinedArgs.includes(' ~ ') || joinedArgs.match(/\s~\//)) {
          issues.push('Args reference home directory "~" — scope to ${workspaceFolder}');
        }
      }

      // Count tools if listed
      const tools = serverConfig.tools as unknown[] | undefined;
      const toolCount = Array.isArray(tools) ? tools.length : 5; // Default estimate
      totalTools += toolCount;

      // Check if server is disabled (VS Code mcp.json supports "disabled": true)
      const isDisabled = serverConfig.disabled === true;
      if (isDisabled) {
        // Skip disabled servers from token cost but still report them
        totalTools -= toolCount;
      }

      const status: 'healthy' | 'misconfigured' | 'unused' = issues.length > 0 ? 'misconfigured' : isDisabled ? 'unused' : 'healthy';
      servers.push({ name, status, issues });
    }
  }

  // Check for too many active servers
  const activeServers = servers.filter(s => s.status !== 'unused');
  if (activeServers.length > 5) {
    for (const s of activeServers.slice(5)) {
      s.issues.push(`${activeServers.length} MCP servers active — consider disabling unused ones to reduce context overhead (~${totalTools * 300} tokens)`);
      if (s.status === 'healthy') { (s as any).status = 'misconfigured'; }
    }
  }

  const estimatedTokenCost = totalTools * 300;
  const score = clampScore(servers.length === 0 ? 0 : 100 - servers.reduce((sum, s) => sum + s.issues.length * 15, 0));

  endTimer?.end?.();
  return { score, servers, totalTools, estimatedTokenCost };
}

// ─── Skill Quality Audit ────────────────────────────────────────────

export async function auditSkillQuality(workspaceUri: vscode.Uri): Promise<SkillQualityResult> {
  const endTimer = logger.time('auditSkillQuality');
  const skillPatterns = ['.github/skills/**/SKILL.md', '.windsurf/skills/**/SKILL.md'];
  const allFiles: vscode.Uri[] = [];
  for (const pat of skillPatterns) {
    const found = await findFiles(workspaceUri, pat);
    allFiles.push(...found);
  }

  const skills: SkillQualityResult['skills'] = [];

  for (const file of allFiles) {
    const text = await readFileText(file);
    if (!text) { continue; }

    const relativePath = vscode.workspace.asRelativePath(file, false);
    const frontmatter = parseYamlFrontmatter(text);
    const issues: string[] = [];
    let skillScore = 0;

    // Has YAML frontmatter with name and description
    if (frontmatter.name && frontmatter.description) {
      skillScore += 25;
    } else {
      if (!frontmatter.name) { issues.push('Missing "name" in frontmatter'); }
      if (!frontmatter.description) { issues.push('Missing "description" in frontmatter'); }
    }

    // Description length check
    const desc = String(frontmatter.description ?? '');
    if (desc.length >= 10 && desc.length <= 1024) {
      skillScore += 15;
    } else if (desc.length > 0) {
      issues.push(`Description length ${desc.length} chars — ideal range is 10-1024`);
    }

    // Has ## sections
    const sectionHeaders = text.match(/^##\s+.+/gm) ?? [];
    if (sectionHeaders.length > 0) {
      skillScore += 20;
    } else {
      issues.push('No ## sections found (expected steps, guidelines, or prerequisites)');
    }

    // Body length
    const bodyLines = text.replace(/^---[\s\S]*?---/, '').trim().split('\n').filter(l => l.trim().length > 0);
    if (bodyLines.length > 10) {
      skillScore += 15;
    } else {
      issues.push(`Body has only ${bodyLines.length} non-empty lines — consider adding more detail`);
    }

    // References to files that exist (check for path-like strings)
    const pathRefs = text.match(/(?:src|lib|docs|scripts|config)\/[\w./\-]+/g) ?? [];
    if (pathRefs.length > 0) {
      let validRefs = 0;
      for (const ref of pathRefs.slice(0, 5)) {
        try {
          const refUri = vscode.Uri.joinPath(workspaceUri, ref);
          await vscode.workspace.fs.stat(refUri);
          validRefs++;
        } catch {
          // File doesn't exist — not necessarily an issue for partial matches
        }
      }
      if (validRefs > 0) {
        skillScore += 25;
      } else {
        issues.push('Referenced paths could not be verified');
      }
    } else {
      skillScore += 25; // No refs to check — don't penalize
    }

    const name = String(frontmatter.name ?? relativePath.split('/').slice(-2, -1)[0] ?? 'unknown');
    skills.push({ name, path: relativePath, score: clampScore(skillScore), issues });
  }

  const score = skills.length === 0 ? 0 : Math.round(skills.reduce((s, sk) => s + sk.score, 0) / skills.length);

  endTimer?.end?.();
  return { score, skills };
}

// ─── Context Efficiency Audit ───────────────────────────────────────

export async function auditContextEfficiency(
  workspaceUri: vscode.Uri,
  context: ProjectContext,
  mcpTokenCost: number = 0,
  selectedTool?: string,
): Promise<ContextEfficiencyResult> {
  const endTimer = logger.time('auditContextEfficiency');

  // Context window budget varies by platform (user-configurable)
  const DEFAULT_BUDGETS: Record<string, number> = {
    copilot: 200_000, cline: 200_000, cursor: 128_000,
    claude: 200_000, roo: 200_000, windsurf: 128_000, aider: 128_000,
  };
  let budget = DEFAULT_BUDGETS[selectedTool || ''] || 128_000;
  try {
    const vscode = require('vscode');
    const userBudgets = vscode.workspace.getConfiguration('ai-readiness').get('contextBudgets') as Record<string, number> | undefined;
    if (userBudgets && selectedTool && userBudgets[selectedTool]) {
      budget = userBudgets[selectedTool];
    }
  } catch { /* running outside vscode */ }
  const redundancies: string[] = [];

  // Only count instruction files relevant to the selected platform
  const PLATFORM_PATTERNS: Record<string, string[]> = {
    copilot: ['.github/copilot-instructions.md', '.github/instructions/**/*.md', '.github/agents/**', '.github/skills/**', '.github/prompts/**'],
    cline: ['.clinerules/**', 'memory-bank/**'],
    cursor: ['.cursorrules', '.cursor/rules/**', '.cursorignore'],
    claude: ['CLAUDE.md', '.claude/**'],
    roo: ['.roo/rules/**', '.roorules', '.roomodes'],
    windsurf: ['.windsurf/rules/**', '.windsurf/skills/**', 'AGENTS.md'],
    aider: ['.aider.conf.yml', '.aiderignore'],
  };

  const instructionPatterns = selectedTool && PLATFORM_PATTERNS[selectedTool]
    ? PLATFORM_PATTERNS[selectedTool]
    : Object.values(PLATFORM_PATTERNS).flat();

  // Collect all instruction file contents + paths
  const instructionFiles: { path: string; content: string; tokens: number }[] = [];
  for (const pat of instructionPatterns) {
    const files = await findFiles(workspaceUri, pat);
    for (const f of files) {
      const text = await readFileText(f);
      if (text) {
        const relPath = vscode.workspace.asRelativePath(f, false);
        instructionFiles.push({ path: relPath, content: text, tokens: estimateTokens(text) });
      }
    }
  }

  // Memory bank tokens — only for Cline/Roo
  let memoryTokens = 0;
  if (!selectedTool || selectedTool === 'cline' || selectedTool === 'roo') {
    const memoryFiles = await findFiles(workspaceUri, 'memory-bank/**/*.md');
    for (const f of memoryFiles) {
      const text = await readFileText(f);
      if (text) { memoryTokens += estimateTokens(text); }
    }
  }

  const instructionTokens = instructionFiles.reduce((s, f) => s + f.tokens, 0);
  const totalTokens = instructionTokens + mcpTokenCost + memoryTokens;
  const budgetPct = (totalTokens / budget) * 100;

  // ── Per-component coverage + budget analysis ──
  const TYPE_WEIGHTS: Record<string, number> = { service: 1.0, app: 1.0, library: 0.9, infra: 0.6, config: 0.4, script: 0.5, data: 0.3, unknown: 0.5 };
  const components = context.components || [];

  let efficiencyWeightedSum = 0;
  let totalWeight = 0;

  for (const comp of components) {
    const weight = TYPE_WEIGHTS[comp.type] ?? 0.5;
    totalWeight += weight;

    // ── Coverage: how well is this component covered? ──
    let coverageType: 'specific' | 'scoped' | 'global' | 'none' = 'none';
    let compTokens = 0; // tokens from instruction files covering this component

    for (const f of instructionFiles) {
      const mentionsPath = f.content.includes(comp.path) || f.content.includes(comp.name);
      if (mentionsPath) { coverageType = 'specific'; compTokens += f.tokens; continue; }

      const hasGlob = f.content.match(/(?:applyTo|paths|glob):\s*[^\n]*/) !== null;
      const globCoversComp = hasGlob && (
        f.content.includes(`${comp.path}/`) ||
        f.content.includes(`${comp.path}/**`) ||
        f.content.includes(`*.${comp.language === 'Python' ? 'py' : comp.language === 'TypeScript' ? 'ts' : comp.language?.toLowerCase() || '*'}`)
      );
      if (globCoversComp && coverageType !== 'specific') { coverageType = 'scoped'; compTokens += f.tokens; continue; }

      const isSubdirInstruction = f.path.startsWith(comp.path + '/');
      if (isSubdirInstruction) { coverageType = 'specific'; compTokens += f.tokens; continue; }

      const isGlobal = !hasGlob && (
        f.path.includes('copilot-instructions') || f.path.includes('default-rules') ||
        f.path === 'CLAUDE.md' || f.path === '.cursorrules' || f.path === '.roorules'
      );
      if (isGlobal && coverageType === 'none') { coverageType = 'global'; }
    }

    const coverageScore = coverageType === 'specific' ? 100 : coverageType === 'scoped' ? 80 : coverageType === 'global' ? 40 : 0;

    // ── Budget: are the instruction tokens for this component right-sized? ──
    // Per-component ideal: 500-3000 tokens. Too little = generic, too much = verbose.
    let compBudgetScore: number;
    if (compTokens === 0) {
      compBudgetScore = coverageType === 'global' ? 30 : 10; // global gives some implicit tokens
    } else if (compTokens <= 200) {
      compBudgetScore = 40; // too thin
    } else if (compTokens <= 3000) {
      compBudgetScore = 80 + Math.round((1 - Math.abs(compTokens - 1500) / 1500) * 20); // sweet spot ~1500
    } else if (compTokens <= 8000) {
      compBudgetScore = Math.round(80 - (compTokens - 3000) / 250); // getting heavy
    } else {
      compBudgetScore = Math.max(20, Math.round(60 - (compTokens - 8000) / 500)); // too verbose
    }
    compBudgetScore = clampScore(compBudgetScore);

    // Blend per-component: 60% coverage + 40% budget
    const compEfficiency = Math.round(coverageScore * 0.6 + compBudgetScore * 0.4);
    efficiencyWeightedSum += compEfficiency * weight;
  }

  // Weighted average across all components
  let efficiencyScore = totalWeight > 0 ? Math.round(efficiencyWeightedSum / totalWeight) : 50;

  // Cross-platform credit: if this platform has low coverage but OTHER platforms have
  // instruction files, give partial credit (knowledge exists, just needs migration)
  if (selectedTool && efficiencyScore < 50) {
    const otherPlatformPatterns = Object.entries(PLATFORM_PATTERNS)
      .filter(([p]) => p !== selectedTool)
      .flatMap(([, pats]) => pats);
    let crossPlatformFiles = 0;
    for (const pat of otherPlatformPatterns.slice(0, 10)) {
      const found = await findFiles(workspaceUri, pat);
      crossPlatformFiles += found.length;
    }
    if (crossPlatformFiles > 0) {
      const crossCredit = Math.min(20, crossPlatformFiles * 4);
      efficiencyScore = Math.min(65, efficiencyScore + crossCredit);
    }
  }

  const breakdown: ContextEfficiencyResult['breakdown'] = [
    { category: 'Instructions', tokens: instructionTokens, pct: totalTokens > 0 ? (instructionTokens / totalTokens) * 100 : 0 },
    { category: 'MCP Tools', tokens: mcpTokenCost, pct: totalTokens > 0 ? (mcpTokenCost / totalTokens) * 100 : 0 },
    { category: 'Memory Bank', tokens: memoryTokens, pct: totalTokens > 0 ? (memoryTokens / totalTokens) * 100 : 0 },
  ];

  // Check for redundant MCP tools
  const mcpFiles = await findFiles(workspaceUri, '{.vscode/mcp.json,.mcp.json}');
  for (const f of mcpFiles) {
    const text = await readFileText(f);
    if (text && /filesystem|file.?system|read.?file/i.test(text)) {
      redundancies.push('Filesystem MCP server detected — IDE already provides file read/write capabilities');
    }
  }

  const score = clampScore(efficiencyScore);

  endTimer?.end?.();
  return { score, totalTokens, budgetPct: Math.round(budgetPct * 100) / 100, breakdown, redundancies };
}

// ─── Tool Security Audit ────────────────────────────────────────────

export async function auditToolSecurity(workspaceUri: vscode.Uri): Promise<ToolSecurityResult> {
  const endTimer = logger.time('auditToolSecurity');
  const agentFiles = await findFiles(workspaceUri, '.github/agents/*.agent.md');
  const issues: ToolSecurityResult['issues'] = [];

  for (const file of agentFiles) {
    const text = await readFileText(file);
    if (!text) { continue; }

    const frontmatter = parseYamlFrontmatter(text);
    const agentName = String(frontmatter.name ?? file.fsPath.split('/').pop()?.replace('.agent.md', '') ?? 'unknown');
    const description = String(frontmatter.description ?? '').toLowerCase();
    const tools = frontmatter.tools as string[] | undefined;

    if (!tools) {
      issues.push({
        agent: agentName,
        severity: 'warning',
        issue: 'No "tools" key in frontmatter — agent has implicit full access',
      });
      continue;
    }

    const toolSet = new Set(Array.isArray(tools) ? tools.map(t => String(t).toLowerCase()) : []);
    const hasShell = toolSet.has('shell') || toolSet.has('execute');
    const hasEdit = toolSet.has('edit') || toolSet.has('write');
    const isReviewOrArchitect = /review|architect|read.?only|analyst|auditor/i.test(description);
    const isReadOnly = /read.?only/i.test(description);

    if (hasShell && hasEdit && isReviewOrArchitect) {
      issues.push({
        agent: agentName,
        severity: 'critical',
        issue: 'Review/architect agent has both shell and edit access — violates least-privilege',
      });
    }

    if (hasShell && isReadOnly) {
      issues.push({
        agent: agentName,
        severity: 'critical',
        issue: 'Read-only agent has shell access — violates least-privilege',
      });
    }
  }

  const criticalCount = issues.filter(i => i.severity === 'critical').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;
  const score = clampScore(100 - (criticalCount * 25 + warningCount * 10));

  endTimer?.end?.();
  return { score, issues };
}

// ─── Hook Coverage Audit ────────────────────────────────────────────

export async function auditHookCoverage(workspaceUri: vscode.Uri): Promise<HookCoverageResult> {
  const endTimer = logger.time('auditHookCoverage');

  // Check for post-task patterns in instruction files
  let hasPostTask = false;
  const instructionFiles = await findFiles(workspaceUri, '{.github/copilot-instructions.md,.clinerules/**/*.md,CLAUDE.md,.claude/**/*.md,.cursor/rules/**/*.md,.windsurf/rules/**/*.md,AGENTS.md}');
  for (const f of instructionFiles) {
    const text = await readFileText(f);
    if (text && /after completing|post.?task|when done|update docs|run tests after/i.test(text)) {
      hasPostTask = true;
      break;
    }
  }

  // Check for memory bank update workflows
  let hasMemoryUpdate = false;
  const memoryBankDir = await findFiles(workspaceUri, 'memory-bank/**');
  const memoryWorkflow = await findFiles(workspaceUri, '.clinerules/workflows/update-memory-bank.md');
  if (memoryBankDir.length > 0 || memoryWorkflow.length > 0) {
    hasMemoryUpdate = true;
  }

  // Check for safe-commands
  let hasSafeCommands = false;
  const safeFiles = await findFiles(workspaceUri, '.clinerules/safe-commands*');
  if (safeFiles.length > 0) {
    hasSafeCommands = true;
  }

  // Check for pre-commit hooks
  let hasPreCommit = false;
  const huskyFiles = await findFiles(workspaceUri, '.husky/**');
  if (huskyFiles.length > 0) {
    hasPreCommit = true;
  } else {
    // Check package.json for husky or lint-staged
    const pkgUri = vscode.Uri.joinPath(workspaceUri, 'package.json');
    const pkgText = await readFileText(pkgUri);
    if (pkgText && (/\"husky\"/.test(pkgText) || /\"lint-staged\"/.test(pkgText))) {
      hasPreCommit = true;
    }
  }

  const checks = [hasPostTask, hasMemoryUpdate, hasSafeCommands, hasPreCommit];
  const score = checks.filter(Boolean).length * 25;

  endTimer?.end?.();
  return { score, hasPostTask, hasMemoryUpdate, hasSafeCommands, hasPreCommit };
}

// ─── Skill Coverage Audit ───────────────────────────────────────────

interface LanguageSkillMap {
  area: string;
  suggestion: string;
}

const LANGUAGE_SKILL_EXPECTATIONS: Record<string, LanguageSkillMap[]> = {
  python: [
    { area: 'pytest', suggestion: 'Add a pytest skill for test generation and patterns' },
    { area: 'linting', suggestion: 'Add a linting skill (ruff, pylint, or flake8 patterns)' },
    { area: 'type-checking', suggestion: 'Add a mypy/pyright type-checking skill' },
  ],
  typescript: [
    { area: 'testing', suggestion: 'Add a testing skill (vitest, jest, or mocha patterns)' },
    { area: 'build', suggestion: 'Add a build skill (tsc, esbuild, or webpack patterns)' },
    { area: 'lint', suggestion: 'Add a linting skill (eslint patterns)' },
  ],
  javascript: [
    { area: 'testing', suggestion: 'Add a testing skill (jest, vitest, or mocha patterns)' },
    { area: 'lint', suggestion: 'Add a linting skill (eslint patterns)' },
  ],
  bicep: [
    { area: 'architecture', suggestion: 'Add an Azure architecture deployment skill' },
    { area: 'deployment', suggestion: 'Add a Bicep deployment validation skill' },
  ],
  terraform: [
    { area: 'infrastructure', suggestion: 'Add a Terraform plan/apply skill' },
    { area: 'validation', suggestion: 'Add a Terraform validation and linting skill' },
  ],
  docker: [
    { area: 'container', suggestion: 'Add a container management skill (build, push, run)' },
  ],
  go: [
    { area: 'testing', suggestion: 'Add a Go testing skill (go test patterns)' },
    { area: 'lint', suggestion: 'Add a Go linting skill (golangci-lint patterns)' },
  ],
  rust: [
    { area: 'testing', suggestion: 'Add a Rust testing skill (cargo test patterns)' },
    { area: 'build', suggestion: 'Add a Rust build skill (cargo build patterns)' },
  ],
};

export async function auditSkillCoverage(
  workspaceUri: vscode.Uri,
  context: ProjectContext,
): Promise<SkillCoverageResult> {
  const endTimer = logger.time('auditSkillCoverage');

  // Collect expected skills based on detected languages
  const expectedSkills: LanguageSkillMap[] = [];
  for (const lang of context.languages) {
    const lower = lang.toLowerCase();
    const mapped = LANGUAGE_SKILL_EXPECTATIONS[lower];
    if (mapped) {
      expectedSkills.push(...mapped);
    }
  }

  // Check for Docker-related files
  const dockerFiles = await findFiles(workspaceUri, '{Dockerfile,docker-compose.yml,docker-compose.yaml}');
  if (dockerFiles.length > 0) {
    const dockerSkills = LANGUAGE_SKILL_EXPECTATIONS.docker;
    if (dockerSkills) {
      expectedSkills.push(...dockerSkills);
    }
  }

  if (expectedSkills.length === 0) {
    endTimer?.end?.();
    return { score: 100, coveredAreas: [], gaps: [] };
  }

  // Find existing skills
  const skillFiles = await findFiles(workspaceUri, '.github/skills/**');
  const skillNames = new Set<string>();
  for (const f of skillFiles) {
    const text = await readFileText(f);
    if (text) {
      const fm = parseYamlFrontmatter(text);
      if (fm.name) { skillNames.add(String(fm.name).toLowerCase()); }
    }
    // Also use the directory name
    const dirMatch = f.fsPath.match(/skills\/([^/]+)\//);
    if (dirMatch) { skillNames.add(dirMatch[1].toLowerCase()); }
  }

  // Also check windsurf skills
  const windsurfSkills = await findFiles(workspaceUri, '.windsurf/skills/**');
  for (const f of windsurfSkills) {
    const dirMatch = f.fsPath.match(/skills\/([^/]+)\//);
    if (dirMatch) { skillNames.add(dirMatch[1].toLowerCase()); }
  }

  const coveredAreas: string[] = [];
  const gaps: SkillCoverageResult['gaps'] = [];
  const skillContent = [...skillNames].join(' ');

  for (const expected of expectedSkills) {
    const areaLower = expected.area.toLowerCase();
    // Check if the area keyword appears in any skill name or content
    const covered = [...skillNames].some(name => name.includes(areaLower)) || skillContent.includes(areaLower);
    if (covered) {
      coveredAreas.push(expected.area);
    } else {
      gaps.push({ area: expected.area, suggestion: expected.suggestion });
    }
  }

  const score = clampScore(Math.round((coveredAreas.length / expectedSkills.length) * 100));

  endTimer?.end?.();
  return { score, coveredAreas, gaps };
}

// ─── Full Audit ─────────────────────────────────────────────────────

export async function runContextAudit(
  workspaceUri: vscode.Uri,
  context: ProjectContext,
  selectedTool?: string,
): Promise<ContextAuditResult> {
  logger.info('Starting context architecture audit');
  const endTimer = logger.time('runContextAudit');

  const mcpHealth = await auditMCPHealth(workspaceUri);
  const skillQuality = await auditSkillQuality(workspaceUri);
  const contextEfficiency = await auditContextEfficiency(workspaceUri, context, mcpHealth.estimatedTokenCost, selectedTool);
  const toolSecurity = await auditToolSecurity(workspaceUri);
  const hookCoverage = await auditHookCoverage(workspaceUri);
  const skillCoverage = await auditSkillCoverage(workspaceUri, context);

  endTimer?.end?.();
  logger.info('Context audit complete', {
    mcpScore: mcpHealth.score,
    skillScore: skillQuality.score,
    efficiencyScore: contextEfficiency.score,
    securityScore: toolSecurity.score,
    hookScore: hookCoverage.score,
    coverageScore: skillCoverage.score,
  });

  return { mcpHealth, skillQuality, contextEfficiency, toolSecurity, hookCoverage, skillCoverage };
}
