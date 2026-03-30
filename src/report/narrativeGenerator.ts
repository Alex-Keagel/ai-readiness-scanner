import { ReadinessReport, NarrativeSections, NarrativeMetric, ToolingHealthItem, FrictionStep, AI_TOOLS, AITool, MATURITY_LEVELS } from '../scoring/types';
import { CopilotClient } from '../llm/copilotClient';
import { getPlatformExpertPrompt } from '../remediation/fixPrompts';
import { logger } from '../logging';

export class NarrativeGenerator {
  constructor(private client: CopilotClient) {}

  async generate(report: ReadinessReport): Promise<NarrativeSections> {
    const timer = logger.time('NarrativeGenerator: generate');
    try {
      // Sequential with delays to avoid transport overload
      const platformReadiness = await this.generatePlatformReadiness(report);
      await new Promise(r => setTimeout(r, 1000));
      const toolingHealth = await this.generateToolingHealth(report);
      await new Promise(r => setTimeout(r, 1000));
      const frictionMap = await this.generateFrictionMap(report);
      timer?.end?.();
      return { platformReadiness, toolingHealth, frictionMap };
    } catch (err) {
      logger.error('NarrativeGenerator: generation failed', err);
      timer?.end?.();
      return this.fallbackNarrative(report);
    }
  }

