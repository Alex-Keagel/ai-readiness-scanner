import { describe, it, expect } from 'vitest';
import {
  TACTICAL_GLASSBOX_CSS,
  getLevelColor,
  getLevelGlowClass,
  getSeverityGlowClass,
} from '../../ui/theme';

// ─── TACTICAL_GLASSBOX_CSS ───────────────────────────────────────────

describe('TACTICAL_GLASSBOX_CSS', () => {
  it('is a non-empty string', () => {
    expect(typeof TACTICAL_GLASSBOX_CSS).toBe('string');
    expect(TACTICAL_GLASSBOX_CSS.length).toBeGreaterThan(0);
  });

  it('contains key CSS variables', () => {
    expect(TACTICAL_GLASSBOX_CSS).toContain('--bg-primary');
    expect(TACTICAL_GLASSBOX_CSS).toContain('--color-cyan');
    expect(TACTICAL_GLASSBOX_CSS).toContain('--color-crimson');
  });

  it('contains glass-card class definition', () => {
    expect(TACTICAL_GLASSBOX_CSS).toContain('.glass-card');
  });

  it('contains glow variant classes', () => {
    expect(TACTICAL_GLASSBOX_CSS).toContain('.glass-card.glow-emerald');
    expect(TACTICAL_GLASSBOX_CSS).toContain('.glass-card.glow-amber');
    expect(TACTICAL_GLASSBOX_CSS).toContain('.glass-card.glow-crimson');
    expect(TACTICAL_GLASSBOX_CSS).toContain('.glass-card.glow-cyan');
    expect(TACTICAL_GLASSBOX_CSS).toContain('.glass-card.glow-purple');
  });
});

// ─── getLevelColor ────────────────────────────────────────────────────

describe('getLevelColor', () => {
  it('returns correct color for each level 1-6', () => {
    expect(getLevelColor(1)).toBe('#FF3B5C');
    expect(getLevelColor(2)).toBe('#FFB020');
    expect(getLevelColor(3)).toBe('#FFEA00');
    expect(getLevelColor(4)).toBe('#00E676');
    expect(getLevelColor(5)).toBe('#00E5FF');
    expect(getLevelColor(6)).toBe('#B388FF');
  });

  it('returns fallback color for unknown level', () => {
    expect(getLevelColor(0)).toBe('#888');
    expect(getLevelColor(7)).toBe('#888');
    expect(getLevelColor(-1)).toBe('#888');
  });
});

// ─── getLevelGlowClass ───────────────────────────────────────────────

describe('getLevelGlowClass', () => {
  it('returns glow-cyan for levels 5 and 6', () => {
    expect(getLevelGlowClass(5)).toBe('glow-cyan');
    expect(getLevelGlowClass(6)).toBe('glow-cyan');
  });

  it('returns glow-emerald for level 4', () => {
    expect(getLevelGlowClass(4)).toBe('glow-emerald');
  });

  it('returns glow-amber for level 3', () => {
    expect(getLevelGlowClass(3)).toBe('glow-amber');
  });

  it('returns glow-crimson for levels 1, 2, and 0', () => {
    expect(getLevelGlowClass(1)).toBe('glow-crimson');
    expect(getLevelGlowClass(2)).toBe('glow-crimson');
    expect(getLevelGlowClass(0)).toBe('glow-crimson');
  });
});

// ─── getSeverityGlowClass ────────────────────────────────────────────

describe('getSeverityGlowClass', () => {
  it('maps critical to glow-crimson', () => {
    expect(getSeverityGlowClass('critical')).toBe('glow-crimson');
  });

  it('maps important to glow-amber', () => {
    expect(getSeverityGlowClass('important')).toBe('glow-amber');
  });

  it('maps suggestion to glow-cyan', () => {
    expect(getSeverityGlowClass('suggestion')).toBe('glow-cyan');
  });
});
