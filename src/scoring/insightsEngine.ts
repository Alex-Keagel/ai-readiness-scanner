import * as vscode from 'vscode';
import { ReadinessReport, MaturityLevel, MATURITY_LEVELS, AI_TOOLS, AITool } from './types';
import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';
import { PlatformSignalFilter } from './signalFilter';
import { deduplicateInsights } from '../utils';

// Insight type defined locally (removed from core types.ts)
export interface Insight {
  category: 'missing-readme-content' | 'missing-skill' | 'missing-agent' | 'missing-workflow' | 'missing-instructions' | 'missing-tool' | 'improvement' | 'next-level';
  severity: 'critical' | 'important' | 'nice-to-have';
  title: string;
  description: string;
  recommendation: string;
  targetLevel: MaturityLevel;
  affectedComponent?: string;
  affectedLanguage?: string;
  estimatedImpact: number;
}

// Maps signal IDs to specific, actionable recommendations
const SIGNAL_RECOMMENDATIONS: Record<string, {
  title: string;
  description: string;
  recommendation: string;
  category: Insight['category'];
  severity: Insight['severity'];
  estimatedImpact: number;
}> = {
  // Level 1 / Level 2 signals
  copilot_instructions: {
    title: 'Missing GitHub Copilot instructions',
    description: 'Without copilot-instructions.md, GitHub Copilot has no project-specific context and generates generic code that may not follow your patterns.',
    recommendation: 'Create `.github/copilot-instructions.md` with project overview, coding conventions, and repo structure. This is the primary way GitHub Copilot learns about your project.',
    category: 'missing-instructions',
    severity: 'critical',
    estimatedImpact: 9,
  },
  agent_instructions: {
    title: 'No AI agent instruction files',
    description: 'Without agent instructions (AGENTS.md, .clinerules, .cursorrules, CLAUDE.md), AI tools operate blindly without understanding your project conventions.',
    recommendation: 'Create at least one agent instruction file — start with AGENTS.md or .github/copilot-instructions.md describing your project structure, conventions, and common workflows.',
    category: 'missing-instructions',
    severity: 'critical',
    estimatedImpact: 9,
  },
  readme: {
    title: 'README.md missing or insufficient',
    description: 'The README is the first thing an AI agent reads to understand the project. Without it, agents can\'t reason about purpose, setup, or architecture.',
    recommendation: 'Create or improve README.md with: project purpose, setup instructions, directory structure, architecture overview, and common development tasks.',
    category: 'missing-readme-content',
    severity: 'critical',
    estimatedImpact: 8,
  },
  project_structure_documented: {
    title: 'Project structure not documented',
    description: 'Agents need to understand directory layout and component boundaries to navigate the codebase effectively.',
    recommendation: 'Add a directory tree to README.md or create ARCHITECTURE.md explaining what each top-level directory contains and how components relate to each other.',
    category: 'missing-readme-content',
    severity: 'critical',
    estimatedImpact: 8,
  },
  conventions_documented: {
    title: 'No coding conventions documented',
    description: 'Without documented conventions, agents generate code that may not match your project\'s style, naming patterns, or architectural decisions.',
    recommendation: 'Create CONTRIBUTING.md or add conventions to your agent instruction files covering: naming patterns, file organization, error handling approach, and testing expectations.',
    category: 'missing-instructions',
    severity: 'important',
    estimatedImpact: 7,
  },
  cline_rules: {
    title: 'No Cline rules configured',
    description: 'Without .clinerules, Cline agents lack session startup rules, context loading order, and domain knowledge references.',
    recommendation: 'Create the Cline directory structure:\n• `.clinerules/default-rules.md` — core rules loaded at session startup\n• `.clinerules/core/project-overview.md` — project context\n• `.clinerules/core/technical-context.md` — tech stack details\n• `.clinerules/core/development-standards.md` — coding conventions\n• `.clinerules/domains/` — domain-specific rules\n• `.clineignore` — files agents should not touch',
    category: 'missing-instructions',
    severity: 'important',
    estimatedImpact: 6,
  },
  cursor_rules: {
    title: 'No Cursor rules configured',
    description: 'Without Cursor rules, Cursor lacks project-specific coding conventions and architecture patterns.',
    recommendation: 'Create `.cursor/rules/` with scoped rule files (preferred over legacy `.cursorrules`):\n• `.cursor/rules/general.md` — project-wide conventions\n• Each rule file supports YAML frontmatter with `description`, `globs` (path scoping), and `alwaysApply` fields\n• `.cursorignore` — files Cursor should not index',
    category: 'missing-instructions',
    severity: 'important',
    estimatedImpact: 6,
  },
  claude_instructions: {
    title: 'No Claude Code instructions',
    description: 'Without CLAUDE.md, Claude Code has no project-specific context and cannot follow your conventions.',
    recommendation: 'Create `CLAUDE.md` in the project root with project overview, conventions, and common commands. Key features:\n• Use `@import` syntax to include other docs: `@docs/git-instructions.md`\n• Create `.claude/rules/*.md` for organized rules (supports `paths:` YAML frontmatter for file-scoping)\n• Subdirectory `CLAUDE.md` files auto-load when Claude reads files in that directory',
    category: 'missing-instructions',
    severity: 'important',
    estimatedImpact: 6,
  },
  roo_modes: {
    title: 'No Roo Code configuration',
    description: 'Without Roo Code rules, Roo agents lack mode-specific behavior and project conventions.',
    recommendation: 'Create the Roo Code directory structure:\n• `.roo/rules/01-general.md`, `.roo/rules/02-coding-style.md` — workspace-wide rules (numbered for load order)\n• `.roo/rules-code/` — rules for code mode\n• `.roo/rules-architect/` — rules for architect mode\n• `.roo/rules-debug/` — rules for debug mode\n• `.roomodes` — custom mode definitions',
    category: 'missing-instructions',
    severity: 'important',
    estimatedImpact: 6,
  },
  windsurf_rules: {
    title: 'No Windsurf rules configured',
    description: 'Without Windsurf rules, Windsurf agents lack project-specific context and trigger-based behavior.',
    recommendation: 'Create `.windsurf/rules/` with rule files using YAML frontmatter:\n• `trigger: always_on` — loaded every session\n• `trigger: model_decision` — AI decides when relevant\n• `trigger: glob` with `globs:` pattern — auto-load for matching files\n• `AGENTS.md` — root-level always-on rules, subdirectory AGENTS.md auto-scoped\n• `.windsurf/skills/` — multi-step procedures\n• `.windsurf/workflows/` — prompt templates for repeatable tasks',
    category: 'missing-instructions',
    severity: 'important',
    estimatedImpact: 6,
  },
  aider_config: {
    title: 'No Aider configuration',
    description: 'Without Aider config, Aider uses default settings without project-specific model or ignore settings.',
    recommendation: 'Create Aider configuration files:\n• `.aider.conf.yml` — project configuration (model, conventions, settings)\n• `.aiderignore` — files Aider should not edit\n• `.aider.model.settings.yml` — model-specific settings',
    category: 'missing-instructions',
    severity: 'important',
    estimatedImpact: 5,
  },

  // Level 2 signals
  memory_bank: {
    title: 'No persistent memory for agents',
    description: 'Without memory/context files, agents lose all context between sessions and must re-learn your project every time.',
    recommendation: 'Create `memory-bank/` with `projectContext.md`, `techContext.md`, and domain-specific context files so agents retain knowledge across sessions.',
    category: 'missing-tool',
    severity: 'important',
    estimatedImpact: 7,
  },
  skills: {
    title: 'No skills or domain knowledge directories',
    description: 'Skills directories provide specialized, reusable instructions for specific tasks like deployment, testing, or domain-specific operations.',
    recommendation: 'Create `.github/instructions/` with language-specific and workflow-specific instruction files, or `.clinerules/domains/` with domain knowledge.',
    category: 'missing-skill',
    severity: 'important',
    estimatedImpact: 6,
  },
  safe_operations_defined: {
    title: 'No safe commands list defined',
    description: 'Without a safe operations list, agents either run commands unsafely or ask for permission on every command, slowing down workflows.',
    recommendation: 'Create `.clinerules/safe-commands.md` listing which commands agents can auto-run (e.g., `npm test`, `pytest`, `go test`) vs which need human approval (e.g., `rm -rf`, deployments).',
    category: 'missing-instructions',
    severity: 'important',
    estimatedImpact: 5,
  },

  // Level 3 signals
  copilot_agents: {
    title: 'No Copilot agent definitions',
    description: 'Without agent definitions, Copilot can\'t delegate to specialized personas for different tasks like code review, testing, or deployment.',
    recommendation: 'Create `.github/agents/` with agent definitions tailored to your project\'s languages and frameworks.',
    category: 'missing-agent',
    severity: 'important',
    estimatedImpact: 7,
  },
  copilot_skills: {
    title: 'No Copilot skill definitions',
    description: 'Skills let agents execute specific, repeatable tasks like running tests, deploying, or formatting code.',
    recommendation: 'Create reusable skills based on your project\'s common operations — test runners, build commands, deployment steps.',
    category: 'missing-skill',
    severity: 'important',
    estimatedImpact: 6,
  },
  mcp_config: {
    title: 'No MCP server configurations',
    description: 'MCP lets agents access external data sources (databases, APIs, ADO). Without it, agents are limited to local file operations.',
    recommendation: 'Add MCP configurations for your data sources. Create `.vscode/mcp.json` or `.copilot/mcp-config.json` with server definitions.',
    category: 'missing-tool',
    severity: 'nice-to-have',
    estimatedImpact: 5,
  },
  agent_instructions_validation: {
    title: 'Agent instructions not validated against codebase',
    description: 'Agent instruction files may contain outdated references to files, patterns, or tools that no longer exist in the codebase.',
    recommendation: 'Review agent instruction files and ensure all referenced paths, commands, and patterns still match the current codebase. Consider adding a CI check.',
    category: 'improvement',
    severity: 'nice-to-have',
    estimatedImpact: 4,
  },
  service_flow_documented: {
    title: 'No architecture diagrams',
    description: 'Architecture diagrams help agents understand how services, components, and data flow through the system.',
    recommendation: 'Create `docs/architecture.mermaid` or add Mermaid diagrams to README.md showing component relationships, data flow, and service dependencies.',
    category: 'missing-readme-content',
    severity: 'nice-to-have',
    estimatedImpact: 4,
  },

  // Level 4 signals
  agent_workflows: {
    title: 'No end-to-end agent workflows',
    description: 'Without playbooks, agents must improvise on multi-step tasks like bug fixes, feature additions, or deployments.',
    recommendation: 'Create `.clinerules/workflows/` with playbooks for common tasks like "fix a bug", "add a new API endpoint", "deploy to production".',
    category: 'missing-workflow',
    severity: 'nice-to-have',
    estimatedImpact: 6,
  },

  // Level 5 signals
  memory_bank_update: {
    title: 'Agents don\'t update their memory',
    description: 'Agents aren\'t instructed to record decisions and learnings after completing tasks, so knowledge is lost.',
    recommendation: 'Add a workflow that tells agents to record decisions, learnings, and context updates in memory-bank/ after completing tasks.',
    category: 'missing-workflow',
    severity: 'nice-to-have',
    estimatedImpact: 5,
  },
  agent_evals: {
    title: 'No agent evaluation framework',
    description: 'Without evaluations, you can\'t measure whether agents are improving or degrading over time.',
    recommendation: 'Create `evals/` with test cases that validate agent outputs against expected results.',
    category: 'missing-tool',
    severity: 'nice-to-have',
    estimatedImpact: 4,
  },
  session_management: {
    title: 'No session/plan file management instructions',
    description: 'Your instruction files don\'t tell agents to track their session progress. Agents lose track of what they\'re doing during multi-step tasks.',
    recommendation: 'Add instructions like \'Update activeContext.md with current task state\' or \'Maintain a plan.md with task progress\' to your agent instruction files.',
    category: 'missing-workflow',
    severity: 'important',
    estimatedImpact: 6,
  },
  post_task_instructions: {
    title: 'No post-task instructions found',
    description: 'No post-task instructions found. Agents finish tasks without updating documentation, running tests, or recording decisions.',
    recommendation: 'Tell agents what to do after completing work: update README, run tests, update memory bank, commit with descriptive message.',
    category: 'missing-workflow',
    severity: 'important',
    estimatedImpact: 7,
  },
  long_term_memory: {
    title: 'No long-term memory system',
    description: 'No long-term memory system found. Agents lose all project knowledge between sessions and must re-learn everything.',
    recommendation: 'Create `memory-bank/` with `productContext.md`, `techContext.md`, `systemPatterns.md` so agents retain knowledge across sessions.',
    category: 'missing-tool',
    severity: 'important',
    estimatedImpact: 7,
  },
  short_term_memory: {
    title: 'No session-scoped memory',
    description: 'No session-scoped memory found. Agents can\'t track their current work state within a session.',
    recommendation: 'Create `memory-bank/personal/activeContext.md` and `.clinerules/current-context.template.md` for agents to track current work state.',
    category: 'missing-tool',
    severity: 'nice-to-have',
    estimatedImpact: 5,
  },
  doc_update_instructions: {
    title: 'Agents not told to update docs when modifying code',
    description: 'Agents aren\'t told to update docs when modifying code. Documentation drifts out of sync with the codebase.',
    recommendation: 'Add explicit instructions: \'When changing code, update the relevant README and memory bank files to reflect the change.\'',
    category: 'missing-instructions',
    severity: 'important',
    estimatedImpact: 7,
  },
  copilot_cli_instructions: {
    title: 'No Copilot CLI agent mode instructions',
    description: 'Without Copilot CLI instructions, terminal-based agent usage lacks project-specific context and slash command guidance.',
    recommendation: 'Add Copilot CLI guidance to `.github/copilot-instructions.md` covering agent mode usage, slash commands (/fix, /test, /explain), and terminal-based workflows.',
    category: 'missing-instructions',
    severity: 'nice-to-have',
    estimatedImpact: 5,
  },
  pattern_to_skill_pipeline: {
    title: 'No pattern-to-skill pipeline',
    description: 'Without a mechanism to discover recurring tasks and convert them into reusable skills or agents, teams keep solving the same problems manually.',
    recommendation: 'Create a workflow (e.g. `.clinerules/workflows/create-skill.md` or `.github/workflows/create-skill.yml`) that identifies repeated tasks from session history and generates skill/agent definitions.',
    category: 'missing-workflow',
    severity: 'important',
    estimatedImpact: 8,
  },
  session_history_analysis: {
    title: 'No session history or task logs',
    description: 'Without session logs or task history, there is no data to analyze for recurring patterns that could become reusable skills.',
    recommendation: 'Enable session tracking (e.g. `.copilot/session-state/`, `memory-bank/personal/progress.md`, or `docs/decisions/`) so recurring tasks can be identified and converted into skills.',
    category: 'missing-tool',
    severity: 'nice-to-have',
    estimatedImpact: 6,
  },
};

