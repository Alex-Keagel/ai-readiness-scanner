export type AITool = 'copilot' | 'cline' | 'cursor' | 'roo' | 'claude' | 'windsurf' | 'aider';

export interface ReasoningContext {
  instructionFormat: string;
  structureExpectations: string;
  qualityMarkers: string;
  antiPatterns: string;
}

export interface DocUrls {
  main: string;
  rules: string;
  memory?: string;
  bestPractices?: string;
  rawExamples?: string[]; // Raw GitHub URLs with actual example files
  guideSources?: string[]; // URLs to fetch for guide generation (raw GitHub or HTML doc sites)
}

export const AI_TOOLS: Record<AITool, {
  name: string;
  icon: string;
  signalIds: string[];
  level2Files: string[];
  level3Files: string[];
  level4Files: string[];
  level5Files: string[];
  reasoningContext: ReasoningContext;
  docUrls: DocUrls;
}> = {
  copilot: {
    name: 'GitHub Copilot',
    icon: '🤖',
    signalIds: ['codebase_type_strictness', 'codebase_semantic_density', 'codebase_context_efficiency', 'copilot_instructions', 'copilot_domain_instructions', 'copilot_agents', 'copilot_skills', 'mcp_config', 'copilot_cli_instructions', 'post_task_instructions', 'doc_update_instructions', 'pattern_to_skill_pipeline', 'session_history_analysis'],
    level2Files: ['.github/copilot-instructions.md', '.github/instructions/**/*.instructions.md'],
    level3Files: ['.github/agents/*.agent.md', '.github/skills/**/SKILL.md', '.vscode/mcp.json'],
    level4Files: ['.github/playbooks/**'],
    level5Files: ['.copilot/session-state/**'],
    reasoningContext: {
      instructionFormat: 'Copilot reads .github/copilot-instructions.md (always-on) and .github/instructions/*.instructions.md (scoped via applyTo: glob in YAML frontmatter). Instructions should be concise coding rules, not essays. Copilot also reads AGENTS.md and CLAUDE.md for cross-tool compatibility.',
      structureExpectations: 'Expected: .github/copilot-instructions.md at root. Domain instructions in .github/instructions/ with .instructions.md suffix and YAML frontmatter containing applyTo: glob. Agents in .github/agents/*.agent.md with description/name/tools YAML frontmatter. Skills in .github/skills/*/SKILL.md. Prompt files in .github/prompts/*.prompt.md.',
      qualityMarkers: 'Good Copilot instructions: use applyTo scoping to target specific file types, define concrete coding conventions (not vague advice), reference actual project paths, use /init to generate initial instructions. Agent definitions include tools array and description. Good Copilot setup includes instructions to update documentation and README when making changes, and guidance for Copilot CLI agent mode.',
      antiPatterns: 'Bad: long essays instead of bullet rules. Missing applyTo frontmatter (instructions apply everywhere). Generic advice like "write clean code". Agent files without tools array. Skills without clear steps.',
    },
    docUrls: {
      main: 'https://code.visualstudio.com/docs/copilot/copilot-customization',
      rules: 'https://code.visualstudio.com/docs/copilot/customization/custom-instructions',
      bestPractices: 'https://code.visualstudio.com/docs/copilot/guides/customize-copilot-guide',
      rawExamples: [
        'https://raw.githubusercontent.com/microsoft/vscode/main/.github/copilot-instructions.md',
        'https://raw.githubusercontent.com/microsoft/typescript-go/main/.github/copilot-instructions.md',
      ],
      guideSources: [
        'https://raw.githubusercontent.com/microsoft/vscode/main/.github/copilot-instructions.md',
        'https://raw.githubusercontent.com/microsoft/typescript-go/main/.github/copilot-instructions.md',
      ],
    },
  },
  cline: {
    name: 'Cline',
    icon: '🔧',
    signalIds: ['codebase_type_strictness', 'codebase_semantic_density', 'codebase_context_efficiency', 'cline_rules', 'cline_domains', 'safe_commands', 'tool_definitions', 'mcp_config', 'memory_bank', 'memory_bank_update', 'agent_workflows', 'ignore_files', 'session_management', 'post_task_instructions', 'long_term_memory', 'short_term_memory', 'doc_update_instructions', 'pattern_to_skill_pipeline', 'session_history_analysis'],
    level2Files: ['.clinerules/default-rules.md', '.clinerules/core/**', '.clinerules/domains/**', '.clineignore'],
    level3Files: ['.clinerules/tools/**', '.clinerules/safe-commands.md', '.clinerules/mcp-config/**', 'memory-bank/**'],
    level4Files: ['.clinerules/workflows/**'],
    level5Files: ['.clinerules/workflows/update-memory-bank.md', 'memory-bank/activeContext.md', 'memory-bank/**/progress.md', '.clinerules/current-context.template.md', 'memory-bank/personal/activeContext.md', 'memory-bank/personal/progress.md'],
    reasoningContext: {
      instructionFormat: 'Cline reads .clinerules/ directory with .md files. Supports conditional rules via paths: YAML frontmatter. default-rules.md is the master file loaded first. Cline also reads .cursorrules, .windsurfrules, AGENTS.md for cross-tool compat.',
      structureExpectations: 'Expected hierarchy: .clinerules/default-rules.md (master), .clinerules/core/ (project-overview, technical-context, development-standards, security-guidelines), .clinerules/domains/ (per-language/domain), .clinerules/workflows/ (step-by-step procedures), .clinerules/tools/ (tool usage patterns), .clinerules/safe-commands.md (auto-approved commands), .clinerules/mcp-config/*.json (MCP server configs). Memory bank: memory-bank/ with projectbrief.md, productContext.md, systemPatterns.md, techContext.md, memoryBankManagement.md (domain-to-directory mapping).',
      qualityMarkers: 'Good Cline setup: default-rules.md defines session startup reading sequence. memoryBankManagement.md maps code directories to domain banks for selective loading. safe-commands.md organized by category. Files under 200 lines for context efficiency. Conditional rules use paths: frontmatter for scoping. MCP configs have autoApprove lists. Good Cline setup includes update-memory-bank workflow, current-context.template.md for session tracking, and explicit post-task instructions to update docs.',
      antiPatterns: 'Bad: single massive default-rules.md over 200 lines. No memoryBankManagement.md domain mapping. safe-commands including dangerous operations (rm, sudo). MCP configs without autoApprove. No session startup sequence. Memory bank files without .gitignore for personal/ directory.',
    },
    docUrls: {
      main: 'https://docs.cline.bot/features/cline-rules',
      rules: 'https://docs.cline.bot/features/cline-rules',
      memory: 'https://docs.cline.bot/features/cline-docs',
      rawExamples: [
        'https://raw.githubusercontent.com/cline/cline-docs/main/docs/features/cline-rules.md',
      ],
      guideSources: [
        'https://raw.githubusercontent.com/cline/cline/main/README.md',
      ],
    },
  },
  cursor: {
    name: 'Cursor',
    icon: '📝',
    signalIds: ['codebase_type_strictness', 'codebase_semantic_density', 'codebase_context_efficiency', 'cursor_rules', 'mcp_config', 'ignore_files', 'post_task_instructions', 'doc_update_instructions'],
    level2Files: ['.cursor/rules/**', '.cursorrules', '.cursorignore'],
    level3Files: ['.cursor/mcp.json'],
    level4Files: [],
    level5Files: [],
    reasoningContext: {
      instructionFormat: 'Cursor reads .cursor/rules/*.md files (preferred, directory-based) or .cursorrules (legacy single file). Rules support YAML frontmatter with paths: for file-scoped activation. Also reads .cursorignore.',
      structureExpectations: 'Expected: .cursor/rules/ directory with topic-specific files (coding.md, testing.md, architecture.md). Each can have paths: frontmatter with glob patterns for scoping. Legacy: single .cursorrules file at root.',
      qualityMarkers: 'Good Cursor rules: use .cursor/rules/ directory (not legacy .cursorrules). File-scoped rules with paths: frontmatter. Descriptive filenames indicating scope. Specific, verifiable instructions not vague advice. Code examples showing desired patterns.',
      antiPatterns: 'Bad: only legacy .cursorrules (no directory structure). Rules over 12000 chars. No path scoping (everything applies everywhere). Generic advice. Conflicting rules across files.',
    },
    docUrls: {
      main: 'https://docs.cursor.com/context/rules',
      rules: 'https://docs.cursor.com/context/rules',
      rawExamples: [
        'https://raw.githubusercontent.com/PatrickJS/awesome-cursorrules/main/rules/cursor-rules.md',
      ],
      guideSources: [
        'https://raw.githubusercontent.com/PatrickJS/awesome-cursorrules/main/README.md',
      ],
    },
  },
  roo: {
    name: 'Roo Code',
    icon: '🦘',
    signalIds: ['codebase_type_strictness', 'codebase_semantic_density', 'codebase_context_efficiency', 'roo_modes', 'agent_personas', 'tool_definitions', 'post_task_instructions', 'doc_update_instructions', 'session_history_analysis'],
    level2Files: ['.roo/rules/**', '.roorules', '.roomodes'],
    level3Files: ['.roo/rules-code/**', '.roo/rules-architect/**', '.roo/rules-debug/**'],
    level4Files: ['.roo/rules-*/'],
    level5Files: [],
    reasoningContext: {
      instructionFormat: 'Roo Code reads .roo/rules/*.md for workspace rules and .roo/rules-{mode}/*.md for mode-specific rules (code, architect, debug, docs-extractor). Also reads .roomodes for custom mode definitions. Falls back to .roorules and .clinerules.',
      structureExpectations: 'Expected: .roo/rules/ for general rules. .roo/rules-code/ for code mode. .roo/rules-architect/ for architecture mode. .roo/rules-debug/ for debugging. .roomodes for custom mode definitions. Files numbered for ordering (01-general.md, 02-coding-style.md).',
      qualityMarkers: 'Good Roo setup: mode-specific rules leveraging Roo\'s multi-mode architecture. Numbered files for load ordering. Custom modes defined in .roomodes for specialized workflows. Rules per file type/domain. Separate rules for code vs architecture vs debug.',
      antiPatterns: 'Bad: only generic .roorules file (no mode-specific rules). Not using .roo/ directory structure. No custom modes despite complex project. All rules in one file.',
    },
    docUrls: {
      main: 'https://docs.roocode.com/features/custom-instructions',
      rules: 'https://docs.roocode.com/features/custom-instructions',
      rawExamples: [
        'https://raw.githubusercontent.com/RooVetGit/Roo-Code/main/README.md',
      ],
      guideSources: [
        'https://raw.githubusercontent.com/RooVetGit/Roo-Code/main/README.md',
      ],
    },
  },
  claude: {
    name: 'Claude Code',
    icon: '🧠',
    signalIds: ['codebase_type_strictness', 'codebase_semantic_density', 'codebase_context_efficiency', 'claude_instructions', 'post_task_instructions', 'doc_update_instructions'],
    level2Files: ['CLAUDE.md', '.claude/CLAUDE.md', '.claude/rules/**'],
    level3Files: [],
    level4Files: [],
    level5Files: ['.claude/settings.json'],
    reasoningContext: {
      instructionFormat: 'Claude Code reads CLAUDE.md (project root or .claude/CLAUDE.md). Supports @import syntax to pull in other files. .claude/rules/*.md for organized rules with paths: YAML frontmatter scoping. Each session starts fresh — CLAUDE.md is the primary context carrier.',
      structureExpectations: 'Expected: CLAUDE.md at root (under 200 lines) with @imports for detailed docs. .claude/rules/ for topic-specific rules (code-style.md, testing.md, security.md). Rules support paths: frontmatter for file-type scoping. Subdirectory CLAUDE.md files load on-demand.',
      qualityMarkers: 'Good Claude setup: CLAUDE.md under 200 lines with clear sections. Uses @import for longer docs (e.g., @docs/architecture.md). Rules organized by topic. Path-scoped rules for frontend vs backend. Specific build/test commands. Subdirectory CLAUDE.md for component-specific context.',
      antiPatterns: 'Bad: CLAUDE.md over 200 lines (wastes context). No @imports (everything crammed in one file). No .claude/rules/ organization. Generic instructions. No subdirectory CLAUDE.md files in monorepos.',
    },
    docUrls: {
      main: 'https://docs.anthropic.com/en/docs/claude-code/memory',
      rules: 'https://docs.anthropic.com/en/docs/claude-code/memory',
      rawExamples: [
        'https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/CLAUDE.md',
      ],
      guideSources: [
        'https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/misc/prompt_caching.ipynb',
      ],
    },
  },
  windsurf: {
    name: 'Windsurf',
    icon: '🏄',
    signalIds: ['codebase_type_strictness', 'codebase_semantic_density', 'codebase_context_efficiency', 'windsurf_rules', 'agents_md', 'post_task_instructions', 'doc_update_instructions', 'pattern_to_skill_pipeline', 'session_history_analysis'],
    level2Files: ['.windsurf/rules/**', 'AGENTS.md'],
    level3Files: ['.windsurf/skills/**'],
    level4Files: ['.windsurf/workflows/**'],
    level5Files: [],
    reasoningContext: {
      instructionFormat: 'Windsurf reads .windsurf/rules/*.md with YAML frontmatter trigger: field (always_on, glob, model_decision, manual). Also reads AGENTS.md (root=always-on, subdir=auto-glob). Skills in .windsurf/skills/, workflows in .windsurf/workflows/.',
      structureExpectations: 'Expected: .windsurf/rules/ with trigger frontmatter. AGENTS.md for location-scoped rules. .windsurf/skills/ for multi-step procedures. .windsurf/workflows/ for repeatable tasks via slash commands. Rules limited to 12000 chars each.',
      qualityMarkers: 'Good Windsurf setup: uses trigger modes appropriately (always_on for universal rules, glob for file-specific, model_decision for contextual, manual for on-demand). Skills include supporting files. Workflows use slash command activation. AGENTS.md in subdirectories for component-specific rules.',
      antiPatterns: 'Bad: all rules as always_on (wastes context). No trigger frontmatter. Rules over 12000 chars. No AGENTS.md. Skills without supporting files.',
    },
    docUrls: {
      main: 'https://docs.windsurf.com/windsurf/cascade/memories',
      rules: 'https://docs.windsurf.com/windsurf/cascade/memories',
      rawExamples: [
        'https://raw.githubusercontent.com/nicepkg/aide/main/README.md',
      ],
      guideSources: [
        'https://raw.githubusercontent.com/nicepkg/aide/main/README.md',
      ],
    },
  },
  aider: {
    name: 'Aider',
    icon: '🔨',
    signalIds: ['codebase_type_strictness', 'codebase_semantic_density', 'codebase_context_efficiency', 'aider_config', 'ignore_files'],
    level2Files: ['.aider.conf.yml', '.aiderignore'],
    level3Files: [],
    level4Files: [],
    level5Files: [],
    reasoningContext: {
      instructionFormat: 'Aider reads .aider.conf.yml for configuration and .aiderignore for file exclusions. Minimal instruction system compared to other tools.',
      structureExpectations: 'Expected: .aider.conf.yml with model settings, .aiderignore for excluding files, .aider.model.settings.yml for model-specific config.',
      qualityMarkers: 'Good Aider setup: .aiderignore excludes generated/vendor files. Model settings configured for project. Convention file referenced.',
      antiPatterns: 'Bad: no .aiderignore (agent processes everything including node_modules). No model configuration.',
    },
    docUrls: {
      main: 'https://aider.chat/docs/config.html',
      rules: 'https://aider.chat/docs/config.html',
      rawExamples: [
        'https://raw.githubusercontent.com/Aider-AI/aider/main/README.md',
        'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/assets/sample.aider.conf.yml',
      ],
      guideSources: [
        'https://raw.githubusercontent.com/Aider-AI/aider/main/README.md',
      ],
    },
  },
};

