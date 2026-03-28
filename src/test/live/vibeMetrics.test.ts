import { describe, it, expect } from 'vitest';

/**
 * Tests for vibe report metric computations:
 * - Executive vibe summary generation
 * - Tool success color logic
 * - Human takeover color logic
 *
 * These replicate the pure formulas from VibeReportGenerator.renderHtml
 * to validate the logic without filesystem I/O.
 */

// ── Replicate the vibe summary logic from vibeReport.ts ──────────

function computeVibeSummary(autonomyScore: number, outputDensityScore: number, toolCallSuccessRate: number): string {
  if (autonomyScore > 80 && outputDensityScore > 80) {
    return 'High-Output, Low-Friction. Agent operates efficiently with strong contextual understanding.';
  }
  if (autonomyScore > 50 && toolCallSuccessRate < 70) {
    return 'High-Output, High-Friction. Agent generates rapidly but tool failures create bottlenecks.';
  }
  if (autonomyScore < 30) {
    return 'Manual-Heavy. Agent requires frequent manual intervention — instructions may be insufficient.';
  }
  return 'Developing. Agent proficiency is building — focus on instruction quality and tool coverage.';
}

// ── Replicate the color logic from vibeReport.ts ─────────────────

function toolSuccessColor(rate: number): string {
  return rate >= 90 ? 'var(--color-emerald)' : rate >= 70 ? 'var(--level-3)' : 'var(--color-crimson)';
}

function humanTakeoverColor(rate: number): string {
  return rate <= 10 ? 'var(--color-emerald)' : rate <= 30 ? 'var(--level-3)' : 'var(--color-crimson)';
}

// ═══════════════════════════════════════════════════════════════
// Executive vibe summary
// ═══════════════════════════════════════════════════════════════

describe('executive vibe summary', () => {
  it('returns high-output summary when autonomy and density are both > 80', () => {
    const summary = computeVibeSummary(85, 90, 95);
    expect(summary).toContain('High-Output, Low-Friction');
  });

  it('returns high-friction when autonomy > 50 but tool success < 70', () => {
    const summary = computeVibeSummary(60, 40, 60);
    expect(summary).toContain('High-Output, High-Friction');
  });

  it('returns manual-heavy when autonomy < 30', () => {
    const summary = computeVibeSummary(20, 50, 90);
    expect(summary).toContain('Manual-Heavy');
  });

  it('returns developing for moderate scores', () => {
    const summary = computeVibeSummary(45, 50, 80);
    expect(summary).toContain('Developing');
  });

  it('prefers high-output check before high-friction check', () => {
    // autonomy > 80 && density > 80 wins even if toolSuccess < 70
    const summary = computeVibeSummary(85, 85, 60);
    expect(summary).toContain('High-Output, Low-Friction');
  });

  it('prefers high-friction over manual-heavy when autonomy > 50', () => {
    const summary = computeVibeSummary(55, 20, 50);
    expect(summary).toContain('High-Output, High-Friction');
  });
});

// ═══════════════════════════════════════════════════════════════
// Tool success color
// ═══════════════════════════════════════════════════════════════

describe('tool success color', () => {
  it('returns emerald (green) for rate >= 90', () => {
    expect(toolSuccessColor(90)).toBe('var(--color-emerald)');
    expect(toolSuccessColor(100)).toBe('var(--color-emerald)');
    expect(toolSuccessColor(95)).toBe('var(--color-emerald)');
  });

  it('returns level-3 (yellow) for rate >= 70 and < 90', () => {
    expect(toolSuccessColor(70)).toBe('var(--level-3)');
    expect(toolSuccessColor(89)).toBe('var(--level-3)');
    expect(toolSuccessColor(75)).toBe('var(--level-3)');
  });

  it('returns crimson (red) for rate < 70', () => {
    expect(toolSuccessColor(69)).toBe('var(--color-crimson)');
    expect(toolSuccessColor(0)).toBe('var(--color-crimson)');
    expect(toolSuccessColor(50)).toBe('var(--color-crimson)');
  });
});

// ═══════════════════════════════════════════════════════════════
// Human takeover color
// ═══════════════════════════════════════════════════════════════

describe('human takeover color', () => {
  it('returns emerald (green) for rate <= 10', () => {
    expect(humanTakeoverColor(0)).toBe('var(--color-emerald)');
    expect(humanTakeoverColor(10)).toBe('var(--color-emerald)');
    expect(humanTakeoverColor(5)).toBe('var(--color-emerald)');
  });

  it('returns level-3 (yellow) for rate <= 30 and > 10', () => {
    expect(humanTakeoverColor(11)).toBe('var(--level-3)');
    expect(humanTakeoverColor(30)).toBe('var(--level-3)');
    expect(humanTakeoverColor(20)).toBe('var(--level-3)');
  });

  it('returns crimson (red) for rate > 30', () => {
    expect(humanTakeoverColor(31)).toBe('var(--color-crimson)');
    expect(humanTakeoverColor(100)).toBe('var(--color-crimson)');
    expect(humanTakeoverColor(50)).toBe('var(--color-crimson)');
  });
});
