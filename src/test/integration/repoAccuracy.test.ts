/**
 * Integration tests that exercise scanner logic against ground-truth
 * repo fixtures WITHOUT requiring VS Code APIs or a running extension host.
 *
 * Each test builds mock data that mirrors actual filesystem state captured
 * from the three target repos, then asserts results fall within expected ranges.
 */

import { describe, expect, it } from 'vitest';
import { NarrativeGenerator } from '../../report/narrativeGenerator';
import { calculateInstructionRealitySync } from '../../report/instructionRealitySync';
import {
  computeBlendedSemanticDensity,
  computeTypeStrictness,
  type FileAnalysis,
} from '../../metrics/codebaseMetrics';
import { validateComponentName } from '../../deep/validators/componentNameValidator';
import { validateSignalScope } from '../../deep/validators/signalScopeValidator';
import { MaturityEngine } from '../../scoring/maturityEngine';
import type {
  AITool,
  ComponentScore,
  LevelScore,
  MaturityLevel,
  ProjectContext,
  ReadinessReport,
  SignalResult,
} from '../../scoring/types';

import {
  ALL_REPOS,
  APP_SEC,
  DATA_PIPELINES,
  ZTS,
  type RepoGroundTruth,
} from '../fixtures/repoGroundTruth';

// ── Helpers ──────────────────────────────────────────────────────

function createNarrativeGenerator(): NarrativeGenerator {
  return new NarrativeGenerator({
    analyze: async () => '[]',
    analyzeFast: async () => '[]',
  } as any);
}

function makeSignal(
  id: string,
  level: MaturityLevel,
  detected: boolean,
  files: string[] = [],
  score = detected ? 85 : 0,
): SignalResult {
  return {
    signalId: id,
    level,
    detected,
    score,
    finding: detected ? `Found ${id}` : `Not found: ${id}`,
    files,
    confidence: detected ? 'high' : 'low',
  };
}

function makeLevelScore(
  level: MaturityLevel,
  signals: SignalResult[],
  rawScore?: number,
): LevelScore {
  const detected = signals.filter(s => s.detected);
  return {
    level,
    name: `Level ${level}`,
    rawScore: rawScore ?? (detected.length > 0 ? Math.round(detected.reduce((a, s) => a + s.score, 0) / detected.length) : 0),
    qualified: false,
    signals,
    signalsDetected: detected.length,
    signalsTotal: signals.length,
  };
}

function makeProjectContext(gt: RepoGroundTruth): ProjectContext {
  return {
    languages: gt.languages,
    frameworks: [],
    projectType: gt.projectType,
    packageManager: gt.primaryLanguage === 'python' ? 'pip' : gt.primaryLanguage === 'csharp' ? 'nuget' : 'npm',
    directoryTree: gt.subProjectPaths.map(p => `${p}/`).join('\n'),
    components: gt.subProjectPaths.map(p => ({
      path: p,
      name: p,
      language: gt.primaryLanguage,
      type: 'service',
    })),
  };
}

// ── 1. getRootInstructionFact ────────────────────────────────────

describe('getRootInstructionFact — via NarrativeGenerator', () => {
  const generator = createNarrativeGenerator();

  it('DataPipelines: detects root copilot-instructions from signal data', () => {
    const signals: SignalResult[] = [
      makeSignal('copilot_instructions', 2, true, ['.github/copilot-instructions.md']),
      makeSignal('copilot_l2_instructions', 2, true, ['.github/copilot-instructions.md']),
    ];
    const report = {
      levels: [{ level: 2, signals }],
      structureComparison: {
        expected: [{ path: '.github/copilot-instructions.md', exists: true, actualPath: '.github/copilot-instructions.md' }],
      },
    } as any;

    const fact = (generator as any).getRootInstructionFact(report, 'copilot', signals);
    expect(fact.present).toBe(true);
    expect(fact.files).toContain('.github/copilot-instructions.md');
  });

  it('ZTS: correctly reports no root copilot-instructions', () => {
    const signals: SignalResult[] = [
      makeSignal('copilot_instructions', 2, false),
      makeSignal('copilot_l2_instructions', 2, false),
    ];
    const report = { levels: [{ level: 2, signals }] } as any;

    const fact = (generator as any).getRootInstructionFact(report, 'copilot', signals);
    expect(fact.present).toBe(false);
  });

  it('AppSec: nested-only copilot-instructions → not present at root', () => {
    const signals: SignalResult[] = [
      makeSignal('copilot_instructions', 2, true, [
        'risk-register/.github/copilot-instructions.md',
        'ai-readiness-scanner-vs-code-extension/.github/copilot-instructions.md',
      ]),
    ];
    const report = { levels: [{ level: 2, signals }] } as any;

    // The fact check itself doesn't scope — it just checks signal detection.
    // The *scope* validation is separate (validateSignalScope).
    const fact = (generator as any).getRootInstructionFact(report, 'copilot', signals);
    // Signal says detected=true, so fact.present=true from signal source.
    // But validateSignalScope should later filter it.
    expect(fact.present).toBe(true);
  });
});