export const MATURITY_LEVELS = {
  1: { name: 'Prompt-Only', description: 'Ad-hoc prompting, no agent awareness' },
  2: { name: 'Instruction-Guided', description: 'Custom instructions shape agent behavior' },
  3: { name: 'Skill-Equipped', description: 'Reusable skills, agents, and tool integrations' },
  4: { name: 'Playbook-Driven', description: 'End-to-end workflows agents can follow' },
  5: { name: 'Self-Improving', description: 'Agents record learnings and suggest improvements' },
  6: { name: 'Autonomous Orchestration', description: 'Multi-agent coordination across systems' },
} as const;

export type MaturityLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface LevelSignal {
  id: string;
  level: MaturityLevel;
  name: string;
  description: string;
  filePatterns: string[];
  contentMarkers: string[];  // regex patterns to look for inside files
  weight: number;  // 0-25, how important this signal is
  category: 'file-presence' | 'content-quality' | 'depth';
}

/**
 * Dynamically compute expected files for a platform at a given level.
 * Derives from LEVEL_SIGNALS + AI_TOOLS.signalIds instead of hardcoded arrays.
 * Falls back to static level*Files if defined (for backward compatibility).
 */
export function getLevelFiles(tool: AITool, level: MaturityLevel): string[] {
  const toolConfig = AI_TOOLS[tool];
  // Use static override if present and non-empty
  const staticFiles = level === 2 ? toolConfig.level2Files :
    level === 3 ? toolConfig.level3Files :
    level === 4 ? toolConfig.level4Files :
    level === 5 ? toolConfig.level5Files : [];
  if (staticFiles && staticFiles.length > 0) return staticFiles;

  // Dynamic: collect filePatterns from signals at this level that are relevant to this platform
  // Lazy import to avoid circular dependency
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LEVEL_SIGNALS } = require('./levelSignals') as { LEVEL_SIGNALS: LevelSignal[] };
    const platformSignalIds = new Set(toolConfig.signalIds);
    const patterns: string[] = [];
    for (const signal of LEVEL_SIGNALS) {
      if (signal.level !== level) continue;
      if (signal.filePatterns.length === 0) continue;
      // Include if signal is in platform's list OR signal is shared (not platform-specific)
      const isShared = !signal.id.match(/^(copilot|cline|cursor|claude|roo|windsurf|aider)_/);
      if (platformSignalIds.has(signal.id) || isShared) {
        patterns.push(...signal.filePatterns);
      }
    }
    return [...new Set(patterns)];
  } catch {
    return staticFiles || [];
  }
}

