import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { validateComponentName } from '../../deep/validators/componentNameValidator';
import { validateSignalScope } from '../../deep/validators/signalScopeValidator';
import { applySemanticDensitySampleGate } from '../../scanner/maturityScanner';
import { MaturityEngine } from '../../scoring/maturityEngine';
import type { LanguageScore, LevelScore, MaturityLevel, ProjectContext } from '../../scoring/types';

const APPSEC_REPO = '/Users/alexkeagel/Dev/AzNet-Application-Security';
const APPSEC_EXPORT = join(APPSEC_REPO, 'ai-readiness-graph-AzNet-Application-Security.json');
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);

function walkFiles(rootDir: string): string[] {
  const results: string[] = [];

  const visit = (currentDir: string) => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }

      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }

      results.push(relative(rootDir, fullPath).replace(/\\/g, '/'));
    }
  };

  visit(rootDir);
  return results.sort();
}

function topLevelDirs(rootDir: string): string[] {
  return readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort();
}

function detectSubProjects(rootDir: string): string[] {
  return topLevelDirs(rootDir).filter(dirName =>
    existsSync(join(rootDir, dirName, '.github', 'copilot-instructions.md')) ||
    existsSync(join(rootDir, dirName, 'package.json')) ||
    existsSync(join(rootDir, dirName, 'pyproject.toml'))
  );
}

function loadExport(): any | null {
  if (!existsSync(APPSEC_EXPORT)) {
    return null;
  }

  return JSON.parse(readFileSync(APPSEC_EXPORT, 'utf8'));
}

function mkLevel(level: MaturityLevel, rawScore: number, signals: LevelScore['signals']): LevelScore {
  return {
    level,
    name: `Level ${level}`,
    rawScore,
    qualified: false,
    signals,
    signalsDetected: signals.filter(signal => signal.detected).length,
    signalsTotal: signals.length,
  };
}

describe('AppSec ground truth', () => {
  const allFiles = walkFiles(APPSEC_REPO);
  const subProjects = detectSubProjects(APPSEC_REPO);
  const topDirs = topLevelDirs(APPSEC_REPO);
  const copilotInstructionFiles = allFiles.filter(file => file.endsWith('copilot-instructions.md'));
  const instructionFiles = allFiles.filter(file => file.endsWith('.instructions.md'));
  const agentAndSkillFiles = allFiles.filter(file => file.endsWith('.agent.md') || file.endsWith('/SKILL.md'));

  it('matches the expected monorepo shape', () => {
    expect(topDirs).toEqual([
      'CRStoXMLConverter',
      'agc-setup',
      'ai-readiness-scanner-vs-code-extension',
      'appgw-quick-test',
      'benchmark-automation',
      'cline-compliance',
      'lrt',
      'risk-register',
      'slices',
      'waf-evaluation',
    ]);

    expect(existsSync(join(APPSEC_REPO, '.github'))).toBe(false);
    expect(subProjects).toEqual([
      'ai-readiness-scanner-vs-code-extension',
      'cline-compliance',
      'risk-register',
    ]);
  });

  it('finds instructions, agents, and skills only below nested projects', () => {
    expect(copilotInstructionFiles).toEqual([
      'ai-readiness-scanner-vs-code-extension/.github/copilot-instructions.md',
      'lrt/appgw/.github/copilot-instructions.md',
      'risk-register/.github/copilot-instructions.md',
    ]);

    expect(instructionFiles).toEqual([
      'ai-readiness-scanner-vs-code-extension/.github/instructions/scoring.instructions.md',
      'ai-readiness-scanner-vs-code-extension/.github/instructions/typescript.instructions.md',
      'ai-readiness-scanner-vs-code-extension/.github/instructions/vscode-extension.instructions.md',
    ]);

    expect(agentAndSkillFiles.some(file => file.startsWith('.github/'))).toBe(false);
    expect(agentAndSkillFiles.some(file => file.startsWith('ai-readiness-scanner-vs-code-extension/.github/agents/'))).toBe(true);
    expect(agentAndSkillFiles.some(file => file.startsWith('risk-register/.github/skills/'))).toBe(true);
  });

  it('confirms risk-register is the nested Copilot-ready component', () => {
    expect(existsSync(join(APPSEC_REPO, 'risk-register', '.github', 'copilot-instructions.md'))).toBe(true);
    expect(statSync(join(APPSEC_REPO, 'risk-register', '.github', 'agents')).isDirectory()).toBe(true);
    expect(statSync(join(APPSEC_REPO, 'risk-register', '.github', 'skills')).isDirectory()).toBe(true);
  });
});