export class InsightsEngine {
  constructor(private copilotClient: CopilotClient) {}

  async generateInsights(
    report: ReadinessReport,
    token?: vscode.CancellationToken
  ): Promise<Insight[]> {
    const insights: Insight[] = [];
    const timer = logger.time('Insights: total generation');

    logger.info('Insights: analyzing signal gaps...');
    const gaps = this.getSignalGapInsights(report);
    insights.push(...gaps);
    logger.info(`Insights: ${gaps.length} signal gap insights`);

    logger.info('Insights: checking accuracy...');
    const accuracy = this.getAccuracyInsights(report);
    insights.push(...accuracy);
    logger.info(`Insights: ${accuracy.length} accuracy insights`);

    logger.info(`Insights: analyzing ${report.componentScores?.length || 0} components...`);
    const comp = this.getComponentInsights(report);
    insights.push(...comp);
    logger.info(`Insights: ${comp.length} component insights`);

    const lang = this.getLanguageInsights(report);
    insights.push(...lang);

    const next = this.getNextLevelInsights(report);
    insights.push(...next);
    logger.info(`Insights: ${insights.length} static insights total (gaps:${gaps.length} accuracy:${accuracy.length} component:${comp.length} language:${lang.length} next-level:${next.length})`);

    if (this.copilotClient.isAvailable()) {
      logger.info(`Insights: calling LLM for deep analysis + skill recommendations (agent: ${this.copilotClient.getModelName()}, 5min timeout)...`);
      const llmTimer = logger.time('Insights: LLM calls');
      const [llmResult, skillResult] = await Promise.allSettled([
        this.getLLMInsights(report, token),
        this.getSkillRecommendations(report, token),
      ]);
      llmTimer?.end?.();
      if (llmResult.status === 'fulfilled') {
        insights.push(...llmResult.value);
        logger.info(`Insights: LLM generated ${llmResult.value.length} deep insights`);
      } else {
        logger.warn('Failed to generate LLM insights', { error: llmResult.reason instanceof Error ? llmResult.reason.message : String(llmResult.reason) });
      }
      if (skillResult.status === 'fulfilled') {
        insights.push(...skillResult.value);
        logger.info(`Insights: LLM generated ${skillResult.value.length} skill recommendations`);
      } else {
        logger.warn('Failed to generate skill recommendations', { error: skillResult.reason instanceof Error ? skillResult.reason.message : String(skillResult.reason) });
      }
    } else {
      logger.info('Insights: LLM not available, skipping deep analysis');
    }

    timer?.end?.();

    // Dedup using centralized utility
    const deduped = deduplicateInsights(insights);

    const critical = deduped.filter(i => i.severity === 'critical').length;
    const important = deduped.filter(i => i.severity === 'important').length;
    const nice = deduped.filter(i => i.severity === 'nice-to-have').length;
    logger.info(`Insights complete: ${deduped.length} total (deduped from ${insights.length}) — ${critical} critical, ${important} important, ${nice} suggestions`);

    return deduped.sort((a, b) => {
      const sevOrder: Record<string, number> = { critical: 0, important: 1, 'nice-to-have': 2 };
      if (sevOrder[a.severity] !== sevOrder[b.severity]) {
        return sevOrder[a.severity] - sevOrder[b.severity];
      }
      return b.estimatedImpact - a.estimatedImpact;
    });
  }

