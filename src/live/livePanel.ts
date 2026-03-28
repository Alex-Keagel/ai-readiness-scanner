import * as vscode from 'vscode';
import type { LiveMetrics } from './metricsEngine';
import { TACTICAL_GLASSBOX_CSS, getLevelColor, getLevelGlowClass, getSeverityGlowClass } from '../ui/theme';
import { logger } from '../logging';

export class LivePanel {
  public static currentPanel: LivePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static createOrShow(): LivePanel {
    try {
    const column = vscode.ViewColumn.Beside;

    if (LivePanel.currentPanel) {
      LivePanel.currentPanel.panel.reveal(column);
      return LivePanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'aiReadinessLive',
      '⚡ Live AIPM Dashboard',
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    LivePanel.currentPanel = new LivePanel(panel);
    return LivePanel.currentPanel;
    } catch (err) {
      logger.error('LivePanel: failed to create', err);
      vscode.window.showErrorMessage(`Failed to open panel: ${err instanceof Error ? err.message : String(err)}`);
      return LivePanel.currentPanel!;
    }
  }

  update(metrics: LiveMetrics): void {
    try {
      this.panel.webview.html = this.getHtml(metrics);
    } catch (err) {
      logger.error('LivePanel: update failed', err);
    }
  }

  private getHtml(metrics: LiveMetrics): string {
    try {
    const aipmColor = this.colorValue(metrics.color);
    const concurrencyColor = this.colorValue(
      metrics.concurrency >= 4 ? 'purple' :
      metrics.concurrency >= 2 ? 'green' :
      metrics.concurrency >= 1 ? 'yellow' : 'red'
    );

    const platformBadges = metrics.activePlatforms.map(p => {
      const icon = p === 'copilot' ? '🤖' : p === 'claude' ? '🧠' : p === 'cline' ? '🔧' : p === 'roo' ? '🦘' : '⚡';
      return `<span class="platform-badge">${icon} ${p}</span>`;
    }).join(' ') || '<span class="platform-badge muted">No platforms active</span>';

    const platformRows = metrics.platformBreakdown.map(p => {
      const icon = p.platform === 'copilot' ? '🤖' : p.platform === 'claude' ? '🧠' : p.platform === 'cline' ? '🔧' : p.platform === 'roo' ? '🦘' : '⚡';
      return `<tr><td>${icon} ${p.platform}</td><td>${this.fmtNum(p.tokens)}</td><td>${p.prompts}</td><td>${p.toolCalls}</td></tr>`;
    }).join('');

    // Sparkline data: show AIPM color intensity
    const aipmPct = Math.min(100, (metrics.aipm / 8000) * 100);
    const sessionPct = Math.min(100, (metrics.sessionAipm / 8000) * 100);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live AIPM Dashboard</title>
  <style>
    ${TACTICAL_GLASSBOX_CSS}

    /* Panel-specific layout */
    body { padding: 20px; }
    .header {
      text-align: center;
      padding: 10px 0 20px;
      border-bottom: 1px solid var(--border-subtle);
      margin-bottom: 20px;
    }
    .header h1 { font-size: 1.2em; color: var(--text-muted); }
    .hero {
      text-align: center;
      padding: 30px 0;
    }
    .aipm-value {
      font-size: 4em;
      font-weight: bold;
      line-height: 1;
      font-family: var(--font-mono);
      color: ${aipmColor};
      text-shadow: 0 0 20px ${aipmColor}40;
    }
    .aipm-label {
      font-size: 1.2em;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin: 20px 0;
    }
    .card {
      border-radius: 12px;
      padding: 16px;
      text-align: center;
    }
    .card-value {
      font-size: 2em;
      font-weight: bold;
      line-height: 1.2;
      font-family: var(--font-mono);
    }
    .card-label {
      font-size: 0.85em;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .card-sub {
      font-size: 0.75em;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .bar-container {
      background: var(--bg-elevated);
      border-radius: 4px;
      height: 8px;
      margin: 12px 0 4px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.5s ease;
    }
    .platforms {
      text-align: center;
      margin: 20px 0;
    }
    .platform-badge {
      display: inline-block;
      background: var(--bg-elevated);
      color: var(--text-primary);
      padding: 4px 12px;
      border-radius: 12px;
      margin: 2px 4px;
      font-size: 0.85em;
      border: 1px solid var(--border-subtle);
    }
    .platform-badge.muted { opacity: 0.5; }
    .stats-table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    .stats-table td {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .stats-table td:first-child { color: var(--text-secondary); }
    .stats-table td:last-child { text-align: right; font-weight: bold; font-family: var(--font-mono); }
    .context-windows { margin-top: 8px; }
    .ctx-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; font-size: 0.85em; }
    .ctx-label { min-width: 90px; color: var(--text-secondary); }
    .ctx-bar { flex: 1; height: 8px; background: var(--bg-elevated); border-radius: 4px; overflow: hidden; }
    .ctx-fill { height: 100%; border-radius: 4px; transition: width 0.5s; }
    .ctx-pct { min-width: 80px; text-align: right; font-weight: bold; font-size: 0.85em; font-family: var(--font-mono); }
    .chart-card { background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 8px; }
    .chart-label { font-size: 0.8em; color: var(--text-secondary); margin-bottom: 4px; }
    .footer {
      text-align: center;
      color: var(--text-muted);
      font-size: 0.8em;
      margin-top: 24px;
      padding-top: 12px;
      border-top: 1px solid var(--border-subtle);
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>⚡ LIVE AIPM TRACKER</h1>
  </div>

  <div class="hero">
    <div class="aipm-value">${metrics.aipm.toLocaleString()}</div>
    <div class="aipm-label">AI Tokens Per Minute</div>
    <div class="bar-container">
      <div class="bar-fill" style="width: ${aipmPct}%; background: ${aipmColor};"></div>
    </div>
  </div>

  <div class="grid">
    <div class="card glass-card glow-cyan">
      <div class="card-value" style="color: ${concurrencyColor};">${metrics.concurrency}</div>
      <div class="card-label">Active Agents</div>
      <div class="card-sub">avg ${metrics.avgConcurrency} · peak ${metrics.peakConcurrency}</div>
    </div>
    <div class="card glass-card">
      <div class="card-value">${metrics.aipmPerAgent.toLocaleString()}</div>
      <div class="card-label">AIPM / Agent</div>
      <div class="card-sub">efficiency ratio</div>
    </div>
    <div class="card glass-card">
      <div class="card-value">${metrics.sessionAipm.toLocaleString()}</div>
      <div class="card-label">Session Avg AIPM</div>
      <div class="bar-container">
        <div class="bar-fill" style="width: ${sessionPct}%; background: var(--color-cyan);"></div>
      </div>
    </div>
    <div class="card glass-card">
      <div class="card-value">${metrics.peakAipm.toLocaleString()}</div>
      <div class="card-label">Peak AIPM</div>
      <div class="card-sub">all-time high</div>
    </div>
  </div>

  <div class="platforms">${platformBadges}</div>

  <table class="stats-table">
    <tr><td>📊 Session Tokens</td><td>${metrics.sessionTokens.toLocaleString()}</td></tr>
    <tr><td>💬 Prompts Sent</td><td>${metrics.sessionPrompts}</td></tr>
    <tr><td>🔧 Tool Calls</td><td>${metrics.sessionToolCalls}</td></tr>
    <tr><td>⏱️ Session Duration</td><td>${metrics.sessionDuration}</td></tr>
  </table>

  ${platformRows ? `
  <h3 style="margin-top:16px;font-size:0.9em;color:var(--text-secondary)">🌐 Per-Platform Breakdown</h3>
  <table>
    <thead><tr><th>Platform</th><th>Tokens</th><th>Prompts</th><th>Tools</th></tr></thead>
    <tbody>${platformRows}</tbody>
  </table>` : ''}

  <h3 style="margin-top:16px;font-size:0.9em;color:var(--text-secondary)">📈 Activity Over Time</h3>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:8px 0">
    <div class="chart-card">
      <div class="chart-label">AIPM</div>
      <canvas id="chartAipm" height="120"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-label">Active Agents</div>
      <canvas id="chartConcurrency" height="120"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-label">Tokens (cumulative)</div>
      <canvas id="chartTokens" height="120"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-label">Tool Calls (cumulative)</div>
      <canvas id="chartTools" height="120"></canvas>
    </div>
  </div>

  <script>
    (function() {
      function drawChart(canvasId, data, timestamps, color) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !data || data.length < 2) return;

        // Make canvas fill its container width
        const rect = canvas.parentElement.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr;
        canvas.height = 120 * dpr;
        canvas.style.width = '100%';
        canvas.style.height = '120px';

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        const w = rect.width;
        const h = 120;

        const padBottom = 20; // space for x-axis labels
        const padTop = 18;    // space for value label
        const chartH = h - padBottom - padTop;

        ctx.clearRect(0, 0, w, h);

        const max = Math.max(...data, 1);
        const min = Math.min(...data);
        const range = max - min || 1;

        // Grid lines
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 3; i++) {
          const y = padTop + (chartH / 3) * i;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }

        // Data line
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        for (let i = 0; i < data.length; i++) {
          const x = (i / (data.length - 1)) * w;
          const y = padTop + chartH - ((data[i] - min) / range) * chartH;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Fill under line
        ctx.lineTo(w, padTop + chartH);
        ctx.lineTo(0, padTop + chartH);
        ctx.closePath();
        ctx.fillStyle = color.replace(')', ',0.1)').replace('rgb', 'rgba');
        ctx.fill();

        // Current value label (top right)
        ctx.fillStyle = color;
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(data[data.length - 1].toLocaleString(), w - 4, 14);

        // X-axis time labels
        if (timestamps && timestamps.length >= 2) {
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.font = '9px system-ui, sans-serif';
          ctx.textAlign = 'center';
          const labelCount = Math.min(5, timestamps.length);
          for (let i = 0; i < labelCount; i++) {
            const idx = Math.floor(i * (timestamps.length - 1) / (labelCount - 1));
            const x = (idx / (data.length - 1)) * w;
            const t = new Date(timestamps[idx]);
            const label = t.getHours() + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
            ctx.fillText(label, x, h - 4);
          }
        }

        // Y-axis max/min
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.font = '9px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(max.toLocaleString(), 4, padTop + 8);
        if (min !== max) {
          ctx.fillText(min.toLocaleString(), 4, padTop + chartH - 2);
        }
      }

      const history = ${JSON.stringify(metrics.history ?? { timestamps: [], aipm: [], concurrency: [], tokens: [], toolCalls: [] })};
      const ts = history.timestamps || [];
      drawChart('chartAipm', history.aipm, ts, 'rgb(168,85,247)');
      drawChart('chartConcurrency', history.concurrency, ts, 'rgb(34,197,94)');
      drawChart('chartTokens', history.tokens, ts, 'rgb(59,130,246)');
      drawChart('chartTools', history.toolCalls, ts, 'rgb(234,179,8)');

      // Redraw on resize
      let resizeTimer;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          drawChart('chartAipm', history.aipm, ts, 'rgb(168,85,247)');
          drawChart('chartConcurrency', history.concurrency, ts, 'rgb(34,197,94)');
          drawChart('chartTokens', history.tokens, ts, 'rgb(59,130,246)');
          drawChart('chartTools', history.toolCalls, ts, 'rgb(234,179,8)');
        }, 100);
      });
    })();
  </script>