describe('AppSec scanner guards', () => {
  it('validateSignalScope keeps nested Copilot instructions out of root scoring', () => {
    const scope = validateSignalScope(
      'copilot_l2_instructions',
      [
        'ai-readiness-scanner-vs-code-extension/.github/copilot-instructions.md',
        'risk-register/.github/copilot-instructions.md',
      ],
      ['ai-readiness-scanner-vs-code-extension', 'risk-register', 'cline-compliance'],
    );

    expect(scope.isRootDetected).toBe(false);
    expect(scope.rootFiles).toEqual([]);
    expect(scope.subProjectFiles).toEqual([
      'ai-readiness-scanner-vs-code-extension/.github/copilot-instructions.md',
      'risk-register/.github/copilot-instructions.md',
    ]);
  });

  it('MaturityEngine.calculateReport caps an AppSec-like root report at L1 when only nested files are detected', () => {
    const engine = new MaturityEngine();
    const levels: LevelScore[] = [
      mkLevel(1, 70, [
        {
          signalId: 'codebase_type_strictness',
          level: 1,
          detected: true,
          score: 58,
          finding: 'Mixed languages and scripts at the monorepo root',
          files: [],
          confidence: 'high',
        },
        {
          signalId: 'codebase_semantic_density',
          level: 1,
          detected: true,
          score: 60,
          finding: 'Small root-owned sample capped for confidence',
          files: [],
          confidence: 'low',
        },
      ]),
      mkLevel(2, 82, [
        {
          signalId: 'copilot_l2_instructions',
          level: 2,
          detected: true,
          score: 92,
          finding: 'Nested instructions found in sub-projects',
          files: ['ai-readiness-scanner-vs-code-extension/.github/copilot-instructions.md'],
          confidence: 'high',
        },
      ]),
      mkLevel(3, 76, [
        {
          signalId: 'copilot_l3_skills_and_tools',
          level: 3,
          detected: true,
          score: 88,
          finding: 'Nested skills found in risk-register',
          files: ['risk-register/.github/skills/score-impact/SKILL.md'],
          confidence: 'high',
        },
      ]),
    ];

    const projectContext: ProjectContext = {
      languages: ['Python', 'JavaScript', 'Go', 'TypeScript'],
      frameworks: [],
      projectType: 'monorepo',
      packageManager: 'npm',
      directoryTree: '.',
      components: [
        { name: 'CRStoXMLConverter', path: 'CRStoXMLConverter', language: 'Python', type: 'app', parentPath: '' },
        { name: 'ai-readiness-scanner-vs-code-extension', path: 'ai-readiness-scanner-vs-code-extension', language: 'TypeScript', type: 'app', parentPath: '' },
        { name: 'risk-register', path: 'risk-register', language: 'Python', type: 'service', parentPath: '' },
        { name: 'cline-compliance', path: 'cline-compliance', language: 'TypeScript', type: 'app', parentPath: '' },
      ],
    };

    const report = engine.calculateReport(
      'AzNet-Application-Security',
      levels,
      projectContext,
      [],
      [] as LanguageScore[],
      'test-model',
      'full',
      'copilot',
    );

    expect(report.primaryLevel).toBe(1);
  });

  it('small root-only semantic-density samples stay capped even when documentation ratio is high', () => {
    const summary = applySemanticDensitySampleGate(88, 6);

    expect(summary.score).toBeLessThanOrEqual(60);
    expect(summary.score).toBe(60);
    expect(summary.confidence).toBe('low');
  });

  it('preserves real AppSec sub-project names', () => {
    expect(validateComponentName('risk-register', 'Enterprise Risk Portal').validatedName).toBe('risk-register');
    expect(validateComponentName('ai-readiness-scanner-vs-code-extension', 'AI Maturity Assessment Tool').validatedName)
      .toBe('ai-readiness-scanner-vs-code-extension');
    expect(validateComponentName('cline-compliance', 'Compliance Automation Hub').validatedName).toBe('cline-compliance');
  });
});

describe('AppSec export comparison', () => {
  const graphExport = loadExport();

  if (!graphExport) {
    it.skip('AppSec export is not present', () => {});
    return;
  }

  it('keeps IQ Sync low and retains risk-register as a named nested component', () => {
    const iqMetric = graphExport.narrativeSections?.platformReadiness?.find((metric: any) =>
      String(metric.dimension).includes('Instruction/Reality Sync')
    );
    const riskRegister = graphExport.componentScores?.find((component: any) => component.path === 'risk-register');

    expect(iqMetric?.score).toBeLessThanOrEqual(30);
    expect(riskRegister).toBeDefined();
    expect(validateComponentName(riskRegister.path, riskRegister.name).validatedName).toBe('risk-register');
  });
});
