import { LevelScore, MaturityLevel, MATURITY_LEVELS, ReadinessReport, ProjectContext, ComponentScore, LanguageScore, SignalResult, AITool, AI_TOOLS, RealityCheckRef } from './types';

// ─── Confidence Multipliers ─────────────────────────────────────
const CONFIDENCE_MULTIPLIER: Record<string, number> = {
  high: 1.00,
  medium: 0.85,
  low: 0.65,
};

// ─── Signal Classification per Platform ─────────────────────────
type SignalClass = 'critical' | 'required' | 'recommended';

const PLATFORM_SIGNAL_CLASS: Record<string, Record<string, SignalClass>> = {
  copilot: {
    copilot_instructions: 'critical', copilot_domain_instructions: 'required',
    project_structure_doc: 'required', conventions_documented: 'required',
    copilot_agents: 'critical', copilot_skills: 'required',
    mcp_config: 'required', instruction_accuracy: 'critical',
    copilot_cli_instructions: 'recommended', ignore_files: 'recommended',
    post_task_instructions: 'required', session_management: 'recommended',
    agent_workflows: 'required', doc_update_instructions: 'recommended',
    memory_bank_update: 'recommended', memory_bank_accuracy: 'recommended',
  },
  cline: {
    cline_rules: 'critical', cline_domains: 'required',
    project_structure_doc: 'required', conventions_documented: 'required',
    ignore_files: 'required', memory_bank: 'critical',
    safe_commands: 'critical', tool_definitions: 'required',
    mcp_config: 'required', instruction_accuracy: 'critical',
    agent_workflows: 'critical', session_management: 'required',
    post_task_instructions: 'required', memory_bank_update: 'critical',
    memory_bank_accuracy: 'critical', long_term_memory: 'required',
    short_term_memory: 'required', doc_update_instructions: 'required',
  },
  cursor: {
    cursor_rules: 'critical', project_structure_doc: 'required',
    conventions_documented: 'required', ignore_files: 'required',
    instruction_accuracy: 'critical', mcp_config: 'recommended',
    post_task_instructions: 'recommended', doc_update_instructions: 'recommended',
  },
  claude: {
    claude_instructions: 'critical', project_structure_doc: 'required',
    conventions_documented: 'required', instruction_accuracy: 'critical',
    post_task_instructions: 'required', doc_update_instructions: 'required',
  },
  roo: {
    roo_modes: 'critical', project_structure_doc: 'required',
    conventions_documented: 'required', agent_personas: 'required',
    tool_definitions: 'required', instruction_accuracy: 'critical',
    post_task_instructions: 'recommended',
  },
  windsurf: {
    windsurf_rules: 'critical', agents_md: 'required',
    project_structure_doc: 'required', instruction_accuracy: 'critical',
    post_task_instructions: 'recommended',
  },
  aider: {
    aider_config: 'critical', ignore_files: 'required',
    project_structure_doc: 'recommended', instruction_accuracy: 'required',
  },
};

// ─── Dimension Weights per Platform ─────────────────────────────
interface DimensionWeights {
  presence: number;
  quality: number;
  operability: number;
  breadth: number;
}

const PLATFORM_DIMENSION_WEIGHTS: Record<string, DimensionWeights> = {
  copilot:  { presence: 0.20, quality: 0.40, operability: 0.15, breadth: 0.25 },
  cline:    { presence: 0.15, quality: 0.30, operability: 0.30, breadth: 0.25 },
  cursor:   { presence: 0.25, quality: 0.45, operability: 0.10, breadth: 0.20 },
  claude:   { presence: 0.15, quality: 0.50, operability: 0.10, breadth: 0.25 },
  roo:      { presence: 0.20, quality: 0.30, operability: 0.25, breadth: 0.25 },
  windsurf: { presence: 0.25, quality: 0.35, operability: 0.15, breadth: 0.25 },
  aider:    { presence: 0.40, quality: 0.30, operability: 0.10, breadth: 0.20 },
};

// ─── Component Type Importance Weights ──────────────────────────
export const DEFAULT_COMPONENT_TYPE_WEIGHTS: Record<string, number> = {
  service: 1.0,
  app: 1.0,
  library: 0.9,
  infra: 0.6,
  config: 0.4,
  script: 0.5,
  data: 0.3,
  generated: 0,
  unknown: 0.5,
};

