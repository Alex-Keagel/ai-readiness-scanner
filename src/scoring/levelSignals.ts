import { LevelSignal, MaturityLevel } from './types';

export const LEVEL_SIGNALS: LevelSignal[] = [
  // ─── Level 1: Codebase Quality (Prompt-Only baseline) ─────
  { id: 'codebase_type_strictness', level: 1, name: 'Type Strictness', description: 'Explicit type annotations and interfaces in application code. Agents rely on LSPs for cross-file navigation — untyped code causes hallucinated imports.', filePatterns: [], contentMarkers: [], weight: 20, category: 'content-quality' },
  { id: 'codebase_semantic_density', level: 1, name: 'Semantic Density', description: 'Ratio of comments, docstrings, and descriptive names to raw logic in application code. Higher density means agents pull better context when reasoning.', filePatterns: [], contentMarkers: [], weight: 20, category: 'content-quality' },
  { id: 'codebase_context_efficiency', level: 1, name: 'Context Efficiency', description: 'How much of the agent context window is consumed by instruction files. Sweet spot: 1-8% of budget. Too little = no guidance, too much = less room for code.', filePatterns: [], contentMarkers: [], weight: 15, category: 'content-quality' },

  // ─── Level 2: Instruction-Guided ──────────────────────────
  // Global instruction files
  { id: 'copilot_instructions', level: 2, name: 'Copilot Instructions', description: 'GitHub Copilot custom instructions', filePatterns: ['.github/copilot-instructions.md'], contentMarkers: [], weight: 15, category: 'file-presence' },
  { id: 'copilot_domain_instructions', level: 2, name: 'Domain-Specific Copilot Instructions', description: 'Per-domain instruction files for Copilot', filePatterns: ['.github/instructions/*.instructions.md', '.github/instructions/**/*.md'], contentMarkers: [], weight: 20, category: 'depth' },
  { id: 'cline_rules', level: 2, name: 'Cline Rules', description: 'Cline agent instruction rules', filePatterns: ['.clinerules/**', '.clinerules/default-rules.md', '.clinerules/core/**'], contentMarkers: [], weight: 15, category: 'file-presence' },
  { id: 'cline_domains', level: 2, name: 'Cline Domain Rules', description: 'Domain-specific Cline rules', filePatterns: ['.clinerules/domains/**'], contentMarkers: [], weight: 15, category: 'depth' },
  { id: 'cursor_rules', level: 2, name: 'Cursor Rules', description: 'Cursor AI rules', filePatterns: ['.cursor/rules/**', '.cursorrules', '.cursorignore'], contentMarkers: ['description', 'globs', 'alwaysApply'], weight: 10, category: 'file-presence' },
  { id: 'claude_instructions', level: 2, name: 'Claude Instructions', description: 'Claude Code instructions', filePatterns: ['CLAUDE.md', '.claude/CLAUDE.md', '.claude/rules/**'], contentMarkers: ['@import', 'paths:'], weight: 10, category: 'file-presence' },
  { id: 'roo_modes', level: 2, name: 'Roo Code Modes', description: 'Roo Code mode definitions', filePatterns: ['.roo/rules/**', '.roorules', '.roomodes', '.roorules-*'], contentMarkers: [], weight: 10, category: 'file-presence' },
  { id: 'windsurf_rules', level: 2, name: 'Windsurf Rules', description: 'Windsurf instructions', filePatterns: ['.windsurf/rules/**', 'AGENTS.md'], contentMarkers: ['trigger:', 'always_on', 'model_decision', 'glob'], weight: 5, category: 'file-presence' },
  { id: 'aider_config', level: 2, name: 'Aider Config', description: 'Aider AI configuration', filePatterns: ['.aider.conf.yml', '.aiderignore', '.aider.model.settings.yml'], contentMarkers: [], weight: 5, category: 'file-presence' },
  { id: 'agents_md', level: 2, name: 'AGENTS.md', description: 'Agent instructions file (Windsurf location-scoped rules)', filePatterns: ['AGENTS.md', '**/AGENTS.md'], contentMarkers: [], weight: 10, category: 'file-presence' },
  { id: 'ignore_files', level: 2, name: 'Agent Ignore Files', description: 'Files telling agents what NOT to touch', filePatterns: ['.clineignore', '.cursorignore', '.aiderignore', '.gitignore'], contentMarkers: [], weight: 5, category: 'file-presence' },
  { id: 'azdevops_copilot', level: 2, name: 'Azure DevOps Copilot Config', description: 'Azure DevOps AI configurations', filePatterns: ['.azuredevops/policies/copilot*.yml', '.azuredevops/policies/copilot*.yaml', '.azuredevops/prompts/**'], contentMarkers: [], weight: 10, category: 'file-presence' },
  { id: 'conventions_documented', level: 2, name: 'Coding Conventions', description: 'Coding conventions documented for agents', filePatterns: ['CONTRIBUTING.md', '.editorconfig', '.clinerules/core/development-standards*', '.github/instructions/development-standards*'], contentMarkers: ['convention', 'style', 'naming', 'pattern'], weight: 10, category: 'content-quality' },
  { id: 'project_structure_doc', level: 2, name: 'Project Structure Documented', description: 'Repo layout explained for agents', filePatterns: ['README.md', 'ARCHITECTURE.md', '.clinerules/core/project-overview*', '.clinerules/core/technical-context*'], contentMarkers: ['structure', 'directory', 'layout', 'component', 'module'], weight: 15, category: 'content-quality' },
  
  // ─── Level 3: Skill-Equipped ──────────────────────────────
  { id: 'instruction_accuracy', level: 3, name: 'Instruction Content Accuracy', description: 'Agent instruction files accurately describe the actual project structure, tech stack, and workflows', filePatterns: ['.clinerules/**', '.cursorrules', '.cursor/rules/**', 'CLAUDE.md', '.claude/**', '.github/copilot-instructions.md', '.github/instructions/**', '.roo/rules/**', '.roomodes', '.windsurf/rules/**', 'AGENTS.md', 'memory-bank/**', 'README.md'], contentMarkers: [], weight: 25, category: 'content-quality' },
  { id: 'copilot_agents', level: 3, name: 'Copilot Agents', description: 'GitHub Copilot agent definitions', filePatterns: ['.github/agents/*.agent.md'], contentMarkers: ['description:', 'tools:', 'name:'], weight: 20, category: 'file-presence' },
  { id: 'copilot_skills', level: 3, name: 'Copilot Skills', description: 'Reusable Copilot skills', filePatterns: ['.github/skills/**/SKILL.md', '.github/skills/**/*.md'], contentMarkers: [], weight: 20, category: 'file-presence' },
  { id: 'mcp_config', level: 3, name: 'MCP Server Config', description: 'Model Context Protocol integrations', filePatterns: ['.vscode/mcp.json', '.mcp.json', '.clinerules/mcp-config/**', '**/mcp*.json', '**/mcp*.yaml'], contentMarkers: ['mcpServers', 'command', 'transport'], weight: 20, category: 'file-presence' },
  { id: 'safe_commands', level: 3, name: 'Safe Commands', description: 'Defined safe operations for agents', filePatterns: ['.clinerules/safe-commands*', '.clinerules/core/security*'], contentMarkers: ['safe', 'allow', 'permitted', 'forbidden', 'never'], weight: 15, category: 'content-quality' },
  { id: 'tool_definitions', level: 3, name: 'Tool Definitions', description: 'Structured tool/function definitions', filePatterns: ['.clinerules/tools/**', '.roo/rules-code/**', '.roo/rules-architect/**', '.roo/rules-debug/**', '.roo/rules-docs-extractor/**', '.windsurf/skills/**'], contentMarkers: ['tool', 'function', 'input', 'output', 'parameter'], weight: 15, category: 'file-presence' },
  { id: 'memory_bank', level: 3, name: 'Memory Bank', description: 'Persistent agent context', filePatterns: ['memory-bank/**', 'memory-bank/activeContext.md', 'memory-bank/productContext.md', 'memory-bank/techContext.md', 'memory-bank/systemPatterns.md', '.context/**', 'context.md'], contentMarkers: ['context', 'session', 'domain'], weight: 15, category: 'file-presence' },
  { id: 'agent_personas', level: 3, name: 'Agent Personas', description: 'Named agent specializations', filePatterns: ['.github/agents/**', '.roomodes', 'AGENTS.md'], contentMarkers: ['role', 'persona', 'expert', 'specialist'], weight: 15, category: 'content-quality' },
  {
    id: 'copilot_cli_instructions',
    level: 3,
    name: 'GitHub Copilot CLI Instructions',
    description: 'Instructions specifically for GitHub Copilot CLI agent mode (terminal-based agent usage)',
    filePatterns: [
      '.github/copilot-instructions.md', '.github/instructions/**',
      'AGENTS.md', '.clinerules/core/**',
    ],
    contentMarkers: [
      'copilot.*cli', 'terminal.*agent', 'agent.*mode',
      'gh.*copilot', 'copilot.*chat', '@workspace',
      'slash.*command', '/fix', '/test', '/explain',
    ],
    weight: 10,
    category: 'content-quality',
  },

  // L3 Context Architecture signals
  { id: 'mcp_health', level: 3, name: 'MCP Server Health', description: 'MCP servers are properly configured with valid commands, scoped access, and no hardcoded secrets', filePatterns: ['.vscode/mcp.json', '.mcp.json', '.clinerules/mcp-config/**'], contentMarkers: ['mcpServers', 'command', 'transport'], weight: 15, category: 'content-quality' },
  { id: 'skill_quality', level: 3, name: 'Skill Definition Quality', description: 'Skills have proper frontmatter, clear steps, valid references, and are not generic boilerplate', filePatterns: ['.github/skills/**/SKILL.md', '.windsurf/skills/**'], contentMarkers: ['name:', 'description:', 'step', 'guideline'], weight: 10, category: 'content-quality' },
  { id: 'context_efficiency', level: 3, name: 'Context Efficiency', description: 'Total context consumed by instructions, MCP tools, and memory banks is under 10% of budget', filePatterns: [], contentMarkers: [], weight: 10, category: 'content-quality' },

  // ─── Level 4: Playbook-Driven ─────────────────────────────
  { id: 'agent_workflows', level: 4, name: 'Agent Workflows', description: 'Step-by-step workflows for agents', filePatterns: ['.clinerules/workflows/**', '.windsurf/workflows/**', 'playbooks/**', 'runbooks/**', '.github/playbooks/**'], contentMarkers: ['step 1', 'step 2', 'then', 'next', 'finally', 'verify', 'validate'], weight: 25, category: 'content-quality' },
  {
    id: 'session_management',
    level: 4,
    name: 'Session/Plan File Management',
    description: 'Agents instructed to maintain session files, update plans, and track progress during work',
    filePatterns: [
      '.clinerules/workflows/**', '.clinerules/default-rules.md',
      'CLAUDE.md', '.claude/rules/**',
      '.github/copilot-instructions.md', '.github/instructions/**',
      '.cursor/rules/**', '.cursorrules',
      '.roo/rules/**', '.windsurf/rules/**',
    ],
    contentMarkers: [
      'update.*plan', 'session.*file', 'track.*progress', 'update.*context',
      'current.context', 'activeContext', 'plan\\.md', 'progress\\.md',
      'at the end', 'after complet', 'when done', 'before closing',
    ],
    weight: 20,
    category: 'content-quality',
  },
  {
    id: 'post_task_instructions',
    level: 4,
    name: 'Post-Task Instructions',
    description: 'Explicit instructions for what agents should do after completing a task (update docs, memory, tests)',
    filePatterns: [
      '.clinerules/**', 'CLAUDE.md', '.claude/**',
      '.github/copilot-instructions.md', '.github/instructions/**',
      '.cursorrules', '.cursor/rules/**',
      '.roo/rules/**', '.windsurf/rules/**', 'AGENTS.md',
    ],
    contentMarkers: [
      'after.*task', 'when.*complete', 'after.*implement', 'post.*task',
      'update.*readme', 'update.*documentation', 'update.*memory',
      'update.*changelog', 'commit.*message',
      'run.*test', 'verify', 'validate',
    ],
    weight: 20,
    category: 'content-quality',
  },
  { id: 'task_playbooks', level: 4, name: 'Task Playbooks', description: 'End-to-end playbooks for common tasks', filePatterns: ['playbooks/**/*.md', 'docs/agents/**/*.md', 'docs/ai/**/*.md'], contentMarkers: ['prerequisite', 'output', 'completion', 'checklist'], weight: 20, category: 'content-quality' },
  { id: 'workflow_verification', level: 4, name: 'Workflow Verification Steps', description: 'Playbooks include validation/exit criteria', filePatterns: ['.clinerules/workflows/**', 'playbooks/**'], contentMarkers: ['verify', 'validate', 'assert', 'check', 'confirm', 'test'], weight: 20, category: 'content-quality' },
  { id: 'error_recovery', level: 4, name: 'Error Recovery Docs', description: 'Troubleshooting and rollback guidance', filePatterns: ['docs/troubleshooting*', 'runbooks/**', 'playbooks/*error*', 'playbooks/*rollback*'], contentMarkers: ['if.*fail', 'rollback', 'escalat', 'recover', 'fallback'], weight: 15, category: 'content-quality' },
  { id: 'workflow_tool_refs', level: 4, name: 'Workflows Reference Tools', description: 'Playbooks reference defined skills/tools', filePatterns: ['.clinerules/workflows/**', 'playbooks/**'], contentMarkers: ['skill', 'tool', 'mcp', 'command', 'script'], weight: 15, category: 'content-quality' },
  { id: 'domain_workflows', level: 4, name: 'Domain-Specific Workflows', description: 'Workflows for different domains/languages', filePatterns: ['.clinerules/workflows/**', '.clinerules/domains/**'], contentMarkers: ['python', 'typescript', 'kusto', 'bicep', 'data', 'infra'], weight: 10, category: 'depth' },

  // L4 Context Architecture signals
  { id: 'tool_security', level: 4, name: 'Agent Tool Security', description: 'Agent tool assignments follow least-privilege principle with no dangerous combinations', filePatterns: ['.github/agents/*.agent.md', '.roomodes'], contentMarkers: ['tools:', 'shell', 'execute', 'edit'], weight: 15, category: 'content-quality' },
  { id: 'hook_coverage', level: 4, name: 'Hook & Automation Coverage', description: 'Post-task hooks, memory updates, safe-commands, and pre-commit hooks are configured', filePatterns: ['.clinerules/safe-commands*', '.clinerules/workflows/**', '.husky/**', 'memory-bank/**'], contentMarkers: ['after completing', 'update', 'validate'], weight: 10, category: 'content-quality' },

  // ─── Level 5: Self-Improving ──────────────────────────────
  { id: 'memory_bank_accuracy', level: 5, name: 'Memory Bank Accuracy', description: 'Memory bank domain mappings and context files accurately reflect the current project state', filePatterns: ['memory-bank/**', 'memory-bank/memoryBankManagement.md', 'memory-bank/techContext.md', 'memory-bank/systemPatterns.md'], contentMarkers: ['domain_coverage', 'directory', 'component', 'module'], weight: 20, category: 'content-quality' },
  { id: 'memory_bank_update', level: 5, name: 'Memory Bank Update Process', description: 'Agents instructed to update memory', filePatterns: ['.clinerules/workflows/update-memory*', '.clinerules/workflows/update-memory-bank.md', '.clinerules/workflows/*memory*', 'memory-bank/**', 'memory-bank/activeContext.md', 'memory-bank/**/progress.md'], contentMarkers: ['update memory', 'record', 'log decision', 'lesson', 'retrospective'], weight: 25, category: 'content-quality' },
  {
    id: 'long_term_memory',
    level: 5,
    name: 'Long-Term Memory Management',
    description: 'Persistent memory that survives across sessions (memory-bank/, knowledge base, decision logs)',
    filePatterns: [
      'memory-bank/**', 'memory-bank/productContext.md', 'memory-bank/techContext.md',
      'memory-bank/systemPatterns.md', 'memory-bank/memoryBankManagement.md',
      '.context/**', 'docs/decisions/**', 'docs/adr/**',
    ],
    contentMarkers: [
      'long.term', 'persistent', 'across.*session', 'decision.*log',
      'architectural.*decision', 'pattern', 'domain.*coverage',
    ],
    weight: 20,
    category: 'content-quality',
  },
  {
    id: 'short_term_memory',
    level: 5,
    name: 'Short-Term Memory Management',
    description: 'Session-scoped context tracking (activeContext, current-context, scratchpad)',
    filePatterns: [
      'memory-bank/personal/**', 'memory-bank/personal/activeContext.md',
      'memory-bank/personal/progress.md', 'memory-bank/personal/notes/**',
      '.clinerules/current-context.template.md',
      '.copilot/session-state/**',
    ],
    contentMarkers: [
      'active.*context', 'current.*session', 'current.*task', 'short.term',
      'scratchpad', 'working.*memory', 'session.*state', 'progress',
    ],
    weight: 15,
    category: 'content-quality',
  },
  {
    id: 'doc_update_instructions',
    level: 5,
    name: 'Documentation Update Instructions',
    description: 'Agents explicitly told to update README, memory banks, and docs when modifying code',
    filePatterns: [
      '.clinerules/**', 'CLAUDE.md', '.claude/**',
      '.github/copilot-instructions.md', '.github/instructions/**',
      '.cursorrules', '.cursor/rules/**',
      '.roo/rules/**', '.windsurf/rules/**', 'AGENTS.md',
    ],
    contentMarkers: [
      'update.*readme', 'update.*documentation', 'update.*memory.*bank',
      'keep.*sync', 'keep.*up.to.date', 'reflect.*change',
      'when.*modify', 'after.*chang', 'update.*agents?\\.md',
      'maintain.*doc', 'update.*copilot.instructions',
    ],
    weight: 20,
    category: 'content-quality',
  },
  { id: 'agent_evals', level: 5, name: 'Agent Evaluations', description: 'Eval harness for agent performance', filePatterns: ['evals/**', 'agent-evals/**', 'benchmarks/**', '.github/evals/**'], contentMarkers: ['eval', 'benchmark', 'score', 'compare', 'baseline'], weight: 25, category: 'file-presence' },
  { id: 'retrospectives', level: 5, name: 'Retrospectives', description: 'Agent learning records', filePatterns: ['retrospectives/**', 'lessons-learned/**', '.ai-feedback/**', 'memory-bank/*decision*', 'memory-bank/*progress*'], contentMarkers: ['learned', 'improvement', 'decision', 'outcome', 'retrospective'], weight: 20, category: 'content-quality' },
  { id: 'self_improve_workflow', level: 5, name: 'Self-Improvement Workflow', description: 'Process for agents to improve their own instructions', filePatterns: ['.clinerules/workflows/improve-*', '.clinerules/workflows/*improve*', 'scripts/*improve*', 'scripts/*feedback*'], contentMarkers: ['improve', 'update instruction', 'suggest change', 'propose'], weight: 20, category: 'content-quality' },
  { id: 'feedback_ci', level: 5, name: 'Feedback CI/Automation', description: 'CI that runs agent evals or feedback', filePatterns: ['.github/workflows/*eval*', '.github/workflows/*feedback*', '.github/workflows/*benchmark*'], contentMarkers: ['eval', 'feedback', 'benchmark'], weight: 10, category: 'file-presence' },
  { id: 'pattern_to_skill_pipeline', level: 5, name: 'Pattern-to-Skill Pipeline', description: 'Mechanisms to identify recurring tasks and convert them into reusable skills or agents', filePatterns: ['.clinerules/workflows/create-skill*', '.clinerules/workflows/new-skill*', '.github/workflows/*skill*', '.github/workflows/*agent*', 'scripts/*skill*', 'scripts/*agent*', '.factory/skills/**', '.github/skills/**', 'docs/skills/**', 'docs/agents/**'], contentMarkers: ['create.*skill', 'new.*skill', 'convert.*to.*skill', 'recurring', 'repeated', 'automate.*task', 'template.*skill', 'skill.*template', 'agent.*template', 'reusable.*workflow'], weight: 15, category: 'content-quality' },
  { id: 'session_history_analysis', level: 5, name: 'Session History Available', description: 'Session logs or task history that can be analyzed for recurring patterns', filePatterns: ['memory-bank/personal/progress.md', 'memory-bank/personal/notes/**', '.copilot/session-state/**', '.claude/sessions/**', 'docs/decisions/**', 'docs/adr/**', 'retrospectives/**', 'lessons-learned/**', '.clinerules/current-context.template.md'], contentMarkers: ['session', 'history', 'task.*log', 'completed.*task', 'decision.*record', 'adr', 'retrospective', 'what.*learned', 'pattern.*discovered'], weight: 10, category: 'file-presence' },

  // ─── Level 6: Autonomous Orchestration ────────────────────
  { id: 'orchestrator_agents', level: 6, name: 'Orchestrator Agents', description: 'Agents that coordinate other agents', filePatterns: ['.github/agents/orchestrator*', '.github/agents/*planner*', '.github/agents/*coordinator*', 'orchestrator/**'], contentMarkers: ['orchestrat', 'coordinat', 'delegat', 'handoff'], weight: 25, category: 'content-quality' },
  { id: 'multi_agent_framework', level: 6, name: 'Multi-Agent Framework', description: 'Multi-agent coordination framework', filePatterns: ['crewai/**', 'autogen/**', 'langgraph/**', 'semantic-kernel/**', 'multi-agent/**'], contentMarkers: ['agent', 'crew', 'team', 'swarm', 'graph'], weight: 20, category: 'file-presence' },
  { id: 'cross_repo_triggers', level: 6, name: 'Cross-Repo Triggers', description: 'Triggers across repos or services', filePatterns: ['.github/workflows/**'], contentMarkers: ['repository_dispatch', 'workflow_dispatch', 'workflow_call'], weight: 20, category: 'content-quality' },
  { id: 'autonomous_actions', level: 6, name: 'Autonomous Actions', description: 'Agents can open PRs, create issues, deploy', filePatterns: ['.github/workflows/**', 'scripts/*agent*'], contentMarkers: ['create.*issue', 'open.*pr', 'pull.*request', 'deploy', 'dispatch'], weight: 15, category: 'content-quality' },
  { id: 'agent_governance', level: 6, name: 'Agent Governance', description: 'Approval gates and safety controls', filePatterns: ['**/*agent*permission*', '**/*agent*governance*'], contentMarkers: ['approv', 'gate', 'escalat', 'human.*review', 'rollback'], weight: 10, category: 'content-quality' },
  { id: 'agent_specialization', level: 6, name: 'Agent Specialization', description: 'Different agents for different domains', filePatterns: ['.github/agents/**'], contentMarkers: ['specialist', 'domain', 'responsibility'], weight: 10, category: 'depth' },
];

// Helper functions
export function getSignalsByLevel(level: MaturityLevel): LevelSignal[] {
  return LEVEL_SIGNALS.filter(s => s.level === level);
}

export function getSignalById(id: string): LevelSignal | undefined {
  return LEVEL_SIGNALS.find(s => s.id === id);
}

export function getAllSignals(): LevelSignal[] {
  return [...LEVEL_SIGNALS];
}