  private async generatePlatformReadiness(report: ReadinessReport): Promise<NarrativeMetric[]> {
    try {
      const tool = report.selectedTool as AITool;
      const toolConfig = AI_TOOLS[tool];
      const metrics = report.codebaseMetrics;
      const audit = report.contextAudit;

      // Get platform-specific signal IDs via central filter
      const { PlatformSignalFilter } = await import('../scoring/signalFilter');
      const platformSignalIdSet = new Set(PlatformSignalFilter.getSignalIds(tool));
      const allSignals = report.levels.flatMap(l => l.signals);

      // Instruction/Reality Sync — weighted: 60% coverage exists + 40% path accuracy
      const platformSignals = allSignals.filter(s => platformSignalIdSet.has(s.signalId));
      const realityChecks = platformSignals
        .filter(s => s.realityChecks?.length)
        .flatMap(s => s.realityChecks!);
      const validChecks = realityChecks.filter(r => r.status === 'valid').length;
      const totalChecks = realityChecks.length;

      // Coverage score: do instruction files exist for this platform?
      const instructionSignalsExist = platformSignals.filter(s => s.detected && s.level <= 3);
      const expectedInstructionSignals = platformSignals.filter(s => s.level <= 3);
      const coverageScore = expectedInstructionSignals.length > 0
        ? Math.round((instructionSignalsExist.length / expectedInstructionSignals.length) * 100)
        : 50;

      // Path accuracy score: of the paths referenced, how many are valid?
      const pathAccuracyScore = totalChecks > 0
        ? Math.round((validChecks / totalChecks) * 100)
        : 80; // no paths referenced = no stale references = good

      // Blend: 60% coverage + 40% accuracy
      const instructionSyncScore = Math.round(coverageScore * 0.6 + pathAccuracyScore * 0.4);

      // Business Logic Alignment — 3-factor blend:
      // 1. Business validation scores (LLM cross-reference: do instructions match code?)
      // 2. Component coverage (what % of app components are mentioned in instructions?)
      // 3. Reality sync contribution (do referenced paths exist?)
      const APP_TYPES = new Set(['service', 'app', 'library']);
      const appComponentPaths = (report.componentScores || [])
        .filter(c => APP_TYPES.has(c.type))
        .map(c => c.path);
      const appComponents = (report.componentScores || []).filter(c => APP_TYPES.has(c.type));

      const bizSignals = platformSignals
        .filter(s => s.detected && s.businessFindings?.length)
        .filter(s => {
          if (!s.files?.length || appComponentPaths.length === 0) return true;
          return s.files.some(f => appComponentPaths.some(cp => f.startsWith(cp)));
        });
      
      // Factor 1: LLM business validation score
      const bizValidationScore = bizSignals.length > 0
        ? Math.round(bizSignals.reduce((acc, s) => acc + s.score, 0) / bizSignals.length)
        : 50; // neutral if no validation data

      // Factor 2: component coverage — how many app components have detected signals?
      let componentCoverageScore = 50;
      if (appComponents.length > 0) {
        const coveredComponents = appComponents.filter(c => c.overallScore >= 40).length;
        componentCoverageScore = Math.round((coveredComponents / appComponents.length) * 100);
      }

      // Factor 3: instruction quality — average of detected instruction signals  
      const instructionSignals = platformSignals.filter(s => s.detected && s.level <= 3);
      const instructionQualityScore = instructionSignals.length > 0
        ? Math.round(instructionSignals.reduce((acc, s) => acc + s.score, 0) / instructionSignals.length)
        : 30;

      // Blend: 40% validation + 30% coverage + 30% instruction quality
      const businessLogicScore = Math.round(
        bizValidationScore * 0.4 + componentCoverageScore * 0.3 + instructionQualityScore * 0.3
      );

      // Context efficiency: use audit score or estimate from overall
      const contextEffScore = audit?.contextEfficiency?.score ?? Math.min(60, report.overallScore + 10);

      // Prefer L1 signal scores (app-layer filtered) over global codebaseMetrics
      const l1Signals = report.levels.flatMap(l => l.signals).filter(s => s.level === 1 && s.detected);
      const l1TypeStrictness = l1Signals.find(s => s.signalId === 'codebase_type_strictness')?.score;
      const l1SemanticDensity = l1Signals.find(s => s.signalId === 'codebase_semantic_density')?.score;

      const dimensions: { dimension: string; score: number }[] = [
        { dimension: 'Business Logic Alignment', score: businessLogicScore },
        { dimension: 'Type & Environment Strictness', score: Math.round(l1TypeStrictness ?? metrics?.typeStrictnessIndex ?? report.overallScore * 0.7) },
        { dimension: 'Semantic Density', score: Math.round(l1SemanticDensity ?? metrics?.semanticDensity ?? report.overallScore * 0.6) },
        { dimension: 'Instruction/Reality Sync', score: instructionSyncScore },
        { dimension: 'Context Efficiency', score: contextEffScore },
      ];

      const expertPrompt = getPlatformExpertPrompt(tool);
      const prompt = `${expertPrompt}

You are writing a platform readiness assessment for a ${toolConfig.name} user.
Project: ${report.projectName} (Level ${report.primaryLevel}: ${MATURITY_LEVELS[report.primaryLevel].name}, Score: ${report.overallScore}/100)

For each metric below, write ONE specific, insightful sentence explaining what the score means for THIS project. Reference actual component names. Do NOT mention calculation methodology.

IMPORTANT: Your narrative must match the metric's actual meaning:
- Business Logic Alignment: Do instruction files accurately describe the codebase structure and conventions?
- Type & Environment Strictness: Language-aware type safety. Statically typed languages score high. Python with type hints gets partial credit. Config files excluded.
- Semantic Density: Ratio of documentation (comments, docstrings) to code. Higher = agents understand better.
- Instruction/Reality Sync: 60% "do instruction files exist" + 40% "do referenced paths exist". NOT about applyTo patterns.
- Context Efficiency: 60% component coverage (specific mention=100, scoped applyTo=80, global-only=40, absent=0) + 40% token budget. A global copilot-instructions.md gives only 40/100 per component — scoped instructions are needed for high scores. Low score = insufficient or too generic instruction coverage.

Metrics:
${dimensions.map(d => `- ${d.dimension}: ${d.score}/100`).join('\n')}

Context:
- Languages: ${report.projectContext.languages.join(', ')}
- Components: ${report.componentScores.slice(0, 8).map(c => `${c.name} (L${c.primaryLevel}, ${c.overallScore}pts)`).join(', ')}
- Reality check: ${validChecks}/${totalChecks} paths verified
- Instruction files: ${report.contextAudit ? `${report.contextAudit.contextEfficiency.totalTokens} tokens (${report.contextAudit.contextEfficiency.budgetPct}% of budget)` : 'unknown'}
- ${report.levels.flatMap(l => l.signals).filter(s => s.detected).length} signals detected out of ${report.levels.flatMap(l => l.signals).length}

Respond as JSON array:
[{"dimension":"...","narrative":"one specific sentence"}]`;

      const response = await this.client.analyzeFast(prompt);
      const parsed = this.parseJsonArray<{ dimension: string; narrative: string }>(response);

      return dimensions.map(d => {
        const match = parsed?.find(p => p.dimension === d.dimension);
        const label = d.score >= 75 ? 'excellent' as const : d.score >= 55 ? 'strong' as const : d.score >= 35 ? 'warning' as const : 'critical' as const;
        return {
          dimension: d.dimension,
          score: d.score,
          label,
          narrative: match?.narrative || this.defaultNarrative(d.dimension, d.score),
        };
      });
    } catch (err) {
      logger.error('NarrativeGenerator: platformReadiness failed', err);
      return this.fallbackMetrics(report);
    }
  }