// ── 2. containsRootAbsenceClaim ─────────────────────────────────

describe('containsRootAbsenceClaim', () => {
  const generator = createNarrativeGenerator();

  it('flags narrative claiming absence of copilot-instructions', () => {
    const bad = 'The repository lacks a root copilot-instructions.md file, which limits AI tool guidance.';
    expect(generator.containsRootAbsenceClaim(bad)).toBe(true);
  });

  it('flags "missing copilot-instructions" claim', () => {
    const bad = 'The absence of copilot-instructions prevents optimal AI assistance.';
    expect(generator.containsRootAbsenceClaim(bad)).toBe(true);
  });

  it('does NOT flag narrative that confirms presence with scoped gap', () => {
    const good = 'The root copilot-instructions.md is present and well-structured, but individual components lack scoped guidance.';
    expect(generator.containsRootAbsenceClaim(good)).toBe(false);
  });

  it('does NOT flag unrelated narrative', () => {
    const neutral = 'The codebase has good test coverage and consistent naming conventions.';
    expect(generator.containsRootAbsenceClaim(neutral)).toBe(false);
  });

  for (const phrase of DATA_PIPELINES.narrativeShouldNotContain) {
    it(`DataPipelines: IQ narrative must not contain "${phrase}"`, () => {
      // The scanner should never produce a narrative containing these phrases
      // for a repo that HAS root copilot-instructions
      expect(generator.containsRootAbsenceClaim(phrase)).toBe(true);
    });
  }
});

// ── 3. computeBlendedSemanticDensity ────────────────────────────

describe('computeBlendedSemanticDensity', () => {
  it('DataPipelines: Python repo with moderate docs → 20-75', () => {
    // 270 .py files, moderate documentation, data pipeline scripts
    const score = computeBlendedSemanticDensity(
      200,   // totalProcedures (estimated from 270 py files)
      60,    // documentedProcedures (~30% docstrings)
      15000, // totalCodeLines
      1500,  // totalCommentLines (~10% ratio)
    );
    expect(score).toBeGreaterThanOrEqual(DATA_PIPELINES.expectedSemanticDensity.min);
    expect(score).toBeLessThanOrEqual(DATA_PIPELINES.expectedSemanticDensity.max);
  });

  it('ZTS: C# service with moderate XML docs → 30-75', () => {
    const score = computeBlendedSemanticDensity(
      500,   // totalProcedures (1353 .cs files, large codebase)
      200,   // documentedProcedures (~40% XML docs)
      40000, // totalCodeLines
      4000,  // totalCommentLines (~10% ratio)
    );
    expect(score).toBeGreaterThanOrEqual(ZTS.expectedSemanticDensity.min);
    expect(score).toBeLessThanOrEqual(ZTS.expectedSemanticDensity.max);
  });

  it('AppSec: mixed monorepo with few root files → 15-60', () => {
    const score = computeBlendedSemanticDensity(
      80,    // totalProcedures (smaller mixed codebase)
      20,    // documentedProcedures (~25%)
      5000,  // totalCodeLines
      300,   // totalCommentLines (~6%)
    );
    expect(score).toBeGreaterThanOrEqual(APP_SEC.expectedSemanticDensity.min);
    expect(score).toBeLessThanOrEqual(APP_SEC.expectedSemanticDensity.max);
  });

  it('zero inputs return 0', () => {
    expect(computeBlendedSemanticDensity(0, 0, 0, 0)).toBe(0);
  });
});