export interface RealityCheckRef {
  category: 'path' | 'command' | 'tech-stack' | 'structure' | 'stale';
  status: 'valid' | 'invalid' | 'warning';
  claim: string;
  reality: string;
  file: string;
  line?: number;
}

export interface SignalResult {
  signalId: string;
  level: MaturityLevel;
  detected: boolean;
  score: number;     // 0-100 quality score from LLM or deterministic
  finding: string;
  files: string[];   // files that contributed to this signal
  modelUsed?: string;
  confidence: 'high' | 'medium' | 'low';
  confidenceScore?: number; // 0.0-1.0 numeric confidence from validation pipeline
  validatorAgreed?: boolean;
  debateOutcome?: string;
  realityChecks?: RealityCheckRef[];
  businessFindings?: string[];  // business logic validation findings
}

export interface LevelScore {
  level: MaturityLevel;
  name: string;
  rawScore: number;       // 0-100
  qualified: boolean;     // meets threshold
  signals: SignalResult[];
  signalsDetected: number;
  signalsTotal: number;
}

export interface ComponentScore {
  name: string;
  path: string;
  language: string;
  type: string;
  description?: string;
  parentPath?: string;     // path of parent component (for sub-components)
  children?: string[];     // paths of child components
  primaryLevel: MaturityLevel;
  depth: number;           // 0-100 within primary level
  overallScore: number;    // 0-100 composite
  levels: LevelScore[];
  signals: ComponentSignal[];
  isGenerated?: boolean;   // true for exported/backup/auto-generated code (KQL backups, protobuf stubs, etc.)
}