// ─── Level Thresholds per Platform ──────────────────────────────
const PLATFORM_THRESHOLDS: Record<string, Record<number, { self: number; previous?: number }>> = {
  copilot:  { 1: { self: 0 }, 2: { self: 35 }, 3: { self: 40, previous: 40 }, 4: { self: 45, previous: 45 }, 5: { self: 50, previous: 50 }, 6: { self: 55, previous: 55 } },
  cline:    { 1: { self: 0 }, 2: { self: 30 }, 3: { self: 35, previous: 35 }, 4: { self: 40, previous: 40 }, 5: { self: 45, previous: 45 }, 6: { self: 55, previous: 50 } },
  cursor:   { 1: { self: 0 }, 2: { self: 35 }, 3: { self: 40, previous: 40 }, 4: { self: 50, previous: 45 }, 5: { self: 60, previous: 55 }, 6: { self: 70, previous: 65 } },
  claude:   { 1: { self: 0 }, 2: { self: 40 }, 3: { self: 45, previous: 45 }, 4: { self: 50, previous: 50 }, 5: { self: 55, previous: 55 }, 6: { self: 60, previous: 60 } },
  roo:      { 1: { self: 0 }, 2: { self: 30 }, 3: { self: 40, previous: 40 }, 4: { self: 45, previous: 45 }, 5: { self: 50, previous: 50 }, 6: { self: 55, previous: 55 } },
  windsurf: { 1: { self: 0 }, 2: { self: 35 }, 3: { self: 40, previous: 40 }, 4: { self: 50, previous: 45 }, 5: { self: 55, previous: 55 }, 6: { self: 60, previous: 60 } },
  aider:    { 1: { self: 0 }, 2: { self: 25 }, 3: { self: 40, previous: 35 }, 4: { self: 55, previous: 50 }, 5: { self: 65, previous: 60 }, 6: { self: 75, previous: 70 } },
};

// Map signal categories to dimensions
const CATEGORY_TO_DIMENSION: Record<string, keyof DimensionWeights> = {
  'file-presence': 'presence',
  'content-quality': 'quality',
  'depth': 'breadth',
};

// Map signal IDs to operability dimension (overrides category mapping)
const OPERABILITY_SIGNALS = new Set([
  'safe_commands', 'tool_definitions', 'mcp_config', 'workflow_verification',
  'error_recovery', 'workflow_tool_refs', 'agent_governance',
]);

const CLASS_WEIGHTS: Record<SignalClass, number> = {
  critical: 3.0,
  required: 2.0,
  recommended: 1.0,
};

// ─── Anti-Pattern Penalties (Multiplier-Based) ──────────────────
interface AntiPattern {
  id: string;
  multiplier: number;           // e.g. 0.93 = 7% penalty
  levels: number[];             // which levels this applies to directly
  cascadeTo?: number[];         // cascade to higher levels at reduced strength
  cascadeMultiplier?: number;   // multiplier when cascading (e.g. 0.97)
  description: string;
  check: (signals: SignalResult[]) => boolean;
}

