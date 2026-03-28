/**
 * SVG radar chart generator for displaying AI readiness metrics.
 * Pure logic — outputs an SVG string embeddable in webview HTML.
 */

export interface RadarDataPoint {
  label: string;
  value: number;
  color?: string;
}

// ─── Geometry helpers ─────────────────────────────────────────────────

function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleRad: number,
): { x: number; y: number } {
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad),
  };
}

function polygonPoints(
  cx: number,
  cy: number,
  radius: number,
  sides: number,
  startAngle: number = -Math.PI / 2,
): string {
  const pts: string[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = startAngle + (2 * Math.PI * i) / sides;
    const { x, y } = polarToCartesian(cx, cy, radius, angle);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(' ');
}

// ─── SVG building blocks ─────────────────────────────────────────────

function guideRings(cx: number, cy: number, maxR: number, sides: number): string {
  const levels = [0.25, 0.5, 0.75, 1.0];
  return levels
    .map(pct => {
      const r = maxR * pct;
      const pts = polygonPoints(cx, cy, r, sides);
      return `<polygon points="${pts}" fill="none" stroke="var(--vscode-editorWidget-border, #555)" stroke-width="0.5" opacity="0.4"/>`;
    })
    .join('\n    ');
}

function axisLines(cx: number, cy: number, maxR: number, sides: number): string {
  const lines: string[] = [];
  const startAngle = -Math.PI / 2;
  for (let i = 0; i < sides; i++) {
    const angle = startAngle + (2 * Math.PI * i) / sides;
    const { x, y } = polarToCartesian(cx, cy, maxR, angle);
    lines.push(
      `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}" stroke="var(--vscode-editorWidget-border, #555)" stroke-width="0.5" opacity="0.3"/>`,
    );
  }
  return lines.join('\n    ');
}

function dataPolygon(
  cx: number,
  cy: number,
  maxR: number,
  data: RadarDataPoint[],
): string {
  const sides = data.length;
  const startAngle = -Math.PI / 2;
  const pts: string[] = [];

  for (let i = 0; i < sides; i++) {
    const angle = startAngle + (2 * Math.PI * i) / sides;
    const r = maxR * Math.max(0, Math.min(100, data[i].value)) / 100;
    const { x, y } = polarToCartesian(cx, cy, r, angle);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }

  const fillColor = data[0]?.color ?? 'var(--vscode-charts-blue, #4fc1ff)';

  return `<polygon points="${pts.join(' ')}" fill="${fillColor}" fill-opacity="0.25" stroke="${fillColor}" stroke-width="1.5"/>`;
}

function dataPoints(
  cx: number,
  cy: number,
  maxR: number,
  data: RadarDataPoint[],
): string {
  const sides = data.length;
  const startAngle = -Math.PI / 2;
  const dots: string[] = [];

  for (let i = 0; i < sides; i++) {
    const angle = startAngle + (2 * Math.PI * i) / sides;
    const r = maxR * Math.max(0, Math.min(100, data[i].value)) / 100;
    const { x, y } = polarToCartesian(cx, cy, r, angle);
    const color = data[i].color ?? 'var(--vscode-charts-blue, #4fc1ff)';
    dots.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3" fill="${color}"/>`);
  }

  return dots.join('\n    ');
}

function labels(
  cx: number,
  cy: number,
  maxR: number,
  data: RadarDataPoint[],
): string {
  const sides = data.length;
  const startAngle = -Math.PI / 2;
  const labelR = maxR + 18;
  const texts: string[] = [];

  for (let i = 0; i < sides; i++) {
    const angle = startAngle + (2 * Math.PI * i) / sides;
    const { x, y } = polarToCartesian(cx, cy, labelR, angle);

    let anchor = 'middle';
    if (Math.cos(angle) < -0.1) { anchor = 'end'; }
    else if (Math.cos(angle) > 0.1) { anchor = 'start'; }

    const val = Math.round(Math.max(0, Math.min(100, data[i].value)));
    texts.push(
      `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="${anchor}" dominant-baseline="central" fill="var(--vscode-foreground, #ccc)" font-size="11" font-family="var(--vscode-font-family, sans-serif)">${data[i].label} (${val})</text>`,
    );
  }

  return texts.join('\n    ');
}

// ─── Public API ───────────────────────────────────────────────────────

export function generateRadarChartSVG(
  data: RadarDataPoint[],
  size: number = 300,
  showLabels: boolean = true,
): string {
  if (data.length < 3 || data.length > 8) {
    return `<!-- Radar chart requires 3-8 data points, got ${data.length} -->`;
  }

  const padding = showLabels ? 60 : 20;
  const totalSize = size + padding * 2;
  const cx = totalSize / 2;
  const cy = totalSize / 2;
  const maxR = size / 2;
  const sides = data.length;

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" width="${totalSize}" height="${totalSize}">`,
    `  <g>`,
    `    ${guideRings(cx, cy, maxR, sides)}`,
    `    ${axisLines(cx, cy, maxR, sides)}`,
    `    ${dataPolygon(cx, cy, maxR, data)}`,
    `    ${dataPoints(cx, cy, maxR, data)}`,
  ];

  if (showLabels) {
    parts.push(`    ${labels(cx, cy, maxR, data)}`);
  }

  parts.push(`  </g>`, `</svg>`);

  return parts.join('\n');
}
