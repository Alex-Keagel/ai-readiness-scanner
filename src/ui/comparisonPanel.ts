import * as vscode from 'vscode';
import { logger } from '../logging';
import { MATURITY_LEVELS,MaturityLevel,SignalResult } from '../scoring/types';
import { ScanRun } from '../storage/runStorage';
import { TACTICAL_GLASSBOX_CSS } from './theme';

export class ComparisonPanel {
  public static currentPanel: ComparisonPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static createOrShow(runA: ScanRun, runB: ScanRun): void {
    try {
    const column = vscode.ViewColumn.One;
    if (ComparisonPanel.currentPanel) {
      ComparisonPanel.currentPanel.panel.reveal(column);
      ComparisonPanel.currentPanel.panel.webview.html = ComparisonPanel.getHtml(runA, runB);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'aiReadinessComparison', '🔄 Scan Comparison',
      column, { enableScripts: true, retainContextWhenHidden: true }
    );
    ComparisonPanel.currentPanel = new ComparisonPanel(panel);
    panel.webview.html = ComparisonPanel.getHtml(runA, runB);
    } catch (err) {
      logger.error('ComparisonPanel: failed to create', err);
      vscode.window.showErrorMessage(`Failed to open panel: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private static getHtml(runA: ScanRun, runB: ScanRun): string {
    try {
    const a = runA.report;
    const b = runB.report;

    const scoreDelta = b.overallScore - a.overallScore;
    const depthDelta = b.depth - a.depth;
    const levelDelta = b.primaryLevel - a.primaryLevel;
    const dateA = new Date(runA.timestamp).toLocaleString();
    const dateB = new Date(runB.timestamp).toLocaleString();

    // Build signal comparison
    const signalsA = new Map<string, SignalResult>();
    const signalsB = new Map<string, SignalResult>();
    a.levels.forEach(l => l.signals.forEach(s => signalsA.set(s.signalId, s)));
    b.levels.forEach(l => l.signals.forEach(s => signalsB.set(s.signalId, s)));

    const allSignalIds = new Set([...signalsA.keys(), ...signalsB.keys()]);
    
    type SignalDiff = {
      id: string;
      change: 'gained' | 'lost' | 'improved' | 'declined' | 'unchanged' | 'new';
      scoreA: number;
      scoreB: number;
      detectedA: boolean;
      detectedB: boolean;
    };
    
    const diffs: SignalDiff[] = [];
    for (const id of allSignalIds) {
      const sa = signalsA.get(id);
      const sb = signalsB.get(id);
      const scoreA = sa?.score || 0;
      const scoreB = sb?.score || 0;
      const detA = sa?.detected || false;
      const detB = sb?.detected || false;
      
      let change: SignalDiff['change'];
      if (!detA && detB) change = 'gained';
      else if (detA && !detB) change = 'lost';
      else if (scoreB > scoreA + 5) change = 'improved';
      else if (scoreB < scoreA - 5) change = 'declined';
      else if (!sa) change = 'new';
      else change = 'unchanged';
      
      diffs.push({ id, change, scoreA, scoreB, detectedA: detA, detectedB: detB });
    }

    const gained = diffs.filter(d => d.change === 'gained');
    const lost = diffs.filter(d => d.change === 'lost');
    const improved = diffs.filter(d => d.change === 'improved');
    const declined = diffs.filter(d => d.change === 'declined');

    const deltaIcon = (delta: number) => delta > 0 ? `<span style="color:var(--color-emerald)">▲ +${delta}</span>` : delta < 0 ? `<span style="color:var(--color-crimson)">▼ ${delta}</span>` : `<span style="color:var(--text-secondary)">→ 0</span>`;

    // Per-level comparison
    const levelComparison = Array.from({ length: 6 }, (_, i) => {
      const level = (i + 1) as MaturityLevel;
      const la = a.levels.find(l => l.level === level);
      const lb = b.levels.find(l => l.level === level);
      return { level, nameA: la?.name || MATURITY_LEVELS[level].name, scoreA: la?.rawScore || 0, scoreB: lb?.rawScore || 0, qualA: la?.qualified || false, qualB: lb?.qualified || false };
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Scan Comparison</title>
  <style>
    ${TACTICAL_GLASSBOX_CSS}

    /* Panel-specific layout */
    body { padding: 20px; max-width: 1100px; margin: 0 auto; }
    h1 { border-bottom: 2px solid var(--border-subtle); padding-bottom: 12px; }
    
    .comparison-header { display: grid; grid-template-columns: 1fr auto 1fr; gap: 16px; margin: 20px 0; align-items: center; }
    .run-card { border-radius: 12px; padding: 20px; text-align: center; }
    .run-card.older { opacity: 0.8; }
    .run-card .level { font-size: 2em; font-weight: bold; }
    .run-card .score { font-size: 1.5em; margin: 4px 0; }
    .run-card .date { font-size: 0.85em; color: var(--text-secondary); }
    .vs { font-size: 1.5em; font-weight: bold; color: var(--text-secondary); }
    
    .delta-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 20px 0; }
    .delta-card { border-radius: 8px; padding: 16px; text-align: center; }
    .delta-card .delta-value { font-size: 2em; font-weight: bold; }
    .delta-card .delta-label { font-size: 0.85em; color: var(--text-secondary); }
    
    .changes-section { margin: 24px 0; }
    .changes-section h2 { font-size: 1.1em; display: flex; align-items: center; gap: 8px; }
    .signal-diff { padding: 8px 12px; margin: 4px 0; border-radius: 6px; font-size: 0.9em; display: flex; align-items: center; gap: 8px; }
    .signal-diff.gained { background: var(--color-emerald-dim); border-left: 3px solid var(--color-emerald); }
    .signal-diff.lost { background: var(--color-crimson-dim); border-left: 3px solid var(--color-crimson); }
    .signal-diff.improved { background: var(--color-cyan-dim); border-left: 3px solid var(--color-cyan); }
    .signal-diff.declined { background: var(--color-amber-dim); border-left: 3px solid var(--color-amber); }
    .signal-name { flex: 1; }
    .signal-scores { font-size: 0.85em; color: var(--text-secondary); }
    
    .level-table th, .level-table td { border-bottom: 1px solid var(--border-subtle); }
    .level-table th { color: var(--text-muted); }
    .level-table .qualified { color: var(--color-emerald); }
    .level-table .not-qualified { color: var(--text-secondary); }
    
    .empty-changes { color: var(--text-secondary); font-style: italic; padding: 12px; }
  </style>
</head>
<body>
  <h1>🔄 Scan Comparison</h1>

  <div class="comparison-header">
    <div class="run-card glass-card older">
      <div class="date">${escapeHtml(dateA)}</div>
      <div class="level">L${a.primaryLevel}</div>
      <div class="score">${a.overallScore}/100</div>
      <div class="date">${escapeHtml(runA.toolName)} · ${a.depth}% depth</div>
    </div>
    <div class="vs">→</div>
    <div class="run-card glass-card">
      <div class="date">${escapeHtml(dateB)}</div>
      <div class="level">L${b.primaryLevel}</div>
      <div class="score">${b.overallScore}/100</div>
      <div class="date">${escapeHtml(runB.toolName)} · ${b.depth}% depth</div>
    </div>
  </div>

  <div class="delta-cards">
    <div class="delta-card glass-card ${scoreDelta > 0 ? 'glow-emerald' : scoreDelta < 0 ? 'glow-crimson' : ''}">
      <div class="delta-value">${deltaIcon(scoreDelta)}</div>
      <div class="delta-label">Overall Score</div>
    </div>
    <div class="delta-card glass-card ${levelDelta > 0 ? 'glow-emerald' : levelDelta < 0 ? 'glow-crimson' : ''}">
      <div class="delta-value">${deltaIcon(levelDelta)}</div>
      <div class="delta-label">Level Change</div>
    </div>
    <div class="delta-card glass-card ${depthDelta > 0 ? 'glow-emerald' : depthDelta < 0 ? 'glow-crimson' : ''}">
      <div class="delta-value">${deltaIcon(depthDelta)}</div>
      <div class="delta-label">Depth Change</div>
    </div>
  </div>

  <div class="changes-section">
    <h2>📊 Per-Level Breakdown</h2>
    <table class="level-table">
      <tr><th>Level</th><th>Name</th><th>Before</th><th>After</th><th>Change</th></tr>
      ${levelComparison.map(lc => `
        <tr>
          <td>L${lc.level}</td>
          <td style="text-align:left">${escapeHtml(lc.nameA)}</td>
          <td class="${lc.qualA ? 'qualified' : 'not-qualified'}">${lc.scoreA}${lc.qualA ? ' ✓' : ''}</td>
          <td class="${lc.qualB ? 'qualified' : 'not-qualified'}">${lc.scoreB}${lc.qualB ? ' ✓' : ''}</td>
          <td>${deltaIcon(lc.scoreB - lc.scoreA)}</td>
        </tr>
      `).join('')}
    </table>
  </div>

  ${gained.length > 0 ? `
  <div class="changes-section">
    <h2>✅ Signals Gained (${gained.length})</h2>
    ${gained.map(d => `<div class="signal-diff gained">
      <span class="signal-name">${humanize(d.id)}</span>
      <span class="signal-scores">0 → ${d.scoreB}</span>
    </div>`).join('')}
  </div>` : ''}

  ${lost.length > 0 ? `
  <div class="changes-section">
    <h2>❌ Signals Lost (${lost.length})</h2>
    ${lost.map(d => `<div class="signal-diff lost">
      <span class="signal-name">${humanize(d.id)}</span>
      <span class="signal-scores">${d.scoreA} → 0</span>
    </div>`).join('')}
  </div>` : ''}

  ${improved.length > 0 ? `
  <div class="changes-section">
    <h2>📈 Signals Improved (${improved.length})</h2>
    ${improved.map(d => `<div class="signal-diff improved">
      <span class="signal-name">${humanize(d.id)}</span>
      <span class="signal-scores">${d.scoreA} → ${d.scoreB}</span>
    </div>`).join('')}
  </div>` : ''}

  ${declined.length > 0 ? `
  <div class="changes-section">
    <h2>📉 Signals Declined (${declined.length})</h2>
    ${declined.map(d => `<div class="signal-diff declined">
      <span class="signal-name">${humanize(d.id)}</span>
      <span class="signal-scores">${d.scoreA} → ${d.scoreB}</span>
    </div>`).join('')}
  </div>` : ''}

  ${gained.length === 0 && lost.length === 0 && improved.length === 0 && declined.length === 0 
    ? '<div class="empty-changes">No significant signal changes between runs.</div>' : ''}
</body>
</html>`;
    } catch (err) {
      logger.error('ComparisonPanel: render failed', err);
      return `<html><body><h2>❌ Render Error</h2><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`;
    }
  }

  private dispose(): void {
    ComparisonPanel.currentPanel = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function humanize(signalId: string): string {
  return signalId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