  private getSignalGapInsights(report: ReadinessReport): Insight[] {
    const insights: Insight[] = [];

    // Collect all undetected signals across all levels
    const allSignals = report.levels.flatMap(ls => ls.signals);
    const failedSignalIds = new Set(
      allSignals.filter(s => !s.detected).map(s => s.signalId)
    );

    // When a specific tool is selected, only recommend that tool's signals
    const selectedTool = report.selectedTool as AITool;
    // PlatformSignalFilter imported statically

    for (const signalId of failedSignalIds) {
      // Skip signals that don't apply to this platform
      if (!PlatformSignalFilter.isRelevant(signalId, selectedTool)) {
        continue;
      }

      const rec = SIGNAL_RECOMMENDATIONS[signalId];
      if (!rec) { continue; }

      const signal = allSignals.find(s => s.signalId === signalId);
      const level = signal?.level ?? 1;

      insights.push({
        category: rec.category,
        severity: rec.severity,
        title: rec.title,
        description: rec.description,
        recommendation: rec.recommendation,
        targetLevel: level,
        estimatedImpact: rec.estimatedImpact,
      });
    }

    // Multi-tool coverage check: only show when no specific tool selected
    if (!selectedTool || selectedTool === 'ask' as any) {
      const agentToolSignals = ['copilot_instructions', 'agent_instructions'];
      const presentTools: string[] = [];
      const missingTools: string[] = [];

      for (const id of agentToolSignals) {
        if (failedSignalIds.has(id)) {
          missingTools.push(id === 'copilot_instructions' ? 'Copilot' : 'Agent (Cline/Cursor/Claude)');
        } else {
          presentTools.push(id === 'copilot_instructions' ? 'Copilot' : 'Agent (Cline/Cursor/Claude)');
        }
      }

      if (presentTools.length > 0 && missingTools.length > 0) {
        insights.push({
          category: 'missing-instructions',
          severity: 'important',
          title: 'Limited AI tool coverage',
          description: `You have instructions for ${presentTools.join(', ')} but not for ${missingTools.join(', ')}. Developers using different AI tools won't get project-specific guidance.`,
          recommendation: `Add instructions for ${missingTools.join(' and ')} to ensure agents work regardless of which tool developers use.`,
          targetLevel: 2,
          estimatedImpact: 6,
        });
      }
    }

    return insights;
  }