  ${metrics.agentContextWindows.length > 0 ? `
  <h3 style="margin-top:16px;font-size:0.9em;color:var(--text-secondary)">🧠 Context Windows</h3>
  <div class="context-windows">
    ${metrics.agentContextWindows.map(cw => {
      const barColor = cw.status === 'critical' ? 'var(--color-crimson)' : cw.status === 'warning' ? 'var(--level-3)' : 'var(--color-emerald)';
      const limitLabel = cw.estimatedLimit >= 1_000_000 ? `${(cw.estimatedLimit / 1_000_000).toFixed(0)}M` : `${(cw.estimatedLimit / 1000).toFixed(0)}K`;
      return `<div class="ctx-row">
        <span class="ctx-label">${cw.platform} ${cw.sessionId}</span>
        <div class="ctx-bar"><div class="ctx-fill" style="width:${Math.min(cw.usagePercent, 100)}%;background:${barColor}"></div></div>
        <span class="ctx-pct" style="color:${barColor}">${cw.usagePercent}% of ${limitLabel}</span>
      </div>`;
    }).join('')}
  </div>` : ''}

  <div class="footer">
    Polling every 2s
  </div>
</body>
</html>`;
    } catch (err) {
      logger.error('LivePanel: render failed', err);
      return `<html><body><h2>❌ Render Error</h2><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`;
    }
  }

  private colorValue(color: string): string {
    switch (color) {
      case 'purple': return '#B388FF';
      case 'green': return '#00E676';
      case 'yellow': return '#FFEA00';
      case 'red': return '#FF3B5C';
      default: return '#888';
    }
  }

  private fmtNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  }

  private dispose(): void {
    LivePanel.currentPanel = undefined;
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
  }
}