  private async generateToolingHealth(report: ReadinessReport): Promise<{ status: string; items: ToolingHealthItem[] }> {
    try {
      const tool = report.selectedTool as AITool;
      const audit = report.contextAudit;
      const signals = report.levels.flatMap(l => l.signals);

      // Determine overall status
      const skillCount = audit?.skillQuality?.skills?.length ?? 0;
      const mcpServers = audit?.mcpHealth?.servers?.length ?? 0;
      const mcpIssues = audit?.mcpHealth?.servers?.filter(s => s.status !== 'healthy').length ?? 0;
      const securityIssues = audit?.toolSecurity?.issues?.length ?? 0;

      // Cross-platform detection
      const allPlatformSignals = ['copilot_instructions', 'cline_rules', 'cursor_rules', 'claude_instructions', 'roo_modes', 'windsurf_rules', 'aider_config'];
      const detectedPlatforms = allPlatformSignals.filter(id => signals.find(s => s.signalId === id && s.detected));

      const expertPrompt = getPlatformExpertPrompt(tool);
      const prompt = `${expertPrompt}

Assess the tooling ecosystem health for this ${AI_TOOLS[tool].name} project.

Data:
- Skills defined: ${skillCount} (quality scores: ${audit?.skillQuality?.skills?.map(s => `${s.name}:${s.score}`).join(', ') || 'none'})
- MCP servers: ${mcpServers} (${mcpIssues} with issues)
- Security issues: ${securityIssues}
- Platforms with config: ${detectedPlatforms.length} (${detectedPlatforms.map(id => id.split('_')[0]).join(', ')})
- Hook coverage: postTask=${audit?.hookCoverage?.hasPostTask}, memoryUpdate=${audit?.hookCoverage?.hasMemoryUpdate}, safeCommands=${audit?.hookCoverage?.hasSafeCommands}
- Reality check failures: ${signals.filter(s => s.realityChecks?.some(r => r.status === 'invalid')).map(s => s.signalId).join(', ') || 'none'}

Write a JSON response:
{
  "status": "one short overall status phrase (e.g. 'Capable, but Fragmented' or 'Excellent & Integrated' or 'Minimal Setup')",
  "items": [
    {"name":"Skill Portability","severity":"good|warning|critical","narrative":"one specific sentence"},
    {"name":"Tooling Execution Risk","severity":"good|warning|critical","narrative":"one specific sentence about broken paths/commands"},
    {"name":"Context Collision","severity":"good|warning|critical","narrative":"one specific sentence about multi-platform fragmentation"}
  ]
}`;

      const response = await this.client.analyzeFast(prompt);
      const parsed = this.parseJson<{ status: string; items: ToolingHealthItem[] }>(response);
      if (parsed?.status && parsed?.items?.length) {
        return parsed;
      }
      return this.fallbackTooling(report);
    } catch (err) {
      logger.error('NarrativeGenerator: toolingHealth failed', err);
      return this.fallbackTooling(report);
    }
  }

  private async generateFrictionMap(report: ReadinessReport): Promise<FrictionStep[]> {
    try {
      const tool = report.selectedTool as AITool;
      const toolConfig = AI_TOOLS[tool];
      const nextLevel = Math.min(6, report.primaryLevel + 1);
      const missingSignals = report.levels.flatMap(l => l.signals).filter(s => !s.detected && s.level <= nextLevel);
      const realityFailures = report.levels.flatMap(l => l.signals)
        .filter(s => s.realityChecks?.some(r => r.status === 'invalid'))
        .flatMap(s => s.realityChecks!.filter(r => r.status === 'invalid'));
      const insights = report.insights || [];

      const expertPrompt = getPlatformExpertPrompt(tool);
      const prompt = `${expertPrompt}

Create an Architectural Friction Map for upgrading this ${toolConfig.name} project from Level ${report.primaryLevel} (${MATURITY_LEVELS[report.primaryLevel as 1|2|3|4|5|6].name}) to Level ${nextLevel} (${MATURITY_LEVELS[nextLevel as 1|2|3|4|5|6].name}).

Project: ${report.projectName}
Languages: ${report.projectContext.languages.join(', ')}
Components: ${report.componentScores.slice(0, 6).map(c => c.name).join(', ')}

EXISTING FILES (DO NOT suggest creating these — they already exist):
${report.structureComparison?.expected?.filter((f) => f.exists).map((f) => `✅ ${f.path}`).join('\n') || '(none detected)'}

Missing signals: ${missingSignals.map(s => `${s.signalId}: ${s.finding}`).join('\n')}

Reality check failures: ${realityFailures.slice(0, 5).map(r => `${r.claim} → ${r.reality} (${r.file})`).join('\n') || 'none'}

Critical insights: ${insights.filter(i => i.severity === 'critical').slice(0, 3).map(i => `${i.title}: ${i.recommendation}`).join('\n') || 'none'}

Low-scoring components: ${report.componentScores.filter(c => c.overallScore < 40).slice(0, 5).map(c => `${c.name} (${c.overallScore}pts)`).join(', ') || 'none'}

IMPORTANT: Only suggest creating files that are MISSING. Never suggest creating a file listed above as existing.

Create 3-5 numbered remediation steps. Each step should have:
- A creative, memorable title (e.g. "Fix the Ghost Map", "Patch the Semantic Black Holes")
- A narrative paragraph explaining WHY this matters for AI agents
- 1-3 specific file-level actions with expected impact

Respond as JSON array:
[{"title":"creative title","narrative":"why paragraph","actions":[{"action":"specific file action","impact":"what improves"}]}]`;

      const response = await this.client.analyzeFast(prompt);
      const parsed = this.parseJsonArray<FrictionStep>(response);
      if (parsed?.length) {
        return parsed.slice(0, 5);
      }
      return this.fallbackFriction(report);
    } catch (err) {
      logger.error('NarrativeGenerator: frictionMap failed', err);
      return this.fallbackFriction(report);
    }
  }