  private getAccuracyInsights(report: ReadinessReport): Insight[] {
    const insights: Insight[] = [];
    // L1 codebase signals are AST-measured metrics, not content that can be "inaccurate"
    const SKIP_ACCURACY_CHECK = new Set(['codebase_type_strictness', 'codebase_semantic_density', 'codebase_context_efficiency']);

    for (const level of report.levels) {
      for (const signal of level.signals) {
        if (signal.detected && signal.score < 60 && !SKIP_ACCURACY_CHECK.has(signal.signalId)) {
          insights.push({
            category: 'improvement',
            severity: signal.score < 40 ? 'critical' : 'important',
            title: `${signal.signalId} content may be inaccurate`,
            description: signal.finding,
            recommendation: `Review and update the content in the files for ${signal.signalId}. The LLM detected potential inaccuracies when cross-referencing against the actual project structure.`,
            targetLevel: signal.level,
            estimatedImpact: Math.round((100 - signal.score) / 10),
          });
        }
      }
    }

    return insights;
  }

  private getComponentInsights(report: ReadinessReport): Insight[] {
    const insights: Insight[] = [];
    const repoLevel = report.primaryLevel;

    for (const comp of report.componentScores) {
      // ── Skip noise categories that don't benefit from AI-readiness insights ──

      const nameLower = comp.name.toLowerCase();
      const pathLower = comp.path.toLowerCase();

      // Virtual groups are scanner-internal aggregations, not real directories
      if (pathLower.includes('.group-')) continue;

      // Test projects and test frameworks don't need READMEs or "add tests" recommendations
      const isTestProject = nameLower.endsWith('.tests') || nameLower.endsWith('.test') ||
        nameLower.startsWith('test_') || nameLower.startsWith('testfx') ||
        nameLower === 'tests' || nameLower.includes('testutils') ||
        pathLower.endsWith('.tests') || /\.tests[/\\]/.test(pathLower) ||
        /\/tests?$/.test(pathLower) || /testfx/i.test(nameLower);
      if (isTestProject) continue;

      // Config/dotfile directories (.azuredevops, .config, .vscode, .pipelines, etc.)
      // These are infrastructure, not code that agents edit
      const pathSegments = comp.path.split('/');
      const topSegment = pathSegments[0];
      const isConfigDir = topSegment.startsWith('.') && !topSegment.startsWith('.github');
      if (isConfigDir && !comp.children?.length) continue;

      // Generated code doesn't need AI-readiness treatment
      if (comp.isGenerated) continue;

      const issues: string[] = [];
      const recs: string[] = [];
      let worstSeverity: Insight['severity'] = 'nice-to-have';
      let maxImpact = 0;

      // Check: lagging behind
      if (comp.primaryLevel < repoLevel) {
        const missingSignals = comp.signals
          .filter(s => !s.present)
          .map(s => s.signal);
        issues.push(`Level ${comp.primaryLevel} (repo is Level ${repoLevel}), missing: ${missingSignals.join(', ')}`);
        recs.push(...missingSignals.map(s => `add ${s}`));
        worstSeverity = 'important';
        maxImpact = Math.max(maxImpact, 5);
      }

      // Check: no README
      const readmeSignal = comp.signals.find(s => s.signal === 'README');
      if (readmeSignal && !readmeSignal.present) {
        issues.push('no README.md — agents can\'t understand its purpose');
        recs.push(`create \`${comp.path}/README.md\``);
        maxImpact = Math.max(maxImpact, 4);
      }

      // Check: no tests
      const testSignal = comp.signals.find(s => s.signal === 'Tests');
      if (testSignal && !testSignal.present) {
        issues.push('no tests — agents can\'t verify changes');
        recs.push(`add tests for \`${comp.path}\``);
        worstSeverity = worstSeverity === 'nice-to-have' ? 'important' : worstSeverity;
        maxImpact = Math.max(maxImpact, 6);
      }

      // Consolidate into a single insight per component
      if (issues.length > 0) {
        insights.push({
          category: issues.length === 1 && !readmeSignal?.present && !testSignal?.present ? 'missing-readme-content' : 'improvement',
          severity: worstSeverity,
          title: `Component "${comp.name}" needs improvement (${issues.length} issue${issues.length > 1 ? 's' : ''})`,
          description: `Component \`${comp.name}\` at \`${comp.path}\`: ${issues.join('; ')}.`,
          recommendation: `Address: ${recs.join(', ')}.`,
          targetLevel: repoLevel,
          affectedComponent: comp.name,
          estimatedImpact: maxImpact,
        });
      }
    }

    return insights;
  }

