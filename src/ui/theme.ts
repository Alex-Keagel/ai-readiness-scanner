export const TACTICAL_GLASSBOX_CSS = `
/* Tactical Glassbox Design System */

/* ─── Base Palette ─── */
:root {
  --bg-primary: #0D0E15;
  --bg-card: #13141D;
  --bg-card-hover: #1A1B26;
  --bg-surface: #181924;
  --bg-elevated: #1E1F2E;
  --border-subtle: #2A2B3A;
  --border-active: #3A3B4A;
  --text-primary: #E2E8F0;
  --text-secondary: #94A3B8;
  --text-muted: #64748B;
  
  /* Vibe Color System */
  --color-cyan: #00E5FF;
  --color-cyan-dim: rgba(0, 229, 255, 0.15);
  --color-amber: #FFB020;
  --color-amber-dim: rgba(255, 176, 32, 0.15);
  --color-crimson: #FF3B5C;
  --color-crimson-dim: rgba(255, 59, 92, 0.15);
  --color-emerald: #00E676;
  --color-emerald-dim: rgba(0, 230, 118, 0.15);
  --color-purple: #B388FF;
  --color-purple-dim: rgba(179, 136, 255, 0.15);
  
  /* Level Colors */
  --level-1: #FF3B5C;
  --level-2: #FFB020;
  --level-3: #FFEA00;
  --level-4: #00E676;
  --level-5: #00E5FF;
  --level-6: #B388FF;
  
  /* Typography */
  --font-ui: 'Inter', var(--vscode-font-family, system-ui), -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', var(--vscode-editor-font-family, monospace), monospace;
}

/* ─── Reset & Base ─── */
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--font-ui);
  color: var(--text-primary);
  background: var(--bg-primary);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
/* Subtle noise texture overlay */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  opacity: 0.03;
  pointer-events: none;
  z-index: 9999;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}

/* ─── Glass Cards ─── */
.glass-card {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 16px;
  transition: border-color 0.2s, box-shadow 0.2s, transform 0.15s;
}
.glass-card:hover {
  border-color: var(--border-active);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
}

/* Severity glow variants */
.glass-card.glow-emerald { border-color: var(--color-emerald); box-shadow: 0 0 16px var(--color-emerald-dim); }
.glass-card.glow-amber { border-color: var(--color-amber); box-shadow: 0 0 16px var(--color-amber-dim); }
.glass-card.glow-crimson { border-color: var(--color-crimson); box-shadow: 0 0 16px var(--color-crimson-dim); }
.glass-card.glow-cyan { border-color: var(--color-cyan); box-shadow: 0 0 16px var(--color-cyan-dim); }
.glass-card.glow-purple { border-color: var(--color-purple); box-shadow: 0 0 16px var(--color-purple-dim); }

/* ─── Badges & Pills ─── */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 0.75em;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.badge-level { color: #fff; }
.badge-l1 { background: var(--level-1); }
.badge-l2 { background: var(--level-2); color: #000; }
.badge-l3 { background: var(--level-3); color: #000; }
.badge-l4 { background: var(--level-4); color: #000; }
.badge-l5 { background: var(--level-5); color: #000; }
.badge-l6 { background: var(--level-6); }
.badge-lang { background: var(--bg-elevated); color: var(--text-secondary); }
.badge-score { background: var(--bg-elevated); color: var(--text-primary); font-family: var(--font-mono); }
.badge-status { padding: 2px 10px; border-radius: 20px; }
.badge-pass { background: var(--color-emerald-dim); color: var(--color-emerald); }
.badge-fail { background: var(--color-crimson-dim); color: var(--color-crimson); }
.badge-warn { background: var(--color-amber-dim); color: var(--color-amber); }

/* ─── Section Headers ─── */
.section-header {
  font-size: 1.1em;
  font-weight: 700;
  color: var(--text-primary);
  padding-bottom: 8px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ─── Metric Rows ─── */
.metric-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
.metric-label {
  min-width: 120px;
  font-size: 0.85em;
  color: var(--text-secondary);
}
.metric-bar {
  flex: 1;
  height: 6px;
  background: var(--bg-elevated);
  border-radius: 3px;
  overflow: hidden;
}
.metric-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.5s ease;
}
.metric-value {
  min-width: 40px;
  text-align: right;
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 0.9em;
}

/* ─── Tables ─── */
table { width: 100%; border-collapse: collapse; }
th {
  text-align: left;
  padding: 10px 12px;
  font-size: 0.75em;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-subtle);
}
td {
  padding: 10px 12px;
  font-size: 0.88em;
  border-bottom: 1px solid rgba(42, 43, 58, 0.5);
}
tr:hover { background: var(--bg-card-hover); }

/* ─── Buttons ─── */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: 0.85em;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}
.btn:hover { background: var(--bg-card-hover); border-color: var(--color-cyan); }
.btn-primary { background: var(--color-cyan); color: #000; border-color: var(--color-cyan); font-weight: 600; }
.btn-primary:hover { background: #33EAFF; box-shadow: 0 0 12px var(--color-cyan-dim); }
.btn-danger { border-color: var(--color-crimson); color: var(--color-crimson); }
.btn-danger:hover { background: var(--color-crimson-dim); }
.btn-small { padding: 4px 10px; font-size: 0.78em; border-radius: 6px; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ─── Signal Rows ─── */
.signal-row { padding: 4px 0; display: flex; align-items: center; gap: 6px; font-size: 0.88em; }
.signal-row.pass { color: var(--color-emerald); }
.signal-row.pass::before { content: '✓'; font-weight: bold; }
.signal-row.fail { color: var(--text-muted); }
.signal-row.fail::before { content: '✗'; color: var(--color-crimson); }

/* ─── Code Blocks ─── */
pre, code {
  font-family: var(--font-mono);
  font-size: 0.85em;
}
pre {
  background: var(--bg-primary);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 12px;
  overflow-x: auto;
  white-space: pre-wrap;
}

/* ─── Scrollbar ─── */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border-subtle); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--border-active); }

/* ─── Grid Layouts ─── */
.grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
@media (max-width: 700px) {
  .grid-2, .grid-3, .grid-4 { grid-template-columns: 1fr; }
}

/* ─── Animations ─── */
@keyframes pulse-glow {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}
.pulse { animation: pulse-glow 2s ease-in-out infinite; }

@keyframes fade-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.fade-in { animation: fade-in 0.3s ease-out; }

/* ─── Container ─── */
.container { max-width: 1100px; margin: 0 auto; padding: 24px 20px; }
`;

export function getLevelColor(level: number): string {
  const colors: Record<number, string> = {
    1: '#FF3B5C', 2: '#FFB020', 3: '#FFEA00', 4: '#00E676', 5: '#00E5FF', 6: '#B388FF',
  };
  return colors[level] || '#888';
}

export function getLevelGlowClass(level: number): string {
  if (level >= 5) return 'glow-cyan';
  if (level >= 4) return 'glow-emerald';
  if (level >= 3) return 'glow-amber';
  return 'glow-crimson';
}

export function getSeverityGlowClass(severity: 'critical' | 'important' | 'suggestion'): string {
  switch (severity) {
    case 'critical': return 'glow-crimson';
    case 'important': return 'glow-amber';
    case 'suggestion': return 'glow-cyan';
  }
}
