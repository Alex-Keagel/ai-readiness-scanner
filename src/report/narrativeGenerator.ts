import { ReadinessReport, NarrativeSections, NarrativeMetric, ToolingHealthItem, FrictionStep, AI_TOOLS, AITool, MATURITY_LEVELS, SignalResult } from '../scoring/types';
import { CopilotClient } from '../llm/copilotClient';
import { getPlatformExpertPrompt } from '../remediation/fixPrompts';
import { logger } from '../logging';
import { calculateInstructionRealitySync } from './instructionRealitySync';

export class NarrativeGenerator {
  constructor(private client: CopilotClient) {}

  /**
   * Repair cached narrativeSections in stored reports so old (pre-fix) contradictions don't persist.
   */
  sanitizeNarrativeSections(report: ReadinessReport): boolean {
    const ns = report.narrativeSections;
    if (!ns) return false;

    const tool = report.selectedTool as AITool;
    const allSignals = report.levels.flatMap(l => l.signals);
    const rootInstructionFact = this.getRootInstructionFact(report, tool, allSignals);

    let changed = false;

    const platformReadiness = (ns.platformReadiness || []).map(metric => {
      const nextNarrative = metric.dimension === 'Instruction/Reality Sync'
        ? this.correctedIQSyncNarrative(
          rootInstructionFact.present,
          rootInstructionFact.files,
          metric.score,
          tool,
          rootInstructionFact.canonicalPaths[0],
        )
        : this.sanitizeNarrativeText(metric.dimension, metric.narrative, metric.score, rootInstructionFact);

      if (nextNarrative !== metric.narrative) changed = true;
      return { ...metric, narrative: nextNarrative };
    });

    const toolingHealth = ns.toolingHealth
      ? {
        ...ns.toolingHealth,
        status: this.sanitizeNarrativeText('Tooling Health', ns.toolingHealth.status, report.overallScore, rootInstructionFact),
        items: (ns.toolingHealth.items || []).map(item => {
          const next = this.sanitizeNarrativeText(item.name, item.narrative, report.overallScore, rootInstructionFact);
          if (next !== item.narrative) changed = true;
          return { ...item, narrative: next };
        }),
      }
      : ns.toolingHealth;

    if (ns.toolingHealth?.status && toolingHealth?.status !== ns.toolingHealth.status) {
      changed = true;
    }

    const frictionMap = (ns.frictionMap || []).map(step => {
      const nextNarrative = this.sanitizeNarrativeText('Friction Map', step.narrative, report.overallScore, rootInstructionFact);
      if (nextNarrative !== step.narrative) changed = true;

      const nextActions = (step.actions || []).map(action => {
        const nextAction = this.sanitizeNarrativeText('Friction Action', action.action, report.overallScore, rootInstructionFact);
        const nextImpact = this.sanitizeNarrativeText('Friction Impact', action.impact, report.overallScore, rootInstructionFact);
        if (nextAction !== action.action || nextImpact !== action.impact) changed = true;
        return { ...action, action: nextAction, impact: nextImpact };
      });

      return { ...step, narrative: nextNarrative, actions: nextActions };
    });

    if (!changed) return false;

    report.narrativeSections = {
      platformReadiness,
      toolingHealth: toolingHealth as any,
      frictionMap,
    };

    return true;
  }

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

      // Instruction/Reality Sync — root instruction presence + scoped coverage + skills/tools + path accuracy,
      // blended with deep instructionQuality when available.
      const platformSignals = allSignals.filter(s => platformSignalIdSet.has(s.signalId));

      // Ground truth: verified instruction file presence (derived from multiple verified sources)
      // NOTE: The narrative must reflect the filesystem, not just one signal.
      const rootInstructionFact = this.getRootInstructionFact(report, tool, allSignals);
      const signalGroundTruth = this.buildSignalGroundTruth(allSignals, platformSignalIdSet);