  private getLanguageInsights(report: ReadinessReport): Insight[] {
    const insights: Insight[] = [];

    for (const lang of report.languageScores) {
      const instructionSignal = lang.signals.find(s => s.signal === 'Agent Instructions');
      if (instructionSignal && !instructionSignal.present) {
        insights.push({
          category: 'missing-instructions',
          severity: 'important',
          title: `No agent instructions for ${lang.language}`,
          description: `No agent instructions specific to ${lang.language} found. Agents won't know about ${lang.language}-specific conventions, patterns, or anti-patterns in your project.`,
          recommendation: `Create \`.github/instructions/${lang.language.toLowerCase()}.instructions.md\` with language-specific conventions, preferred libraries, and coding patterns.`,
          targetLevel: 2,
          affectedLanguage: lang.language,
          estimatedImpact: 5,
        });
      }

      const testSignal = lang.signals.find(s => s.signal === 'Tests');
      if (testSignal && !testSignal.present && lang.fileCount > 0) {
        insights.push({
          category: 'improvement',
          severity: 'important',
          title: `No tests for ${lang.language}`,
          description: `${lang.language} has ${lang.fileCount} files but no tests detected. Agents can't verify changes to ${lang.language} code without tests.`,
          recommendation: `Add tests for your ${lang.language} code. Configure a test runner and create at least basic test coverage.`,
          targetLevel: 2,
          affectedLanguage: lang.language,
          estimatedImpact: 6,
        });
      }
    }

    return insights;
  }

