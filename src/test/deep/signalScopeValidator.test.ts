import { describe, expect, it } from 'vitest';
import { validateSignalScope } from '../../deep/validators/signalScopeValidator';

describe('validateSignalScope', () => {
  it('marks sub-project-only files as not root detected', () => {
    const result = validateSignalScope(
      'copilot_instructions',
      ['packages/api/.github/copilot-instructions.md'],
      ['packages/api'],
    );

    expect(result.isRootDetected).toBe(false);
    expect(result.rootFiles).toEqual([]);
    expect(result.subProjectFiles).toEqual(['packages/api/.github/copilot-instructions.md']);
  });

  it('marks root-level files as root detected', () => {
    const result = validateSignalScope(
      'copilot_instructions',
      ['.github/copilot-instructions.md'],
      ['packages/api'],
    );

    expect(result.isRootDetected).toBe(true);
    expect(result.rootFiles).toEqual(['.github/copilot-instructions.md']);
    expect(result.subProjectFiles).toEqual([]);
  });

  it('keeps detection true when files exist at both root and sub-project scope', () => {
    const result = validateSignalScope(
      'copilot_instructions',
      ['.github/copilot-instructions.md', 'packages/api/.github/copilot-instructions.md'],
      ['packages/api'],
    );

    expect(result.isRootDetected).toBe(true);
    expect(result.rootFiles).toEqual(['.github/copilot-instructions.md']);
    expect(result.subProjectFiles).toEqual(['packages/api/.github/copilot-instructions.md']);
  });

  it('passes all files through for non-monorepo scans', () => {
    const files = ['.github/copilot-instructions.md', 'packages/api/.github/copilot-instructions.md'];
    const result = validateSignalScope('copilot_instructions', files, []);

    expect(result.isRootDetected).toBe(true);
    expect(result.rootFiles).toEqual(files);
    expect(result.subProjectFiles).toEqual([]);
  });
});
