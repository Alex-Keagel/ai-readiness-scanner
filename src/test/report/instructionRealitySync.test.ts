import { describe, expect, it } from 'vitest';
import { calculateInstructionRealitySync } from '../../report/instructionRealitySync';

function makeReport(overrides: Record<string, any> = {}) {
  return {
    projectName: 'test-project',
    scannedAt: new Date().toISOString(),
    primaryLevel: 2,
    levelName: 'Instruction-Guided',
    depth: 50,
    overallScore: 40,
    levels: [
      { level: 1, name: 'Prompt-Only', rawScore: 0, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
      { level: 2, name: 'Instruction-Guided', rawScore: 0, qualified: false, signals: [], signalsDetected: 0, signalsTotal: 0 },
      { level: 3, name: 'Skill-Equipped', rawScore: 0, qualified: false, signals: [], signalsDetected: 0, signalsTotal: 0 },
    ],
    componentScores: [],
    languageScores: [],
    projectContext: { languages: ['TypeScript'], frameworks: [], projectType: 'app', packageManager: 'npm', directoryTree: '', components: [] },
    selectedTool: 'copilot',
    modelUsed: 'test',
    scanMode: 'full',
    ...overrides,
  } as any;
}

function makeSignal(overrides: Record<string, any> = {}) {
  return {
    signalId: 'copilot_instructions',
    level: 2,
    detected: true,
    score: 70,
    finding: 'Found',
    files: ['.github/copilot-instructions.md'],
    confidence: 'high',
    realityChecks: [],
    ...overrides,
  };
}

describe('calculateInstructionRealitySync', () => {
  it('gives minor credit for general docs when no copilot instruction artifacts exist', () => {
    const report = makeReport({
      levels: [
        { level: 1, name: 'Prompt-Only', rawScore: 0, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
        {
          level: 2,
          name: 'Instruction-Guided',
          rawScore: 0,
          qualified: false,
          signals: [
            makeSignal({ signalId: 'project_structure_doc', detected: true, files: ['README.md'] }),
            makeSignal({ signalId: 'conventions_documented', detected: true, files: ['CONTRIBUTING.md'] }),
          ],
          signalsDetected: 2,
          signalsTotal: 2,
        },
      ],
    });

    expect(calculateInstructionRealitySync(report)).toBe(20);
  });

  it('treats missing reality checks as 0 path accuracy instead of a bonus', () => {
    const report = makeReport({
      levels: [
        { level: 1, name: 'Prompt-Only', rawScore: 0, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
        {
          level: 2,
          name: 'Instruction-Guided',
          rawScore: 0,
          qualified: true,
          signals: [makeSignal()],
          signalsDetected: 1,
          signalsTotal: 1,
        },
      ],
    });

    expect(calculateInstructionRealitySync(report)).toBe(30);
  });

  it('keeps skills-without-root low even when deep quality exists', () => {
    const report = makeReport({
      levels: [
        { level: 1, name: 'Prompt-Only', rawScore: 0, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
        {
          level: 3,
          name: 'Skill-Equipped',
          rawScore: 0,
          qualified: true,
          signals: [
            makeSignal({
              signalId: 'copilot_l3_skills_and_tools',
              level: 3,
              files: ['.github/skills/build/SKILL.md'],
            }),
          ],
          signalsDetected: 1,
          signalsTotal: 1,
        },
      ],
      deepAnalysis: {
        instructionQuality: { overall: 39, accuracy: 39, coverage: 39 },
      },
    });

    expect(calculateInstructionRealitySync(report)).toBe(26);
  });

  it('returns 0 for monorepo root scans with no root copilot setup', () => {
    const report = makeReport({
      projectContext: { languages: ['TypeScript'], frameworks: [], projectType: 'monorepo', packageManager: 'npm', directoryTree: '', components: [] },
      deepAnalysis: {
        instructionQuality: { overall: 0, accuracy: 0, coverage: 0 },
      },
    });

    expect(calculateInstructionRealitySync(report)).toBe(0);
  });

  it('scores rich copilot setups high when deep analysis agrees', () => {
    const report = makeReport({
      levels: [
        { level: 1, name: 'Prompt-Only', rawScore: 0, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
        {
          level: 2,
          name: 'Instruction-Guided',
          rawScore: 0,
          qualified: true,
          signals: [
            makeSignal({
              realityChecks: [
                { category: 'path', status: 'valid', claim: 'src/api', reality: 'exists', file: '.github/copilot-instructions.md' },
                { category: 'path', status: 'valid', claim: 'src/lib', reality: 'exists', file: '.github/copilot-instructions.md' },
                { category: 'path', status: 'warning', claim: 'src/old', reality: 'stale', file: '.github/copilot-instructions.md' },
              ],
            }),
            makeSignal({
              signalId: 'copilot_domain_instructions',
              files: ['.github/instructions/api.instructions.md'],
            }),
          ],
          signalsDetected: 2,
          signalsTotal: 2,
        },
        {
          level: 3,
          name: 'Skill-Equipped',
          rawScore: 0,
          qualified: true,
          signals: [
            makeSignal({
              signalId: 'copilot_l3_skills_and_tools',
              level: 3,
              files: ['.github/skills/build/SKILL.md', '.vscode/mcp.json'],
            }),
          ],
          signalsDetected: 1,
          signalsTotal: 1,
        },
      ],
      deepAnalysis: {
        instructionQuality: { overall: 82, accuracy: 84, coverage: 80 },
      },
    });

    expect(calculateInstructionRealitySync(report)).toBe(88);
  });

  it('returns 0 when absolutely no signals exist', () => {
    const report = makeReport();
    expect(calculateInstructionRealitySync(report)).toBe(0);
  });

  it('scores copilot-instructions.md with all valid paths at 70', () => {
    const report = makeReport({
      levels: [
        { level: 1, name: 'Prompt-Only', rawScore: 0, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
        {
          level: 2,
          name: 'Instruction-Guided',
          rawScore: 0,
          qualified: true,
          signals: [
            makeSignal({
              realityChecks: [
                { category: 'path', status: 'valid', claim: 'src/api', reality: 'exists', file: '.github/copilot-instructions.md' },
                { category: 'path', status: 'valid', claim: 'src/lib', reality: 'exists', file: '.github/copilot-instructions.md' },
              ],
            }),
          ],
          signalsDetected: 1,
          signalsTotal: 1,
        },
      ],
    });

    const score = calculateInstructionRealitySync(report);
    expect(score).toBeGreaterThanOrEqual(70);
    expect(score).toBeLessThanOrEqual(90);
  });

  it('scores copilot-instructions.md with 50% stale paths between 40-55', () => {
    const report = makeReport({
      levels: [
        { level: 1, name: 'Prompt-Only', rawScore: 0, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
        {
          level: 2,
          name: 'Instruction-Guided',
          rawScore: 0,
          qualified: true,
          signals: [
            makeSignal({
              realityChecks: [
                { category: 'path', status: 'valid', claim: 'src/api', reality: 'exists', file: '.github/copilot-instructions.md' },
                { category: 'path', status: 'invalid', claim: 'src/old', reality: 'missing', file: '.github/copilot-instructions.md' },
              ],
            }),
          ],
          signalsDetected: 1,
          signalsTotal: 1,
        },
      ],
    });

    const score = calculateInstructionRealitySync(report);
    expect(score).toBeGreaterThanOrEqual(40);
    expect(score).toBeLessThanOrEqual(55);
  });
});