// AP multipliers stack via product (they compound), floored at 0.70
// Combined with gates: max(gate × AP, 0.40)
const ANTI_PATTERNS: AntiPattern[] = [
  // L1: Codebase quality
  {
    id: 'no_type_hints',
    multiplier: 0.95,
    levels: [1],
    description: 'Application code has near-zero type annotations — agents cannot resolve cross-file references via LSP',
    check: (signals) => signals.some(s =>
      s.signalId === 'codebase_type_strictness' && s.detected && s.score < 10
    ),
  },
  // L2-L3: Instruction quality
  {
    id: 'stale_content',
    multiplier: 0.93,
    levels: [2, 3],
    cascadeTo: [4, 5],
    cascadeMultiplier: 0.97,
    description: 'Instruction files reference paths or commands that do not exist — agents will hallucinate',
    check: (signals) => signals.some(s =>
      s.detected && s.realityChecks?.filter(r => r.status === 'invalid').length
        ? (s.realityChecks!.filter(r => r.status === 'invalid').length >= 2)
        : false
    ),
  },
  {
    id: 'generic_boilerplate',
    multiplier: 0.96,
    levels: [2, 3],
    description: 'Instruction file exists but contains only generic/placeholder content — worse than no file',
    check: (signals) => signals.some(s =>
      s.detected && s.score < 20 && s.confidence === 'high'
    ),
  },
  // L3+: Business logic
  {
    id: 'contradictory_content',
    multiplier: 0.89,
    levels: [3, 4, 5],
    cascadeTo: [6],
    cascadeMultiplier: 0.89,
    description: 'Instructions claim X but code does Y — agents will generate wrong code',
    check: (signals) => signals.some(s =>
      s.businessFindings?.some(f => f.startsWith('❌'))
    ),
  },
  // L4+: Workflow safety
  {
    id: 'unsafe_workflow',
    multiplier: 0.92,
    levels: [4, 5],
    cascadeTo: [6],
    cascadeMultiplier: 0.92,
    description: 'Workflows reference tools without safe-command guardrails — agents may execute destructive operations',
    check: (signals) => {
      const hasWorkflows = signals.some(s => s.signalId.includes('workflow') && s.detected);
      const hasSafeCommands = signals.some(s => s.signalId === 'safe_commands' && s.detected);
      return hasWorkflows && !hasSafeCommands;
    },
  },
];

const AP_PRODUCT_FLOOR = 0.70;
const COMBINED_PENALTY_FLOOR = 0.40;

// ─── Main Engine ────────────────────────────────────────────────
export class MaturityEngine {
  
