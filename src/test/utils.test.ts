import { describe, it, expect, vi } from 'vitest';
import { humanizeSignalId, deduplicateInsights, retryWithBackoff } from '../utils';

describe('humanizeSignalId', () => {
  // ── Shared / legacy signal lookups ──────────────────────────────
  it('returns mapped name for known shared signal', () => {
    expect(humanizeSignalId('copilot_instructions')).toBe('Copilot Instructions');
  });

  it('returns mapped name for another known shared signal', () => {
    expect(humanizeSignalId('project_structure_doc')).toBe('Project Structure Documented');
  });

  it('returns mapped name for memory_bank', () => {
    expect(humanizeSignalId('memory_bank')).toBe('Memory Bank');
  });

  // ── Tool-specific level IDs ─────────────────────────────────────
  it('returns category name for tool-level signal with known category', () => {
    expect(humanizeSignalId('cline_l2_instructions')).toBe('Instructions & Rules');
  });

  it('returns category name for skills_and_tools', () => {
    expect(humanizeSignalId('copilot_l3_skills_and_tools')).toBe('Skills, Tools & MCP');
  });

  it('returns category name for workflows', () => {
    expect(humanizeSignalId('roo_l4_workflows')).toBe('Workflows & Playbooks');
  });

  it('returns category name for memory_feedback', () => {
    expect(humanizeSignalId('claude_l5_memory_feedback')).toBe('Memory & Feedback');
  });

  it('humanizes unknown tool-level category by replacing underscores', () => {
    expect(humanizeSignalId('cursor_l2_custom_stuff')).toBe('custom stuff');
  });

  // ── Fallback: unknown signal ID ─────────────────────────────────
  it('replaces underscores with spaces for unknown IDs', () => {
    expect(humanizeSignalId('some_unknown_signal')).toBe('some unknown signal');
  });

  // ── Edge cases ──────────────────────────────────────────────────
  it('returns "Unknown Signal" for empty string', () => {
    expect(humanizeSignalId('')).toBe('Unknown Signal');
  });

  it('returns "Unknown Signal" for undefined (cast)', () => {
    expect(humanizeSignalId(undefined as unknown as string)).toBe('Unknown Signal');
  });

  it('returns "Unknown Signal" for null (cast)', () => {
    expect(humanizeSignalId(null as unknown as string)).toBe('Unknown Signal');
  });

  it('returns the id itself if it has no underscores and is not mapped', () => {
    expect(humanizeSignalId('readme')).toBe('readme');
  });
});

// ─── deduplicateInsights ────────────────────────────────────────────

function makeInsight(overrides: Partial<ReturnType<typeof makeInsight>> = {}) {
  return {
    title: 'Some insight',
    severity: 'important' as const,
    category: 'improvement',
    affectedComponent: undefined as string | undefined,
    confidenceScore: 0.75,
    recommendation: 'Do something',
    ...overrides,
  };
}

