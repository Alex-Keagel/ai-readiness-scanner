import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import {
  MaturityScanner,
  sanitizeFinding,
  applyLlmProcCorrection,
  applySemanticDensitySampleGate,
  filterRootFiles,
  selectRepresentativeSemanticDensitySample,
} from '../../scanner/maturityScanner';
import { RealityChecker } from '../../scanner/realityChecker';

describe('MaturityScanner prompt grounding', () => {
  it('injects verified-path instructions into the tool-level prompt', async () => {
    const scanner = new MaturityScanner({} as any, {} as any, {} as any);
    const checker = new RealityChecker();
    const realitySummary = checker.formatForPrompt({
      totalChecks: 2,
      valid: 2,
      invalid: 0,
      warnings: 0,
      accuracyScore: 100,
      checks: [
        { category: 'path', status: 'valid', claim: 'python-workspace', reality: 'exists', file: '.github/copilot-instructions.md' },
        { category: 'path', status: 'valid', claim: 'src/api', reality: 'exists', file: '.github/copilot-instructions.md' },
      ],
    });

    const prompt = await (scanner as any).buildToolLevelPrompt(
      'copilot',
      2,
      'instructions',
      [{ path: '.github/copilot-instructions.md', relativePath: '.github/copilot-instructions.md', content: 'Use python-workspace for Python tasks.' }],
      {
        languages: ['TypeScript', 'Python'],
        frameworks: [],
        projectType: 'app',
        packageManager: 'npm',
        directoryTree: 'python-workspace/\nsrc/\n  api/',
        components: [],
      },
      realitySummary
    );

    expect(prompt).toContain('GROUND TRUTH from filesystem verification');
    expect(prompt).toContain('Do NOT claim it is missing, non-existent, or hallucinated');
    expect(prompt).toContain('python-workspace');
  });

  it('adds explicit monorepo root-scope instructions to tool-level prompts', async () => {
    const scanner = new MaturityScanner({} as any, {} as any, {} as any);

    const prompt = await (scanner as any).buildToolLevelPrompt(
      'copilot',
      3,
      'skills_and_tools',
      [{ path: '.github/agents/root.agent.md', relativePath: '.github/agents/root.agent.md', content: 'Use repo-root agents.' }],
      {
        languages: ['TypeScript'],
        frameworks: [],
        projectType: 'monorepo',
        packageManager: 'pnpm',
        directoryTree: '.github/\npackages/\n  api/\n  web/',
        components: [],
      },
      '',
      ['packages/api', 'packages/web']
    );

    expect(prompt).toContain('MONOREPO ROOT-SCOPE RULES');
    expect(prompt).toContain('Evaluate ONLY repository-root files for root-level signals');
    expect(prompt).toContain('packages/api/');
    expect(prompt).toContain('packages/web/');
  });
});

describe('filterRootFiles', () => {
  it('excludes signal files inside sub-projects from root evaluation', () => {
    const files = [
      vscode.Uri.file('/repo/.github/copilot-instructions.md'),
      vscode.Uri.file('/repo/packages/api/.github/copilot-instructions.md'),
      vscode.Uri.file('/repo/packages/api/README.md'),
    ];

    const filtered = filterRootFiles(files, ['packages/api']);

    expect(filtered.map(file => file.fsPath)).toEqual(['/repo/.github/copilot-instructions.md']);
  });

  it('keeps root-level files when they are outside sub-projects', () => {
    const files = [
      vscode.Uri.file('/repo/.github/agents/root.agent.md'),
      vscode.Uri.file('/repo/README.md'),
    ];

    const filtered = filterRootFiles(files, ['packages/api']);

    expect(filtered).toHaveLength(2);
  });

  it('does not change file lists when no sub-project paths are provided', () => {
    const files = [
      vscode.Uri.file('/repo/.github/copilot-instructions.md'),
      vscode.Uri.file('/repo/packages/api/.github/copilot-instructions.md'),
    ];

    const filtered = filterRootFiles(files, []);

    expect(filtered).toHaveLength(2);
  });
});

describe('sanitizeFinding', () => {
  it('rewrites hallucinated missing-path findings when reality checks verified the path', () => {
    const finding = `The instructions suffer from high hallucination rates, referencing non-existent script paths and incorrect directory structures like 'python-workspace'.`;

    const sanitized = sanitizeFinding(finding, [
      { category: 'path', status: 'valid', claim: 'python-workspace', reality: 'exists', file: '.github/copilot-instructions.md' },
      { category: 'path', status: 'valid', claim: 'src/api', reality: 'exists', file: '.github/copilot-instructions.md' },
    ]);

    expect(sanitized).toContain('verified 2 path reference(s) on disk');
    expect(sanitized).toContain(`'python-workspace'`);
    expect(sanitized.toLowerCase()).not.toContain('non-existent');
    expect(sanitized.toLowerCase()).not.toContain('incorrect directory');
  });
});

