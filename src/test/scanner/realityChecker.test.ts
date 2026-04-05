import { describe, expect, it } from 'vitest';
import { RealityChecker } from '../../scanner/realityChecker';

describe('RealityChecker prompt formatting', () => {
  it('includes verified existing paths for the LLM prompt', () => {
    const checker = new RealityChecker();
    const summary = checker.formatForPrompt({
      totalChecks: 3,
      valid: 2,
      invalid: 1,
      warnings: 0,
      accuracyScore: 67,
      checks: [
        { category: 'path', status: 'valid', claim: 'python-workspace', reality: 'exists', file: '.github/copilot-instructions.md' },
        { category: 'path', status: 'valid', claim: 'src/api', reality: 'exists', file: '.github/copilot-instructions.md' },
        { category: 'path', status: 'invalid', claim: 'src/missing', reality: 'not found on disk', file: '.github/copilot-instructions.md' },
      ],
    });

    expect(summary).toContain('Verified existing paths');
    expect(summary).toContain('do NOT call these missing');
    expect(summary).toContain('"python-workspace"');
    expect(summary).toContain('"src/missing"');
  });
});
