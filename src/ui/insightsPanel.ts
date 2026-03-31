import * as vscode from 'vscode';
import { ReadinessReport, MATURITY_LEVELS, AI_TOOLS, AITool, Insight, MaturityLevel, SignalResult } from '../scoring/types';
import { generateRadarChartSVG, type RadarDataPoint } from '../metrics';
import { TACTICAL_GLASSBOX_CSS, getSeverityGlowClass } from './theme';
import { logger } from '../logging';
import { humanizeSignalId } from '../utils';

export class InsightsPanel {
  public static currentPanel: InsightsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    report: ReadinessReport,
  ) {
    this.panel = panel;
    try {
      this.panel.webview.html = this.getHtml(report);
    } catch (err) {
      logger.error('InsightsPanel render failed', err);
      this.panel.webview.html = `<html><body><h1>❌ Error rendering insights</h1><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`;
    }
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (msg.command === 'open-action-center') {
          vscode.commands.executeCommand('ai-readiness.fixAll');
        }
      },
      null,
      this.disposables
    );
  }

  public static createOrShow(
    report: ReadinessReport,
    onAction?: (signalId: string, action: 'fix' | 'preview') => Promise<void>
  ): void {
    try {
    const column = vscode.ViewColumn.One;
    if (InsightsPanel.currentPanel) {
      InsightsPanel.currentPanel.panel.reveal(column);
      InsightsPanel.currentPanel.panel.webview.html = new InsightsPanel(InsightsPanel.currentPanel.panel, report).getHtml(report);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'aiReadinessInsights', '💡 AI Strategy',
      column, { enableScripts: true, retainContextWhenHidden: true }
    );
    InsightsPanel.currentPanel = new InsightsPanel(panel, report);
    } catch (err) {
      logger.error('InsightsPanel: failed to create', err);
      vscode.window.showErrorMessage(`Failed to open panel: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getHtml(report: ReadinessReport): string {
    const insights = report.insights || [];
    const toolMeta = AI_TOOLS[report.selectedTool as AITool];
    const toolName = toolMeta?.name ?? report.selectedTool;

    const critical = insights.filter(i => i.severity === 'critical');
    const important = insights.filter(i => i.severity === 'important');
    const suggestions = insights.filter(i => i.severity === 'suggestion');

    const currentLevel = report.primaryLevel;
    const nextLevel = Math.min(6, currentLevel + 1) as 1|2|3|4|5|6;
    const nextLevelInfo = MATURITY_LEVELS[nextLevel];

    const missingSignals = report.levels
      .flatMap(l => l.signals)
      .filter(s => !s.detected && s.level <= nextLevel);

    // Compute Action Center totals (same logic as recommendationsPanel.buildRecommendations)
    const QUALITY_THRESHOLD = 40;
    const allSignals = report.levels.flatMap(ls => ls.signals);
    const actionableSignals = allSignals.filter(s => !s.detected || s.score < QUALITY_THRESHOLD);
    let acCritical = 0, acImportant = 0, acSuggestion = 0;
    for (const s of actionableSignals) {
      if (!s.detected && s.level <= 3) acCritical++;
      else if (!s.detected) acImportant++;
      else acSuggestion++;
    }
    // Add insight-based recs
    for (const i of insights) {
      if (i.severity === 'critical') acCritical++;
      else if (i.severity === 'important') acImportant++;
      else acSuggestion++;
    }
    const isTestComponent = (name: string, path: string) => {
      const n = name.toLowerCase(), p = path.toLowerCase();
      return n.endsWith('.tests') || n.endsWith('tests') || n.startsWith('test_') ||
        p.includes('.tests/') || p.includes('/tests/') || p.endsWith('.tests');
    };
    const isRemoved = (name: string, desc?: string) => {
      return /(removed|deprecated|obsolete|archived)/i.test(name) || /(removed|deprecated|obsolete|archived)/i.test(desc || '');
    };
    const isVirtualGroup = (path: string) => path.includes('.group-');
    const isConfigDir = (path: string) => {
      const top = path.split('/')[0];
      return top.startsWith('.') && !top.startsWith('.github');
    };
    // Add component-quality recs
    const lowComponents = (report.componentScores || []).filter(c =>
      c.overallScore < 50 && !isTestComponent(c.name, c.path) && !c.isGenerated &&
      !isRemoved(c.name, c.description) && !isVirtualGroup(c.path) && !isConfigDir(c.path)
    );
    for (const comp of lowComponents) {
      const compSignals = comp.signals || [];
      if (!compSignals.some(s => s.signal?.includes('readme') && s.present)) {
        if (comp.overallScore < 30) acImportant++; else acSuggestion++;
      }
      if (!compSignals.some(s => s.signal?.includes('doc') && s.present) && comp.overallScore < 35) {
        acSuggestion++;
      }
    }
    const acTotal = acCritical + acImportant + acSuggestion;

    // Generate executive brief
    const executiveBrief = this.generateExecutiveBrief(report, acCritical, acImportant, acSuggestion, currentLevel, nextLevel);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>AI Readiness Insights</title>
  <style>
    ${TACTICAL_GLASSBOX_CSS}

    /* Panel-specific layout */
    body { padding: 20px; max-width: 1000px; margin: 0 auto; }
    h1 { border-bottom: 2px solid var(--border-subtle); padding-bottom: 12px; }
    .summary { border-radius: 12px; padding: 20px; margin: 16px 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; text-align: center; }
    .summary-item .count { font-size: 2em; font-weight: bold; }
    .summary-item .label { font-size: 0.85em; color: var(--text-secondary); }
    .summary-item.critical .count { color: var(--color-crimson); }
    .summary-item.important .count { color: var(--level-3); }
    .summary-item.suggestion .count { color: var(--color-cyan); }
    .section { margin: 24px 0; }
    .section h2 { font-size: 1.1em; display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .insight-card { border-radius: 8px; padding: 16px; margin: 8px 0; transition: transform 0.1s; }
    .insight-card:hover { transform: translateX(4px); }
    .insight-card.critical { border-left: 4px solid var(--color-crimson); }
    .insight-card.important { border-left: 4px solid var(--level-3); }
    .insight-card.suggestion { border-left: 4px solid var(--color-cyan); }
    .insight-title { font-weight: 600; font-size: 1em; margin-bottom: 6px; }
    .insight-rec { font-size: 0.9em; color: var(--text-secondary); }
    .insight-meta { font-size: 0.8em; color: var(--text-secondary); margin-top: 8px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
    .insight-tag { padding: 2px 8px; border-radius: 4px; background: var(--bg-elevated); color: var(--text-primary); font-size: 0.8em; }
    .fix-btn { padding: 4px 12px; border-radius: 6px; border: 1px solid var(--border-subtle); background: var(--bg-elevated); color: var(--text-primary); cursor: pointer; font-size: 0.8em; transition: all 0.15s; }
    .fix-btn:hover { background: var(--bg-card-hover); border-color: var(--color-cyan); }
    .fix-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .fix-btn.generating { background: var(--color-amber-dim); border-color: var(--color-amber); }
    .fix-btn.done { background: var(--color-emerald-dim); border-color: var(--color-emerald); color: var(--color-emerald); }
    .fix-btn.error { background: var(--color-crimson-dim); border-color: var(--color-crimson); color: var(--color-crimson); }
    .next-level { background: linear-gradient(135deg, var(--bg-card) 0%, transparent 100%); border: 2px solid var(--color-cyan); border-radius: 12px; padding: 20px; margin: 24px 0; }
    .next-level h2 { margin: 0 0 12px 0; color: var(--color-cyan); }
    .missing-signal { padding: 6px 0; font-size: 0.9em; display: flex; align-items: center; gap: 8px; justify-content: space-between; }
    .missing-signal .signal-name { display: flex; align-items: center; gap: 8px; }
    .missing-signal .signal-name::before { content: '○'; color: var(--color-crimson); }
    .empty-state { text-align: center; padding: 40px; opacity: 0.6; }

    /* Path Flow Graph */
    .flow-graph { margin: 24px 0; }
    .flow-graph svg { width: 100%; height: auto; }
    .flow-level-box { fill: var(--bg-card); stroke-width: 2; rx: 8; }
    .flow-level-text { fill: var(--text-primary); font-size: 12px; font-weight: 600; }
    .flow-action-node { rx: 6; }
    .flow-action-text { fill: var(--text-primary); font-size: 10px; }
    .flow-arrow { stroke: var(--border-subtle); stroke-width: 1.5; fill: none; marker-end: url(#arrowhead); }

    /* Best Setup */
    .best-setup { margin: 24px 0; }
    .setup-tree { padding: 0; margin: 8px 0; list-style: none; }
    .setup-file { padding: 6px 12px; margin: 4px 0; border-radius: 6px; background: var(--bg-elevated); display: flex; align-items: center; gap: 8px; font-size: 0.9em; }
    .setup-file.exists { border-left: 3px solid var(--color-emerald); }
    .setup-file.missing { border-left: 3px solid var(--color-crimson); opacity: 0.85; }
    .setup-file .purpose { color: var(--text-secondary); font-size: 0.85em; margin-left: auto; }
    .setup-chain { display: flex; align-items: center; gap: 6px; padding: 8px 0; color: var(--text-secondary); font-size: 0.85em; flex-wrap: wrap; }
    .setup-chain .chain-arrow { color: var(--color-cyan); }

    /* Component Health */
    .health-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; margin: 8px 0; }
    .health-cell { padding: 10px; border-radius: 8px; background: var(--bg-elevated); border-left: 4px solid; }
    .health-cell .comp-name { font-size: 0.85em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .health-cell .comp-score { font-size: 1.4em; font-weight: bold; }
    .health-cell .comp-level { font-size: 0.75em; color: var(--text-secondary); }

    /* Issue Summary */
    .issue-summary { padding: 16px; }
    .issue-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; font-size: 0.9em; }
    .issue-row .issue-dot { font-size: 0.8em; }
    .issue-row .issue-titles { color: var(--text-secondary); font-size: 0.85em; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 50%; }

    /* LLM Insight Cards */
    .llm-insights { margin: 24px 0; }
    .llm-insight-card { border-radius: 8px; padding: 14px 16px; margin: 8px 0; background: var(--bg-elevated); transition: transform 0.1s; }
    .llm-insight-card:hover { transform: translateX(4px); }
    .llm-insight-card.critical { border-left: 4px solid var(--color-crimson); }
    .llm-insight-card.important { border-left: 4px solid var(--level-3); }
    .llm-insight-card.suggestion { border-left: 4px solid var(--color-cyan); }
    .llm-insight-title { font-weight: 600; font-size: 0.92em; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
    .llm-insight-rec { font-size: 0.85em; color: var(--text-secondary); line-height: 1.5; }
    .llm-insight-meta { display: flex; gap: 10px; margin-top: 8px; font-size: 0.78em; color: var(--text-secondary); flex-wrap: wrap; align-items: center; }
    .llm-insight-tag { padding: 2px 8px; border-radius: 4px; background: var(--bg-card); font-size: 0.85em; }
    .llm-insights-header { display: flex; align-items: center; justify-content: space-between; }
    .llm-insights-header .count-badge { font-size: 0.8em; padding: 2px 10px; border-radius: 12px; background: var(--bg-elevated); color: var(--text-secondary); }
    .btn-primary { padding: 8px 16px; border-radius: 8px; border: 1px solid var(--color-cyan); background: linear-gradient(135deg, rgba(0,210,255,0.15), rgba(0,210,255,0.05)); color: var(--color-cyan); cursor: pointer; font-size: 0.9em; font-weight: 600; transition: all 0.15s; }
    .btn-primary:hover { background: linear-gradient(135deg, rgba(0,210,255,0.25), rgba(0,210,255,0.1)); }

    /* Executive Brief */
    .exec-brief { margin: 16px 0 24px; }
    .exec-brief .brief-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .brief-panel { border-radius: 10px; padding: 16px; }
    .brief-panel h3 { font-size: 0.9em; margin: 0 0 12px; color: var(--text-secondary); letter-spacing: 0.5px; text-transform: uppercase; }
    .brief-counts { display: flex; gap: 16px; }
    .brief-count { text-align: center; flex: 1; }
    .brief-count .num { font-size: 1.8em; font-weight: bold; line-height: 1; }
    .brief-count .lbl { font-size: 0.75em; color: var(--text-secondary); margin-top: 4px; }
    .brief-count.crit .num { color: var(--color-crimson); }
    .brief-count.imp .num { color: var(--level-3); }
    .brief-count.sug .num { color: var(--color-cyan); }
    .brief-focus { margin-top: 16px; padding: 12px; border-radius: 8px; background: var(--bg-elevated); font-size: 0.85em; line-height: 1.5; }
    .brief-focus .focus-label { font-weight: 600; color: var(--color-amber); margin-bottom: 4px; }
    .brief-focus ul { margin: 6px 0 0; padding-left: 18px; }
    .brief-focus li { margin: 3px 0; }
    .score-ring { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 8px 0; }
    .score-ring .ring-score { font-size: 2.6em; font-weight: bold; color: var(--text-primary); }
    .score-ring .ring-label { font-size: 0.85em; color: var(--text-secondary); }
    .level-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 20px; font-size: 0.85em; font-weight: 600; background: linear-gradient(135deg, rgba(0,210,255,0.12), rgba(0,210,255,0.04)); border: 1px solid var(--color-cyan); color: var(--color-cyan); margin-top: 8px; }
  </style>
</head>
<body>
  <h1>💡 AI Strategy</h1>
  <div class="meta" style="color:var(--text-secondary);margin-bottom:16px">
    ${toolMeta?.icon || ''} ${this.escapeHtml(toolName)} · L${report.primaryLevel} ${MATURITY_LEVELS[report.primaryLevel].name} · Score: ${report.overallScore}/100
  </div>

  <div class="exec-brief">
    <div class="brief-grid">
      <div class="brief-panel glass-card">
        <h3>📊 Readiness Overview</h3>
        <div class="score-ring">
          <div>
            <div class="ring-score">${report.overallScore}</div>
            <div class="ring-label">out of 100</div>
          </div>
          <div style="text-align:left">
            <div class="level-badge">L${currentLevel} ${MATURITY_LEVELS[currentLevel].name}</div>
            <div style="font-size:0.8em;color:var(--text-secondary);margin-top:6px">${missingSignals.length} signal${missingSignals.length !== 1 ? 's' : ''} to reach L${nextLevel}</div>
          </div>
        </div>
      </div>
      <div class="brief-panel glass-card">
        <h3>🔧 Action Items</h3>
        <div class="brief-counts">
          <div class="brief-count crit"><div class="num">${acCritical}</div><div class="lbl">Critical</div></div>
          <div class="brief-count imp"><div class="num">${acImportant}</div><div class="lbl">Important</div></div>
          <div class="brief-count sug"><div class="num">${acSuggestion}</div><div class="lbl">Suggestions</div></div>
        </div>
        <div style="text-align:center;margin-top:8px;font-size:0.8em;color:var(--text-secondary)">${acTotal} total recommendations</div>
      </div>
    </div>
    ${executiveBrief}
  </div>

  ${this.renderPathFlowGraph(report, currentLevel, missingSignals)}

  ${this.renderBestSetup(report)}

  ${this.renderComponentHealth(report)}

  ${insights.length > 0 ? `
  <div class="section llm-insights">
    <div class="llm-insights-header">
      <h2>🧠 LLM Analysis</h2>
      <span class="count-badge">${insights.length} insight${insights.length !== 1 ? 's' : ''}</span>
    </div>
    ${[...critical, ...important, ...suggestions].map(i => `
    <div class="llm-insight-card ${i.severity} glass-card">
      <div class="llm-insight-title">
        ${i.severity === 'critical' ? '🔴' : i.severity === 'important' ? '🟡' : '🔵'}
        ${this.escapeHtml(i.title)}
      </div>
      <div class="llm-insight-rec">${this.escapeHtml(i.recommendation)}</div>
      <div class="llm-insight-meta">
        ${i.category ? `<span class="llm-insight-tag">${this.escapeHtml(i.category)}</span>` : ''}
        ${i.affectedComponent ? `<span>📦 ${this.escapeHtml(i.affectedComponent)}</span>` : ''}
        ${i.estimatedImpact ? `<span>📈 ${this.escapeHtml(i.estimatedImpact)}</span>` : ''}
        ${i.confidenceScore !== undefined ? `<span title="Confidence: ${Math.round(i.confidenceScore * 100)}%">${i.confidenceScore >= 0.8 ? '🟢' : i.confidenceScore >= 0.5 ? '🟡' : '🔴'} ${Math.round(i.confidenceScore * 100)}% conf</span>` : ''}
      </div>
    </div>`).join('')}
  </div>` : ''}

  ${insights.length === 0 ? '<div class="empty-state"><h2>No strategy data yet</h2><p>Run a full scan to generate AI strategy insights.</p></div>' : ''}

  <script>
    const vscode = acquireVsCodeApi();
  </script>
</body>
</html>`;
  }

  private renderCodebaseMetrics(report: ReadinessReport): string {
    try {
    const m = report.codebaseMetrics;
    if (!m) { return ''; }

    const radarData: RadarDataPoint[] = [
      { label: 'Semantic Density', value: m.semanticDensity, color: '#B388FF' },
      { label: 'Type Strictness', value: m.typeStrictnessIndex, color: '#00E676' },
      { label: 'Low Fragmentation', value: m.contextFragmentation, color: '#FFB020' },
      { label: 'Overall Score', value: report.overallScore, color: '#B388FF' },
      { label: 'Depth', value: report.depth, color: '#00E5FF' },
    ];
    const radarSvg = generateRadarChartSVG(radarData, 280, true);

    // Metric bars with tooltips
    const metrics = [
      { label: 'Semantic Density', value: m.semanticDensity, color: '#B388FF', tip: 'Ratio of comments, docstrings & descriptive names to raw logic. Higher = agents pull better context on first try.' },
      { label: 'Type Strictness', value: m.typeStrictnessIndex, color: '#00E676', tip: 'Percentage of code using explicit types & interfaces. Agents rely on LSPs for cross-file references — duck typing kills confidence.' },
      { label: 'Low Fragmentation', value: m.contextFragmentation, color: '#FFB020', tip: 'How self-contained modules are. High = fewer files needed to trace one flow. Low fragmentation reduces hallucination rate.' },
      { label: 'Overall Score', value: report.overallScore, color: '#B388FF', tip: 'Composite AI readiness score combining all maturity signals, component scores, and quality gates.' },
      { label: 'Depth', value: report.depth, color: '#00E5FF', tip: 'Progress within the current maturity level. 100% = ready to advance to the next level.' },
    ];

    const barsHtml = metrics.map(m => `
      <div class="metric-row" title="${this.escapeHtml(m.tip)}">
        <span class="metric-label">${this.escapeHtml(m.label)} ℹ️</span>
        <div class="metric-bar"><div class="metric-bar-fill" style="width:${m.value}%;background:${m.color}"></div></div>
        <span class="metric-value" style="color:${m.color}">${Math.round(m.value)}</span>
      </div>
    `).join('');

    return `
    <div class="section">
      <h2>🧠 Codebase Readiness Metrics</h2>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:0 0 auto;position:relative">
          ${radarSvg}
          <div style="text-align:center;font-size:0.72em;color:var(--text-muted);margin-top:4px">Outer ring = perfect score (100)</div>
        </div>
        <div style="flex:1;min-width:220px">
          ${barsHtml}
        </div>
      </div>
    </div>`;
    } catch (err) {
      logger.error('InsightsPanel: renderCodebaseMetrics failed', err);
      return '<div class="section">⚠️ Error rendering codebase metrics</div>';
    }
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private generateExecutiveBrief(
    report: ReadinessReport,
    acCritical: number, acImportant: number, acSuggestion: number,
    currentLevel: number, nextLevel: number
  ): string {
    const bullets: string[] = [];
    const allSignals = report.levels.flatMap(ls => ls.signals);
    const detectedCount = allSignals.filter(s => s.detected).length;
    const totalSignals = allSignals.length;

    // Biggest bottleneck
    if (acCritical > 0) {
      const missingL2L3 = allSignals.filter(s => !s.detected && s.level <= 3);
      if (missingL2L3.length > 0) {
        bullets.push(`<strong>${missingL2L3.length} foundational signals</strong> are missing (L2-L3) — these block agents from reliably editing your code`);
      }
    }

    // Low-scoring components
    const lowComps = (report.componentScores || []).filter(c => c.overallScore < 40);
    if (lowComps.length > 0) {
      const worstComp = lowComps.sort((a, b) => a.overallScore - b.overallScore)[0];
      bullets.push(`<strong>${lowComps.length} component${lowComps.length > 1 ? 's score' : ' scores'} below 40</strong> — "${this.escapeHtml(worstComp.name)}" (${worstComp.overallScore}/100) is the weakest link`);
    }

    // Quality vs presence gap
    const detectedLowQuality = allSignals.filter(s => s.detected && s.score < 40);
    if (detectedLowQuality.length > 5) {
      bullets.push(`<strong>${detectedLowQuality.length} signals are present but low quality</strong> — files exist but content doesn't help agents understand the code`);
    }

    // Path to next level
    const missingForNext = allSignals.filter(s => !s.detected && s.level <= nextLevel);
    if (missingForNext.length <= 3 && missingForNext.length > 0) {
      bullets.push(`Only <strong>${missingForNext.length} signal${missingForNext.length > 1 ? 's' : ''}</strong> away from reaching Level ${nextLevel} — this is achievable in one session`);
    }

    // Signal detection rate
    const detectionRate = totalSignals > 0 ? Math.round((detectedCount / totalSignals) * 100) : 0;
    if (detectionRate < 50) {
      bullets.push(`Signal detection rate is <strong>${detectionRate}%</strong> — more than half of expected configuration files are missing`);
    }

    if (bullets.length === 0) {
      bullets.push(`Your workspace is well-configured at Level ${currentLevel} with ${detectionRate}% signal coverage`);
    }

    return `<div class="brief-focus glass-card">
      <div class="focus-label">🎯 What Matters Most</div>
      <ul>${bullets.map(b => `<li>${b}</li>`).join('')}</ul>
      <button class="btn-primary" style="margin-top:12px;width:100%" onclick="vscode.postMessage({command:'open-action-center'})">🔧 Open Action Center (${acCritical + acImportant + acSuggestion} items) →</button>
      
    </div>`;
  }

  private renderPathFlowGraph(report: ReadinessReport, currentLevel: number, missingSignals: SignalResult[]): string {
    try {
      if (currentLevel >= 6) {
        return `<div class="next-level glass-card"><h2>🏆 Maximum Level Reached!</h2><p>Your repo is at the highest AI readiness level.</p></div>`;
      }

      const nextLevel = Math.min(6, currentLevel + 1) as MaturityLevel;
      const nextInfo = MATURITY_LEVELS[nextLevel];
      const currentInfo = MATURITY_LEVELS[currentLevel as MaturityLevel];
      const tool = report.selectedTool as AITool;
      const toolConfig = AI_TOOLS[tool];

      // Get signals for next level - both detected and missing
      const nextLevelSignals = report.levels
        .flatMap(l => l.signals)
        .filter(s => s.level <= nextLevel);
      const doneSignals = nextLevelSignals.filter(s => s.detected && s.score >= 40);
      const actionSignals = nextLevelSignals.filter(s => !s.detected || s.score < 40).slice(0, 6);

      // Build SVG flow graph
      const W = 700, nodeH = 32, gapY = 8;
      const actionCount = actionSignals.length || 1;
      const actionsBlockH = actionCount * (nodeH + gapY);
      const H = Math.max(180, actionsBlockH + 100);

      const currentBoxY = H / 2 - 20;
      const nextBoxY = H / 2 - 20;
      const actionsStartY = (H - actionsBlockH) / 2;

      // Colors
      const currentColor = currentLevel <= 2 ? '#ff4757' : currentLevel <= 4 ? '#ffa502' : '#2ed573';
      const nextColor = '#00d2ff';

      const actionNodes = actionSignals.map((s, i) => {
        const y = actionsStartY + i * (nodeH + gapY);
        const name = humanizeSignalId(s.signalId);
        const color = s.detected ? '#ffa502' : '#ff4757'; // amber if low-score, red if missing
        const icon = s.detected ? '⚠' : '○';
        return { y, name, color, icon, signalId: s.signalId };
      });

      const svg = `
      <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="font-family:system-ui,sans-serif">
        <defs>
          <marker id="arrowhead" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="#555"/>
          </marker>
        </defs>

        <!-- Current Level Box -->
        <rect x="10" y="${currentBoxY}" width="130" height="40" rx="8" fill="${currentColor}22" stroke="${currentColor}" stroke-width="2"/>
        <text x="75" y="${currentBoxY + 17}" text-anchor="middle" fill="${currentColor}" font-size="11" font-weight="700">L${currentLevel}</text>
        <text x="75" y="${currentBoxY + 31}" text-anchor="middle" fill="${currentColor}" font-size="9">${this.escapeHtml(currentInfo.name)}</text>

        <!-- Action Nodes -->
        ${actionNodes.map(n => `
          <line x1="140" y1="${H / 2}" x2="190" y2="${n.y + nodeH / 2}" class="flow-arrow"/>
          <rect x="195" y="${n.y}" width="310" height="${nodeH}" rx="6" fill="${n.color}18" stroke="${n.color}88" stroke-width="1"/>
          <text x="210" y="${n.y + nodeH / 2 + 4}" fill="#ccc" font-size="10">${n.icon} ${this.escapeHtml(n.name.slice(0, 38))}</text>
          <line x1="505" y1="${n.y + nodeH / 2}" x2="555" y2="${H / 2}" class="flow-arrow"/>
        `).join('')}

        ${actionNodes.length === 0 ? `
          <line x1="140" y1="${H / 2}" x2="555" y2="${H / 2}" class="flow-arrow"/>
          <text x="350" y="${H / 2 - 8}" text-anchor="middle" fill="#2ed573" font-size="11">✅ All signals present!</text>
        ` : ''}

        <!-- Next Level Box -->
        <rect x="560" y="${nextBoxY}" width="130" height="40" rx="8" fill="${nextColor}22" stroke="${nextColor}" stroke-width="2"/>
        <text x="625" y="${nextBoxY + 17}" text-anchor="middle" fill="${nextColor}" font-size="11" font-weight="700">L${nextLevel}</text>
        <text x="625" y="${nextBoxY + 31}" text-anchor="middle" fill="${nextColor}" font-size="9">${this.escapeHtml(nextInfo.name)}</text>

        <!-- Progress indicator -->
        <text x="350" y="${H - 8}" text-anchor="middle" fill="#888" font-size="9">${doneSignals.length} of ${nextLevelSignals.length} signals ready · ${actionSignals.length} actions needed</text>
      </svg>`;

      return `
      <div class="section flow-graph">
        <h2>🗺️ Path to Level ${nextLevel}: ${this.escapeHtml(nextInfo.name)}</h2>
        <p style="font-size:0.85em;color:var(--text-secondary);margin:0 0 8px">${this.escapeHtml(nextInfo.description)}</p>
        ${svg}
      </div>`;
    } catch (err) {
      logger.error('InsightsPanel: renderPathFlowGraph failed', err);
      return '<div class="section">⚠️ Error rendering path flow graph</div>';
    }
  }

  private renderBestSetup(report: ReadinessReport): string {
    try {
      const tool = report.selectedTool as AITool;
      const toolConfig = AI_TOOLS[tool];
      if (!toolConfig) return '';

      const currentLevel = report.primaryLevel;
      const nextLevel = Math.min(6, currentLevel + 1) as MaturityLevel;

      // Collect all expected files up to next level
      type FileEntry = { pattern: string; level: number; exists: boolean; purpose: string };
      const fileEntries: FileEntry[] = [];

      const purposeMap: Record<string, string> = {
        'copilot-instructions.md': 'Project-wide agent instructions',
        '*.instructions.md': 'Domain-scoped instructions',
        '*.agent.md': 'Agent persona definitions',
        'SKILL.md': 'Reusable skill procedures',
        'mcp.json': 'Tool integrations',
        'default-rules.md': 'Master rule file',
        '.clinerules': 'Agent instruction hierarchy',
        '.cursorrules': 'Legacy cursor rules',
        '.cursor/rules': 'Cursor rule directory',
        'CLAUDE.md': 'Claude Code instructions',
        '.roomodes': 'Custom mode definitions',
        'AGENTS.md': 'Location-scoped rules',
        '.aider.conf.yml': 'Aider configuration',
        '.aiderignore': 'File exclusions',
        'memory-bank': 'Persistent agent context',
        'workflows': 'End-to-end playbooks',
        'safe-commands': 'Approved operations',
      };

      const getPurpose = (pattern: string): string => {
        for (const [key, purpose] of Object.entries(purposeMap)) {
          if (pattern.includes(key)) return purpose;
        }
        return 'Platform configuration';
      };

      // Check which files exist from scan signals
      const detectedSignals = new Set(
        report.levels.flatMap(l => l.signals).filter(s => s.detected).flatMap(s => s.files || [])
      );
      const detectedIds = new Set(
        report.levels.flatMap(l => l.signals).filter(s => s.detected).map(s => s.signalId)
      );

      const levelFiles: [string[], number][] = [
        [toolConfig.level2Files, 2],
        [toolConfig.level3Files, 3],
        [toolConfig.level4Files, 4],
        [toolConfig.level5Files, 5],
      ];

      for (const [files, level] of levelFiles) {
        if (level > nextLevel) break;
        for (const pattern of files) {
          const exists = detectedSignals.has(pattern) ||
            [...detectedSignals].some(f => f.includes(pattern.replace(/\*\*/g, '').replace(/\*/g, '')));
          fileEntries.push({ pattern, level, exists, purpose: getPurpose(pattern) });
        }
      }

      // Build the chain explanation
      const chains: Record<string, string[]> = {
        copilot: ['instructions.md', 'agents/', 'skills/', 'mcp.json'],
        cline: ['default-rules.md', 'domains/', 'safe-commands', 'memory-bank/', 'workflows/'],
        cursor: ['.cursor/rules/', '.cursorignore', 'mcp.json'],
        claude: ['CLAUDE.md', '.claude/rules/', 'settings.json'],
        roo: ['.roo/rules/', '.roomodes', 'rules-code/', 'rules-architect/'],
        windsurf: ['.windsurf/rules/', 'AGENTS.md', 'skills/', 'workflows/'],
        aider: ['.aider.conf.yml', '.aiderignore'],
      };

      const chain = chains[tool] || [];

      return `
      <div class="section best-setup">
        <h2>🏗️ Best Setup for ${this.escapeHtml(toolConfig.name)}</h2>
        <p style="font-size:0.85em;color:var(--text-secondary);margin:0 0 12px">Ideal file combination for Level ${nextLevel}. Files build on each other in order.</p>
        ${chain.length > 0 ? `
          <div class="setup-chain glass-card" style="padding:10px 14px">
            <span style="font-size:0.8em;color:var(--text-secondary)">Build order:</span>
            ${chain.map((c, i) => `<code style="font-size:0.85em">${this.escapeHtml(c)}</code>${i < chain.length - 1 ? '<span class="chain-arrow">→</span>' : ''}`).join('')}
          </div>` : ''}
        <ul class="setup-tree">
          ${fileEntries.map(f => `
            <li class="setup-file ${f.exists ? 'exists' : 'missing'}">
              <span>${f.exists ? '✅' : '○'}</span>
              <code style="font-size:0.85em">${this.escapeHtml(f.pattern)}</code>
              <span class="purpose">${this.escapeHtml(f.purpose)}</span>
              <span style="font-size:0.7em;opacity:0.6">L${f.level}</span>
            </li>
          `).join('')}
        </ul>
      </div>`;
    } catch (err) {
      logger.error('InsightsPanel: renderBestSetup failed', err);
      return '<div class="section">⚠️ Error rendering best setup</div>';
    }
  }

  private renderComponentHealth(report: ReadinessReport): string {
    try {
      const components = report.componentScores;
      if (!components || components.length === 0) return '';

      // Sort by score ascending (worst first), exclude test projects
      const isTest = (c: { name: string; path: string }) => {
        const n = c.name.toLowerCase(), p = c.path.toLowerCase();
        return n.endsWith('.tests') || n.endsWith('tests') || n.startsWith('test_') ||
          p.includes('.tests/') || p.includes('/tests/') || p.endsWith('.tests');
      };
      const sorted = [...components].filter(c =>
        !isTest(c) && !c.isGenerated &&
        !/(removed|deprecated|obsolete|archived)/i.test(c.name) &&
        !/(removed|deprecated|obsolete|archived)/i.test(c.description || '')
      ).sort((a, b) => a.overallScore - b.overallScore);

      const getColor = (score: number): string => {
        if (score >= 70) return '#2ed573';
        if (score >= 40) return '#ffa502';
        return '#ff4757';
      };

      return `
      <div class="section">
        <h2>🗂️ Component Health</h2>
        <p style="font-size:0.85em;color:var(--text-secondary);margin:0 0 8px">Lowest-scoring components drag your overall score down.</p>
        <div class="health-grid">
          ${sorted.slice(0, 12).map(c => `
            <div class="health-cell" style="border-left-color:${getColor(c.overallScore)}">
              <div class="comp-name" title="${this.escapeHtml(c.path)}">${this.escapeHtml(c.name)}</div>
              <div class="comp-score" style="color:${getColor(c.overallScore)}">${c.overallScore}</div>
              <div class="comp-level">L${c.primaryLevel} · ${this.escapeHtml(c.language || 'mixed')}</div>
            </div>
          `).join('')}
        </div>
      </div>`;
    } catch (err) {
      logger.error('InsightsPanel: renderComponentHealth failed', err);
      return '<div class="section">⚠️ Error rendering component health</div>';
    }
  }

  private dispose(): void {
    InsightsPanel.currentPanel = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
