import { describe, it, expect, vi } from 'vitest';
import { validatedAnalyze, validatedAnalyzeFast, validatedJsonCall } from '../../llm/validatedCall';

function mockClient(analyzeResult = '{}', fastResult = '{}') {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    analyze: vi.fn().mockResolvedValue(analyzeResult),
    analyzeFast: vi.fn().mockResolvedValue(fastResult),
    getModelName: vi.fn().mockReturnValue('test-model'),
  } as any;
}

describe('validatedCall', () => {
  describe('validatedAnalyze', () => {
    it('skips validation for display tier', async () => {
      const client = mockClient('primary result');
      const result = await validatedAnalyze(client, 'test prompt', { tier: 'display' });
      expect(result.result).toBe('primary result');
      expect(result.confidence).toBe(0.5);
      expect(result.validatorAgreed).toBe(true);
      expect(client.analyzeFast).not.toHaveBeenCalled();
    });

    it('runs quick validation for standard tier', async () => {
      const client = mockClient('primary result', JSON.stringify({ agrees: true, score: 90, feedback: 'Good' }));
      const result = await validatedAnalyze(client, 'test prompt', { tier: 'standard' });
      expect(result.result).toBe('primary result');
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
      expect(result.validatorAgreed).toBe(true);
    });

    it('returns lower confidence when validator disagrees (standard)', async () => {
      const client = mockClient('primary result', JSON.stringify({ agrees: false, score: 40, feedback: 'Inaccurate' }));
      const result = await validatedAnalyze(client, 'test prompt', { tier: 'standard' });
      expect(result.confidence).toBeLessThan(0.7);
      expect(result.validatorAgreed).toBe(false);
    });

    it('triggers debate for important tier on disagreement', async () => {
      const client = mockClient('primary result');
      client.analyzeFast
        .mockResolvedValueOnce(JSON.stringify({ agrees: false, score: 30, feedback: 'Issues' }))
        .mockResolvedValueOnce(JSON.stringify({ winner: 'A', reasoning: 'Primary correct' }));

      const result = await validatedAnalyze(client, 'test prompt', { tier: 'important' });
      expect(result.debateOutcome).toBeDefined();
      expect(client.analyzeFast).toHaveBeenCalledTimes(2);
    });

    it('uses tiebreaker for critical tier', async () => {
      const client = mockClient('primary result');
      client.analyzeFast
        .mockResolvedValueOnce(JSON.stringify({ agrees: false, score: 20, feedback: 'Wrong' }))
        .mockResolvedValueOnce('invalid json'); // debate fails
      client.analyze
        .mockResolvedValueOnce('primary result') // original call
        .mockResolvedValueOnce(JSON.stringify({ winner: 'A', reasoning: 'Primary better' }));

      const result = await validatedAnalyze(client, 'test prompt', { tier: 'critical' });
      expect(result.debateOutcome).toBe('tiebreaker');
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('handles validator failure gracefully', async () => {
      const client = mockClient('primary result');
      client.analyzeFast.mockRejectedValue(new Error('timeout'));
      const result = await validatedAnalyze(client, 'test prompt', { tier: 'standard' });
      expect(result.result).toBe('primary result');
      expect(result.confidence).toBe(0.55);
    });

    it('skips debate on minor disagreement', async () => {
      const client = mockClient('primary result', JSON.stringify({ agrees: false, score: 85, feedback: 'Minor' }));
      const result = await validatedAnalyze(client, 'test prompt', { tier: 'important' });
      expect(result.confidence).toBe(0.85);
      expect(result.debateOutcome).toBeUndefined();
    });

    it('uses custom validator prompt when provided', async () => {
      const customValidator = vi.fn((result: string) => `Check this: ${result}`);
      const client = mockClient('result', JSON.stringify({ agrees: true, score: 95 }));
      await validatedAnalyze(client, 'prompt', {
        tier: 'standard',
        validatorPrompt: customValidator,
      });
      expect(customValidator).toHaveBeenCalledWith('result');
    });
  });

  describe('validatedAnalyzeFast', () => {
    it('uses fast model for primary call', async () => {
      const client = mockClient('unused', 'fast result');
      client.analyzeFast
        .mockResolvedValueOnce('fast result')
        .mockResolvedValueOnce(JSON.stringify({ agrees: true, score: 95 }));
      const result = await validatedAnalyzeFast(client, 'prompt', { tier: 'standard' });
      expect(result.result).toBe('fast result');
    });

    it('skips validation for display tier', async () => {
      const client = mockClient('unused', 'fast result');
      const result = await validatedAnalyzeFast(client, 'prompt', { tier: 'display' });
      expect(result.confidence).toBe(0.5);
    });
  });

  describe('validatedJsonCall', () => {
    it('parses JSON with confidence', async () => {
      const client = mockClient();
      client.analyzeFast
        .mockResolvedValueOnce('{"val": 42}') // primary
        .mockResolvedValueOnce(JSON.stringify({ agrees: true, score: 90 })); // validator
      const result = await validatedJsonCall(
        client, 'prompt', { tier: 'standard' },
        (raw) => { const m = raw.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; }
      );
      expect(result.result).toEqual({ val: 42 });
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('returns null for unparseable response', async () => {
      const client = mockClient('not json');
      const result = await validatedJsonCall(
        client, 'prompt', { tier: 'display' },
        () => null
      );
      expect(result.result).toBeNull();
    });
  });
});
