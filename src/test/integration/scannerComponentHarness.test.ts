import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateSignalScope } from '../../deep/validators/signalScopeValidator';
import { GENERIC_DIRS, validateComponentName } from '../../deep/validators/componentNameValidator';
import { MaturityEngine } from '../../scoring/maturityEngine';
import { computeBlendedSemanticDensity } from '../../metrics/codebaseMetrics';
import type { ComponentScore, LanguageScore, LevelScore, MaturityLevel, ProjectContext } from '../../scoring/types';

const DP_EXPORT = '/Users/alexkeagel/Dev/AzNet-ApplicationSecurity-DataPipelines/ai-readiness-graph-AzNet-ApplicationSecurity-DataPipelines.json';
const ZTS_EXPORT = '/Users/alexkeagel/Dev/ZTS/ai-readiness-graph-ZTS.json';
const APPSEC_EXPORT = '/Users/alexkeagel/Dev/AzNet-Application-Security/ai-readiness-graph-AzNet-Application-Security.json';

function loadGraphExport(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function dirName(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments[segments.length - 1] || path;
}

function mkLevel(level: MaturityLevel, rawScore: number, signals: LevelScore['signals']): LevelScore {
  return {
    level,
    name: `Level ${level}`,
    rawScore,
    qualified: false,
    signals,
    signalsDetected: signals.filter(s => s.detected).length,
    signalsTotal: signals.length,
  };
}

describe('scanner component harness (real-repo patterns)', () => {
  it('validateSignalScope: AppSec-style sub-project instruction file does not count as root detection', () => {
    const scope = validateSignalScope(
      'copilot_l2_instructions',
      ['ai-readiness-scanner-vs-code-extension/.github/copilot-instructions.md'],
      ['ai-readiness-scanner-vs-code-extension', 'risk-register'],
    );

    expect(scope.isRootDetected).toBe(false);
    expect(scope.rootFiles).toEqual([]);
    expect(scope.subProjectFiles).toEqual(['ai-readiness-scanner-vs-code-extension/.github/copilot-instructions.md']);
  });

  it('validateComponentName: real component names across DP/ZTS/AppSec keep real directory name for non-generic paths', () => {
    const allComponents = [
      ...loadGraphExport(DP_EXPORT).componentScores,
      ...loadGraphExport(ZTS_EXPORT).componentScores,
      ...loadGraphExport(APPSEC_EXPORT).componentScores,
    ] as ComponentScore[];

    expect(allComponents.length).toBeGreaterThan(0);

    for (const component of allComponents) {
      const baseDir = dirName(component.path);
      const isGeneric = GENERIC_DIRS.has(baseDir.toLowerCase()) || baseDir.length <= 3;
      const validation = validateComponentName(component.path, component.name, component.language);

      if (!isGeneric) {
        expect(
          validation.validatedName.toLowerCase(),
          `Expected non-generic component to include real dir: ${component.path} -> ${validation.validatedName}`,
        ).toContain(baseDir.toLowerCase());
      }
    }
  });

  it('MaturityEngine.calculateReport: monorepo L2 signal detected only in sub-project is capped at L1', () => {
    const engine = new MaturityEngine();

    const levels: LevelScore[] = [
      mkLevel(1, 75, [
        {
          signalId: 'codebase_semantic_density',
          level: 1,
          detected: true,
          score: 75,
          finding: 'Semantic density strong',
          files: [],
          confidence: 'high',
        },
      ]),
      mkLevel(2, 80, [
        {
          signalId: 'copilot_l2_instructions',
          level: 2,
          detected: true,
          score: 85,
          finding: 'Found in nested project',
          files: ['ai-readiness-scanner-vs-code-extension/.github/copilot-instructions.md'],
          confidence: 'high',
        },
      ]),
    ];

    const projectContext: ProjectContext = {
      languages: ['TypeScript', 'Go'],
      frameworks: [],
      projectType: 'monorepo',
      packageManager: 'npm',
      directoryTree: '.',
      components: [
        { name: 'scanner', path: 'ai-readiness-scanner-vs-code-extension', language: 'TypeScript', type: 'app', parentPath: '' },
        { name: 'risk-register', path: 'risk-register', language: 'Go', type: 'service', parentPath: '' },
      ],
    };

    const report = engine.calculateReport(
      'AzNet-Application-Security',
      levels,
      projectContext,
      [],
      [] as LanguageScore[],
      'test',
      'full',
      'copilot',
    );

    expect(report.primaryLevel).toBe(1);
  });

  it('computeBlendedSemanticDensity: DP/ZTS/AppSec-like ranges', () => {
    const dp = computeBlendedSemanticDensity(500, 430, 50_000, 5_000);
    expect(dp).toBeGreaterThanOrEqual(55);
    expect(dp).toBeLessThanOrEqual(75);

    const zts = computeBlendedSemanticDensity(2_000, 700, 100_000, 10_000);
    expect(zts).toBeGreaterThanOrEqual(50);
    expect(zts).toBeLessThanOrEqual(70);

    const appSecRootOnly = computeBlendedSemanticDensity(15, 15, 2_000, 200);
    expect(appSecRootOnly).toBeLessThanOrEqual(60);
  });
});
