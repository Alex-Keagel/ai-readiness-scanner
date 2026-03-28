import { describe, it, expect } from 'vitest';
import { generateRadarChartSVG, type RadarDataPoint } from '../../metrics/radarChart';

function makePoints(count: number, value = 50): RadarDataPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    label: `Axis ${i + 1}`,
    value,
  }));
}

// ─── Basic SVG output ────────────────────────────────────────────────

describe('generateRadarChartSVG', () => {
  it('returns valid SVG string with 5 data points', () => {
    const svg = generateRadarChartSVG(makePoints(5));

    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('contains polygon for data area', () => {
    const svg = generateRadarChartSVG(makePoints(5));
    // data polygon and guide ring polygons
    expect(svg).toContain('<polygon');
  });

  it('contains text labels for each axis', () => {
    const points = makePoints(4);
    const svg = generateRadarChartSVG(points);

    for (const p of points) {
      expect(svg).toContain(p.label);
    }
  });
});

// ─── Axis count boundaries ───────────────────────────────────────────

describe('axis count handling', () => {
  it('handles 3 axes (minimum)', () => {
    const svg = generateRadarChartSVG(makePoints(3));
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  it('handles 8 axes (maximum)', () => {
    const svg = generateRadarChartSVG(makePoints(8));
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  it('returns comment for 2 axes (below minimum)', () => {
    const svg = generateRadarChartSVG(makePoints(2));
    expect(svg).toContain('<!--');
    expect(svg).not.toContain('<svg');
  });

  it('returns comment for 9 axes (above maximum)', () => {
    const svg = generateRadarChartSVG(makePoints(9));
    expect(svg).toContain('<!--');
    expect(svg).not.toContain('<svg');
  });
});

// ─── Extreme values ──────────────────────────────────────────────────

describe('extreme values', () => {
  it('all values at 0 produces valid SVG', () => {
    const svg = generateRadarChartSVG(makePoints(5, 0));

    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('<polygon');
  });

  it('all values at 100 produces valid SVG', () => {
    const svg = generateRadarChartSVG(makePoints(5, 100));

    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('<polygon');
  });

  it('labels show rounded values', () => {
    const svg = generateRadarChartSVG(makePoints(3, 0));
    expect(svg).toContain('(0)');

    const svg100 = generateRadarChartSVG(makePoints(3, 100));
    expect(svg100).toContain('(100)');
  });
});

// ─── Label toggling ──────────────────────────────────────────────────

describe('showLabels option', () => {
  it('excludes text labels when showLabels is false', () => {
    const points = makePoints(4);
    const svg = generateRadarChartSVG(points, 300, false);

    for (const p of points) {
      expect(svg).not.toContain(p.label);
    }
  });
});