  calculateReport(
    projectName: string,
    levels: LevelScore[],
    projectContext: ProjectContext,
    componentScores: ComponentScore[],
    languageScores: LanguageScore[],
    modelUsed: string,
    scanMode: 'full' | 'quick',
    selectedTool: AITool
  ): ReadinessReport {
    const toolKey = selectedTool as string;
    const thresholds = PLATFORM_THRESHOLDS[toolKey] || PLATFORM_THRESHOLDS['copilot'];

    // 1. Apply gating with platform-specific thresholds
    if (levels.length === 0) {
      levels = [{ level: 1 as MaturityLevel, name: 'Prompt-Only', rawScore: 0, signalsDetected: 0, signalsTotal: 0, signals: [], qualified: false }];
    }
    levels[0].qualified = true;
    for (let i = 1; i < levels.length; i++) {
      const levelNum = (i + 1) as MaturityLevel;
      const thresh = thresholds[levelNum] || { self: 50 };
      const meetsOwn = levels[i].rawScore >= thresh.self;
      const meetsPrevious = !thresh.previous || levels[i - 1].rawScore >= (thresh.previous ?? 0);
      // Require minimum signal detection rate for higher levels
      // L2-L3: at least 1 signal detected. L4+: at least 2 signals or 50% of total.
      const detected = levels[i].signalsDetected;
      const total = levels[i].signalsTotal;
      const minSignals = levelNum >= 4 ? Math.max(2, Math.ceil(total * 0.3)) : 1;
      const meetsMinSignals = detected >= minSignals;
      levels[i].qualified = meetsOwn && meetsPrevious && meetsMinSignals && levels[i - 1].qualified;
    }

    // 2. Primary level = highest qualified
    let primaryLevel: MaturityLevel = 1;
    for (const level of levels) {
      if (level.qualified) primaryLevel = level.level;
    }

    // 2b. Monorepo root correction: base primary level on root-level signals only.
    // In monorepos, workspace-wide signal detection may find files in sub-projects,
    // inflating the root's level. Require critical signals to be actually detected
    // at each qualified level for the root to claim that level.
    if (projectContext.projectType === 'monorepo') {
      const signalClasses = PLATFORM_SIGNAL_CLASS[toolKey] || {};
      const subProjectPaths = this.collectMonorepoSubProjectPaths(projectContext, levels);

      let monorepoLevel: MaturityLevel = 1;
      for (let i = 1; i < levels.length; i++) {
        if (!levels[i].qualified) break;
        const criticalSignals = levels[i].signals.filter(s =>
          signalClasses[s.signalId] === 'critical'
        );
        // Critical signals must be detected AND their files must be at root, not inside sub-projects
        if (criticalSignals.length > 0) {
          const rootDetected = criticalSignals.every(s => {
            if (!s.detected) return false;
            // If signal has files, at least one must NOT be inside a sub-project
            if (s.files && s.files.length > 0) {
              return s.files.some(f => !([...subProjectPaths].some(sp => f.startsWith(sp + '/'))));
            }
            return true; // codebase signals (no files) pass through
          });
          if (!rootDetected) break;
        }
        const detected = levels[i].signals.filter(s => s.detected).length;
        const total = levels[i].signals.length;
        const minSignals = levels[i].level >= 4 ? Math.max(2, Math.ceil(total * 0.3)) : 1;
        if (total > 0 && detected < minSignals) {
          break;
        }
        monorepoLevel = levels[i].level;
      }
      primaryLevel = monorepoLevel;
    }

    // 3. EGDR Depth calculation
    const primaryLevelScore = levels[primaryLevel - 1].rawScore;
    
    // Next-level support bonus
    let nextSupport = 0;
    if (primaryLevel < 6) {
      const nextThresh = thresholds[primaryLevel + 1]?.self ?? 50;
      const nextScore = levels[primaryLevel]?.rawScore ?? 0;
      nextSupport = Math.min(10, Math.max(0, (nextScore - nextThresh * 0.5) * 0.25));
    }

    // Stability penalty (arithmetic - harmonic gap)
    const primarySignals = levels[primaryLevel - 1].signals;
    const effectiveScores = primarySignals
      .filter(s => s.detected)
      .map(s => this.effectiveScore(s));
    
    let stabilityPenalty = 0;
    if (effectiveScores.length >= 2) {
      const arith = effectiveScores.reduce((a, b) => a + b, 0) / effectiveScores.length;
      const harm = this.harmonicMean(effectiveScores);
      stabilityPenalty = Math.min(12, Math.max(0, (arith - harm) * 0.35));
    }

    const depth = Math.max(0, Math.min(99, Math.round(
      primaryLevelScore + nextSupport - stabilityPenalty
    )));

    // 4. Overall score (base)
    const baseOverallScore = Math.round(((primaryLevel - 1 + depth / 100) / 6) * 100);

    // 5. Apply component type weights to adjust score
    let overallScore = baseOverallScore;
    // For monorepo roots, don't blend with sub-project component scores —
    // the root's score should reflect its own signals only
    if (componentScores.length > 0 && projectContext.projectType !== 'monorepo') {
      let typeWeights: Record<string, number> = { ...DEFAULT_COMPONENT_TYPE_WEIGHTS };
      try {
        const vscode = require('vscode');
        const userTypeWeights = vscode.workspace.getConfiguration('ai-readiness').get('componentTypeWeights') as Record<string, number> | undefined;
        if (userTypeWeights && Object.keys(userTypeWeights).length > 0) {
          typeWeights = { ...typeWeights, ...userTypeWeights };
        }
      } catch { /* running outside vscode */ }

      let weightedSum = 0;
      let totalWeight = 0;
      for (const comp of componentScores) {
        const baseWeight = typeWeights[comp.type] ?? typeWeights['unknown'] ?? 0.5;
        // Generated components use the 'generated' type weight (default 0, configurable)
        let w = comp.isGenerated ? (typeWeights['generated'] ?? 0) : baseWeight;
        if (w === 0) continue; // Skip zero-weight components entirely
        // Dotfile config dirs (.vscode, .github, .clinerules, etc.) get minimal weight
        if (comp.type === 'config' && comp.path.startsWith('.')) w = Math.min(w, 0.15);
        // Virtual group nodes get reduced weight (they're synthetic)
        if (comp.path.includes('.group-')) w = Math.min(w, 0.2);
        weightedSum += comp.overallScore * w;
        totalWeight += w;
      }
      const weightedComponentAvg = totalWeight > 0 ? weightedSum / totalWeight : 0;
      // Blend: 70% signal-based score + 30% component-weighted average
      overallScore = Math.round(baseOverallScore * 0.7 + weightedComponentAvg * 0.3);
    }

    return {
      projectName,
      scannedAt: new Date().toISOString(),
      primaryLevel,
      levelName: MATURITY_LEVELS[primaryLevel].name,
      depth,
      overallScore,
      levels,
      componentScores,
      languageScores,
      projectContext,
      selectedTool: selectedTool,
      modelUsed,
      scanMode,
    };
  }