export interface ComponentSignal {
  signal: string;
  present: boolean;
  detail: string;
}

export interface LanguageScore {
  language: string;
  fileCount: number;
  components: string[];
  primaryLevel: MaturityLevel;
  depth: number;
  signals: ComponentSignal[];
}

export interface StructureComparison {
  tool: string;
  toolName: string;
  expected: { path: string; description: string; required: boolean; level: number; exists: boolean; actualPath?: string }[];
  presentCount: number;
  missingCount: number;
  completeness: number;
  visualTree: string;
}

export interface Insight {
  title: string;
  recommendation: string;
  severity: 'critical' | 'important' | 'suggestion';
  category: string;
  estimatedImpact?: string;
  affectedComponent?: string;
  confidenceScore?: number; // 0.0-1.0 from validation pipeline
}

export interface ReadinessReport {
  projectName: string;
  scannedAt: string;
  primaryLevel: MaturityLevel;
  levelName: string;
  depth: number;            // 0-100 within primary level
  overallScore: number;     // 0-100 composite
  levels: LevelScore[];
  componentScores: ComponentScore[];
  languageScores: LanguageScore[];
  projectContext: ProjectContext;
  selectedTool: string;
  modelUsed: string;
  scanMode: 'full' | 'quick';
  repoMap?: unknown;
  knowledgeGraph?: unknown;
  structureComparison?: StructureComparison;
  insights?: Insight[];
  codebaseMetrics?: {
    semanticDensity: number;
    typeStrictnessIndex: number;
    contextFragmentation: number;
  };
  contextAudit?: {
    mcpHealth: { score: number; servers: { name: string; status: string; issues: string[] }[]; totalTools: number; estimatedTokenCost: number };
    skillQuality: { score: number; skills: { name: string; path: string; score: number; issues: string[] }[] };
    contextEfficiency: { score: number; totalTokens: number; budgetPct: number; breakdown: { category: string; tokens: number; pct: number }[]; redundancies: string[] };
    toolSecurity: { score: number; issues: { agent: string; severity: string; issue: string }[] };
    hookCoverage: { score: number; hasPostTask: boolean; hasMemoryUpdate: boolean; hasSafeCommands: boolean; hasPreCommit: boolean };
    skillCoverage: { score: number; coveredAreas: string[]; gaps: { area: string; suggestion: string }[] };
  };
  narrativeSections?: NarrativeSections;
  coherenceWarning?: string;
  appliedFixes?: AppliedFix[];
}