  private getNextLevelInsights(report: ReadinessReport): Insight[] {
    const insights: Insight[] = [];
    const currentLevel = report.primaryLevel;
    const nextLevel = (currentLevel + 1) as MaturityLevel;

    if (nextLevel > 6) { return insights; }

    const nextMeta = MATURITY_LEVELS[nextLevel as keyof typeof MATURITY_LEVELS];
    const currentMeta = MATURITY_LEVELS[currentLevel];
    if (!nextMeta) { return insights; }

    const nextLevelScore = report.levels.find(ls => ls.level === nextLevel);
    if (!nextLevelScore) { return insights; }

    const missingSignals = nextLevelScore.signals.filter(s => !s.detected);
    if (missingSignals.length === 0) { return insights; }

    const topMissing = missingSignals.slice(0, 5);
    const failureList = topMissing
      .map(s => `• ${s.finding || s.signalId}`)
      .join('\n');

    insights.push({
      category: 'next-level',
      severity: 'nice-to-have',
      title: `Roadmap to ${nextMeta.name} (Level ${nextLevel})`,
      description: `You're at Level ${currentLevel} (${currentMeta.name}). To reach Level ${nextLevel} (${nextMeta.name}), you need to address ${missingSignals.length} missing signals.`,
      recommendation: `Top items to address:\n${failureList}`,
      targetLevel: nextLevel,
      estimatedImpact: 8,
    });

    return insights;
  }