  calculateLevelScore(level: MaturityLevel, signals: SignalResult[], selectedTool?: AITool): LevelScore {
    const levelSignals = signals.filter(s => s.level === level);
    if (levelSignals.length === 0) {
      return {
        level,
        name: MATURITY_LEVELS[level].name,
        rawScore: 0,
        qualified: false,
        signals: [],
        signalsDetected: 0,
        signalsTotal: 0,
      };
    }

    const toolKey = (selectedTool || 'copilot') as string;
    const signalClasses = PLATFORM_SIGNAL_CLASS[toolKey] || {};
    const platformDimWeights = PLATFORM_DIMENSION_WEIGHTS[toolKey] || PLATFORM_DIMENSION_WEIGHTS['copilot'];
    
    // Merge user dimension weight overrides (if available via vscode settings)
    let dimWeights = platformDimWeights;
    try {
      const vscode = require('vscode');
      const userDimWeights = vscode.workspace.getConfiguration('ai-readiness').get('dimensionWeights') as Partial<DimensionWeights> | undefined;
      if (userDimWeights && Object.keys(userDimWeights).length > 0) {
        dimWeights = { ...platformDimWeights, ...userDimWeights };
        // Normalize to sum to 1.0
        const total = dimWeights.presence + dimWeights.quality + dimWeights.operability + dimWeights.breadth;
        if (total > 0 && Math.abs(total - 1.0) > 0.01) {
          dimWeights = {
            presence: dimWeights.presence / total,
            quality: dimWeights.quality / total,
            operability: dimWeights.operability / total,
            breadth: dimWeights.breadth / total,
          };
        }
      }
    } catch { /* running outside vscode (tests) — use platform defaults */ }

    const detected = levelSignals.filter(s => s.detected);

    // ── Stage 1: Compute effective scores ──
    const effectiveSignals = levelSignals.map(s => ({
      signal: s,
      effective: s.detected ? this.effectiveScore(s) : 0,
      dimension: this.signalDimension(s),
      classification: signalClasses[s.signalId] || this.inferClassification(s),
    }));

    // (Quality gates moved to Stage 5 — after anti-pattern detection, to avoid double-counting)

    // ── Stage 3: Dimension scores (proper weighted average, no duplication) ──
    const dimAccum: Record<keyof DimensionWeights, { weightedSum: number; totalWeight: number }> = {
      presence: { weightedSum: 0, totalWeight: 0 },
      quality: { weightedSum: 0, totalWeight: 0 },
      operability: { weightedSum: 0, totalWeight: 0 },
      breadth: { weightedSum: 0, totalWeight: 0 },
    };

    for (const es of effectiveSignals) {
      const classWeight = CLASS_WEIGHTS[es.classification];
      const dim = es.dimension;
      dimAccum[dim].weightedSum += es.effective * classWeight;
      dimAccum[dim].totalWeight += classWeight;
    }

    // Compute per-dimension weighted averages
    const dimScores: Record<keyof DimensionWeights, number> = {
      presence: 0, quality: 0, operability: 0, breadth: 0,
    };
    for (const [dim, acc] of Object.entries(dimAccum) as [keyof DimensionWeights, { weightedSum: number; totalWeight: number }][]) {
      dimScores[dim] = acc.totalWeight > 0
        ? acc.weightedSum / acc.totalWeight
        : -1; // -1 = no signals for this dimension
    }

    // ── Stage 4: Arithmetic-dominant blend (harmonic at 35% to catch extremes without crushing) ──
    const activeDims = (Object.entries(dimScores) as [keyof DimensionWeights, number][])
      .filter(([_, v]) => v >= 0);
    
    if (activeDims.length === 0) {
      return {
        level, name: MATURITY_LEVELS[level].name,
        rawScore: 0, qualified: false,
        signals: levelSignals, signalsDetected: detected.length, signalsTotal: levelSignals.length,
      };
    }

    // Normalize dimension weights to only active dimensions
    const totalActiveWeight = activeDims.reduce((s, [d]) => s + dimWeights[d], 0);
    
    const weightedArith = activeDims.reduce((s, [d, v]) => s + v * (dimWeights[d] / totalActiveWeight), 0);
    
    // Harmonic mean with floor of 10 to prevent near-zero blowup
    const harmScores = activeDims.map(([d, v]) => ({
      weight: dimWeights[d] / totalActiveWeight,
      value: Math.max(10, v),
    }));
    const weightedHarm = 1 / harmScores.reduce((s, h) => s + h.weight / h.value, 0);

    // 65% arithmetic + 35% harmonic — arithmetic-dominant, harmonic catches extremes
    // User can override via scoringMode: lenient=80/20, balanced=65/35, strict=50/50
    let arithmeticRatio = 0.65;
    try {
      const vscode = require('vscode');
      const mode = vscode.workspace.getConfiguration('ai-readiness').get('scoringMode') as string | undefined;
      if (mode === 'lenient') arithmeticRatio = 0.80;
      else if (mode === 'strict') arithmeticRatio = 0.50;
    } catch { /* tests — use default */ }

    let blended = arithmeticRatio * weightedArith + (1 - arithmeticRatio) * weightedHarm;

    // Coverage penalty: fewer active dimensions = less confidence in score
    // 1 dim → ×0.625, 2 dims → ×0.75, 3 dims → ×0.875, 4 dims → ×1.0
    const totalDimCount = 4;
    if (activeDims.length < totalDimCount) {
      const coverageFactor = 0.5 + 0.5 * (activeDims.length / totalDimCount);
      blended *= coverageFactor;
    }

    // ── Stage 5: Anti-pattern penalties (multiplier-based, product stacking) ──
    let antiPatternMultiplier = 1.0;
    const triggeredAntiPatterns = new Set<string>();
    for (const ap of ANTI_PATTERNS) {
      // Check direct level match
      const directMatch = ap.levels.includes(level);
      // Check cascade match
      const cascadeMatch = ap.cascadeTo?.includes(level) ?? false;

      if (!directMatch && !cascadeMatch) continue;

      if (ap.check(levelSignals)) {
        const mult = cascadeMatch && !directMatch ? (ap.cascadeMultiplier ?? ap.multiplier) : ap.multiplier;
        antiPatternMultiplier *= mult;
        triggeredAntiPatterns.add(ap.id);
      }
    }
    antiPatternMultiplier = Math.max(AP_PRODUCT_FLOOR, antiPatternMultiplier);

    // ── Stage 2: Quality Gates (skip conditions already penalized by anti-patterns) ──
    let gateMultiplier = 1.0;
    const requiredSignals = effectiveSignals.filter(es => es.classification === 'required');

    // Gate 1: Critical signals must be >= 50
    for (const es of effectiveSignals) {
      if (es.classification === 'critical' && es.signal.detected && es.effective < 50) {
        if (triggeredAntiPatterns.has('generic_boilerplate') && es.effective < 20) continue;
        gateMultiplier = Math.min(gateMultiplier, 0.65);
      }
      if (es.classification === 'critical' && !es.signal.detected) {
        gateMultiplier = Math.min(gateMultiplier, 0.55);
      }
    }

    // Gate 2: Required floor — average of required signals must be >= 25
    if (requiredSignals.length > 0) {
      const reqAvg = requiredSignals.reduce((s, es) => s + es.effective, 0) / requiredSignals.length;
      if (reqAvg < 25) {
        gateMultiplier = Math.min(gateMultiplier, 0.6);
      }
    }

    // Gate 3: Accuracy gate — skip if stale_content anti-pattern already fired
    if (!triggeredAntiPatterns.has('stale_content')) {
      for (const es of effectiveSignals) {
        const invalidCount = es.signal.realityChecks?.filter(r => r.status === 'invalid').length ?? 0;
        if (invalidCount >= 3) {
          gateMultiplier = Math.min(gateMultiplier, 0.7);
        }
      }
    }

    // ── Final: blended × combined multiplier (with floor) ──
    const combinedMultiplier = Math.max(COMBINED_PENALTY_FLOOR, gateMultiplier * antiPatternMultiplier);
    let rawScore = Math.max(0, Math.min(100, Math.round(blended * combinedMultiplier)));

    // Floor: if signals are detected, minimum score is 15%
    if (detected.length > 0 && rawScore < 15) {
      rawScore = 15;
    }

    return {
      level,
      name: MATURITY_LEVELS[level].name,
      rawScore,
      qualified: false, // set by calculateReport
      signals: levelSignals,
      signalsDetected: detected.length,
      signalsTotal: levelSignals.length,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private effectiveScore(signal: SignalResult): number {
    const confMult = CONFIDENCE_MULTIPLIER[signal.confidence] ?? 1.0;
    const accMult = this.accuracyMultiplier(signal.realityChecks);
    return signal.score * confMult * accMult;
  }

  private accuracyMultiplier(checks?: RealityCheckRef[]): number {
    if (!checks || checks.length === 0) return 1.0;
    const total = checks.length;
    const invalid = checks.filter(c => c.status === 'invalid').length;
    const warnings = checks.filter(c => c.status === 'warning').length;
    return Math.max(0.25, 1 - 0.60 * (invalid / total) - 0.20 * (warnings / total));
  }

  private signalDimension(signal: SignalResult): keyof DimensionWeights {
    if (OPERABILITY_SIGNALS.has(signal.signalId)) return 'operability';
    // Tool-level signals: L2=quality, L3/L4=operability, L5=breadth
    const toolMatch = signal.signalId.match(/^[a-z]+_l(\d)_(.+)$/);
    if (toolMatch) {
      const lvl = parseInt(toolMatch[1]);
      if (lvl === 2) return 'quality';
      if (lvl === 3) return 'operability';
      if (lvl === 4) return 'operability';
      if (lvl === 5) return 'breadth';
    }
    if (signal.signalId.includes('accuracy') || signal.signalId.includes('conventions') || 
        signal.signalId.includes('structure_doc')) return 'quality';
    if (signal.signalId.includes('memory') ||
        signal.signalId.includes('coverage')) return 'breadth';
    return signal.detected && signal.score > 0 ? 'presence' : 'quality';
  }

  private inferClassification(signal: SignalResult): SignalClass {
    if (signal.signalId.includes('accuracy')) return 'critical';
    if (signal.signalId.match(/^[a-z]+_l2_/)) return 'required';
    if (signal.signalId.match(/^[a-z]+_l[345]_/)) return 'recommended';
    return 'recommended';
  }

  private collectMonorepoSubProjectPaths(
    projectContext: ProjectContext,
    levels: LevelScore[],
  ): Set<string> {
    const subProjectPaths = new Set<string>();
    const nestedConfigDirs = new Set([
      '.github', '.vscode', '.clinerules', '.roo', '.cursor', '.windsurf', '.claude', 'memory-bank',
    ]);
    const nestedConfigFiles = new Set([
      'CLAUDE.md', 'AGENTS.md', '.cursorrules', '.aider.conf.yml', '.aiderignore',
    ]);

    for (const component of projectContext.components || []) {
      if ((component.parentPath === '' || !component.parentPath) && component.path && !component.path.startsWith('.')) {
        subProjectPaths.add(component.path);
      }
    }

    for (const level of levels) {
      for (const signal of level.signals) {
        for (const file of signal.files || []) {
          const normalized = file.replace(/^\.?\//, '');
          const parts = normalized.split('/').filter(Boolean);
          if (parts.length < 2) continue;

          const [topDir, secondPart] = parts;
          if (!topDir || topDir.startsWith('.')) continue;

          if (nestedConfigDirs.has(secondPart) || nestedConfigFiles.has(secondPart)) {
            subProjectPaths.add(topDir);
          }
        }
      }
    }

    return subProjectPaths;
  }

  private harmonicMean(values: number[]): number {
    if (values.length === 0) return 0;
    const positive = values.map(v => Math.max(1, v));
    return positive.length / positive.reduce((s, v) => s + 1 / v, 0);
  }
}