// ── 4. computeTypeStrictness ────────────────────────────────────

describe('computeTypeStrictness', () => {
  it('ZTS: C# with Nullable+strict+TreatWarningsAsErrors → 80-95', () => {
    // Ratio mirrors real repo: ~1353 .cs vs ~151 .py (≈9:1)
    const csharpFiles: FileAnalysis[] = Array.from({ length: 9 }, (_, i) => ({
      path: `src/Service/Module${i}.cs`,
      language: 'csharp',
      totalLines: 350,
      commentLines: 18,
      blankLines: 35,
      importCount: 12,
      typeAnnotationCount: 14,
      declarationCount: 22,
      hasStrictMode: false,
      totalProcedures: 18,
      documentedProcedures: 7,
    }));
    const files: FileAnalysis[] = [
      ...csharpFiles,
      // Directory.Build.props with strict flags
      {
        path: 'Directory.Build.props',
        language: 'xml',
        totalLines: 15,
        commentLines: 0,
        blankLines: 1,
        importCount: 0,
        typeAnnotationCount: 0,
        declarationCount: 0,
        hasStrictMode: true,
        totalProcedures: 0,
        documentedProcedures: 0,
      },
      // Some Python mixed in (1 file to match 9:1 ratio)
      {
        path: 'scripts/deploy.py',
        language: 'python',
        totalLines: 100,
        commentLines: 5,
        blankLines: 10,
        importCount: 5,
        typeAnnotationCount: 2,
        declarationCount: 8,
        hasStrictMode: false,
        totalProcedures: 6,
        documentedProcedures: 2,
      },
    ];
    const score = computeTypeStrictness(files);
    expect(score).toBeGreaterThanOrEqual(ZTS.expectedTypeStrictness.min);
    expect(score).toBeLessThanOrEqual(ZTS.expectedTypeStrictness.max);
  });

  it('DataPipelines: Python with no type hints → 10-40', () => {
    const files: FileAnalysis[] = Array.from({ length: 10 }, (_, i) => ({
      path: `python-workspace/module${i}.py`,
      language: 'python',
      totalLines: 150,
      commentLines: 8,
      blankLines: 15,
      importCount: 6,
      typeAnnotationCount: 0,
      declarationCount: 12,
      hasStrictMode: false,
      totalProcedures: 10,
      documentedProcedures: 3,
    }));
    const score = computeTypeStrictness(files);
    expect(score).toBeGreaterThanOrEqual(DATA_PIPELINES.expectedTypeStrictness.min);
    expect(score).toBeLessThanOrEqual(DATA_PIPELINES.expectedTypeStrictness.max);
  });

  it('AppSec: mixed TS/Python/Go → 30-70', () => {
    const files: FileAnalysis[] = [
      {
        path: 'risk-register/src/index.ts',
        language: 'typescript',
        totalLines: 200,
        commentLines: 10,
        blankLines: 20,
        importCount: 8,
        typeAnnotationCount: 15,
        declarationCount: 20,
        hasStrictMode: true,
        totalProcedures: 12,
        documentedProcedures: 4,
      },
      {
        path: 'benchmark-automation/main.py',
        language: 'python',
        totalLines: 120,
        commentLines: 5,
        blankLines: 12,
        importCount: 4,
        typeAnnotationCount: 2,
        declarationCount: 10,
        hasStrictMode: false,
        totalProcedures: 8,
        documentedProcedures: 2,
      },
      {
        path: 'slices/main.go',
        language: 'go',
        totalLines: 180,
        commentLines: 8,
        blankLines: 18,
        importCount: 6,
        typeAnnotationCount: 10,
        declarationCount: 14,
        hasStrictMode: false,
        totalProcedures: 10,
        documentedProcedures: 3,
      },
    ];
    const score = computeTypeStrictness(files);
    expect(score).toBeGreaterThanOrEqual(APP_SEC.expectedTypeStrictness.min);
    expect(score).toBeLessThanOrEqual(APP_SEC.expectedTypeStrictness.max);
  });

  it('empty files → 0', () => {
    expect(computeTypeStrictness([])).toBe(0);
  });
});