describe('deduplicateInsights', () => {
  it('returns empty array for empty input', () => {
    expect(deduplicateInsights([])).toEqual([]);
  });

  it('returns single item unchanged', () => {
    const items = [makeInsight({ title: 'Only one' })];
    expect(deduplicateInsights(items)).toHaveLength(1);
  });

  it('removes exact title duplicates', () => {
    const items = [
      makeInsight({ title: 'Add README to engine', confidenceScore: 0.75 }),
      makeInsight({ title: 'Add README to engine', confidenceScore: 0.85 }),
    ];
    const result = deduplicateInsights(items);
    expect(result).toHaveLength(1);
  });

  it('keeps the most severe when titles match', () => {
    const items = [
      makeInsight({ title: 'Fix stale path', severity: 'suggestion' }),
      makeInsight({ title: 'Fix stale path', severity: 'critical' }),
    ];
    const result = deduplicateInsights(items);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('critical');
  });

  it('keeps the highest confidence on severity tie', () => {
    const items = [
      makeInsight({ title: 'Same title', severity: 'important', confidenceScore: 0.75 }),
      makeInsight({ title: 'Same title', severity: 'important', confidenceScore: 0.85 }),
    ];
    const result = deduplicateInsights(items);
    expect(result).toHaveLength(1);
    expect(result[0].confidenceScore).toBe(0.85);
  });

  it('deduplicates by same component + same category', () => {
    const items = [
      makeInsight({ title: 'Component "engine" lagging behind', category: 'improvement', affectedComponent: 'engine' }),
      makeInsight({ title: 'Component "engine" needs improvement (3 issues)', category: 'improvement', affectedComponent: 'engine' }),
    ];
    const result = deduplicateInsights(items);
    expect(result).toHaveLength(1);
  });

  it('does NOT dedup different components with same category', () => {
    const items = [
      makeInsight({ title: 'Component "engine" needs improvement', category: 'improvement', affectedComponent: 'engine' }),
      makeInsight({ title: 'Component "parser" needs improvement', category: 'improvement', affectedComponent: 'parser' }),
    ];
    const result = deduplicateInsights(items);
    expect(result).toHaveLength(2);
  });

  it('deduplicates case-insensitively', () => {
    const items = [
      makeInsight({ title: 'Create "Test" Skill' }),
      makeInsight({ title: 'create "test" skill' }),
    ];
    const result = deduplicateInsights(items);
    expect(result).toHaveLength(1);
  });

  it('deduplicates titles that differ only by issue count', () => {
    const items = [
      makeInsight({ title: 'Component "engine" needs improvement (2 issues)', affectedComponent: 'engine', category: 'improvement' }),
      makeInsight({ title: 'Component "engine" needs improvement (3 issues)', affectedComponent: 'engine', category: 'improvement' }),
    ];
    const result = deduplicateInsights(items);
    expect(result).toHaveLength(1);
  });

  it('handles the real-world scenario: regular insight + deep analysis insight for same component', () => {
    // This is the exact bug: insightsEngine generates "Component X needs improvement"
    // then deep analysis adds "Add X to instruction files" for same component
    const items = [
      makeInsight({ title: 'Component "kusto-manager" needs improvement (2 issues)', category: 'improvement', affectedComponent: 'kusto-manager', confidenceScore: 0.75 }),
      makeInsight({ title: 'Add python-workspace/components/kusto-manager to instruction files', category: 'uncovered-module', affectedComponent: 'python-workspace/components/kusto-manager/src/kusto_manager/kusto_manager.py', confidenceScore: 0.85 }),
    ];
    const result = deduplicateInsights(items);
    // These should NOT be deduped — they're different components (different paths) with different categories
    expect(result).toHaveLength(2);
  });

  it('deduplicates "fix stale path in X" appearing 4 times from different sources', () => {
    const items = [
      makeInsight({ title: 'Fix stale path reference in .github/skills/ev2/SKILL.md', category: 'stale-path', affectedComponent: '.github/skills/ev2/SKILL.md', confidenceScore: 0.75 }),
      makeInsight({ title: 'Fix stale path reference in .github/skills/ev2/SKILL.md', category: 'stale-path', affectedComponent: '.github/skills/ev2/SKILL.md', confidenceScore: 0.85 }),
      makeInsight({ title: 'Fix stale path reference in .github/skills/ev2/SKILL.md', category: 'stale-path', affectedComponent: '.github/skills/ev2/SKILL.md', confidenceScore: 0.85 }),
      makeInsight({ title: 'Fix stale path reference in .github/skills/ev2/SKILL.md', category: 'stale-path', affectedComponent: '.github/skills/ev2/SKILL.md', confidenceScore: 0.85 }),
    ];
    const result = deduplicateInsights(items);
    expect(result).toHaveLength(1);
    expect(result[0].confidenceScore).toBe(0.85);
  });

  it('deduplicates "improve skill X" appearing from both engines', () => {
    const items = [
      makeInsight({ title: 'Improve skill "ev2" — Completeness is weak (5/100)', severity: 'important', affectedComponent: '.github/skills/ev2/SKILL.md', confidenceScore: 0.75 }),
      makeInsight({ title: 'Improve skill "ev2" — Completeness is weak (5/100)', severity: 'critical', affectedComponent: '.github/skills/ev2/SKILL.md', confidenceScore: 0.85 }),
    ];
    const result = deduplicateInsights(items);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('critical'); // keeps the more severe
  });

  it('deduplicates "create X skill" appearing from both signal gaps + deep analysis', () => {
    const items = [
      makeInsight({ title: 'Create "deploy" skill', category: 'missing-skill', confidenceScore: 0.75 }),
      makeInsight({ title: 'Create "deploy" skill', category: 'missing-skill', confidenceScore: 0.85 }),
    ];
    const result = deduplicateInsights(items);
    expect(result).toHaveLength(1);
  });

  it('preserves order stability — first item wins on equal severity+confidence', () => {
    const items = [
      makeInsight({ title: 'First', severity: 'important', confidenceScore: 0.75 }),
      makeInsight({ title: 'Second', severity: 'important', confidenceScore: 0.75 }),
      makeInsight({ title: 'Third', severity: 'important', confidenceScore: 0.75 }),
    ];
    const result = deduplicateInsights(items);
    expect(result).toHaveLength(3);
    expect(result[0].title).toBe('First');
  });

  it('handles large lists efficiently', () => {
    const items = Array.from({ length: 500 }, (_, i) =>
      makeInsight({ title: `Insight ${i % 50}`, affectedComponent: `comp-${i % 50}`, category: 'improvement' })
    );
    const start = Date.now();
    const result = deduplicateInsights(items);
    const elapsed = Date.now() - start;
    expect(result.length).toBeLessThan(items.length);
    expect(result.length).toBe(50); // 500 items with 50 unique keys
    expect(elapsed).toBeLessThan(100); // should be fast
  });

  // ─── Skill name dedup (cross-pass) ────────────────────────────

  it('deduplicates "Create test skill" from gap analysis and "Create .github/skills/test/SKILL.md" from deep analysis', () => {
    const items = [
      makeInsight({ title: 'Create "test" skill', category: 'missing-skill', confidenceScore: 0.75 }),
      makeInsight({ title: 'Create .github/skills/test/SKILL.md with test runner configuration', category: 'missing-skill', confidenceScore: 0.85 }),
    ];
    const result = deduplicateInsights(items);
    expect(result).toHaveLength(1);
  });

  it('deduplicates "Create lint skill" appearing from both passes', () => {
    const items = [
      makeInsight({ title: 'Create "lint" skill', category: 'missing-skill', confidenceScore: 0.75 }),
      makeInsight({ title: 'Create lint skill for C#, Python and Bicep validation', category: 'missing-skill', confidenceScore: 0.85 }),
    ];
    const result = deduplicateInsights(items);
    expect(result).toHaveLength(1);
    expect(result[0].confidenceScore).toBe(0.85); // keeps the more detailed one
  });

  it('deduplicates "Improve skill ev2" appearing from both engines', () => {
    const items = [
      makeInsight({ title: 'Improve skill "ev2" — Completeness weak (5/100)', category: 'weak-description', confidenceScore: 0.75 }),
      makeInsight({ title: 'Improve skill ev2 with better structure', category: 'weak-description', confidenceScore: 0.85 }),
    ];
    const result = deduplicateInsights(items);
    expect(result).toHaveLength(1);
  });

  it('does NOT dedup different skill names', () => {
    const items = [
      makeInsight({ title: 'Create "test" skill', category: 'missing-skill' }),
      makeInsight({ title: 'Create "deploy" skill', category: 'missing-skill' }),
      makeInsight({ title: 'Create "lint" skill', category: 'missing-skill' }),
    ];
    const result = deduplicateInsights(items);
    expect(result).toHaveLength(3);
  });
});

// ─── retryWithBackoff ───────────────────────────────────────────────

describe('retryWithBackoff', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, 2, 10);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on timeout error and succeeds on second attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('LLM call timed out after 60s'))
      .mockResolvedValueOnce('ok');
    const result = await retryWithBackoff(fn, 2, 10);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on rate limit error', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockRejectedValueOnce(new Error('rate limit exceeded'))
      .mockResolvedValueOnce('ok');
    const result = await retryWithBackoff(fn, 2, 10);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Invalid JSON response'));
    await expect(retryWithBackoff(fn, 2, 10)).rejects.toThrow('Invalid JSON');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting all retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('timed out'));
    await expect(retryWithBackoff(fn, 2, 10)).rejects.toThrow('timed out');
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('uses exponential backoff delays', async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: Function, ms: number) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0); // execute immediately in tests
    }) as any);

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce('ok');
    await retryWithBackoff(fn, 2, 100);

    expect(delays[0]).toBe(100);  // base × 2^0
    expect(delays[1]).toBe(200);  // base × 2^1
    vi.restoreAllMocks();
  });
});