  private async getLLMInsights(
    report: ReadinessReport,
    token?: vscode.CancellationToken
  ): Promise<Insight[]> {
    const ctx = report.projectContext;
    const allSignals = report.levels.flatMap(ls => ls.signals);
    const detectedIds = allSignals.filter(s => s.detected).map(s => s.signalId);
    const missingIds = allSignals.filter(s => !s.detected).map(s => s.signalId);

    const toolMeta = AI_TOOLS[report.selectedTool as AITool];
    const toolName = toolMeta?.name ?? report.selectedTool;

    const toolContext = `This project is being evaluated for readiness with ${toolName}. Only suggest improvements relevant to ${toolName}'s file structure and capabilities.`;

    const prompt = `You are an AI readiness advisor analyzing a software project.

${toolContext}

Project context:
- Languages: ${ctx.languages.join(', ') || 'none detected'}
- Frameworks: ${ctx.frameworks.join(', ') || 'none detected'}
- Project type: ${ctx.projectType}
- Components: ${ctx.components.map(c => `${c.name} (${c.language}, ${c.type})`).join(', ') || 'single project'}

Directory structure:
${ctx.directoryTree.slice(0, 2000)}

Detected signals: ${detectedIds.join(', ') || 'none'}
Missing signals: ${missingIds.join(', ') || 'none'}
Current maturity level: ${report.primaryLevel} (${report.levelName})

Suggest 5 SPECIFIC, HIGH-IMPACT improvements:
1. What README sections would most help an AI agent understand this project?
2. What agent personas/skills would be most valuable for this specific codebase?
3. What workflows/playbooks should exist for common development tasks in this project?
4. What tool integrations (MCP, skills) would make agents most effective?
5. Are there any conflicting or redundant instructions across the existing files?

For each suggestion, respond with ONLY a JSON array (no markdown fences, no extra text):
[
  {
    "title": "short name",
    "description": "why this matters",
    "recommendation": "specific action (file to create, content to add)",
    "estimatedImpact": 7
  }
]`;

    const response = await this.copilotClient.analyze(prompt, token, 300_000);

    return this.parseLLMResponse(response);
  }