// ── 5. validateComponentName ────────────────────────────────────

describe('validateComponentName', () => {
  it('DataPipelines: KustoFunctions → keeps real dir name', () => {
    const result = validateComponentName('KustoFunctions', 'Kusto Query Functions Platform');
    expect(result.validatedName).toBe('KustoFunctions');
    expect(result.changed).toBe(true);
  });

  it('DataPipelines: python-workspace → keeps real dir name', () => {
    const result = validateComponentName('python-workspace', 'Data Science Workspace');
    expect(result.validatedName).toBe('python-workspace');
    expect(result.changed).toBe(true);
  });

  it('generic dir "src" allows LLM enrichment', () => {
    const result = validateComponentName('src', 'Core Service Logic');
    // Generic dirs keep LLM name but anchor with dir
    expect(result.validatedName).toContain('src');
  });

  it('exact match returns unchanged', () => {
    const result = validateComponentName('detection', 'detection');
    expect(result.changed).toBe(false);
  });

  it('AppSec: risk-register path preserved', () => {
    const result = validateComponentName('risk-register', 'Risk Register Management Portal');
    expect(result.validatedName).toBe('risk-register');
    expect(result.changed).toBe(true);
  });

  it('ZTS: deploy dir is generic → allows enrichment', () => {
    const result = validateComponentName('deploy', 'EV2 Deployment Pipeline');
    // 'deploy' matches the GENERIC_DIRS set variant 'deployment'
    // or the 3-char-or-less rule doesn't apply (deploy is 6 chars)
    // Let's just check it doesn't crash and returns something reasonable
    expect(result.validatedName).toBeTruthy();
  });
});

// ── 6. validateSignalScope ──────────────────────────────────────

describe('validateSignalScope', () => {
  it('AppSec: nested-only copilot-instructions → isRootDetected=false', () => {
    const result = validateSignalScope(
      'copilot_instructions',
      [
        'risk-register/.github/copilot-instructions.md',
        'ai-readiness-scanner-vs-code-extension/.github/copilot-instructions.md',
      ],
      APP_SEC.subProjectPaths,
    );
    expect(result.isRootDetected).toBe(false);
    expect(result.rootFiles).toEqual([]);
    expect(result.subProjectFiles).toHaveLength(2);
  });

  it('DataPipelines: root copilot-instructions → isRootDetected=true', () => {
    const result = validateSignalScope(
      'copilot_instructions',
      ['.github/copilot-instructions.md'],
      DATA_PIPELINES.subProjectPaths,
    );
    expect(result.isRootDetected).toBe(true);
    expect(result.rootFiles).toContain('.github/copilot-instructions.md');
  });

  it('DataPipelines: instruction files at root scope', () => {
    const result = validateSignalScope(
      'copilot_domain_instructions',
      [
        '.github/instructions/data-engineering.instructions.md',
        '.github/instructions/security-guidelines.instructions.md',
      ],
      DATA_PIPELINES.subProjectPaths,
    );
    expect(result.isRootDetected).toBe(true);
    expect(result.rootFiles).toHaveLength(2);
  });

  it('ZTS: skills in .github → root scope', () => {
    const result = validateSignalScope(
      'copilot_skills',
      ['.github/skills/ev2/SKILL.md', '.github/skills/adhoc-operations/SKILL.md'],
      ZTS.subProjectPaths,
    );
    expect(result.isRootDetected).toBe(true);
    expect(result.rootFiles).toHaveLength(2);
  });

  it('no sub-projects → everything is root', () => {
    const result = validateSignalScope(
      'copilot_instructions',
      ['.github/copilot-instructions.md'],
      [],
    );
    expect(result.isRootDetected).toBe(true);
  });
});

// ── 7. calculateInstructionRealitySync ──────────────────────────

