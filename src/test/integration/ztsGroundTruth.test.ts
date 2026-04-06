import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { computeBlendedSemanticDensity, computeTypeStrictness, type FileAnalysis } from '../../metrics/codebaseMetrics';
import { GENERIC_DIRS, validateComponentName } from '../../deep/validators/componentNameValidator';
import { MaturityEngine } from '../../scoring/maturityEngine';
import { calculateInstructionRealitySync } from '../../report/instructionRealitySync';
import type { LevelScore, MaturityLevel, ProjectContext } from '../../scoring/types';

const ZTS_EXPORT_PATH = '/Users/alexkeagel/Dev/ZTS/ai-readiness-graph-ZTS.json';

type ScanExport = {
  primaryLevel: number;
  componentScores: Array<{ path: string; name: string; language?: string }>;
  narrativeSections?: {
    platformReadiness?: Array<{ dimension: string; score: number }>;
  };
};

function loadZtsExport(): ScanExport | null {
  if (!existsSync(ZTS_EXPORT_PATH)) {
    return null;
  }
  return JSON.parse(readFileSync(ZTS_EXPORT_PATH, 'utf8')) as ScanExport;
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

describe('ZTS ground truth integration', () => {
  const zts = loadZtsExport();

  if (!zts) {
    it.skip('ZTS export not found', () => {});
    return;
  }

  it('ground truth snapshot: L3 with SD in range and strong type strictness', () => {
    const metrics = zts.narrativeSections?.platformReadiness ?? [];
    const semantic = metrics.find(m => m.dimension.includes('Semantic'));
    const strictness = metrics.find(m => m.dimension.includes('Type'));

    expect(zts.primaryLevel).toBe(3);
    expect(semantic?.score).toBeGreaterThanOrEqual(50);
    expect(semantic?.score).toBeLessThanOrEqual(70);
    expect(strictness?.score).toBeGreaterThanOrEqual(85);
    expect(strictness?.score).toBeLessThanOrEqual(95);
  });

  it('contains no .venv contamination and is C#-dominant', () => {
    const components = zts.componentScores ?? [];
    const csharp = components.filter(c => c.language === 'C#').length;
    const python = components.filter(c => c.language === 'Python').length;

    expect(components.every(c => !c.path.includes('.venv'))).toBe(true);
    expect(csharp).toBeGreaterThan(python);
  });

  it('component naming keeps real directory names for key code dirs', () => {
    const components = zts.componentScores ?? [];
    const storage = components.find(c => c.path === 'src/common/Storage');
    const dataProcessing = components.find(c => c.path === 'src/DataProcessing/DataProcessing.Application');

    expect(storage?.name.toLowerCase()).toContain('storage');
    expect(dataProcessing?.name.toLowerCase()).toContain('dataprocessing');

    for (const component of components) {
      const baseDir = component.path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? component.path;
      const isGeneric = GENERIC_DIRS.has(baseDir.toLowerCase()) || baseDir.length <= 3;
      const validated = validateComponentName(component.path, component.name, component.language);
      if (!isGeneric) {
        expect(validated.validatedName.toLowerCase()).toContain(baseDir.toLowerCase());
      }
    }
  });
});

describe('ZTS scanner function assertions', () => {
  it('computeTypeStrictness lands in 85-95 for C# strict + minority Python hints', () => {
    const csharpFiles: FileAnalysis[] = Array.from({ length: 14 }, (_, i) => ({
      path: `src/csharp/Component${i}.cs`,
      language: 'csharp',
      totalLines: 650,
      commentLines: 70,
      blankLines: 70,
      importCount: 12,
      typeAnnotationCount: 130,
      declarationCount: 130,
      hasStrictMode: false,
      totalProcedures: 45,
      documentedProcedures: 16,
    }));

    const pythonFiles: FileAnalysis[] = Array.from({ length: 2 }, (_, i) => ({
      path: `src/python/module_${i}.py`,
      language: 'python',
      totalLines: 360,
      commentLines: 40,
      blankLines: 60,
      importCount: 8,
      typeAnnotationCount: 23,
      declarationCount: 100,
      hasStrictMode: false,
      totalProcedures: 22,
      documentedProcedures: 8,
    }));

    const buildProps: FileAnalysis = {
      path: 'Directory.Build.props',
      language: 'xml',
      totalLines: 40,
      commentLines: 0,
      blankLines: 4,
      importCount: 0,
      typeAnnotationCount: 0,
      declarationCount: 0,
      hasStrictMode: true,
      totalProcedures: 0,
      documentedProcedures: 0,
    };

    const score = computeTypeStrictness([...csharpFiles, ...pythonFiles, buildProps]);
    expect(score).toBeGreaterThanOrEqual(85);
    expect(score).toBeLessThanOrEqual(95);
  });

  it('computeBlendedSemanticDensity lands in 50-70 for ZTS-scale C# docs', () => {
    const score = computeBlendedSemanticDensity(2_000, 700, 100_000, 11_000);
    expect(score).toBeGreaterThanOrEqual(50);
    expect(score).toBeLessThanOrEqual(70);
  });

  it('non-monorepo level qualification reaches L3 without root copilot_instructions', () => {
    const engine = new MaturityEngine();

    const levels: LevelScore[] = [
      mkLevel(1, 80, [{
        signalId: 'codebase_type_strictness',
        level: 1,
        detected: true,
        score: 90,
        finding: 'Strong strictness',
        files: [],
        confidence: 'high',
      }]),
      mkLevel(2, 55, [
        {
          signalId: 'copilot_instructions',
          level: 2,
          detected: false,
          score: 0,
          finding: 'Missing root file',
          files: [],
          confidence: 'high',
        },
        {
          signalId: 'project_structure_doc',
          level: 2,
          detected: true,
          score: 70,
          finding: 'README exists',
          files: ['README.md'],
          confidence: 'high',
        },
        {
          signalId: 'conventions_documented',
          level: 2,
          detected: true,
          score: 60,
          finding: 'Conventions documented',
          files: ['CONTRIBUTING.md'],
          confidence: 'high',
        },
        {
          signalId: 'ignore_files',
          level: 2,
          detected: true,
          score: 65,
          finding: 'Ignore files present',
          files: ['.gitignore'],
          confidence: 'high',
        },
      ]),
      mkLevel(3, 60, [{
        signalId: 'copilot_l3_skills_and_tools',
        level: 3,
        detected: true,
        score: 80,
        finding: 'Agents and skills found',
        files: ['.github/agents/icm-investigator.agent.md', '.github/skills/icm-investigator/SKILL.md'],
        confidence: 'high',
      }]),
    ];

    const projectContext: ProjectContext = {
      languages: ['C#', 'Python'],
      frameworks: [],
      projectType: 'app',
      packageManager: 'npm',
      directoryTree: '.',
      components: [],
    };

    const report = engine.calculateReport('ZTS', levels, projectContext, [], [], 'test', 'full', 'copilot');
    expect(report.primaryLevel).toBe(3);
  });

  it('instruction reality sync is capped at 35 without root instructions', () => {
    const score = calculateInstructionRealitySync({
      projectName: 'ZTS',
      scannedAt: new Date().toISOString(),
      primaryLevel: 3,
      levelName: 'Skill-Equipped',
      depth: 45,
      overallScore: 43,
      selectedTool: 'copilot',
      modelUsed: 'test',
      scanMode: 'full',
      projectContext: {
        languages: ['C#', 'Python'],
        frameworks: [],
        projectType: 'app',
        packageManager: 'npm',
        directoryTree: '.',
        components: [],
      },
      componentScores: [],
      languageScores: [],
      levels: [
        mkLevel(1, 80, []),
        mkLevel(2, 55, [
          {
            signalId: 'copilot_instructions',
            level: 2,
            detected: false,
            score: 0,
            finding: 'Missing root instruction file',
            files: [],
            confidence: 'high',
          },
          {
            signalId: 'project_structure_doc',
            level: 2,
            detected: true,
            score: 70,
            finding: 'README exists',
            files: ['README.md'],
            confidence: 'high',
          },
          {
            signalId: 'conventions_documented',
            level: 2,
            detected: true,
            score: 60,
            finding: 'Conventions documented',
            files: ['CONTRIBUTING.md'],
            confidence: 'high',
          },
        ]),
        mkLevel(3, 60, [
          {
            signalId: 'copilot_l3_skills_and_tools',
            level: 3,
            detected: true,
            score: 85,
            finding: 'Agents and skills found',
            files: ['.github/agents/icm-investigator.agent.md', '.github/skills/icm-investigator/SKILL.md'],
            confidence: 'high',
          },
        ]),
      ],
    } as any);

    expect(score).toBeLessThanOrEqual(35);
  });
});
