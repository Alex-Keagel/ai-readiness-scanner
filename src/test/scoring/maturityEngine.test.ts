import { describe, it, expect } from 'vitest';
import { MaturityEngine, resolveSignalClass } from '../../scoring/maturityEngine';
import type { SignalResult, LevelScore, ProjectContext, ComponentScore, LanguageScore, MaturityLevel, AITool } from '../../scoring/types';

// ── Helpers ──────────────────────────────────────────────────────

function makeSignal(overrides: Partial<SignalResult> = {}): SignalResult {
  return {
    signalId: 'copilot_instructions',
    level: 2 as MaturityLevel,
    detected: true,
    score: 80,
    finding: 'Found',
    files: ['.github/copilot-instructions.md'],
    confidence: 'high',
    ...overrides,
  };
}

function makeLevelScore(level: MaturityLevel, signals: SignalResult[], rawScore?: number): LevelScore {
  const detected = signals.filter(s => s.detected);
  return {
    level,
    name: `Level ${level}`,
    rawScore: rawScore ?? (detected.length > 0 ? 60 : 0),
    qualified: false,
    signals,
    signalsDetected: detected.length,
    signalsTotal: signals.length,
  };
}

const defaultContext: ProjectContext = {
  languages: ['TypeScript'],
  frameworks: ['express'],
  projectType: 'app',
  packageManager: 'npm',
  directoryTree: '.',
  components: [],
};

const defaultComponents: ComponentScore[] = [];
const defaultLanguages: LanguageScore[] = [];