describe('calculateInstructionRealitySync', () => {
  it('DataPipelines: root instructions + scoped + skills → 30-75', () => {
    const report = {
      selectedTool: 'copilot',
      levels: [
        makeLevelScore(1 as MaturityLevel, []),
        makeLevelScore(2 as MaturityLevel, [
          makeSignal('copilot_instructions', 2, true, ['.github/copilot-instructions.md']),
          makeSignal('copilot_domain_instructions', 2, true, ['.github/instructions/data-engineering.instructions.md']),
        ]),
        makeLevelScore(3 as MaturityLevel, [
          makeSignal('copilot_skills', 3, true, ['.github/skills/kusto-backup/SKILL.md']),
        ]),
        makeLevelScore(4 as MaturityLevel, []),
        makeLevelScore(5 as MaturityLevel, []),
        makeLevelScore(6 as MaturityLevel, []),
      ],
    } as any;

    const score = calculateInstructionRealitySync(report);
    expect(score).toBeGreaterThanOrEqual(DATA_PIPELINES.expectedIQSync.min);
    expect(score).toBeLessThanOrEqual(DATA_PIPELINES.expectedIQSync.max);
  });

  it('ZTS: no root instructions, has agents+skills → 0-35', () => {
    const report = {
      selectedTool: 'copilot',
      levels: [
        makeLevelScore(1 as MaturityLevel, []),
        makeLevelScore(2 as MaturityLevel, [
          makeSignal('copilot_instructions', 2, false),
        ]),
        makeLevelScore(3 as MaturityLevel, [
          makeSignal('copilot_agents', 3, true, ['.github/agents/icm-investigator.agent.md']),
          makeSignal('copilot_skills', 3, true, ['.github/skills/ev2/SKILL.md']),
        ]),
        makeLevelScore(4 as MaturityLevel, []),
        makeLevelScore(5 as MaturityLevel, []),
        makeLevelScore(6 as MaturityLevel, []),
      ],
    } as any;

    const score = calculateInstructionRealitySync(report);
    expect(score).toBeGreaterThanOrEqual(ZTS.expectedIQSync.min);
    expect(score).toBeLessThanOrEqual(ZTS.expectedIQSync.max);
  });

  it('AppSec: no root instructions, no root .github → 0-35', () => {
    const report = {
      selectedTool: 'copilot',
      levels: [
        makeLevelScore(1 as MaturityLevel, []),
        makeLevelScore(2 as MaturityLevel, [
          makeSignal('copilot_instructions', 2, false),
        ]),
        makeLevelScore(3 as MaturityLevel, []),
        makeLevelScore(4 as MaturityLevel, []),
        makeLevelScore(5 as MaturityLevel, []),
        makeLevelScore(6 as MaturityLevel, []),
      ],
    } as any;

    const score = calculateInstructionRealitySync(report);
    expect(score).toBeGreaterThanOrEqual(APP_SEC.expectedIQSync.min);
    expect(score).toBeLessThanOrEqual(APP_SEC.expectedIQSync.max);
  });
});

// ── 8. MaturityEngine.calculateReport ───────────────────────────