  private parseLLMResponse(response: string): Insight[] {
    try {
      let jsonStr = response;
      const fenceMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) {
        jsonStr = fenceMatch[1].trim();
      }

      const parsed: Array<{
        title?: string;
        description?: string;
        recommendation?: string;
        estimatedImpact?: number;
      }> = JSON.parse(jsonStr);

      if (!Array.isArray(parsed)) { return []; }

      return parsed
        .filter(item => item.title && item.recommendation)
        .map(item => ({
          category: 'improvement' as const,
          severity: 'nice-to-have' as const,
          title: item.title!,
          description: item.description ?? '',
          recommendation: item.recommendation!,
          targetLevel: 3 as MaturityLevel,
          estimatedImpact: Math.min(10, Math.max(1, item.estimatedImpact ?? 5)),
        }));
    } catch (err) {
      logger.warn('Failed to parse LLM insights response', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  private async getSkillRecommendations(report: ReadinessReport, token?: vscode.CancellationToken): Promise<Insight[]> {
    if (!this.copilotClient.isAvailable()) { return []; }

    const selectedTool = report.selectedTool as AITool;
    const toolConfig = AI_TOOLS[selectedTool];
    if (!toolConfig) {
      logger.debug(`Skipping skill recommendations — unknown tool: ${report.selectedTool}`);
      return [];
    }

    // Define what "skills" means per platform
    const skillFormats: Record<string, { concept: string; path: string; format: string }> = {
      copilot: {
        concept: 'Skills (multi-step procedures) and Agents (specialized personas)',
        path: '.github/skills/{name}/SKILL.md for skills, .github/agents/{name}.agent.md for agents',
        format: 'SKILL.md: markdown with steps, inputs, outputs. Agent: YAML frontmatter with description, name, tools array.',
      },
      cline: {
        concept: 'Workflows (step-by-step procedures) and Tool configs (MCP/tool usage patterns)',
        path: '.clinerules/workflows/{name}.md for workflows, .clinerules/tools/{name}.md for tools',
        format: 'Markdown with numbered steps, validation criteria, references to safe-commands and MCP configs.',
      },
      windsurf: {
        concept: 'Skills (procedures with supporting files) and Workflows (slash-command templates)',
        path: '.windsurf/skills/{name}/ for skills, .windsurf/workflows/{name}.md for workflows',
        format: 'Skills: directory with supporting files, invoked by model or @mention. Workflows: markdown templates for /slash commands.',
      },
      roo: {
        concept: 'Custom Modes (specialized agent personas) and mode-specific rules',
        path: '.roomodes for mode definitions, .roo/rules-{mode}/ for mode rules',
        format: 'Modes defined in .roomodes file. Per-mode rules in numbered .md files.',
      },
      cursor: {
        concept: 'Rules (there is no skills concept in Cursor — use path-scoped rules for domain specialization)',
        path: '.cursor/rules/{domain}.md with paths: frontmatter',
        format: 'Markdown with YAML frontmatter containing paths: glob arrays.',
      },
      claude: {
        concept: 'Rules (there is no skills concept in Claude Code — use path-scoped rules and @imports)',
        path: '.claude/rules/{name}.md with paths: frontmatter, or @import in CLAUDE.md',
        format: 'Markdown with YAML frontmatter. Use @path/to/file syntax for imports.',
      },
    };

    const sf = skillFormats[selectedTool]
      ? skillFormats[selectedTool]
      : skillFormats['copilot']; // default to copilot format

    const prompt = `Analyze this repository and suggest which recurring tasks should be automated.

PROJECT: ${report.projectName}
LANGUAGES: ${report.projectContext.languages.join(', ')}
COMPONENTS: ${report.componentScores.map(c => `${c.name} (${c.path}) — ${c.description || c.type}`).join('\n')}

TARGET AI PLATFORM: ${toolConfig.name}
SKILL/AUTOMATION CONCEPT: ${sf.concept}
FILE LOCATION: ${sf.path}
FILE FORMAT: ${sf.format}

EXISTING AUTOMATIONS (DO NOT suggest any that overlap with these):
${report.levels.flatMap(l => l.signals).filter(s => s.detected && (s.signalId.includes('skill') || s.signalId.includes('agent') || s.signalId.includes('workflow'))).map(s => `- ${s.signalId}: ${s.finding} (files: ${(s.files || []).join(', ')})`).join('\n') || 'None found'}

IMPORTANT: Do NOT suggest skills that already exist above. Only suggest NEW skills for tasks not yet covered. If all common tasks are already covered, return fewer suggestions or an empty array.
IMPORTANT: Only suggest skills relevant to the languages and technologies ACTUALLY PRESENT in this repo (listed above in LANGUAGES). Do NOT suggest KQL/Kusto skills if the repo has no .kql files. Do NOT suggest C# skills for Python-only repos.

Suggest up to 3 specific NEW ${sf.concept.split('(')[0].trim().toLowerCase()} that would be valuable and do NOT overlap with existing ones. Generate the EXACT file path and a brief content outline following the platform's format.

Respond with ONLY valid JSON:
{
  "suggestions": [
    {
      "name": "example-name",
      "filePath": ".github/skills/example/SKILL.md",
      "description": "What it does",
      "contentOutline": "Brief outline of what the file should contain",
      "rationale": "Why this would save developer time",
      "targetComponent": "which component it helps"
    }
  ]
}`;

    try {
      const response = await this.copilotClient.analyze(prompt, token, 300_000);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.suggestions)) {
          // Filter out suggestions that overlap with existing files
          const existingFiles = new Set(
            report.levels.flatMap(l => l.signals)
              .filter(s => s.detected)
              .flatMap(s => s.files || [])
              .map(f => f.toLowerCase())
          );
          const filtered = parsed.suggestions.filter((s: any) => {
            if (!s.filePath) return false;
            const lower = s.filePath.toLowerCase();
            return !existingFiles.has(lower) && ![...existingFiles].some(ef => ef.includes(s.name?.toLowerCase?.() || ''));
          });
          const docUrl = toolConfig?.docUrls?.main || '';
          return filtered.map((s: any) => ({
            category: 'missing-skill' as const,
            severity: 'important' as const,
            title: `Suggested: ${s.name}`,
            description: `${s.description}. ${s.rationale}`,
            recommendation: `Create \`${s.filePath}\`: ${s.contentOutline}.${docUrl ? ` See ${docUrl} for format details.` : ''}`,
            targetLevel: 3 as MaturityLevel,
            affectedComponent: s.targetComponent,
            estimatedImpact: 7,
          }));
        }
      }
    } catch (err) { logger.warn('Failed to generate skill recommendations from LLM', { error: err instanceof Error ? err.message : String(err) }); }

    return [];
  }
}