export interface AppliedFix {
  signalId: string;
  filePaths: string[];
  timestamp: string;
  status: 'pending-review' | 'committed';
}

export interface NarrativeMetric {
  dimension: string;
  score: number;
  label: 'excellent' | 'strong' | 'warning' | 'critical';
  narrative: string;
}

export interface ToolingHealthItem {
  name: string;
  severity: 'good' | 'warning' | 'critical';
  narrative: string;
}

export interface FrictionStep {
  title: string;
  narrative: string;
  actions: { action: string; impact: string }[];
}

export interface NarrativeSections {
  platformReadiness: NarrativeMetric[];
  toolingHealth: { status: string; items: ToolingHealthItem[] };
  frictionMap: FrictionStep[];
}

export interface ProjectContext {
  languages: string[];
  frameworks: string[];
  projectType: 'monorepo' | 'library' | 'app' | 'service' | 'unknown';
  packageManager: string;
  directoryTree: string;
  components: ComponentInfo[];
  buildTasks?: string; // contents of .vscode/tasks.json (summarized)
}

export interface ComponentInfo {
  name: string;
  path: string;
  language: string;
  type: 'app' | 'library' | 'service' | 'script' | 'config' | 'infra' | 'data' | 'unknown';
  description?: string;
  parentPath?: string;  // path of parent component (for sub-components)
  children?: ComponentInfo[];  // sub-components within this component
  isGenerated?: boolean; // true for exported/backup/auto-generated code
}

export interface FileContent {
  path: string;
  content: string;
  relativePath: string;
}

export interface RemediationFix {
  signalId: string;
  tier: 'auto' | 'guided' | 'recommend';
  files: FixFile[];
  explanation: string;
}

export interface FixFile {
  path: string;
  action: 'create' | 'modify';
  content: string;
  originalContent?: string;
}

// ─── Remediation helpers ──────────────────────────────────────────────

/** A signal that was not detected, eligible for remediation. */
export interface FailingSignal {
  id: string;
  level: MaturityLevel;
  finding: string;
  confidence: 'high' | 'medium' | 'low';
  fixTier?: 'auto' | 'guided' | 'recommend';
  modelUsed?: string;
}