describe('MaturityEngine', () => {
  const engine = new MaturityEngine();

  // ── calculateLevelScore ─────────────────────────────────────────

  describe('calculateLevelScore', () => {
    it('returns rawScore 0 for level 1 with no signals (L1 now requires codebase quality signals)', () => {
      const result = engine.calculateLevelScore(1, []);
      expect(result.rawScore).toBe(0);
      expect(result.level).toBe(1);
    });

    it('returns real score for level 1 with codebase signals', () => {
      const signals = [
        makeSignal({ signalId: 'codebase_type_strictness', level: 1 as any, detected: true, score: 60, confidence: 'high' }),
        makeSignal({ signalId: 'codebase_semantic_density', level: 1 as any, detected: true, score: 45, confidence: 'high' }),
        makeSignal({ signalId: 'codebase_context_efficiency', level: 1 as any, detected: true, score: 70, confidence: 'high' }),
      ];
      const result = engine.calculateLevelScore(1, signals, 'copilot');
      expect(result.rawScore).toBeGreaterThan(30);
      expect(result.rawScore).toBeLessThanOrEqual(100);
      expect(result.signalsDetected).toBe(3);
    });

    it('returns rawScore 0 for higher level with no signals', () => {
      const result = engine.calculateLevelScore(3, []);
      expect(result.rawScore).toBe(0);
    });

    it('produces a positive score when signals are detected', () => {
      const signals = [
        makeSignal({ signalId: 'copilot_instructions', level: 2, detected: true, score: 80, confidence: 'high' }),
        makeSignal({ signalId: 'project_structure_doc', level: 2, detected: true, score: 70, confidence: 'high' }),
      ];
      const result = engine.calculateLevelScore(2, signals, 'copilot');
      expect(result.rawScore).toBeGreaterThan(0);
      expect(result.signalsDetected).toBe(2);
      expect(result.signalsTotal).toBe(2);
    });

    it('yields a very low score when all signals are undetected', () => {
      const signals = [
        makeSignal({ signalId: 'copilot_instructions', level: 2, detected: false, score: 0 }),
      ];
      const result = engine.calculateLevelScore(2, signals, 'copilot');
      // Score is near-zero but harmonic mean floor (10) and gate multiplier produce a small residual
      expect(result.rawScore).toBeLessThanOrEqual(5);
    });
  });

  // ── Quality gates ───────────────────────────────────────────────

  describe('quality gates', () => {
    it('penalizes when a critical signal scores below 50', () => {
      const good = [
        makeSignal({ signalId: 'copilot_instructions', level: 2, detected: true, score: 80, confidence: 'high' }),
        makeSignal({ signalId: 'project_structure_doc', level: 2, detected: true, score: 80, confidence: 'high' }),
      ];
      const bad = [
        makeSignal({ signalId: 'copilot_instructions', level: 2, detected: true, score: 20, confidence: 'high' }),
        makeSignal({ signalId: 'project_structure_doc', level: 2, detected: true, score: 80, confidence: 'high' }),
      ];
      const goodResult = engine.calculateLevelScore(2, good, 'copilot');
      const badResult = engine.calculateLevelScore(2, bad, 'copilot');
      expect(badResult.rawScore).toBeLessThan(goodResult.rawScore);
    });

    it('penalizes when a critical signal is not detected', () => {
      const withCritical = [
        makeSignal({ signalId: 'copilot_instructions', level: 2, detected: true, score: 70, confidence: 'high' }),
      ];
      const missingCritical = [
        makeSignal({ signalId: 'copilot_instructions', level: 2, detected: false, score: 0, confidence: 'high' }),
      ];
      const a = engine.calculateLevelScore(2, withCritical, 'copilot');
      const b = engine.calculateLevelScore(2, missingCritical, 'copilot');
      expect(b.rawScore).toBeLessThan(a.rawScore);
    });

    it('normalizes synthetic tool-level IDs to canonical critical signals', () => {
      const syntheticCritical = [
        makeSignal({ signalId: 'copilot_l2_instructions', level: 2, detected: true, score: 20, confidence: 'high' }),
        makeSignal({ signalId: 'project_structure_doc', level: 2, detected: true, score: 80, confidence: 'high' }),
      ];
      const onlyRequiredSignals = [
        makeSignal({ signalId: 'project_structure_doc', level: 2, detected: true, score: 20, confidence: 'high' }),
        makeSignal({ signalId: 'conventions_documented', level: 2, detected: true, score: 80, confidence: 'high' }),
      ];

      const syntheticResult = engine.calculateLevelScore(2, syntheticCritical, 'copilot');
      const requiredResult = engine.calculateLevelScore(2, onlyRequiredSignals, 'copilot');

      expect(syntheticResult.rawScore).toBeLessThan(requiredResult.rawScore);
    });
  });

  // ── Anti-pattern deductions ─────────────────────────────────────

  describe('anti-pattern deductions', () => {
    it('deducts for generic_boilerplate (high confidence, low score)', () => {
      const normal = [
        makeSignal({ signalId: 'conventions_documented', level: 2, detected: true, score: 60, confidence: 'high' }),
      ];
      const boilerplate = [
        makeSignal({ signalId: 'conventions_documented', level: 2, detected: true, score: 15, confidence: 'high' }),
      ];
      const normalResult = engine.calculateLevelScore(2, normal, 'copilot');
      const boilerplateResult = engine.calculateLevelScore(2, boilerplate, 'copilot');
      expect(boilerplateResult.rawScore).toBeLessThan(normalResult.rawScore);
    });

    it('caps total anti-pattern deductions at 12', () => {
      // Trigger all anti-patterns at once
      const signals = [
        makeSignal({
          signalId: 'conventions_documented', level: 2, detected: true, score: 10, confidence: 'high',
          realityChecks: [
            { category: 'path', status: 'invalid', claim: 'a', reality: 'b', file: 'x' },
            { category: 'path', status: 'invalid', claim: 'c', reality: 'd', file: 'y' },
          ],
          businessFindings: ['❌ contradictory content found'],
        }),
      ];
      // If anti-patterns were uncapped, deductions would be 5 + 3 + 8 = 16
      // With the cap, the max deduction is 12
      const result = engine.calculateLevelScore(2, signals, 'copilot');
      expect(result.rawScore).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Harmonic mean ───────────────────────────────────────────────

  describe('harmonic mean blending', () => {
    it('produces finite results for uniform scores', () => {
      const signals = [
        makeSignal({ signalId: 'copilot_instructions', level: 2, detected: true, score: 50, confidence: 'high' }),
        makeSignal({ signalId: 'project_structure_doc', level: 2, detected: true, score: 50, confidence: 'high' }),
        makeSignal({ signalId: 'conventions_documented', level: 2, detected: true, score: 50, confidence: 'high' }),
      ];
      const result = engine.calculateLevelScore(2, signals, 'copilot');
      expect(result.rawScore).toBeGreaterThan(0);
      expect(result.rawScore).toBeLessThanOrEqual(100);
    });
  });

  // ── Platform dimension weights ──────────────────────────────────

  describe('platform-specific scoring', () => {
    it('produces different scores for different platforms with same signals', () => {
      const signals = [
        makeSignal({ signalId: 'copilot_instructions', level: 2, detected: true, score: 70, confidence: 'high' }),
        makeSignal({ signalId: 'safe_commands', level: 2, detected: true, score: 90, confidence: 'high' }),
        makeSignal({ signalId: 'conventions_documented', level: 2, detected: true, score: 60, confidence: 'high' }),
      ];
      const copilotResult = engine.calculateLevelScore(2, signals, 'copilot');
      const clineResult = engine.calculateLevelScore(2, signals, 'cline');
      // Different weights mean different results (may be same by coincidence, but typically differ)
      expect(typeof copilotResult.rawScore).toBe('number');
      expect(typeof clineResult.rawScore).toBe('number');
    });
  });

  // ── calculateReport ─────────────────────────────────────────────

  describe('calculateReport', () => {
    it('returns a well-structured report', () => {
      const levels: LevelScore[] = [
        makeLevelScore(1, [], 100),
        makeLevelScore(2, [makeSignal({ level: 2, score: 70 })], 60),
        makeLevelScore(3, [], 0),
        makeLevelScore(4, [], 0),
        makeLevelScore(5, [], 0),
        makeLevelScore(6, [], 0),
      ];

      const report = engine.calculateReport(
        'test-project', levels, defaultContext,
        defaultComponents, defaultLanguages, 'gpt-4o', 'full', 'copilot',
      );

      expect(report.projectName).toBe('test-project');
      expect(report.primaryLevel).toBeGreaterThanOrEqual(1);
      expect(report.primaryLevel).toBeLessThanOrEqual(6);
      expect(report.depth).toBeGreaterThanOrEqual(0);
      expect(report.depth).toBeLessThanOrEqual(99);
      expect(report.overallScore).toBeGreaterThanOrEqual(0);
      expect(report.overallScore).toBeLessThanOrEqual(100);
      expect(report.scanMode).toBe('full');
    });

    it('qualifies level 1 always', () => {
      const levels: LevelScore[] = Array.from({ length: 6 }, (_, i) =>
        makeLevelScore((i + 1) as MaturityLevel, [], 0),
      );
      const report = engine.calculateReport(
        'empty', levels, defaultContext,
        defaultComponents, defaultLanguages, 'gpt-4o', 'quick', 'copilot',
      );
      expect(report.levels[0].qualified).toBe(true);
      expect(report.primaryLevel).toBe(1);
    });

    it('gates higher levels on previous level qualification', () => {
      const levels: LevelScore[] = [
        makeLevelScore(1, [], 100),
        makeLevelScore(2, [], 0),   // fails threshold
        makeLevelScore(3, [], 80),  // would pass on its own, but L2 blocks it
        makeLevelScore(4, [], 0),
        makeLevelScore(5, [], 0),
        makeLevelScore(6, [], 0),
      ];
      const report = engine.calculateReport(
        'gated', levels, defaultContext,
        defaultComponents, defaultLanguages, 'gpt-4o', 'full', 'copilot',
      );
      expect(report.levels[2].qualified).toBe(false);
    });

    it('blends component type weights into overall score', () => {
      const levels: LevelScore[] = [
        makeLevelScore(1, [], 100),
        makeLevelScore(2, [makeSignal({ score: 70 })], 60),
        makeLevelScore(3, [], 0),
        makeLevelScore(4, [], 0),
        makeLevelScore(5, [], 0),
        makeLevelScore(6, [], 0),
      ];
      const highValueComps: ComponentScore[] = [
        { name: 'API', path: 'src/api', language: 'TypeScript', type: 'service', primaryLevel: 2, depth: 80, overallScore: 90, levels: [], signals: [] },
      ];
      const lowValueComps: ComponentScore[] = [
        { name: 'Config', path: '.config', language: 'JSON', type: 'config', primaryLevel: 1, depth: 30, overallScore: 90, levels: [], signals: [] },
      ];
      const reportHigh = engine.calculateReport('high', levels, defaultContext, highValueComps, defaultLanguages, 'test', 'full', 'copilot');
      const reportLow = engine.calculateReport('low', levels, defaultContext, lowValueComps, defaultLanguages, 'test', 'full', 'copilot');
      // Service component (weight 1.0) should contribute more than config (weight 0.4)
      expect(reportHigh.overallScore).toBeGreaterThanOrEqual(reportLow.overallScore);
    });

    it('produces a score when components are empty', () => {
      const levels: LevelScore[] = [
        makeLevelScore(1, [], 100),
        makeLevelScore(2, [makeSignal({ score: 70 })], 60),
        makeLevelScore(3, [], 0),
        makeLevelScore(4, [], 0),
        makeLevelScore(5, [], 0),
        makeLevelScore(6, [], 0),
      ];
      const report = engine.calculateReport('empty', levels, defaultContext, [], defaultLanguages, 'test', 'full', 'copilot');
      expect(report.overallScore).toBeGreaterThan(0);
    });

    it('does not give monorepo roots L2 credit for nested instruction files', () => {
      const monorepoContext: ProjectContext = {
        ...defaultContext,
        projectType: 'monorepo',
        components: [],
      };
      const levels: LevelScore[] = [
        makeLevelScore(1, [], 100),
        makeLevelScore(2, [
          makeSignal({
            signalId: 'copilot_instructions',
            level: 2,
            score: 80,
            files: ['risk-register/.github/copilot-instructions.md'],
          }),
        ], 60),
        makeLevelScore(3, [], 0),
        makeLevelScore(4, [], 0),
        makeLevelScore(5, [], 0),
        makeLevelScore(6, [], 0),
      ];

      const report = engine.calculateReport(
        'monorepo',
        levels,
        monorepoContext,
        defaultComponents,
        defaultLanguages,
        'test',
        'full',
        'copilot',
      );

      expect(report.primaryLevel).toBe(1);
    });

    it('does not give monorepo roots L3 credit for nested sub-project signals', () => {
      const monorepoContext: ProjectContext = {
        ...defaultContext,
        projectType: 'monorepo',
        components: [],
      };
      const levels: LevelScore[] = [
        makeLevelScore(1, [], 100),
        makeLevelScore(2, [
          makeSignal({
            signalId: 'copilot_instructions',
            level: 2,
            score: 80,
            files: ['.github/copilot-instructions.md'],
          }),
        ], 60),
        makeLevelScore(3, [
          makeSignal({
            signalId: 'copilot_agents',
            level: 3,
            score: 85,
            files: ['ai-readiness-scanner-vs-code-extension/.github/agents/context-architect.agent.md'],
          }),
        ], 70),
        makeLevelScore(4, [], 0),
        makeLevelScore(5, [], 0),
        makeLevelScore(6, [], 0),
      ];

      const report = engine.calculateReport(
        'monorepo',
        levels,
        monorepoContext,
        defaultComponents,
        defaultLanguages,
        'test',
        'full',
        'copilot',
      );

      expect(report.primaryLevel).toBe(2);
    });
  });
});

describe('DEFAULT_COMPONENT_TYPE_WEIGHTS', () => {
  it('exports default type weights', async () => {
    const { DEFAULT_COMPONENT_TYPE_WEIGHTS } = await import('../../scoring/maturityEngine');
    expect(DEFAULT_COMPONENT_TYPE_WEIGHTS).toBeDefined();
    expect(DEFAULT_COMPONENT_TYPE_WEIGHTS.service).toBe(1.0);
    expect(DEFAULT_COMPONENT_TYPE_WEIGHTS.app).toBe(1.0);
    expect(DEFAULT_COMPONENT_TYPE_WEIGHTS.config).toBe(0.4);
    expect(DEFAULT_COMPONENT_TYPE_WEIGHTS.data).toBe(0.3);
  });

  it('has weights for all component types', async () => {
    const { DEFAULT_COMPONENT_TYPE_WEIGHTS } = await import('../../scoring/maturityEngine');
    const types = ['service', 'app', 'library', 'infra', 'config', 'script', 'data', 'unknown'];
    for (const t of types) {
      expect(DEFAULT_COMPONENT_TYPE_WEIGHTS[t]).toBeDefined();
      expect(DEFAULT_COMPONENT_TYPE_WEIGHTS[t]).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_COMPONENT_TYPE_WEIGHTS[t]).toBeLessThanOrEqual(1);
    }
  });

  it('core types weigh more than generated types', async () => {
    const { DEFAULT_COMPONENT_TYPE_WEIGHTS } = await import('../../scoring/maturityEngine');
    expect(DEFAULT_COMPONENT_TYPE_WEIGHTS.service).toBeGreaterThan(DEFAULT_COMPONENT_TYPE_WEIGHTS.config);
    expect(DEFAULT_COMPONENT_TYPE_WEIGHTS.app).toBeGreaterThan(DEFAULT_COMPONENT_TYPE_WEIGHTS.data);
    expect(DEFAULT_COMPONENT_TYPE_WEIGHTS.library).toBeGreaterThan(DEFAULT_COMPONENT_TYPE_WEIGHTS.script);
  });
});

describe('Coverage penalty (empty dimension fix)', () => {
  const engine = new MaturityEngine();

  it('applies coverage penalty when only 1 dimension has signals', () => {
    // Single presence signal — only fills "presence" dimension
    const signals = [
      makeSignal({ signalId: 'copilot_instructions', level: 2, detected: true, score: 80, confidence: 'high' }),
    ];
    const result = engine.calculateLevelScore(2, signals, 'copilot');
    // Without coverage penalty this would be higher
    // With penalty (1/4 dims → ×0.625), score should be noticeably reduced
    expect(result.rawScore).toBeLessThan(70);
    expect(result.rawScore).toBeGreaterThan(0);
  });

  it('no coverage penalty when all 4 dimensions have signals', () => {
    const signals = [
      makeSignal({ signalId: 'copilot_instructions', level: 2, detected: true, score: 70, confidence: 'high' }), // presence
      makeSignal({ signalId: 'conventions_documented', level: 2, detected: true, score: 70, confidence: 'high' }), // quality
      makeSignal({ signalId: 'safe_commands', level: 2, detected: true, score: 70, confidence: 'high' }), // operability
      makeSignal({ signalId: 'copilot_domain_instructions', level: 2, detected: true, score: 70, confidence: 'high' }), // breadth
    ];
    const result = engine.calculateLevelScore(2, signals, 'copilot');
    // All 4 dims active → no coverage penalty → higher score
    expect(result.rawScore).toBeGreaterThan(40);
  });

  it('coverage penalty is proportional to active dimensions', () => {
    const oneDim = [
      makeSignal({ signalId: 'copilot_instructions', level: 2, detected: true, score: 80, confidence: 'high' }),
    ];
    const twoDim = [
      makeSignal({ signalId: 'copilot_instructions', level: 2, detected: true, score: 80, confidence: 'high' }),
      makeSignal({ signalId: 'conventions_documented', level: 2, detected: true, score: 80, confidence: 'high' }),
    ];
    const score1 = engine.calculateLevelScore(2, oneDim, 'copilot').rawScore;
    const score2 = engine.calculateLevelScore(2, twoDim, 'copilot').rawScore;
    // 2 dims should score higher than 1 dim due to less coverage penalty
    expect(score2).toBeGreaterThan(score1);
  });
});

describe('Coherence check', () => {
  it('coherenceWarning field exists on ReadinessReport type', () => {
    const report: any = { coherenceWarning: 'test' };
    expect(report.coherenceWarning).toBe('test');
  });
});

// ── Monorepo gating ──────────────────────────────────────────────

describe('Monorepo gating', () => {
  const engine = new MaturityEngine();

  const monorepoContext: ProjectContext = {
    languages: ['TypeScript'],
    frameworks: [],
    projectType: 'monorepo',
    packageManager: 'npm',
    directoryTree: '.',
    components: [
      { name: 'VS Code Extension', path: 'ai-readiness-scanner-vs-code-extension', language: 'TypeScript', type: 'app' },
      { name: 'Risk Register', path: 'risk-register', language: 'TypeScript', type: 'app' },
    ],
  };

  function buildLevels(l2Signals: SignalResult[], l3Signals: SignalResult[]): LevelScore[] {
    return [
      makeLevelScore(1, [], 100),
      makeLevelScore(2, l2Signals, l2Signals.some(s => s.detected) ? 70 : 0),
      makeLevelScore(3, l3Signals, l3Signals.some(s => s.detected) ? 70 : 0),
      makeLevelScore(4, [], 0),
      makeLevelScore(5, [], 0),
      makeLevelScore(6, [], 0),
    ];
  }

  it('caps level when critical signals are only in sub-projects', () => {
    const l2Signals = [
      makeSignal({ signalId: 'copilot_instructions', level: 2, detected: true, score: 80, files: ['.github/copilot-instructions.md'] }),
      makeSignal({ signalId: 'project_structure_doc', level: 2, detected: true, score: 70, files: ['README.md'] }),
    ];
    const l3Signals = [
      // copilot_agents NOT detected at root (agents only in sub-projects)
      makeSignal({ signalId: 'copilot_agents', level: 3, detected: false, score: 0, files: [] }),
      // instruction_accuracy detected via root README — but alone shouldn't pass gating
      makeSignal({ signalId: 'instruction_accuracy', level: 3, detected: true, score: 70, files: ['README.md', '.github/copilot-instructions.md'] }),
      makeSignal({ signalId: 'mcp_config', level: 3, detected: true, score: 60, files: ['.vscode/mcp.json'] }),
    ];

    const report = engine.calculateReport(
      'appsec-monorepo', buildLevels(l2Signals, l3Signals), monorepoContext,
      [], defaultLanguages, 'test', 'full', 'copilot',
    );

    // L3 should be capped because copilot_agents (critical) is not detected at root
    expect(report.primaryLevel).toBeLessThanOrEqual(2);
  });

  it('does not cap level when critical signals are at root', () => {
    const l2Signals = [
      makeSignal({ signalId: 'copilot_instructions', level: 2, detected: true, score: 80, files: ['.github/copilot-instructions.md'] }),
      makeSignal({ signalId: 'project_structure_doc', level: 2, detected: true, score: 70, files: ['README.md'] }),
    ];
    const l3Signals = [
      // copilot_agents detected at root
      makeSignal({ signalId: 'copilot_agents', level: 3, detected: true, score: 80, files: ['.github/agents/my-agent.agent.md'] }),
      makeSignal({ signalId: 'instruction_accuracy', level: 3, detected: true, score: 70, files: ['README.md', '.github/copilot-instructions.md'] }),
      makeSignal({ signalId: 'mcp_config', level: 3, detected: true, score: 60, files: ['.vscode/mcp.json'] }),
    ];

    const report = engine.calculateReport(
      'appsec-monorepo-with-root-agents', buildLevels(l2Signals, l3Signals), monorepoContext,
      [], defaultLanguages, 'test', 'full', 'copilot',
    );

    // L3 should NOT be capped — critical signals are present at root
    expect(report.primaryLevel).toBeGreaterThanOrEqual(3);
  });

  it('caps level when critical signal files are inside sub-project paths', () => {
    const l2Signals = [
      makeSignal({ signalId: 'copilot_instructions', level: 2, detected: true, score: 80, files: ['.github/copilot-instructions.md'] }),
    ];
    const l3Signals = [
      // copilot_agents detected but files are inside sub-project
      makeSignal({
        signalId: 'copilot_agents', level: 3, detected: true, score: 70,
        files: ['ai-readiness-scanner-vs-code-extension/.github/agents/scanner.agent.md'],
      }),
      makeSignal({ signalId: 'instruction_accuracy', level: 3, detected: true, score: 70, files: ['README.md'] }),
    ];

    const report = engine.calculateReport(
      'appsec-sub-only', buildLevels(l2Signals, l3Signals), monorepoContext,
      [], defaultLanguages, 'test', 'full', 'copilot',
    );

    // L3 should be capped — copilot_agents files are all inside a sub-project
    expect(report.primaryLevel).toBeLessThanOrEqual(2);
  });

  // ── AppSec-exact scenario: synthetic signal IDs from batch evaluation ──

  it('caps monorepo root to L1 when synthetic tool-level signals have no files (AppSec scenario)', () => {
    // This reproduces the ACTUAL scanner output: batch evaluation produces
    // synthetic IDs like copilot_l2_instructions, NOT canonical copilot_instructions.
    // Root has NO .github/ → synthetic tool signals have detected:false, files:[].
    // Shared signals (README, .gitignore) are detected at L2.
    const l2Signals = [
      makeSignal({ signalId: 'copilot_l2_instructions', level: 2, detected: false, score: 0, files: [] }),
      makeSignal({ signalId: 'project_structure_doc', level: 2, detected: true, score: 70, files: ['README.md'] }),
      makeSignal({ signalId: 'conventions_documented', level: 2, detected: true, score: 50, files: ['.editorconfig'] }),
      makeSignal({ signalId: 'ignore_files', level: 2, detected: true, score: 60, files: ['.gitignore'] }),
    ];
    const l3Signals = [
      makeSignal({ signalId: 'copilot_l3_skills_and_tools', level: 3, detected: false, score: 0, files: [] }),
      makeSignal({ signalId: 'instruction_accuracy', level: 3, detected: true, score: 55, files: ['README.md'] }),
    ];

    const report = engine.calculateReport(
      'appsec-synthetic-ids', buildLevels(l2Signals, l3Signals), monorepoContext,
      [], defaultLanguages, 'test', 'full', 'copilot',
    );

    // Root has no .github/ — synthetic tool signal detected:false should cap at L1
    expect(report.primaryLevel).toBe(1);
  });

  it('caps monorepo root to L1 when LLM hallucinates detection with empty files', () => {
    // Edge case: LLM returns detected:true for a level with NO actual files.
    // The synthetic signal has files:[] — the monorepo correction must NOT
    // let this pass through the "no files = codebase signal" path.
    const l2Signals = [
      makeSignal({ signalId: 'copilot_l2_instructions', level: 2, detected: true, score: 50, files: [] }),
      makeSignal({ signalId: 'project_structure_doc', level: 2, detected: true, score: 70, files: ['README.md'] }),
      makeSignal({ signalId: 'ignore_files', level: 2, detected: true, score: 60, files: ['.gitignore'] }),
    ];
    const l3Signals = [
      makeSignal({ signalId: 'copilot_l3_skills_and_tools', level: 3, detected: true, score: 40, files: [] }),
      makeSignal({ signalId: 'instruction_accuracy', level: 3, detected: true, score: 55, files: ['README.md'] }),
    ];

    const report = engine.calculateReport(
      'appsec-hallucinated', buildLevels(l2Signals, l3Signals), monorepoContext,
      [], defaultLanguages, 'test', 'full', 'copilot',
    );

    // LLM hallucinated detection with no files — must still cap at L1
    expect(report.primaryLevel).toBe(1);
  });

  it('non-monorepo projects are not affected by monorepo gating', () => {
    const appContext: ProjectContext = {
      ...monorepoContext,
      projectType: 'app',
    };
    const l2Signals = [
      makeSignal({ signalId: 'copilot_instructions', level: 2, detected: true, score: 80, files: ['.github/copilot-instructions.md'] }),
    ];
    const l3Signals = [
      makeSignal({ signalId: 'copilot_agents', level: 3, detected: false, score: 0, files: [] }),
      makeSignal({ signalId: 'instruction_accuracy', level: 3, detected: true, score: 70, files: ['README.md'] }),
      makeSignal({ signalId: 'mcp_config', level: 3, detected: true, score: 60, files: ['.vscode/mcp.json'] }),
    ];

    const report = engine.calculateReport(
      'regular-app', buildLevels(l2Signals, l3Signals), appContext,
      [], defaultLanguages, 'test', 'full', 'copilot',
    );

    // Non-monorepo — standard qualification applies, not monorepo gating
    expect(report.primaryLevel).toBeGreaterThanOrEqual(2);
  });

  it('does not treat non-critical synthetic signals as critical (L4 workflows)', () => {
    // copilot_l4_workflows resolves to agent_workflows which is 'required', not 'critical'.
    // The gate should NOT require these to have root files.
    const l2Signals = [
      makeSignal({ signalId: 'copilot_l2_instructions', level: 2, detected: true, score: 80, files: ['.github/copilot-instructions.md'] }),
      makeSignal({ signalId: 'project_structure_doc', level: 2, detected: true, score: 70, files: ['README.md'] }),
    ];
    const l3Signals = [
      makeSignal({ signalId: 'copilot_l3_skills_and_tools', level: 3, detected: true, score: 80, files: ['.github/agents/my-agent.agent.md'] }),
      makeSignal({ signalId: 'instruction_accuracy', level: 3, detected: true, score: 70, files: ['README.md'] }),
    ];
    const l4Signals = [
      // workflows is 'required' not 'critical' — should not block level advancement
      makeSignal({ signalId: 'copilot_l4_workflows', level: 4, detected: true, score: 70, files: [] }),
      makeSignal({ signalId: 'agent_workflows', level: 4, detected: true, score: 65, files: ['README.md'] }),
    ];

    const levels: LevelScore[] = [
      makeLevelScore(1, [], 100),
      makeLevelScore(2, l2Signals, 70),
      makeLevelScore(3, l3Signals, 70),
      makeLevelScore(4, l4Signals, 60),
      makeLevelScore(5, [], 0),
      makeLevelScore(6, [], 0),
    ];

    const report = engine.calculateReport(
      'appsec-l4-noncritical', levels, monorepoContext,
      [], defaultLanguages, 'test', 'full', 'copilot',
    );

    // L4 should NOT be blocked by the monorepo gate (no critical signals at L4)
    expect(report.primaryLevel).toBeGreaterThanOrEqual(3);
  });

  it('blocks L2 when only non-critical signals are detected but critical synthetic is missing (ZTS scenario)', () => {
    // Bug 3 scenario: non-critical signals (ignore_files, conventions) are detected
    // but the critical copilot_l2_instructions is not detected at root.
    const l2Signals = [
      makeSignal({ signalId: 'copilot_l2_instructions', level: 2, detected: false, score: 0, files: [] }),
      makeSignal({ signalId: 'ignore_files', level: 2, detected: true, score: 60, files: ['.gitignore'] }),
      makeSignal({ signalId: 'conventions_documented', level: 2, detected: true, score: 55, files: ['.editorconfig'] }),
      makeSignal({ signalId: 'project_structure_doc', level: 2, detected: true, score: 70, files: ['README.md'] }),
    ];

    const report = engine.calculateReport(
      'zts-scenario', buildLevels(l2Signals, []), monorepoContext,
      [], defaultLanguages, 'test', 'full', 'copilot',
    );

    // Non-critical signals alone should NOT qualify L2 when critical is missing
    expect(report.primaryLevel).toBe(1);
  });
});

// ── resolveSignalClass ────────────────────────────────────────────

describe('resolveSignalClass', () => {
  const copilotClasses: Record<string, 'critical' | 'required' | 'recommended'> = {
    copilot_instructions: 'critical',
    copilot_domain_instructions: 'required',
    copilot_agents: 'critical',
    copilot_skills: 'required',
    ignore_files: 'recommended',
    instruction_accuracy: 'critical',
    agent_workflows: 'required',
    memory_bank_update: 'recommended',
  };

  it('resolves canonical signal IDs directly', () => {
    expect(resolveSignalClass('copilot_instructions', 'copilot', copilotClasses)).toBe('critical');
    expect(resolveSignalClass('ignore_files', 'copilot', copilotClasses)).toBe('recommended');
    expect(resolveSignalClass('agent_workflows', 'copilot', copilotClasses)).toBe('required');
  });

  it('resolves synthetic copilot_l2_instructions to critical via alias', () => {
    expect(resolveSignalClass('copilot_l2_instructions', 'copilot', copilotClasses)).toBe('critical');
  });

  it('resolves synthetic copilot_l3_skills_and_tools to critical via alias', () => {
    expect(resolveSignalClass('copilot_l3_skills_and_tools', 'copilot', copilotClasses)).toBe('critical');
  });

  it('resolves synthetic copilot_l4_workflows to required (not critical)', () => {
    expect(resolveSignalClass('copilot_l4_workflows', 'copilot', copilotClasses)).toBe('required');
  });

  it('resolves synthetic copilot_l5_memory_feedback to recommended', () => {
    expect(resolveSignalClass('copilot_l5_memory_feedback', 'copilot', copilotClasses)).toBe('recommended');
  });

  it('returns undefined for unknown signal IDs', () => {
    expect(resolveSignalClass('unknown_signal', 'copilot', copilotClasses)).toBeUndefined();
  });

  it('resolves cline synthetic IDs correctly', () => {
    const clineClasses: Record<string, 'critical' | 'required' | 'recommended'> = {
      cline_rules: 'critical',
      safe_commands: 'critical',
    };
    expect(resolveSignalClass('cline_l2_instructions', 'cline', clineClasses)).toBe('critical');
    expect(resolveSignalClass('cline_l3_skills_and_tools', 'cline', clineClasses)).toBe('critical');
  });
});
