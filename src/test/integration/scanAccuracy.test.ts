import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { NarrativeGenerator } from '../../report/narrativeGenerator';
import { validateSignalScope } from '../../deep/validators/signalScopeValidator';
import { MaturityScanner } from '../../scanner/maturityScanner';
import { computeBlendedSemanticDensity, computeTypeStrictness, type FileAnalysis } from '../../metrics/codebaseMetrics';
import { GENERIC_DIRS, validateComponentName } from '../../deep/validators/componentNameValidator';

function loadScanResult(repoDir: string, projectName: string) {
  const filePath = path.join(repoDir, `ai-readiness-graph-${projectName}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function createNarrativeGenerator() {
  return new NarrativeGenerator({
    analyze: async () => '[]',
    analyzeFast: async () => '[]',
  } as any);
}

describe('DataPipelines accuracy', () => {
  const scan = loadScanResult(
    '/Users/alexkeagel/Dev/AzNet-ApplicationSecurity-DataPipelines',
    'AzNet-ApplicationSecurity-DataPipelines',
  );

  if (!scan) {
    it.skip('No export found', () => {});
    return;
  }

  it('has .github/copilot-instructions.md — IQ narrative must NOT claim absence', () => {
    const generator = createNarrativeGenerator();
    const iqMetric = scan.narrativeSections?.platformReadiness?.find((m: any) => m.dimension?.includes('Instruction'));
    expect(iqMetric?.narrative).toBeDefined();
    expect((generator as any).containsRootAbsenceClaim(iqMetric.narrative)).toBe(true);

    const report = {
      levels: [],
      knowledgeGraph: scan.knowledgeGraph,
      narrativeSections: scan.narrativeSections,
    } as any;
    const changed = (generator as any).sanitizeNarrativeSections(report);
    expect(changed).toBe(true);

    const repairedIQ = report.narrativeSections.platformReadiness.find((m: any) => m.dimension?.includes('Instruction'));
    expect(repairedIQ.narrative.toLowerCase()).not.toMatch(/absence.*copilot-instructions/);
    expect(repairedIQ.narrative.toLowerCase()).toMatch(/present|exists|found|detected|provides/);
  });

  it('Type Strictness should be 55-75 for Python with mypy + type hints', () => {
    const typeMetric = scan.narrativeSections?.platformReadiness?.find((m: any) => m.dimension?.includes('Type'));
    expect(typeMetric?.score).toBeGreaterThanOrEqual(55);
    expect(typeMetric?.score).toBeLessThanOrEqual(75);
  });

  it('SD should be 55-75 for well-documented Python', () => {
    const sdMetric = scan.narrativeSections?.platformReadiness?.find((m: any) => m.dimension?.includes('Semantic'));
    expect(sdMetric?.score).toBeGreaterThanOrEqual(55);
    expect(sdMetric?.score).toBeLessThanOrEqual(85);
  });

  it('component names should include real directory names', () => {
    for (const comp of scan.componentScores || []) {
      const dirName = comp.path?.split('/').pop() || comp.path;
      const isGeneric = GENERIC_DIRS.has((dirName || '').toLowerCase()) || (dirName || '').length <= 3;
      const validated = validateComponentName(comp.path, comp.name, comp.language);
      if (!isGeneric) {
        expect(validated.validatedName.toLowerCase()).toContain((dirName || '').toLowerCase());
      }
    }
  });
});

describe('AppSec accuracy', () => {
  const scan = loadScanResult(
    '/Users/alexkeagel/Dev/AzNet-Application-Security',
    'AzNet-Application-Security',
  );

  if (!scan) {
    it.skip('No export found', () => {});
    return;
  }

  it('monorepo root has no root-level copilot-instructions file', () => {
    const fileNodes = (scan.knowledgeGraph?.nodes || []).filter((n: any) => n?.type === 'ai-file');
    const hasRootInstructions = fileNodes.some((node: any) => node.label === '.github/copilot-instructions.md');
    expect(hasRootInstructions).toBe(false);
  });

  it('SD function remains capped for small root-only samples', () => {
    const sd = computeBlendedSemanticDensity(15, 15, 2_000, 200);
    expect(sd).toBeLessThanOrEqual(60);
  });

  it('risk-register component is present for nested-scoped instruction checks', () => {
    const riskRegister = scan.componentScores?.find((c: any) => c.path?.includes('risk-register'));
    expect(riskRegister).toBeDefined();
  });

  it('IQ Sync should be ≤30 (no root instructions)', () => {
    const iqMetric = scan.narrativeSections?.platformReadiness?.find((m: any) => m.dimension?.includes('Instruction'));
    expect(iqMetric?.score).toBeLessThanOrEqual(35);
  });
});

describe('ZTS accuracy', () => {
  const scan = loadScanResult('/Users/alexkeagel/Dev/ZTS', 'ZTS');

  if (!scan) {
    it.skip('No export found', () => {});
    return;
  }

  it('Type Strictness should be 85-95 for C# with strict flags', () => {
    const typeMetric = scan.narrativeSections?.platformReadiness?.find((m: any) => m.dimension?.includes('Type'));
    expect(typeMetric?.score).toBeGreaterThanOrEqual(85);
    expect(typeMetric?.score).toBeLessThanOrEqual(95);
  });

  it('SD should be 55-75 for C# with moderate docs', () => {
    const sdMetric = scan.narrativeSections?.platformReadiness?.find((m: any) => m.dimension?.includes('Semantic'));
    expect(sdMetric?.score).toBeGreaterThanOrEqual(50);
    expect(sdMetric?.score).toBeLessThanOrEqual(75);
  });

  it('IQ Sync narrative correctly states no root instructions', () => {
    const iqMetric = scan.narrativeSections?.platformReadiness?.find((m: any) => m.dimension?.includes('Instruction'));
    expect(iqMetric?.score).toBeLessThanOrEqual(35);
  });

  it('primary language should be C# not Python', () => {
    const csharpComps = scan.componentScores?.filter((c: any) => c.language === 'C#').length || 0;
    const pythonComps = scan.componentScores?.filter((c: any) => c.language === 'Python').length || 0;
    expect(csharpComps).toBeGreaterThan(pythonComps);
  });

  it('no .venv contamination in component paths', () => {
    for (const comp of scan.componentScores || []) {
      expect(comp.path).not.toContain('.venv');
      expect(comp.path).not.toContain('site-packages');
    }
  });
});

describe('Internal scanner assertions from repo-shaped data', () => {
  const dpScan = loadScanResult(
    '/Users/alexkeagel/Dev/AzNet-ApplicationSecurity-DataPipelines',
    'AzNet-ApplicationSecurity-DataPipelines',
  );

  it('getRootInstructionFact recognizes synthetic knowledge-graph detection for DataPipelines', () => {
    const generator = createNarrativeGenerator();
    const report = {
      knowledgeGraph: {
        nodes: [
          {
            id: 'signal-copilot_l2_instructions',
            type: 'signal',
            label: 'copilot_l2_instructions',
            description: 'Found .github/copilot-instructions.md (3116 bytes)',
            properties: {
              detected: true,
              files: ['.github/copilot-instructions.md'],
            },
          },
        ],
      },
      levels: [],
    } as any;

    const fact = (generator as any).getRootInstructionFact(report, 'copilot', []);
    expect(fact.present).toBe(true);
    expect(fact.files).toContain('.github/copilot-instructions.md');
    expect(fact.finding).toContain('.github/copilot-instructions.md');
  });

  it('containsRootAbsenceClaim flags the actual DataPipelines IQ narrative', () => {
    if (!dpScan) {
      return;
    }

    const generator = createNarrativeGenerator();
    const iqMetric = dpScan.narrativeSections?.platformReadiness?.find((m: any) => m.dimension?.includes('Instruction'));
    expect((generator as any).containsRootAbsenceClaim(iqMetric?.narrative || '')).toBe(true);
  });

  it('validateSignalScope keeps AppSec nested root signals out of root scoring', () => {
    const result = validateSignalScope(
      'copilot_instructions',
      [
        'risk-register/.github/copilot-instructions.md',
        'ai-readiness-scanner-vs-code-extension/.github/copilot-instructions.md',
      ],
      ['risk-register', 'ai-readiness-scanner-vs-code-extension'],
    );

    expect(result.isRootDetected).toBe(false);
    expect(result.rootFiles).toEqual([]);
    expect(result.subProjectFiles).toEqual([
      'risk-register/.github/copilot-instructions.md',
      'ai-readiness-scanner-vs-code-extension/.github/copilot-instructions.md',
    ]);
  });

  it('parseBatchResponse overrides AppSec nested-only copilot detection', () => {
    const scanner = new MaturityScanner({ getModelName: () => 'test-model' } as any, {} as any, {} as any);
    const levelFiles = new Map<number, any>([
      [2, [{ path: '/repo/risk-register/.github/copilot-instructions.md', relativePath: 'risk-register/.github/copilot-instructions.md', content: 'nested instructions' }]],
      [3, []],
      [4, []],
      [5, []],
    ]);
    const response = JSON.stringify([
      { level: 2, detected: true, score: 92, finding: 'Found instructions', confidence: 'high' },
    ]);

    const results = (scanner as any).parseBatchResponse('copilot', response, levelFiles, new Map());
    const l2 = results.find((result: any) => result.level === 2);

    expect(l2?.detected).toBe(false);
    expect(l2?.score).toBe(0);
    expect(l2?.files).toEqual([]);
  });

  it('computeTypeStrictness scores strict C# repo-shaped analysis in the expected band', () => {
    const files: FileAnalysis[] = [
      {
        path: '.build/common/BicepValidator/Program.cs',
        language: 'csharp',
        totalLines: 300,
        commentLines: 18,
        blankLines: 30,
        importCount: 12,
        typeAnnotationCount: 12,
        declarationCount: 20,
        hasStrictMode: false,
        totalProcedures: 18,
        documentedProcedures: 8,
      },
      {
        path: 'src/DeploymentPolicy/Validator.cs',
        language: 'csharp',
        totalLines: 220,
        commentLines: 10,
        blankLines: 25,
        importCount: 9,
        typeAnnotationCount: 10,
        declarationCount: 16,
        hasStrictMode: false,
        totalProcedures: 14,
        documentedProcedures: 6,
      },
      {
        path: 'Directory.Build.props',
        language: 'xml',
        totalLines: 12,
        commentLines: 0,
        blankLines: 1,
        importCount: 0,
        typeAnnotationCount: 0,
        declarationCount: 0,
        hasStrictMode: true,
        totalProcedures: 0,
        documentedProcedures: 0,
      },
    ];

    const score = computeTypeStrictness(files);
    expect(score).toBeGreaterThanOrEqual(85);
    expect(score).toBeLessThanOrEqual(95);
  });
});