describe('applyLlmProcCorrection', () => {
  it('caps documentation inflation to 1.5x before applying it', () => {
    const corrected = applyLlmProcCorrection(100, 40, 20, 4, 20, 20);

    expect(corrected.applied).toBe(true);
    expect(corrected.totalProcs).toBe(100);
    expect(corrected.docProcs).toBe(60);
  });

  it('caps corrected documented procedures at 85% of total procedures', () => {
    const corrected = applyLlmProcCorrection(100, 70, 20, 10, 20, 30);

    expect(corrected.applied).toBe(true);
    expect(corrected.totalProcs).toBe(100);
    expect(corrected.docProcs).toBe(85);
  });
});

describe('applyLlmProcCorrection', () => {
  it('applies correction when factors are within bounds', () => {
    // regex: 500 total, 200 doc (40%). LLM: 600 total, 300 doc
    const result = applyLlmProcCorrection(500, 200, 500, 200, 600, 300);
    expect(result.applied).toBe(true);
    expect(result.totalProcs).toBe(600); // 500 * 1.2
    // docFactor=1.5 → 200*1.5=300, ratio=300/600=50% so the 85% cap does not apply
    expect(result.docProcs).toBe(300);
  });

  it('caps doc inflation at 1.5x even when the LLM is higher', () => {
    // regex: 500 total, 200 doc (40%). LLM inflates doc heavily: docFactor=1.75
    const result = applyLlmProcCorrection(500, 200, 500, 200, 500, 350);
    expect(result.applied).toBe(true);
    // cappedDocFactor=min(1.75, 1.5)=1.5 → 200*1.5=300
    expect(result.docProcs).toBe(300);
  });

  it('caps absolute corrected ratio at 85%', () => {
    // regex: 500 total, 400 doc (80%). LLM: 500 total, 480 doc
    const result = applyLlmProcCorrection(500, 400, 500, 400, 500, 480);
    expect(result.applied).toBe(true);
    // docFactor=480/400=1.2 → docProcs=400*1.2=480, then cap to 500*0.85 = 425
    expect(result.docProcs).toBe(425);
  });

  it('skips correction when factor is too extreme', () => {
    // totalFactor = 5000/500 = 10 → >3.0 → skip
    const result = applyLlmProcCorrection(500, 200, 500, 200, 5000, 4000);
    expect(result.applied).toBe(false);
    expect(result.totalProcs).toBe(500);
    expect(result.docProcs).toBe(200);
  });

  it('skips when regexRatio > 0.3 and llmRatio < 0.1', () => {
    // regex ratio=40%, LLM ratio=5% → skip
    const result = applyLlmProcCorrection(500, 200, 500, 200, 600, 30);
    expect(result.applied).toBe(false);
  });
});

describe('semantic density sampling helpers', () => {
  it('caps semantic density for tiny non-test samples', () => {
    const result = applySemanticDensitySampleGate(80, 3);

    expect(result.score).toBe(60);
    expect(result.confidence).toBe('low');
    expect(result.note).toContain('Low confidence');
  });

  it('stratifies by component/language and spreads sizes', () => {
    const sample = selectRepresentativeSemanticDensitySample([
      { path: 'services/api/a.ts', language: 'typescript', component: 'services/api', size: 10, isTest: false },
      { path: 'services/api/b.ts', language: 'typescript', component: 'services/api', size: 20, isTest: false },
      { path: 'services/api/c.ts', language: 'typescript', component: 'services/api', size: 30, isTest: false },
      { path: 'services/api/d.ts', language: 'typescript', component: 'services/api', size: 40, isTest: false },
      { path: 'pipelines/etl/a.py', language: 'python', component: 'pipelines/etl', size: 15, isTest: false },
      { path: 'pipelines/etl/b.py', language: 'python', component: 'pipelines/etl', size: 25, isTest: false },
      { path: 'pipelines/etl/c.py', language: 'python', component: 'pipelines/etl', size: 35, isTest: false },
      { path: 'pipelines/etl/d.py', language: 'python', component: 'pipelines/etl', size: 45, isTest: false },
    ], 4);

    expect(sample).toHaveLength(4);
    expect(sample.some(file => file.language === 'typescript')).toBe(true);
    expect(sample.some(file => file.language === 'python')).toBe(true);
    expect(sample.some(file => file.size === 10 || file.size === 15)).toBe(true);
    expect(sample.some(file => file.size === 40 || file.size === 45)).toBe(true);
  });
});