      const realityChecks = platformSignals
        .filter(s => s.realityChecks?.length)
        .flatMap(s => s.realityChecks!);
      const validChecks = realityChecks.filter(r => r.status === 'valid').length;
      const totalChecks = realityChecks.length;
      const instructionSyncScore = calculateInstructionRealitySync(report as ReadinessReport & {
        deepAnalysis?: {
          instructionQuality?: {
            overall?: number;
            accuracy?: number;
            coverage?: number;
          };
          coveragePercent?: number;
        };
      });

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
- Instruction/Reality Sync: Gated metric — 30pt base for primary instruction file + 40pt max path accuracy + 35pt max instruction depth. General docs (README, conventions) give 0-20 credit when no AI instruction files exist. NOT about applyTo patterns.
- Context Efficiency: 60% component coverage (specific mention=100, scoped applyTo=80, global-only=40, absent=0) + 40% token budget. A global copilot-instructions.md gives only 40/100 per component — scoped instructions are needed for high scores. Low score = insufficient or too generic instruction coverage.

Metrics:
${dimensions.map(d => `- ${d.dimension}: ${d.score}/100`).join('\n')}

GROUND TRUTH — VERIFIED SIGNAL DETECTION (filesystem-verified facts — DO NOT contradict these):
${signalGroundTruth}
FACT: Root instruction file ${rootInstructionFact.canonicalPaths.join(', ')} ${rootInstructionFact.present ? `EXISTS${rootInstructionFact.finding ? ` (${rootInstructionFact.finding})` : ''}` : 'DOES NOT EXIST'}.
- Canonical path(s): ${rootInstructionFact.canonicalPaths.join(', ')}
- Status: ${rootInstructionFact.present ? '✅ PRESENT — file is on disk and detected by scanner' : '❌ ABSENT'}
- Detected file(s): ${rootInstructionFact.files.length ? rootInstructionFact.files.join(', ') : '(none)'}

MANDATORY RULES (violation = factual error):
- NEVER use "absence", "missing", "lack", "without", "not found", "not present" about root instruction files that are marked PRESENT above.
- For "Instruction/Reality Sync": your narrative MUST state the file exists if Status is PRESENT.
- For ALL OTHER metrics: do NOT mention root instruction file presence/absence at all — focus on that metric only.

Context:
- Languages: ${report.projectContext.languages.join(', ')}
- Components: ${report.componentScores.slice(0, 8).map(c => `${c.name} (L${c.primaryLevel}, ${c.overallScore}pts)`).join(', ')}
- Reality check: ${validChecks}/${totalChecks} paths verified
- Instruction files: ${report.contextAudit ? `${report.contextAudit.contextEfficiency.totalTokens} tokens (${report.contextAudit.contextEfficiency.budgetPct}% of budget)` : 'unknown'}
- Project type: ${report.projectContext.projectType}${report.projectContext.projectType === 'monorepo' ? ' — scores reflect ROOT-LEVEL config only. Sub-projects with their own .github/ are scored independently.' : ''}
- ${report.levels.flatMap(l => l.signals).filter(s => s.detected).length} signals detected out of ${report.levels.flatMap(l => l.signals).length}

Respond as JSON array:
[{"dimension":"...","narrative":"one specific sentence"}]`;

      const response = await this.client.analyzeFast(prompt);
      const parsed = this.parseJsonArray<{ dimension: string; narrative: string }>(response);

      const narrativeByDimension = new Map(
        (parsed || []).map(item => [item.dimension, item.narrative] as const),
      );

      return dimensions.map(d => {
        const label = d.score >= 75 ? 'excellent' as const : d.score >= 55 ? 'strong' as const : d.score >= 35 ? 'warning' as const : 'critical' as const;

        // Bulletproof: never allow the LLM to override root instruction presence/absence.
        let narrative = d.dimension === 'Instruction/Reality Sync'
          ? this.correctedIQSyncNarrative(
            rootInstructionFact.present,
            rootInstructionFact.files,
            d.score,
            tool,
            rootInstructionFact.canonicalPaths[0],
          )
          : (narrativeByDimension.get(d.dimension) || this.defaultNarrative(d.dimension, d.score));

        narrative = this.sanitizeNarrativeText(d.dimension, narrative, d.score, rootInstructionFact);

        return {
          dimension: d.dimension,
          score: d.score,
          label,
          narrative,
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
      const toolingRootFact = this.getRootInstructionFact(report, tool, signals);
      const prompt = `${expertPrompt}

Assess the tooling ecosystem health for this ${AI_TOOLS[tool].name} project.

FACT: Root instruction file ${toolingRootFact.canonicalPaths.join(', ')} ${toolingRootFact.present ? 'EXISTS (detected on disk)' : 'DOES NOT EXIST'}.
Do NOT claim this file is missing/absent if it EXISTS above.

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
        return {
          status: this.sanitizeNarrativeText('Tooling Health', parsed.status, report.overallScore, toolingRootFact),
          items: parsed.items.map(item => ({
            ...item,
            narrative: this.sanitizeNarrativeText(item.name, item.narrative, report.overallScore, toolingRootFact),
          })),
        };
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
      const frictionRootFact = this.getRootInstructionFact(report, tool, report.levels.flatMap(l => l.signals));
      const prompt = `${expertPrompt}

Create an Architectural Friction Map for upgrading this ${toolConfig.name} project from Level ${report.primaryLevel} (${MATURITY_LEVELS[report.primaryLevel as 1|2|3|4|5|6].name}) to Level ${nextLevel} (${MATURITY_LEVELS[nextLevel as 1|2|3|4|5|6].name}).

Project: ${report.projectName}
Languages: ${report.projectContext.languages.join(', ')}
Components: ${report.componentScores.slice(0, 6).map(c => c.name).join(', ')}

FACT: Root instruction file ${frictionRootFact.canonicalPaths.join(', ')} ${frictionRootFact.present ? 'EXISTS (detected on disk)' : 'DOES NOT EXIST'}.
Do NOT claim this file is missing/absent if it EXISTS above. Do NOT suggest creating it if it already exists.

EXISTING FILES (DO NOT suggest creating these — they already exist):
${[
  ...(report.structureComparison?.expected?.filter((f) => f.exists).map((f) => `✅ ${f.path}`) || []),
  ...(report.levels.flatMap(l => l.signals).filter(s => s.detected).flatMap(s => s.files).filter(Boolean).map(f => `✅ ${f}`)),
].filter((v, i, a) => a.indexOf(v) === i).join('\n') || '(none detected)'}

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
        return parsed.slice(0, 5).map(step => ({
          ...step,
          narrative: this.sanitizeNarrativeText('Friction Map', step.narrative, report.overallScore, frictionRootFact),
          actions: (step.actions || []).map(a => ({
            ...a,
            action: this.sanitizeNarrativeText('Friction Action', a.action, report.overallScore, frictionRootFact),
            impact: this.sanitizeNarrativeText('Friction Impact', a.impact, report.overallScore, frictionRootFact),
          })),
        }));
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
      ['Instruction/Reality Sync', calculateInstructionRealitySync(report as ReadinessReport & {
        deepAnalysis?: {
          instructionQuality?: {
            overall?: number;
            accuracy?: number;
            coverage?: number;
          };
          coveragePercent?: number;
        };
      })],
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

  // ── Ground truth & narrative validation ──

  private getCanonicalRootInstructionPaths(tool: AITool): string[] {
    // Keep aligned with instructionRealitySync.ts rootFiles, but duplicated here.
    switch (tool) {
      case 'copilot': return ['.github/copilot-instructions.md'];
      case 'cline': return ['.clinerules/default-rules.md'];
      case 'cursor': return ['.cursorrules'];
      case 'claude': return ['CLAUDE.md', '.claude/CLAUDE.md'];
      case 'roo': return ['.roorules', '.roomodes'];
      case 'windsurf': return ['AGENTS.md'];
      case 'aider': return ['.aider.conf.yml'];
      default: return ['.github/copilot-instructions.md'];
    }
  }

  private getRootInstructionFact(
    report: ReadinessReport,
    tool: AITool,
    allSignals: SignalResult[],
  ): { present: boolean; files: string[]; canonicalPaths: string[]; finding: string } {
    const canonicalPaths = this.getCanonicalRootInstructionPaths(tool);
    const canonicalNorm = new Set(canonicalPaths.map(p => this.normalizePathLike(p)));

    // Source 1: primary/root signal(s) for this platform, including synthetic aliases
    const rootSignalIds = this.getRootSignalIds(tool);
    const rootSignalNorm = new Set(rootSignalIds.map(id => this.normalizePathLike(id)));
    const rootSignals = allSignals.filter(s => rootSignalIds.includes(s.signalId));
    const signalPresent = rootSignals.some(s => s.detected);
    const signalFiles = rootSignals
      .filter(s => s.detected)
      .flatMap(s => s.files ?? []);

    // Source 2: any signal whose detected files match a canonical root path
    const fileMatchSignals = allSignals.filter(s =>
      s.detected && s.files?.some(f => canonicalPaths.includes(f)),
    );
    const fileMatchPresent = fileMatchSignals.length > 0;
    const fileMatchFiles = fileMatchSignals.flatMap(s => s.files ?? []).filter(f => canonicalPaths.includes(f));

    // Source 3: structureComparison existence checks (also filesystem-verified)
    const scMatches = (report.structureComparison?.expected ?? [])
      .filter(e => e.exists)
      .filter(e => canonicalPaths.includes(e.path) || (e.actualPath ? canonicalPaths.includes(e.actualPath) : false));
    const scFiles = scMatches.map(e => e.actualPath || e.path).filter(Boolean);

    // Source 4: knowledge graph signal/file nodes (used by graph export flow)
    const kgNodes = this.getKnowledgeGraphNodes(report);
    const kgSignalNodes = kgNodes.filter(node =>
      node.type === 'signal' && (
        rootSignalNorm.has(this.normalizePathLike(node.label))
        || rootSignalNorm.has(this.normalizePathLike((node.id || '').replace(/^signal-/, '')))
      ),
    );
    const kgSignalPresent = kgSignalNodes.some(node => this.getNodeDetected(node.properties));
    const kgSignalFiles = kgSignalNodes.flatMap(node => this.getNodeFiles(node.properties));

    const kgFileNodes = kgNodes.filter(node => {
      if (node.type !== 'ai-file') return false;
      const normalizedLabel = this.normalizePathLike(node.label);
      const normalizedId = this.normalizePathLike((node.id || '').replace(/^file-/, ''));
      return canonicalNorm.has(normalizedLabel) || canonicalNorm.has(normalizedId);
    });
    const kgFileFiles = kgFileNodes
      .map(node => {
        const labelNorm = this.normalizePathLike(node.label);
        if (canonicalNorm.has(labelNorm)) return node.label;
        const idNorm = this.normalizePathLike((node.id || '').replace(/^file-/, ''));
        return canonicalPaths.find(p => this.normalizePathLike(p) === idNorm) || '';
      })
      .filter(Boolean);

    const present =
      signalPresent
      || fileMatchPresent
      || scMatches.length > 0
      || kgSignalPresent
      || kgFileNodes.length > 0;
    const files = [...new Set([
      ...signalFiles,
      ...fileMatchFiles,
      ...scFiles,
      ...kgSignalFiles,
      ...kgFileFiles,
      ...(present ? canonicalPaths : []),
    ])].filter(Boolean);

    // Extract finding text (may include file size) from the first detected root signal
    const finding = rootSignals.find(s => s.detected)?.finding
      || fileMatchSignals[0]?.finding
      || kgSignalNodes.find(n => this.getNodeDetected(n.properties))?.description
      || '';

    return { present, files, canonicalPaths, finding };
  }

  private getKnowledgeGraphNodes(report: ReadinessReport): Array<{ id: string; type: string; label: string; description?: string; properties?: Record<string, unknown> }> {
    const graph = report.knowledgeGraph as { nodes?: unknown } | undefined;
    if (!graph || !Array.isArray(graph.nodes)) return [];
    return graph.nodes
      .filter((n): n is { id?: unknown; type?: unknown; label?: unknown; description?: unknown; properties?: unknown } => !!n && typeof n === 'object')
      .map(n => ({
        id: typeof n.id === 'string' ? n.id : '',
        type: typeof n.type === 'string' ? n.type : '',
        label: typeof n.label === 'string' ? n.label : '',
        description: typeof n.description === 'string' ? n.description : undefined,
        properties: n.properties && typeof n.properties === 'object' ? n.properties as Record<string, unknown> : undefined,
      }));
  }

  private getNodeDetected(properties?: Record<string, unknown>): boolean {
    const raw = properties?.detected;
    return raw === true || raw === 1 || raw === 'true';
  }

  private getNodeFiles(properties?: Record<string, unknown>): string[] {
    const files = properties?.files;
    return Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [];
  }

  private normalizePathLike(value: string | undefined): string {
    return (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private sanitizeNarrativeText(
    dimension: string,
    narrative: string,
    score: number,
    rootInstructionFact: { present: boolean; files: string[]; canonicalPaths: string[] },
  ): string {
    if (rootInstructionFact.present && this.containsRootAbsenceClaim(narrative)) {
      logger.warn(
        `NarrativeGenerator: narrative contradicts ground truth — root instruction file EXISTS (${rootInstructionFact.files.join(', ')}) ` +
        `but narrative claims absence (dimension: ${dimension}). Patching.`
      );
      return dimension === 'Instruction/Reality Sync'
        ? this.correctedIQSyncNarrative(true, rootInstructionFact.files, score)
        : this.correctedNonIQNarrative(dimension, score, rootInstructionFact, 'present');
    }

    if (!rootInstructionFact.present && this.containsRootPresenceClaim(narrative)) {
      logger.warn(
        `NarrativeGenerator: narrative contradicts ground truth — root instruction file NOT detected (${rootInstructionFact.canonicalPaths.join(', ')}) ` +
        `but narrative claims presence (dimension: ${dimension}). Patching.`
      );
      return dimension === 'Instruction/Reality Sync'
        ? this.correctedIQSyncNarrative(false, [], score)
        : this.correctedNonIQNarrative(dimension, score, rootInstructionFact, 'absent');
    }

    return narrative;
  }

  private correctedNonIQNarrative(
    dimension: string,
    score: number,
    rootInstructionFact: { present: boolean; files: string[]; canonicalPaths: string[] },
    status: 'present' | 'absent',
  ): string {
    const base = this.defaultNarrative(dimension, score).replace(/\.$/, '');
    const fileDesc = rootInstructionFact.files.length
      ? rootInstructionFact.files.join(', ')
      : rootInstructionFact.canonicalPaths.join(', ');

    if (status === 'present') {
      return `${base}; root instruction file (${fileDesc}) is present.`;
    }
    return `${base}; no root instruction file detected (expected ${rootInstructionFact.canonicalPaths.join(', ')}).`;
  }

  /** Map tool to root instruction signal IDs, including synthetic aliases */
  private getRootSignalIds(tool: AITool): string[] {
    const map: Record<AITool, string[]> = {
      copilot: ['copilot_instructions', 'copilot_l2_instructions'],
      cline: ['cline_rules', 'cline_l2_instructions'],
      cursor: ['cursor_rules', 'cursor_l2_instructions'],
      claude: ['claude_instructions', 'claude_l2_instructions'],
      roo: ['roo_modes', 'roo_l2_instructions'],
      windsurf: ['windsurf_rules', 'windsurf_l2_instructions', 'agents_md'],
      aider: ['aider_config', 'aider_l2_instructions'],
    };
    return map[tool] || ['copilot_instructions', 'copilot_l2_instructions'];
  }

  /** Build a ground truth summary of detected/missing instruction signals */
  private buildSignalGroundTruth(allSignals: SignalResult[], platformSignalIdSet: Set<string>): string {
    const lines: string[] = [];
    for (const signal of allSignals) {
      if (!platformSignalIdSet.has(signal.signalId)) continue;
      const status = signal.detected ? '✅ DETECTED (EXISTS)' : '❌ NOT DETECTED';
      const files = signal.files?.length ? ` — files: ${signal.files.join(', ')}` : '';
      lines.push(`  ${signal.signalId}: ${status}${files}`);
    }
    return lines.join('\n') || '  (no platform signals found)';
  }

  /**
   * Post-validate IQ Sync narrative against signal ground truth.
   * If the LLM claims the root instruction file is absent when it actually exists
   * (or vice versa), replace with a deterministic, factually correct narrative.
   */
  public validateIQSyncNarrative(
    narratives: { dimension: string; narrative: string }[] | null,
    rootInstructionDetected: boolean,
    rootInstructionFiles: string[],
    iqSyncScore: number,
  ): { dimension: string; narrative: string }[] | null {
    if (!narratives) return null;

    return narratives.map(n => {
      if (n.dimension !== 'Instruction/Reality Sync') return n;

      if (rootInstructionDetected && this.containsRootAbsenceClaim(n.narrative)) {
        logger.warn(
          'NarrativeGenerator: IQ Sync narrative contradicts ground truth — ' +
          `root instruction file EXISTS (${rootInstructionFiles.join(', ')}) ` +
          'but narrative claims absence. Replacing with corrected narrative.'
        );
        return {
          ...n,
          narrative: this.correctedIQSyncNarrative(true, rootInstructionFiles, iqSyncScore),
        };
      }

      if (!rootInstructionDetected && this.containsRootPresenceClaim(n.narrative)) {
        logger.warn(
          'NarrativeGenerator: IQ Sync narrative contradicts ground truth — ' +
          'root instruction file NOT detected but narrative claims presence. Replacing.'
        );
        return {
          ...n,
          narrative: this.correctedIQSyncNarrative(false, [], iqSyncScore),
        };
      }

      return n;
    });
  }


  /** Check if narrative claims the root instruction file is absent/missing */
  containsRootAbsenceClaim(narrative: string): boolean {
    const lower = narrative.toLowerCase();
    // Fast path: skip if no instruction-related keyword is present
    const keywords = ['instruction', 'copilot-instructions', 'copilot_instructions',
      '.clinerules', '.cursorrules', 'claude.md', 'agents.md', '.aider'];
    if (!keywords.some(k => lower.includes(k))) return false;

    const rootPresenceKeywords = /\b(?:present|exists|found|detected|provides|available|well-structured|solid|strong|in\s+place)\b/i;
    const scopedGapKeywords = /\b(?:scoped|component(?:-level)?|individual\s+components?|specific\s+directories?|submodules?|sub-projects?)\b/i;

    // Valid pattern: root instruction exists, but scoped/component guidance is missing.
    if (rootPresenceKeywords.test(narrative) && scopedGapKeywords.test(narrative)) {
      return false;
    }

    // ── Prong 1: Keyword overlap ──
    // If the narrative contains BOTH a negative keyword AND an instruction-file reference,
    // the LLM is claiming absence regardless of exact phrasing.
    const negativeKeywords = /\b(?:absence|absent|lack\b|lacking|lacks|missing|not\s+found|without|no\s+root|does\s+not|doesn't|no\s+dedicated|not\s+present|not\s+detected|not\s+configured|not\s+available|unavailable|not\s+been|not\s+include|not\s+have|not\s+contain|no\s+root-level|currently\s+no|there\s+is\s+no|has\s+no|no\s+main|no\s+primary|not\s+having|never\s+been|yet\s+to\s+be)\b/i;
    const instructionFileRef = /(?:copilot-instructions|instructions\.md|root(?:-level)?\s+instruction(?:\s+file)?|primary\s+instruction(?:\s+file)?|main\s+instruction(?:\s+file)?|\.github\/copilot)/i;
    if (negativeKeywords.test(narrative) && instructionFileRef.test(narrative)) {
      return true;
    }

    // ── Prong 2: Consequence patterns ──
    // "absence/lack of X prevents/limits/hinders Y" — catches indirect claims
    const consequencePattern = /(?:absence|absent|lack(?:ing)?|missing|without)\s+(?:of\s+)?(?:a\s+)?(?:root\s+)?(?:\.github\/)?(?:copilot-instructions|instructions\.md|instruction\s+file)[^.]*?(?:prevents?|limits?|hinders?|blocks?|weakens?|reduces?|impairs?)/i;
    if (consequencePattern.test(narrative)) {
      return true;
    }

    // ── Prong 3: Negation patterns ──
    // "not" + state verb + instruction-related noun
    const negationPatterns = [
      /\bnot\s+(?:been\s+)?(?:configured|set\s*up|present|detected|found|created|established|available)\b[^.]*?(?:copilot|instruction)/i,
      /(?:copilot|instruction)[^.]*?\bnot\s+(?:been\s+)?(?:configured|set\s*up|present|detected|found|created|established|available)\b/i,
      /\bno\s+(?:main|primary|root)(?:-level)?\s+instruction(?:\s+file)?\b[^.]*?(?:set\s*up|configured|present|available)?/i,
      /\bno\s+copilot-instructions(?:\.md)?\b[^.]*?(?:set\s*up|configured|present|available|created|established|found|detected)?/i,
      /\blacks?\b[^.]*?(?:copilot|instruction)/i,
    ];
    if (negationPatterns.some(p => p.test(narrative))) {
      return true;
    }

    return false;
  }

  /** Check if narrative claims root instruction file exists when it doesn't */
  private containsRootPresenceClaim(narrative: string): boolean {
    const lower = narrative.toLowerCase();
    if ((lower.includes('not ') || lower.includes('missing') || lower.includes('absent') || lower.includes('no '))
      && !/\b(?:root|primary|main)\s+instruction(?:\s+file)?\s+(?:provides|is\s+present|exists|found|detected|available|well-structured|solid|strong|in\s+place)/i.test(narrative)) {
      return false;
    }
    return /(?:root|primary|main)\s+instruction(?:\s+file)?\s+(?:is\s+)?(?:present|exists|detected|found|available|provides|well-structured|solid|strong|in\s+place)/i.test(narrative);
  }

  /** Generate a deterministic, factually correct IQ Sync narrative */
  private correctedIQSyncNarrative(
    exists: boolean,
    files: string[],
    score: number,
    tool: AITool = 'copilot',
    canonicalPath?: string,
  ): string {
    const toolName = AI_TOOLS[tool]?.name ?? tool;
    const path = canonicalPath || files[0] || this.getCanonicalRootInstructionPaths(tool)[0] || 'root instruction file';
    if (exists) {
      const anchor = `The root ${path} provides foundational context for ${toolName}.`;
      if (score >= 75) return `${anchor} Verified paths and strong instruction depth keep guidance closely aligned with the codebase.`;
      if (score >= 55) return `${anchor} Additional scoped instructions or cleaner path references would strengthen alignment further.`;
      if (score >= 35) return `${anchor} More scoped coverage and better path accuracy are needed to keep agents consistently grounded.`;
      return `${anchor} Limited depth and weak path coverage still make alignment fragile for day-to-day agent work.`;
    }
    const anchor = `The absence of a root ${path} limits ${toolName}'s alignment.`;
    if (score >= 20) return `${anchor} General documentation helps somewhat, but a dedicated instruction file would ground agents more reliably.`;
    return `${anchor} Creating that file is the highest-impact step to improve grounded agent behavior.`;
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

/**
 * Reusable narrative fact-checker.
 * Validates ANY narrative text against structural signals and replaces factual
 * contradictions with corrected versions.
 *
 * Signal-based rules:
 *  - If a signal is `detected: true` but the narrative claims it is absent/missing → correct
 *  - If a signal is `detected: false` but the narrative claims it exists → correct
 */
export function validateNarrativeAgainstSignals(narrative: string, signals: SignalResult[]): string {
  if (!narrative || !signals?.length) return narrative;

  const gen = new NarrativeGenerator(null as any); // only uses non-LLM helpers

  let result = narrative;

  for (const signal of signals) {
    const fileRef = signal.files?.[0] ?? signal.signalId;

    if (signal.detected && gen.containsRootAbsenceClaim(result)) {
      // Signal detected but narrative claims absence → patch
      result = result.replace(
        // Replace the contradicting sentence
        /[^.]*(?:absence|absent|lack(?:ing)?|missing|not\s+found|without|no\s+root|does\s+not|doesn't|not\s+present|not\s+detected|not\s+configured|not\s+available|unavailable)[^.]*(?:copilot-instructions|instructions\.md|root\s+instruction|primary\s+instruction|main\s+instruction)[^.]*/i,
        `The root instruction file (${fileRef}) is present and detected`,
      );
      // Also try the reverse word-order (instruction ref appears first)
      result = result.replace(
        /[^.]*(?:copilot-instructions|instructions\.md|root\s+instruction|primary\s+instruction|main\s+instruction)[^.]*(?:absence|absent|lack(?:ing)?|missing|not\s+found|without|no\s+root|does\s+not|doesn't|not\s+present|not\s+detected|not\s+configured|not\s+available|unavailable)[^.]*/i,
        `The root instruction file (${fileRef}) is present and detected`,
      );
    }
  }

  return result;
}