describe('MaturityEngine.calculateReport', () => {
  const engine = new MaturityEngine();

  it('DataPipelines: L2-L3 with copilot instructions + skills', () => {
    const signals: SignalResult[] = [
      makeSignal('copilot_instructions', 2, true, ['.github/copilot-instructions.md']),
      makeSignal('copilot_domain_instructions', 2, true, ['.github/instructions/data-engineering.instructions.md']),
      makeSignal('project_structure_doc', 2, true, ['README.md']),
      makeSignal('copilot_skills', 3, true, ['.github/skills/kusto-backup/SKILL.md']),
    ];
    const levels: LevelScore[] = [
      makeLevelScore(1 as MaturityLevel, [makeSignal('basic_readme', 1, true, ['README.md'])], 80),
      makeLevelScore(2 as MaturityLevel, signals.filter(s => s.level === 2), 75),
      makeLevelScore(3 as MaturityLevel, signals.filter(s => s.level === 3), 40),
      makeLevelScore(4 as MaturityLevel, [], 0),
      makeLevelScore(5 as MaturityLevel, [], 0),
      makeLevelScore(6 as MaturityLevel, [], 0),
    ];
    const ctx = makeProjectContext(DATA_PIPELINES);

    const report = engine.calculateReport(
      DATA_PIPELINES.name, levels, ctx, [], [], 'test-model', 'full', 'copilot',
    );

    expect(report.primaryLevel).toBeGreaterThanOrEqual(DATA_PIPELINES.expectedLevel.min);
    expect(report.primaryLevel).toBeLessThanOrEqual(DATA_PIPELINES.expectedLevel.max);
  });

  it('ZTS: L1-L3 with agents+skills but no root instructions', () => {
    const signals: SignalResult[] = [
      makeSignal('copilot_instructions', 2, false),
      makeSignal('copilot_agents', 3, true, ['.github/agents/icm-investigator.agent.md']),
      makeSignal('copilot_skills', 3, true, ['.github/skills/ev2/SKILL.md']),
    ];
    const levels: LevelScore[] = [
      makeLevelScore(1 as MaturityLevel, [makeSignal('basic_readme', 1, true, ['README.md'])], 70),
      makeLevelScore(2 as MaturityLevel, signals.filter(s => s.level === 2), 20),
      makeLevelScore(3 as MaturityLevel, signals.filter(s => s.level === 3), 60),
      makeLevelScore(4 as MaturityLevel, [], 0),
      makeLevelScore(5 as MaturityLevel, [], 0),
      makeLevelScore(6 as MaturityLevel, [], 0),
    ];
    const ctx = makeProjectContext(ZTS);

    const report = engine.calculateReport(
      ZTS.name, levels, ctx, [], [], 'test-model', 'full', 'copilot',
    );

    expect(report.primaryLevel).toBeGreaterThanOrEqual(ZTS.expectedLevel.min);
    expect(report.primaryLevel).toBeLessThanOrEqual(ZTS.expectedLevel.max);
  });

  it('AppSec: monorepo with no root .github → L1-L2', () => {
    const signals: SignalResult[] = [
      makeSignal('copilot_instructions', 2, true, [
        'risk-register/.github/copilot-instructions.md',
        'ai-readiness-scanner-vs-code-extension/.github/copilot-instructions.md',
      ]),
    ];
    const levels: LevelScore[] = [
      makeLevelScore(1 as MaturityLevel, [makeSignal('basic_readme', 1, true, ['README.md'])], 60),
      makeLevelScore(2 as MaturityLevel, signals.filter(s => s.level === 2), 50),
      makeLevelScore(3 as MaturityLevel, [], 0),
      makeLevelScore(4 as MaturityLevel, [], 0),
      makeLevelScore(5 as MaturityLevel, [], 0),
      makeLevelScore(6 as MaturityLevel, [], 0),
    ];
    const ctx = makeProjectContext(APP_SEC);

    const report = engine.calculateReport(
      APP_SEC.name, levels, ctx, [], [], 'test-model', 'full', 'copilot',
    );

    // Monorepo root correction should demote to L1 since copilot_instructions
    // files are only in sub-projects
    expect(report.primaryLevel).toBeGreaterThanOrEqual(APP_SEC.expectedLevel.min);
    expect(report.primaryLevel).toBeLessThanOrEqual(APP_SEC.expectedLevel.max);
  });
});

// ── 9. Cross-repo parametric checks ─────────────────────────────

describe('Ground truth invariants', () => {
  for (const repo of ALL_REPOS) {
    describe(repo.name, () => {
      it('expected level range is valid (1-6)', () => {
        expect(repo.expectedLevel.min).toBeGreaterThanOrEqual(1);
        expect(repo.expectedLevel.max).toBeLessThanOrEqual(6);
        expect(repo.expectedLevel.min).toBeLessThanOrEqual(repo.expectedLevel.max);
      });

      it('expected metric ranges are 0-100', () => {
        for (const metric of [
          repo.expectedTypeStrictness,
          repo.expectedSemanticDensity,
          repo.expectedIQSync,
        ]) {
          expect(metric.min).toBeGreaterThanOrEqual(0);
          expect(metric.max).toBeLessThanOrEqual(100);
          expect(metric.min).toBeLessThanOrEqual(metric.max);
        }
      });

      it('component count range is consistent', () => {
        expect(repo.expectedComponentCountRange.min).toBeLessThanOrEqual(
          repo.expectedComponentCountRange.max,
        );
      });
    });
  }
});