  // ── Fallbacks ──

  private fallbackNarrative(report: ReadinessReport): NarrativeSections {
    return {
      platformReadiness: this.fallbackMetrics(report),
      toolingHealth: this.fallbackTooling(report),
      frictionMap: this.fallbackFriction(report),
    };
  }

  private fallbackMetrics(report: ReadinessReport): NarrativeMetric[] {
    const m = report.codebaseMetrics;
    const score = report.overallScore;
    // Prefer L1 signal scores (app-layer filtered) over global metrics
    const l1Signals = report.levels.flatMap(l => l.signals).filter(s => s.level === 1 && s.detected);
    const l1TS = l1Signals.find(s => s.signalId === 'codebase_type_strictness')?.score;
    const l1SD = l1Signals.find(s => s.signalId === 'codebase_semantic_density')?.score;
    const dims: [string, number][] = [
      ['Business Logic Alignment', Math.round(score * 0.8)],
      ['Type & Environment Strictness', Math.round(l1TS ?? m?.typeStrictnessIndex ?? score * 0.7)],
      ['Semantic Density', Math.round(l1SD ?? m?.semanticDensity ?? score * 0.6)],
      ['Instruction/Reality Sync', Math.max(40, Math.round(score * 0.9))],
      ['Context Efficiency', report.contextAudit?.contextEfficiency?.score ?? Math.min(60, score + 10)],
    ];
    return dims.map(([dimension, s]) => ({
      dimension,
      score: s,
      label: (s >= 75 ? 'excellent' : s >= 55 ? 'strong' : s >= 35 ? 'warning' : 'critical') as NarrativeMetric['label'],
      narrative: this.defaultNarrative(dimension, s),
    }));
  }

  private fallbackTooling(report: ReadinessReport): { status: string; items: ToolingHealthItem[] } {
    const score = report.overallScore;
    return {
      status: score >= 60 ? 'Established' : score >= 30 ? 'Developing' : 'Minimal Setup',
      items: [
        { name: 'Skill Portability', severity: score >= 50 ? 'good' : 'warning', narrative: `${report.contextAudit?.skillQuality?.skills?.length ?? 0} skills defined.` },
        { name: 'Tooling Execution Risk', severity: 'warning', narrative: 'Run a full scan to assess tooling execution risk.' },
        { name: 'Context Collision', severity: 'warning', narrative: 'Multi-platform analysis pending.' },
      ],
    };
  }

  private fallbackFriction(report: ReadinessReport): FrictionStep[] {
    const nextLevel = Math.min(6, report.primaryLevel + 1);
    const missing = report.levels.flatMap(l => l.signals).filter(s => !s.detected && s.level <= nextLevel);
    if (missing.length === 0) {
      return [{ title: 'All Clear', narrative: 'All signals for the next level are present.', actions: [] }];
    }
    return [{
      title: `Bridge to Level ${nextLevel}`,
      narrative: `${missing.length} signals are missing for Level ${nextLevel} (${MATURITY_LEVELS[nextLevel as 1|2|3|4|5|6].name}).`,
      actions: missing.slice(0, 5).map(s => ({ action: `Add ${s.signalId.replace(/_/g, ' ')}`, impact: s.finding })),
    }];
  }

  private defaultNarrative(dimension: string, score: number): string {
    if (score >= 75) return `${dimension} is excellent at ${score}/100.`;
    if (score >= 55) return `${dimension} is solid at ${score}/100 with room for improvement.`;
    if (score >= 35) return `${dimension} at ${score}/100 needs attention — agents may struggle here.`;
    return `${dimension} at ${score}/100 is a critical friction point for AI agents.`;
  }

  private parseJsonArray<T>(text: string): T[] | null {
    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return null;
      return JSON.parse(match[0]);
    } catch { return null; }
  }

  private parseJson<T>(text: string): T | null {
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      return JSON.parse(match[0]);
    } catch { return null; }
  }
}
