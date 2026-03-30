import * as vscode from 'vscode';
import { ReadinessReport, MATURITY_LEVELS, MaturityLevel, LevelScore, AI_TOOLS, AITool, RealityCheckRef, StructureComparison, NarrativeMetric, NarrativeSections } from '../scoring/types';
import { KnowledgeGraph, GraphTreeNode, GraphNode, GraphEdge } from '../graph/types';
import { GraphBuilder } from '../graph';
import { humanizeSignalId } from '../utils';
import { TACTICAL_GLASSBOX_CSS } from './theme';
import { logger } from '../logging';

const LEVEL_COLORS: Record<MaturityLevel, string> = {
  1: '#ef4444',
  2: '#f97316',
  3: '#eab308',
  4: '#22c55e',
  5: '#3b82f6',
  6: '#8b5cf6',
};

export class WebviewReportPanel {
  public static currentPanel: WebviewReportPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, report: ReadinessReport) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(report);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static createOrShow(extensionUri: vscode.Uri, report: ReadinessReport, _repoMap?: unknown): void {
    try {
    const column = vscode.ViewColumn.Beside;

    if (WebviewReportPanel.currentPanel) {
      WebviewReportPanel.currentPanel.panel.reveal(column);
      WebviewReportPanel.currentPanel.panel.webview.html = WebviewReportPanel.currentPanel.getHtml(report);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'aiReadinessReport',
      'AI Readiness Report',
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    WebviewReportPanel.currentPanel = new WebviewReportPanel(panel, report);
    } catch (err) {
      logger.error('WebviewReportPanel: failed to create', err);
      vscode.window.showErrorMessage(`Failed to open panel: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getHtml(report: ReadinessReport): string {
    try {
    const depthPct = report.depth;
    const levelInfo = MATURITY_LEVELS[report.primaryLevel];
    const levelColor = LEVEL_COLORS[report.primaryLevel];
    const toolMeta = AI_TOOLS[report.selectedTool as AITool];
    const toolName = toolMeta?.name ?? report.selectedTool;
    const toolIcon = toolMeta?.icon ?? '🌐';

    const ladderHtml = this.buildMaturityLadder(report);
    const structureComparisonHtml = this.buildStructureComparison(report);
    const levelDetailsHtml = this.buildLevelDetails(report);
    const repoMapHtml = report.repoMap ? this.buildRepoMapHtml(report.repoMap) : '';
    const nextStepsHtml = this.buildNextSteps(report);
    const platformGuideHtml = this.buildPlatformGuide(report);
    const knowledgeGraphHtml = this.buildKnowledgeGraphSection(report);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Readiness Report</title>
  <style>
    ${TACTICAL_GLASSBOX_CSS}

    :root {
      --report-bg: #0a0b10;
      --card-bg: rgba(20,22,35,0.85);
      --card-border: rgba(255,255,255,0.06);
      --card-glow: rgba(0,210,255,0.05);
      --text-main: #e4e6ef;
      --text-dim: #8b8fa3;
      --text-bright: #fff;
      --accent-cyan: #00d2ff;
      --accent-green: #2ed573;
      --accent-amber: #ffa502;
      --accent-red: #ff4757;
      --accent-purple: #8b5cf6;
      --radius: 16px;
      --shadow: 0 8px 32px rgba(0,0,0,0.4);
    }

    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; color: var(--text-main); background: var(--report-bg); padding: 24px; line-height: 1.6; max-width: 900px; margin: 0 auto; }
    h1 { font-size: 1.6em; font-weight: 800; margin: 0 0 24px; padding-bottom: 16px; border-bottom: 1px solid var(--card-border); letter-spacing: -0.02em; }
    h2 { font-size: 1.15em; font-weight: 700; color: var(--text-bright); margin: 0 0 16px; letter-spacing: -0.01em; }

    /* Glass cards */
    .glass { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--radius); padding: 24px; margin: 0 0 20px; box-shadow: var(--shadow); backdrop-filter: blur(12px); }
    .glass-sm { padding: 16px; border-radius: 12px; }

    /* Header */
    .header-card { text-align: center; border-top: 3px solid ${levelColor}; position: relative; overflow: hidden; }
    .header-card::before { content: ''; position: absolute; top: 0; left: 50%; transform: translateX(-50%); width: 200px; height: 200px; background: radial-gradient(circle, ${levelColor}15, transparent 70%); pointer-events: none; }
    .header-card .project-name { font-size: 1.1em; font-weight: 700; color: var(--text-bright); margin-bottom: 4px; position: relative; }
    .header-card .level-badge { font-size: 1.8em; font-weight: 800; margin: 12px 0 4px; position: relative; }
    .header-card .level-desc { color: var(--text-dim); font-size: 0.9em; position: relative; }
    .score-row { display: flex; justify-content: center; gap: 32px; margin-top: 20px; position: relative; }
    .score-item { text-align: center; }
    .score-value { font-size: 1.8em; font-weight: 800; display: block; line-height: 1; }
    .score-label { font-size: 0.75em; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4px; display: block; }
    .tool-badge { font-size: 0.95em; font-weight: 600; margin-top: 16px; padding: 6px 16px; background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); border-radius: 20px; display: inline-block; position: relative; }
    .model-info { background: rgba(255,255,255,0.04); color: var(--text-dim); padding: 3px 10px; border-radius: 6px; font-size: 0.78em; display: inline-block; margin: 4px 2px 0; }

    /* Radar section */
    .radar-section { display: grid; grid-template-columns: 280px 1fr; gap: 24px; align-items: start; }
    @media (max-width: 700px) { .radar-section { grid-template-columns: 1fr; } }
    .radar-chart { display: flex; justify-content: center; }
    .metric-cards { display: flex; flex-direction: column; gap: 10px; }
    .metric-card { padding: 14px 16px; border-radius: 12px; border-left: 4px solid; background: rgba(255,255,255,0.02); }
    .metric-card.excellent { border-left-color: var(--accent-green); }
    .metric-card.strong { border-left-color: var(--accent-cyan); }
    .metric-card.warning { border-left-color: var(--accent-amber); }
    .metric-card.critical { border-left-color: var(--accent-red); }
    .metric-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .metric-name { font-weight: 600; font-size: 0.9em; }
    .metric-score { font-weight: 800; font-size: 1.1em; }
    .metric-score.excellent { color: var(--accent-green); }
    .metric-score.strong { color: var(--accent-cyan); }
    .metric-score.warning { color: var(--accent-amber); }
    .metric-score.critical { color: var(--accent-red); }
    .metric-label { font-size: 0.7em; padding: 2px 8px; border-radius: 4px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .metric-label.excellent { background: rgba(46,213,115,0.15); color: var(--accent-green); }
    .metric-label.strong { background: rgba(0,210,255,0.15); color: var(--accent-cyan); }
    .metric-label.warning { background: rgba(255,165,2,0.15); color: var(--accent-amber); }
    .metric-label.critical { background: rgba(255,71,87,0.15); color: var(--accent-red); }
    .metric-narrative { font-size: 0.85em; color: var(--text-dim); line-height: 1.5; }

    /* Tooling health */
    .tooling-status { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .tooling-status .status-label { font-size: 1.05em; font-weight: 700; }
    .tooling-status .status-badge { font-size: 0.78em; padding: 3px 10px; border-radius: 6px; font-weight: 600; }
    .tooling-items { display: flex; flex-direction: column; gap: 10px; }
    .tooling-item { padding: 12px 16px; border-radius: 10px; background: rgba(255,255,255,0.02); display: flex; gap: 12px; align-items: flex-start; }
    .tooling-item .ti-icon { font-size: 1.2em; flex-shrink: 0; margin-top: 2px; }
    .tooling-item .ti-name { font-weight: 600; font-size: 0.9em; }
    .tooling-item .ti-narrative { font-size: 0.85em; color: var(--text-dim); margin-top: 2px; }

    /* Friction map */
    .friction-step { padding: 20px; border-radius: 14px; background: rgba(255,255,255,0.02); margin-bottom: 14px; border-left: 3px solid var(--accent-purple); position: relative; }
    .friction-step .step-number { position: absolute; top: -10px; left: -10px; width: 28px; height: 28px; border-radius: 50%; background: var(--accent-purple); color: #fff; font-weight: 800; font-size: 0.85em; display: flex; align-items: center; justify-content: center; }
    .friction-step .step-title { font-weight: 700; font-size: 1em; margin-bottom: 8px; color: var(--text-bright); }
    .friction-step .step-narrative { font-size: 0.88em; color: var(--text-dim); line-height: 1.5; margin-bottom: 12px; }
    .friction-action { padding: 8px 12px; border-radius: 8px; background: rgba(139,92,246,0.06); border: 1px solid rgba(139,92,246,0.15); margin-top: 6px; font-size: 0.85em; }
    .friction-action .fa-action { font-weight: 600; }
    .friction-action .fa-impact { color: var(--text-dim); font-size: 0.9em; margin-top: 2px; }

    /* Ladder, details, etc */
    .ladder-container { display: flex; gap: 4px; align-items: flex-end; margin: 12px 0; padding: 16px; border-radius: 12px; background: rgba(255,255,255,0.02); }
    .ladder-step { flex: 1; text-align: center; position: relative; }
    .ladder-bar { border-radius: 6px 6px 0 0; min-height: 30px; display: flex; align-items: flex-end; justify-content: center; padding: 4px; font-weight: bold; color: #fff; font-size: 0.85em; }
    .ladder-label { font-size: 0.7em; color: var(--text-dim); margin-top: 6px; line-height: 1.2; }
    .ladder-level { font-weight: bold; font-size: 0.85em; margin-top: 2px; }
    .ladder-current { outline: 2px solid var(--accent-cyan); outline-offset: 2px; border-radius: 8px; }
    .details-section { border-radius: 14px; margin: 0 0 16px; background: var(--card-bg); border: 1px solid var(--card-border); overflow: hidden; }
    .details-section > summary { cursor: pointer; padding: 16px 20px; font-weight: 700; font-size: 1em; user-select: none; list-style: none; display: flex; align-items: center; gap: 8px; }
    .details-section > summary::-webkit-details-marker { display: none; }
    .details-section > summary::before { content: '▶'; font-size: 0.65em; transition: transform 0.2s; color: var(--text-dim); }
    .details-section[open] > summary::before { transform: rotate(90deg); }
    .details-section > summary:hover { background: rgba(255,255,255,0.02); }
    .details-section > :not(summary) { padding: 0 20px 20px; }
    .heatmap-table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    .heatmap-table th, .heatmap-table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .heatmap-table th { color: var(--text-dim); font-weight: 600; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.05em; }
    .level-pill { padding: 3px 10px; border-radius: 12px; font-size: 0.8em; font-weight: 600; color: #fff; display: inline-block; }
    .signal-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 0.88em; }
    .signal-badge { padding: 2px 8px; border-radius: 4px; font-size: 0.78em; font-weight: 600; }
    .signal-pass { background: rgba(46,213,115,0.15); color: var(--accent-green); }
    .signal-fail { background: rgba(255,71,87,0.15); color: var(--accent-red); }
    .signal-detail { padding: 8px 0; font-size: 0.88em; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .signal-detail:last-child { border-bottom: none; }
    .signal-score { color: var(--text-dim); font-size: 0.85em; }
    .signal-files { color: var(--text-dim); font-size: 0.8em; font-style: italic; }
    .progress-bar { height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden; margin: 5px 0; }
    .progress-fill { height: 100%; border-radius: 3px; }
    .next-steps { border-radius: 12px; padding: 16px; margin: 12px 0; border-left: 3px solid var(--accent-cyan); background: rgba(0,210,255,0.03); }
    .next-step-item { padding: 6px 0; font-size: 0.9em; }
    .meta { color: var(--text-dim); font-size: 0.88em; }
    .lang-dashboard { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; margin: 12px 0; }
    .lang-card { background: rgba(255,255,255,0.02); border-radius: 10px; padding: 14px; border: 1px solid var(--card-border); }
    .lang-card h3 { margin: 0 0 8px; font-size: 0.95em; }
    .structure-section { border-radius: var(--radius); padding: 20px; margin: 20px 0; background: var(--card-bg); border: 1px solid var(--card-border); }
    .structure-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .structure-completeness { font-size: 1.4em; font-weight: bold; }
    .structure-item { padding: 8px 12px; margin: 4px 0; border-radius: 8px; font-size: 0.88em; display: flex; align-items: flex-start; gap: 8px; }
    .structure-item.present { background: rgba(46,213,115,0.06); border-left: 3px solid var(--accent-green); }
    .structure-item.missing-required { background: rgba(255,71,87,0.06); border-left: 3px solid var(--accent-red); }
    .structure-item.missing-optional { background: rgba(255,255,255,0.02); border-left: 3px solid #555; opacity: 0.7; }
    .structure-item code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.9em; }
    .scoring-content table { width: 100%; border-collapse: collapse; margin: 10px 0; }
    .scoring-content th, .scoring-content td { padding: 8px 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.9em; }
    .scoring-content th { color: var(--text-dim); font-size: 0.8em; text-transform: uppercase; }

    /* Knowledge graph */
    .knowledge-graph { font-size: 0.88em; margin: 12px 0; }
    .graph-node { margin: 4px 0; }
    .graph-node > summary { cursor: pointer; padding: 8px 10px; border-radius: 6px; display: flex; align-items: center; gap: 8px; list-style: none; }
    .graph-node > summary::-webkit-details-marker { display: none; }
    .graph-node > summary::before { content: '▶'; font-size: 0.65em; transition: transform 0.2s; color: var(--text-dim); }
    .graph-node[open] > summary::before { transform: rotate(90deg); }
    .graph-node > summary:hover { background: rgba(255,255,255,0.03); }
    .graph-node.repo > summary { font-size: 1em; font-weight: bold; }
    .graph-node.group > summary { font-weight: 600; color: var(--accent-cyan); }
    .node-children { margin-left: 20px; border-left: 1px solid rgba(255,255,255,0.06); padding-left: 12px; }
    .node-icon { font-size: 1.1em; }
    .node-label { font-weight: 500; }
    .node-badge { font-size: 0.78em; padding: 2px 8px; border-radius: 4px; margin-left: auto; font-weight: 600; }
    .node-badge.good { background: rgba(46,213,115,0.12); color: var(--accent-green); }
    .node-badge.warning { background: rgba(255,165,2,0.12); color: var(--accent-amber); }
    .node-badge.error { background: rgba(255,71,87,0.12); color: var(--accent-red); }
    .node-badge.neutral { background: rgba(255,255,255,0.05); color: var(--text-dim); }
    .node-meta { color: var(--text-dim); font-size: 0.85em; }
    .graph-leaf { padding: 4px 10px; font-size: 0.88em; }
    .graph-leaf.missing { color: var(--accent-red); }
    .leaf-detail { color: var(--text-dim); font-size: 0.85em; margin-left: 20px; }
    .graph-deps { padding: 4px 8px; color: var(--text-dim); font-size: 0.85em; }
    .dep-link { color: var(--accent-cyan); margin: 0 4px; }
    .lang-badge { background: rgba(255,255,255,0.06); color: var(--text-dim); padding: 2px 8px; border-radius: 4px; font-size: 0.78em; margin-left: 4px; }
    .node-description { color: var(--text-dim); font-style: italic; font-size: 0.88em; padding: 2px 0 4px 24px; }
    .node-signals { padding: 2px 0 6px 24px; font-size: 0.82em; }
    .node-signals span { margin-right: 8px; }
    .node-deps { padding: 4px 0 4px 24px; color: var(--accent-cyan); font-size: 0.85em; }

    /* Platform guide */
    .platform-guide { margin: 15px 0; }
    .platform-guide summary { cursor: pointer; }
    .platform-guide summary h2 { display: inline; font-size: 1em; }
    .guide-section { margin: 8px 0; padding: 12px; background: rgba(255,255,255,0.02); border-radius: 8px; }
    .guide-section h3 { margin: 0 0 6px; font-size: 0.9em; color: var(--accent-cyan); }
    .guide-section pre { white-space: pre-wrap; font-size: 0.83em; margin: 0; font-family: 'SF Mono', monospace; }
    .guide-tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 10px; }
    .guide-tab { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--card-border); background: transparent; color: var(--text-main); cursor: pointer; font-size: 0.83em; transition: all 0.15s; }
    .guide-tab:hover { background: rgba(255,255,255,0.04); }
    .guide-tab.active { background: var(--accent-cyan); color: #000; border-color: var(--accent-cyan); font-weight: 600; }
    .guide-tool-panel { display: none; }
    .guide-tool-panel.active { display: block; }
    .doc-links { margin: 8px 0; padding: 12px; background: rgba(255,255,255,0.02); border-radius: 8px; }
    .doc-links h3 { margin: 0 0 6px; font-size: 0.9em; color: var(--accent-cyan); }
    .doc-links ul { margin: 0; padding-left: 16px; }
    .doc-links li { padding: 2px 0; font-size: 0.88em; }
    .doc-links a { color: var(--accent-cyan); text-decoration: none; }
    .doc-links a:hover { text-decoration: underline; }

    /* Report tooltips */
    .metric-formula { margin-top: 6px; }
    .report-tooltip { position: relative; cursor: pointer; color: var(--accent-cyan); font-size: 0.82em; display: inline-block; padding: 2px 0; }
    .report-tooltip .report-tooltip-text {
      display: none;
      position: absolute; bottom: 130%; left: 0;
      background: #12131e; color: #d4d6e4; border: 1px solid rgba(0,210,255,0.2);
      border-radius: 10px; padding: 14px 16px; font-size: 1.05em; line-height: 1.6;
      width: 380px; max-width: 85vw; z-index: 500; box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      font-weight: 400;
    }
    .report-tooltip.open .report-tooltip-text { display: block; }
  </style>
  <script>
    // Click-to-toggle tooltips (more reliable than hover in webviews)
    document.addEventListener('click', function(e) {
      const tip = e.target.closest('.report-tooltip');
      if (tip) {
        // Close all other tooltips
        document.querySelectorAll('.report-tooltip.open').forEach(t => { if (t !== tip) t.classList.remove('open'); });
        tip.classList.toggle('open');
        e.stopPropagation();
      } else {
        document.querySelectorAll('.report-tooltip.open').forEach(t => t.classList.remove('open'));
      }
    });
  </script>
</head>
<body>
  <h1>AI Readiness Report</h1>

  <div class="header-card">
    <div style="font-size:1.3em;font-weight:700;margin-bottom:8px">📂 ${escapeHtml(report.projectName)}</div>
    <div class="level-badge">🏆 Level ${report.primaryLevel}: ${levelInfo.name}</div>
    <div class="meta">${escapeHtml(levelInfo.description)}</div>
    <div class="score-row">
      <div class="score-item">
        <span class="score-value"><span class="pct-val">${depthPct}</span>&#37;</span>
        <span class="score-label">Depth</span>
      </div>
      <div class="score-item">
        <span class="score-value">${report.overallScore}</span>
        <span class="score-label">Overall Score</span>
      </div>
      <div class="score-item">
        <span class="score-value">L${report.primaryLevel}</span>
        <span class="score-label">Maturity</span>
      </div>
    </div>
    <div style="margin-top: 12px;">
      <div class="tool-badge">
        ${toolIcon} Evaluated for ${escapeHtml(toolName)}
      </div>
    </div>
    <div style="margin-top: 8px;">
      <span class="model-info">Model: ${escapeHtml(report.modelUsed)}</span>
      <span class="model-info">Mode: ${report.scanMode}</span>
      <span class="model-info">Enrichment: ${(report as any).enrichmentPct || '?'}%</span>
      <span class="model-info">${new Date(report.scannedAt).toLocaleDateString()}</span>
    </div>
  </div>

  ${this.buildReadinessRadar(report)}

  ${this.buildToolingHealth(report)}

  ${this.buildFrictionMap(report)}

  <details class="details-section" open>
    <summary>📊 Maturity Ladder</summary>
    ${ladderHtml}
  </details>

  ${knowledgeGraphHtml}

  <details class="details-section">
    <summary>📋 Signal Breakdown by Level</summary>
    ${levelDetailsHtml}
  </details>

  ${structureComparisonHtml}

  <details class="details-section">
    <summary>📐 How Scoring Works</summary>
    <div class="scoring-content">
      <h3>The 6-Level AI Maturity Ladder</h3>
      <table>
        <tr><th>Level</th><th>Name</th><th>What It Means</th></tr>
        ${([1,2,3,4,5,6] as const).map(l => {
          const info = MATURITY_LEVELS[l];
          const color = LEVEL_COLORS[l];
          return `<tr><td style="color:${color};font-weight:bold">L${l}</td><td>${info.name}</td><td>${info.description}</td></tr>`;
        }).join('')}
      </table>
      <p><strong>Overall Score</strong> = ((Level - 1 + Depth/100) / 6) × 100 → <strong>${report.overallScore}/100</strong></p>
      <p><em>Evaluated for <strong>${toolName}</strong>. Only ${toolName}-relevant signals scored.</em></p>
    </div>
  </details>

  <script>
    document.querySelectorAll('.guide-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const group = tab.closest('.platform-guide');
        if (!group) return;
        group.querySelectorAll('.guide-tab').forEach(t => t.classList.remove('active'));
        group.querySelectorAll('.guide-tool-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const panel = group.querySelector('#guide-' + tab.dataset.tool);
        if (panel) panel.classList.add('active');
      });
    });
  </script>
</body>
</html>`;
    } catch (err) {
      logger.error('WebviewReportPanel: render failed', err);
      return `<html><body><h2>❌ Render Error</h2><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`;
    }
  }

  private buildKnowledgeGraphSection(report: ReadinessReport): string {
    try {
    const graph = report.knowledgeGraph as KnowledgeGraph | undefined;
    if (!graph || !graph.nodes || graph.nodes.length === 0) { return ''; }

    const builder = new GraphBuilder();
    const tree = builder.buildTree(graph);
    const treeHtml = this.buildKnowledgeGraphHtml(tree, true, graph);

    return `
      <h2>🕸️ Repository Structure &amp; Readiness</h2>
      <div class="knowledge-graph" style="margin: 20px 0;">
        ${treeHtml}
      </div>`;
    } catch (err) {
      logger.error('WebviewReportPanel: buildKnowledgeGraphSection failed', err);
      return '<div>⚠️ Error rendering knowledge graph</div>';
    }
  }

  private buildKnowledgeGraphHtml(treeNode: GraphTreeNode, isRoot = false, graph?: KnowledgeGraph): string {
    const { node, children, edges } = treeNode;

    // Determine CSS class based on node type
    const typeClassMap: Record<string, string> = {
      'repository': 'repo',
      'component': 'component',
      'subcomponent': 'subcomponent',
      'language': 'language',
      'ai-platform': 'platform',
      'ai-file': 'file',
      'signal': 'signal',
      'insight': 'insight',
    };
    const typeClass = typeClassMap[node.type] || 'component';

    // For component/subcomponent nodes, render rich inline view
    if (node.type === 'component' || node.type === 'subcomponent') {
      return this.renderComponentNode(node, children, edges, graph);
    }

    // For ai-platform nodes at the group level, render platform coverage
    if (node.type === 'ai-platform' && children.length > 0) {
      return this.renderPlatformGroupNode(treeNode, graph);
    }

    // For insight nodes, render inline insight
    if (node.type === 'insight') {
      const severityIcon = node.properties?.severity === 'critical' ? '🔴' : node.properties?.severity === 'important' ? '🟠' : '🟡';
      return `<div class="node-insight">${severityIcon} ${escapeHtml(node.label)}${node.description ? ` — ${escapeHtml(node.description)}` : ''}</div>`;
    }

    // Root and other group nodes
    const isGroup = !isRoot && children.length > 0;

    // Leaf nodes (no children) render as simple divs
    if (children.length === 0 && !isRoot) {
      return this.renderGraphLeaf(node, edges);
    }

    // Determine badge HTML
    const badgeHtml = node.badge
      ? `<span class="node-badge ${node.status || 'neutral'}">${escapeHtml(node.badge)}</span>`
      : '';

    // Metadata HTML
    let metaHtml = '';
    if (isRoot && node.type === 'repository') {
      const nodeCount = node.properties?.nodeCount as number || 0;
      const edgeCount = node.properties?.edgeCount as number || 0;
      if (nodeCount || edgeCount) {
        metaHtml = `<span class="node-meta">${nodeCount || '—'} nodes, ${edgeCount || '—'} edges</span>`;
      }
    } else if (node.properties?.fileCount !== undefined) {
      metaHtml = `<span class="node-meta">${node.properties.fileCount} files</span>`;
    } else if (node.properties?.count !== undefined) {
      metaHtml = `<span class="node-meta">${node.properties.count} items</span>`;
    }

    // Description fragment
    const descHtml = node.description
      ? ` — <em>${escapeHtml(node.description)}</em>`
      : '';

    // Root and groups are open by default
    const openAttr = isRoot || isGroup ? ' open' : '';
    const nodeClass = isGroup ? 'group' : typeClass;

    // Separate children by type for better grouping
    const componentChildren = children.filter(c => c.node.type === 'component' || c.node.type === 'subcomponent');
    const platformChildren = children.filter(c => c.node.type === 'ai-platform');
    const insightChildren = children.filter(c => c.node.type === 'insight');
    const otherChildren = children.filter(c =>
      c.node.type !== 'component' && c.node.type !== 'subcomponent' &&
      c.node.type !== 'ai-platform' && c.node.type !== 'insight' &&
      c.node.type !== 'language' && c.node.type !== 'signal'
    );
    // Language nodes are folded into components; signal nodes rendered inline

    let childrenHtml = '';

    // Render components first
    childrenHtml += componentChildren.map(child => this.buildKnowledgeGraphHtml(child, false, graph)).join('');

    // Render platform coverage as a group
    if (platformChildren.length > 0) {
      const platformCoverage = platformChildren.map(p => {
        const configured = p.node.properties?.configured as boolean;
        const fileCount = p.node.properties?.fileCount as number || 0;
        const cssClass = configured ? 'configured' : 'missing';
        const icon = p.node.icon || '🔧';
        const status = configured ? `✅ ${fileCount} files` : '❌';
        return `<span class="platform-item ${cssClass}">${icon} ${escapeHtml(p.node.label)} ${status}</span>`;
      }).join('');

      childrenHtml += `<details open class="graph-node platform-group">
        <summary>
          <span class="node-icon">🔧</span>
          <span class="node-label">AI Platform Coverage</span>
        </summary>
        <div class="node-children">
          <div class="platform-coverage">${platformCoverage}</div>
        </div>
      </details>`;
    }

    // Render insights inline
    if (insightChildren.length > 0) {
      childrenHtml += `<details open class="graph-node group">
        <summary>
          <span class="node-icon">🔍</span>
          <span class="node-label">Insights</span>
          <span class="node-meta">${insightChildren.length} items</span>
        </summary>
        <div class="node-children">
          ${insightChildren.map(child => this.buildKnowledgeGraphHtml(child, false, graph)).join('')}
        </div>
      </details>`;
    }

    // Other children
    childrenHtml += otherChildren.map(child => this.buildKnowledgeGraphHtml(child, false, graph)).join('');

    // Add dependency edges
    const depEdges = edges.filter(e => e.relation === 'DEPENDS_ON');
    let depsHtml = '';
    if (depEdges.length > 0) {
      const depLinks = depEdges.map(e => {
        const label = e.label || e.target.replace(/^comp-/, '').replace(/[-_]/g, '/');
        return `<span class="dep-link">→ ${escapeHtml(label)}</span>`;
      }).join('');
      depsHtml = `<div class="graph-deps">🔗 Dependencies: ${depLinks}</div>`;
    }

    return `<details${openAttr} class="graph-node ${nodeClass}">
      <summary>
        <span class="node-icon">${node.icon || '📁'}</span>
        <span class="node-label">${escapeHtml(node.label)}</span>${descHtml}
        ${badgeHtml}
        ${metaHtml}
      </summary>
      <div class="node-children">
        ${childrenHtml}
        ${depsHtml}
      </div>
    </details>`;
  }

  private renderComponentNode(node: GraphNode, children: GraphTreeNode[], edges: GraphEdge[], graph?: KnowledgeGraph): string {
    const isSubcomponent = node.type === 'subcomponent';
    const cssClass = isSubcomponent ? 'subcomponent' : 'component';

    // Language badge
    const language = node.properties?.language as string || '';
    const langBadgeHtml = language ? `<span class="lang-badge">${escapeHtml(language)}</span>` : '';

    // Level/depth badge
    const badgeHtml = node.badge
      ? `<span class="node-badge ${node.status || 'neutral'}">${escapeHtml(node.badge)}</span>`
      : '';

    // Description
    const descHtml = node.description
      ? `<div class="node-description">"${escapeHtml(node.description)}"</div>`
      : '';

    // Signals — render inline from node properties
    const signals = node.properties?.signals as Array<{ signal: string; present: boolean; detail: string }> | undefined;
    let signalsHtml = '';
    if (signals && signals.length > 0) {
      const signalItems = signals.map(s => {
        const icon = s.present ? '✅' : '❌';
        return `<span>${icon} ${escapeHtml(s.signal)}</span>`;
      }).join('');
      signalsHtml = `<div class="node-signals">${signalItems}</div>`;
    } else {
      // Fallback: render signal child nodes inline
      const signalChildren = children.filter(c => c.node.type === 'signal');
      if (signalChildren.length > 0) {
        const signalItems = signalChildren.map(c => {
          const icon = c.node.properties?.present ? '✅' : (c.node.status === 'good' ? '✅' : '❌');
          return `<span>${icon} ${escapeHtml(c.node.label)}</span>`;
        }).join('');
        signalsHtml = `<div class="node-signals">${signalItems}</div>`;
      }
    }

    // Sub-component children (not signals)
    const subComponents = children.filter(c => c.node.type === 'component' || c.node.type === 'subcomponent');
    const subComponentsHtml = subComponents
      .map(child => this.renderComponentNode(child.node, child.children, child.edges, graph))
      .join('');

    // Dependency edges
    const depEdges = edges.filter(e => e.relation === 'DEPENDS_ON');
    let depsHtml = '';
    if (depEdges.length > 0) {
      const depLinks = depEdges.map(e => {
        const label = e.label || e.target.replace(/^comp-/, '').replace(/[-_]/g, '/');
        return `→ ${escapeHtml(label)}`;
      }).join(', ');
      depsHtml = `<div class="node-deps">🔗 Dependencies: ${depLinks}</div>`;
    }

    // Insights linked to this component
    let insightsHtml = '';
    if (graph) {
      const compId = node.id;
      const insightEdges = graph.edges.filter(e => e.relation === 'SUGGESTS' && e.target === compId);
      for (const ie of insightEdges) {
        const insightNode = graph.nodes.find(n => n.id === ie.source);
        if (insightNode) {
          insightsHtml += `<div class="node-insight">💡 ${escapeHtml(insightNode.label)}${insightNode.description ? ` — ${escapeHtml(insightNode.description)}` : ''}</div>`;
        }
      }
    }

    const hasChildren = subComponents.length > 0 || depsHtml || insightsHtml;
    const openAttr = !isSubcomponent && hasChildren ? ' open' : '';

    return `<details${openAttr} class="graph-node ${cssClass}">
      <summary>
        📦 <strong>${escapeHtml(node.label)}</strong>
        ${langBadgeHtml}
        ${badgeHtml}
      </summary>
      ${descHtml}
      ${signalsHtml}
      ${insightsHtml}
      <div class="node-children">
        ${subComponentsHtml}
        ${depsHtml}
      </div>
    </details>`;
  }

  private renderPlatformGroupNode(treeNode: GraphTreeNode, graph?: KnowledgeGraph): string {
    const { node, children } = treeNode;
    const configured = node.properties?.configured as boolean;
    const fileCount = node.properties?.fileCount as number || 0;
    const cssClass = configured ? 'configured' : 'missing';
    const icon = node.icon || '🔧';
    const status = configured ? `✅ ${fileCount} files` : '❌';
    return `<span class="platform-item ${cssClass}">${icon} ${escapeHtml(node.label)} ${status}</span>`;
  }

  private renderGraphLeaf(node: GraphNode, edges: GraphEdge[]): string {
    const isMissing = edges.some(e => e.relation === 'MISSING') || node.status === 'error';
    const missingClass = isMissing ? ' missing' : '';

    const badgeHtml = node.badge
      ? `<span class="node-badge ${node.status || 'neutral'}">${escapeHtml(node.badge)}</span>`
      : '';

    const detailHtml = node.description
      ? `<div class="leaf-detail">${escapeHtml(node.description)}</div>`
      : '';

    return `<div class="graph-leaf${missingClass}">
      ${node.icon || '📄'} ${escapeHtml(node.label)}
      ${badgeHtml}
      ${detailHtml}
    </div>`;
  }

  private buildMaturityLadder(report: ReadinessReport): string {
    try {
    const steps = report.levels.map(ls => {
      const pct = ls.rawScore;
      const color = LEVEL_COLORS[ls.level];
      const barHeight = Math.max(40, Math.round(pct * 1.5));
      const isCurrent = ls.level === report.primaryLevel;
      const currentClass = isCurrent ? ' ladder-current' : '';
      const opacity = ls.qualified ? '1' : '0.5';
      const icon = ls.qualified ? '✅' : '❌';

      const signalIcon = ls.signalsDetected === ls.signalsTotal && ls.signalsTotal > 0 ? '✅' : ls.signalsDetected > 0 ? '🟡' : '❌';

      return `<div class="ladder-step${currentClass}">
        <div class="ladder-bar" style="height:${barHeight}px;background:${color};opacity:${opacity}"><span class="pct-val">${pct}</span>&#37;</div>
        <div class="ladder-level" style="color:${color}">L${ls.level}</div>
        <div class="ladder-label">${escapeHtml(ls.name)}</div>
        <div class="ladder-label">${signalIcon} ${ls.signalsDetected}/${ls.signalsTotal} signals${ls.qualified ? '' : ls.signalsDetected > 0 ? ' · score too low' : ''}</div>
      </div>`;
    }).join('');

    return `<div class="ladder-container">${steps}</div>`;
    } catch (err) {
      logger.error('WebviewReportPanel: buildMaturityLadder failed', err);
      return '<div>⚠️ Error rendering maturity ladder</div>';
    }
  }

  private buildLevelDetails(report: ReadinessReport): string {
    try {
    return report.levels.map(ls => {
      const pct = ls.rawScore;
      const color = LEVEL_COLORS[ls.level];
      const icon = ls.qualified ? '✅' : '❌';
      const levelInfo = MATURITY_LEVELS[ls.level];

      const signalsHtml = ls.signals.length === 0
        ? '<p class="meta">No signals evaluated for this level.</p>'
        : ls.signals.map(signal => {
          const sIcon = signal.detected ? '✅' : '❌';
          const displayName = humanizeSignalId(signal.signalId);
          const filesHtml = signal.files.length > 0
            ? `<div class="signal-files">Files: ${signal.files.map(f => escapeHtml(f)).join(', ')}</div>`
            : '';

          // Reality check warnings
          let realityHtml = '';
          if (signal.realityChecks && signal.realityChecks.length > 0) {
            const valid = signal.realityChecks.filter(c => c.status === 'valid').length;
            const invalid = signal.realityChecks.filter(c => c.status === 'invalid').length;
            const warns = signal.realityChecks.filter(c => c.status === 'warning').length;
            const summaryParts: string[] = [`${valid}/${signal.realityChecks.length} checks valid`];
            if (invalid > 0) { summaryParts.push(`${invalid} invalid`); }
            if (warns > 0) { summaryParts.push(`${warns} warnings`); }
            realityHtml += `<div class="meta" style="margin-top:4px;font-size:0.85em;">🔍 Reality: ${summaryParts.join(', ')}</div>`;

            const issues = signal.realityChecks.filter(c => c.status === 'invalid' || c.status === 'warning');
            if (issues.length > 0) {
              realityHtml += '<div style="margin-top:4px;font-size:0.85em;">';
              for (const check of issues.slice(0, 5)) {
                const cIcon = check.status === 'invalid' ? '❌' : '⚠️';
                realityHtml += `<div style="padding:2px 0;color:${check.status === 'invalid' ? '#ef4444' : '#eab308'}">`;
                realityHtml += `${cIcon} <strong>[${escapeHtml(check.category)}]</strong> "${escapeHtml(check.claim)}" in ${escapeHtml(check.file)}: ${escapeHtml(check.reality)}`;
                realityHtml += `</div>`;
              }
              if (issues.length > 5) {
                realityHtml += `<div class="meta">...and ${issues.length - 5} more issues</div>`;
              }
              realityHtml += '</div>';
            }
          }

          // Business logic validation findings
          let bizHtml = '';
          if (signal.businessFindings && signal.businessFindings.length > 0) {
            bizHtml += '<div style="margin-top:4px;font-size:0.85em;"><strong>📋 Business Logic Validation:</strong></div>';
            bizHtml += '<div style="margin-top:2px;font-size:0.85em;">';
            for (const finding of signal.businessFindings.slice(0, 8)) {
              bizHtml += `<div style="padding:2px 0;">${escapeHtml(finding)}</div>`;
            }
            if (signal.businessFindings.length > 8) {
              bizHtml += `<div class="meta">...and ${signal.businessFindings.length - 8} more findings</div>`;
            }
            bizHtml += '</div>';
          }

          return `<div class="signal-detail">
            ${sIcon} <strong>${escapeHtml(displayName)}</strong>
            <span class="signal-score">${signal.detected ? `${signal.score}/100` : 'Not detected'}</span>
            <div class="meta">${escapeHtml(signal.finding)}</div>
            ${filesHtml}
            ${realityHtml}
            ${bizHtml}
          </div>`;
        }).join('');

      return `<details class="details-section">
        <summary style="border-left: 4px solid ${color}; padding-left: 8px;">
          ${icon} Level ${ls.level}: ${escapeHtml(ls.name)} — <span class="pct-val">${pct}</span>&#37; (${ls.signalsDetected}/${ls.signalsTotal} signals)
        </summary>
        <p class="meta">${escapeHtml(levelInfo.description)}</p>
        <div class="progress-bar"><div class="progress-fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div></div>
        ${signalsHtml}
      </details>`;
    }).join('');
    } catch (err) {
      logger.error('WebviewReportPanel: buildLevelDetails failed', err);
      return '<div>⚠️ Error rendering level details</div>';
    }
  }

  private buildStructureComparison(report: ReadinessReport): string {
    const sc = report.structureComparison;
    if (!sc || sc.expected.length === 0) { return ''; }

    const completenessColor = sc.completeness >= 75 ? '#22c55e' : sc.completeness >= 40 ? '#eab308' : '#ef4444';

    const itemsHtml = [...sc.expected]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(f => {
        const icon = f.exists ? '✅' : (f.required ? '❌' : '⬜');
        const cssClass = f.exists ? 'present' : (f.required ? 'missing-required' : 'missing-optional');
        const reqLabel = f.required ? '(required)' : '(optional)';
        return `<div class="structure-item ${cssClass}">
          <span>${icon}</span>
          <div>
            <code>${escapeHtml(f.path)}</code> <span class="level-tag">L${f.level}</span> ${reqLabel}
            <div class="description">${escapeHtml(f.description)}</div>
          </div>
        </div>`;
      }).join('');

    return `
      <div class="structure-section">
        <div class="structure-header">
          <h2>📁 ${escapeHtml(sc.toolName)} — Expected vs Actual Structure</h2>
          <span class="structure-completeness" style="color:${completenessColor}"><span class="pct-val">${sc.completeness}</span>&#37; complete</span>
        </div>
        <div class="progress-bar" style="height:10px;margin-bottom:16px">
          <div class="progress-fill" style="width:${Math.min(sc.completeness, 100)}%;background:${completenessColor}"></div>
        </div>
        <div class="meta" style="margin-bottom:12px">
          ✅ ${sc.presentCount} present · ❌ ${sc.missingCount} missing · ${sc.expected.length} total expected files
        </div>
        ${itemsHtml}
      </div>`;
  }

  private buildRepoMapHtml(repoMap: unknown): string {
    if (!repoMap || typeof repoMap !== 'object') return '';

    const map = repoMap as { root?: unknown; stats?: { totalFiles?: number; totalDirs?: number } };
    if (!map.root) return '';

    const statsLabel = map.stats
      ? `${map.stats.totalFiles ?? 0} files across ${map.stats.totalDirs ?? 0} directories`
      : '';

    return `
      <h2>📂 Repository Map</h2>
      <div class="repo-map">
        <div class="meta" style="margin-bottom:10px">${statsLabel}</div>
        <details>
          <summary>Expand repository tree</summary>
          <pre style="font-size:0.85em;overflow-x:auto">${escapeHtml(JSON.stringify(map.root, null, 2).slice(0, 5000))}</pre>
        </details>
      </div>`;
  }

  private buildNextSteps(report: ReadinessReport): string {
    try {
    const nextLevel = report.levels.find(ls => !ls.qualified);
    if (!nextLevel) {
      return `<div class="next-steps">
        <h3>🎉 Congratulations!</h3>
        <p>All maturity levels achieved. Your project has reached full AI readiness.</p>
      </div>`;
    }

    const missing = nextLevel.signals.filter(s => !s.detected);
    if (missing.length === 0) {
      return '';
    }

    const toolMeta = AI_TOOLS[report.selectedTool as AITool];
    const toolName = toolMeta?.name ?? report.selectedTool;
    const toolLevelFiles = this.getToolLevelFiles(report.selectedTool, nextLevel.level);

    const color = LEVEL_COLORS[nextLevel.level];
    const stepsHtml = missing.map((s, i) => {
      const displayName = humanizeSignalId(s.signalId);
      let detail = escapeHtml(s.finding);
      if (toolLevelFiles) {
        const fileHints = toolLevelFiles.map(f => `<code>${escapeHtml(f)}</code>`).join(', ');
        detail += `<div class="meta" style="margin-top:4px">Target: ${fileHints}</div>`;
      }
      return `<div class="next-step-item">
        <strong>${i + 1}. ${escapeHtml(displayName)}</strong> — ${detail}
      </div>`;
    }).join('');

    return `
      <h2>🚀 Next Steps</h2>
      <div class="next-steps" style="border-left-color:${color}">
        <h3>To improve your <strong>${escapeHtml(toolName)}</strong> readiness to Level ${nextLevel.level}: ${escapeHtml(nextLevel.name)}</h3>
        ${stepsHtml}
      </div>`;
    } catch (err) {
      logger.error('WebviewReportPanel: buildNextSteps failed', err);
      return '<div>⚠️ Error rendering next steps</div>';
    }
  }

  private buildPlatformGuide(report: ReadinessReport): string {
    try {
    const selectedTool = report.selectedTool as AITool;
    const toolMeta = AI_TOOLS[selectedTool];
    if (!toolMeta?.reasoningContext) { return ''; }
    const rc = toolMeta.reasoningContext;
    const docLinksHtml = this.buildDocLinksHtml(toolMeta.docUrls);
    return `
    <details class="platform-guide">
      <summary><h2>📚 ${escapeHtml(toolMeta.name)} — What It Expects</h2></summary>
      ${docLinksHtml}
      <div class="guide-section">
        <h3>📁 Expected File Structure</h3>
        <pre>${escapeHtml(rc.structureExpectations)}</pre>
      </div>
      <div class="guide-section">
        <h3>✅ Quality Markers</h3>
        <pre>${escapeHtml(rc.qualityMarkers)}</pre>
      </div>
      <div class="guide-section">
        <h3>❌ Anti-Patterns to Avoid</h3>
        <pre>${escapeHtml(rc.antiPatterns)}</pre>
      </div>
      <div class="guide-section">
        <h3>📝 Instruction Format</h3>
        <pre>${escapeHtml(rc.instructionFormat)}</pre>
      </div>
    </details>`;
    } catch (err) {
      logger.error('WebviewReportPanel: buildPlatformGuide failed', err);
      return '<div>⚠️ Error rendering platform guide</div>';
    }
  }

  private buildDocLinksHtml(docUrls?: { main: string; rules: string; memory?: string; bestPractices?: string }): string {
    if (!docUrls || !docUrls.main) { return ''; }
    const items: string[] = [];
    if (docUrls.main) { items.push(`<li><a href="${escapeHtml(docUrls.main)}">📄 Main Documentation</a></li>`); }
    if (docUrls.rules) { items.push(`<li><a href="${escapeHtml(docUrls.rules)}">📋 Rules &amp; Instructions</a></li>`); }
    if (docUrls.memory) { items.push(`<li><a href="${escapeHtml(docUrls.memory)}">🧠 Memory &amp; Context</a></li>`); }
    if (docUrls.bestPractices) { items.push(`<li><a href="${escapeHtml(docUrls.bestPractices)}">⭐ Best Practices</a></li>`); }
    return `<div class="doc-links"><h3>📖 Official Documentation</h3><ul>${items.join('')}</ul></div>`;
  }

  private getToolLevelFiles(selectedTool: string, level: MaturityLevel): string[] | undefined {
    const tool = AI_TOOLS[selectedTool as AITool];
    if (!tool) { return undefined; }
    switch (level) {
      case 2: return tool.level2Files;
      case 3: return tool.level3Files;
      case 4: return tool.level4Files;
      case 5: return tool.level5Files;
      default: return undefined;
    }
  }

  private buildReadinessRadar(report: ReadinessReport): string {
    try {
      const ns = report.narrativeSections;
      const metrics = ns?.platformReadiness ?? this.computeFallbackMetrics(report);

      // Build SVG radar
      const size = 260;
      const cx = size / 2, cy = size / 2, r = 100;
      const count = metrics.length || 1;
      const points = metrics.map((m, i) => {
        const angle = (Math.PI * 2 * i) / count - Math.PI / 2;
        const val = (m.score / 100) * r;
        return { x: cx + val * Math.cos(angle), y: cy + val * Math.sin(angle), ax: cx + r * Math.cos(angle), ay: cy + r * Math.sin(angle), lx: cx + (r + 18) * Math.cos(angle), ly: cy + (r + 18) * Math.sin(angle) };
      });

      const polygon = points.map(p => `${p.x},${p.y}`).join(' ');
      const outerPolygon = points.map(p => `${p.ax},${p.ay}`).join(' ');

      const labelColor: Record<string, string> = { excellent: '#2ed573', strong: '#00d2ff', warning: '#ffa502', critical: '#ff4757' };

      const svg = `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:260px">
        ${[0.25, 0.5, 0.75, 1].map(pct => `<polygon points="${points.map(p => `${cx + (p.ax - cx) * pct},${cy + (p.ay - cy) * pct}`).join(' ')}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`).join('')}
        ${points.map(p => `<line x1="${cx}" y1="${cy}" x2="${p.ax}" y2="${p.ay}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`).join('')}
        <polygon points="${outerPolygon}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1.5"/>
        <polygon points="${polygon}" fill="rgba(0,210,255,0.12)" stroke="rgba(0,210,255,0.6)" stroke-width="2"/>
        ${points.map((p, i) => `<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="${labelColor[metrics[i].label] || '#00d2ff'}"/>`).join('')}
      </svg>`;

      // Coherence check
      const radarAvg = metrics.reduce((s, m) => s + m.score, 0) / metrics.length;
      const divergence = Math.abs(report.overallScore - radarAvg);
      const coherenceHtml = divergence > 25 ? `
        <div style="padding:10px 14px;border-radius:8px;background:rgba(255,165,2,0.08);border:1px solid rgba(255,165,2,0.2);margin-top:12px;font-size:0.85em;color:var(--accent-amber)">
          ⚠️ Score divergence: EGDR score (${report.overallScore}) and radar average (${Math.round(radarAvg)}) differ by ${Math.round(divergence)} points. This usually means quality gates or anti-pattern penalties are active.
        </div>` : '';

      // Formula tooltips per metric
      const formulaTooltips: Record<string, string> = {
        'Business Logic Alignment': 'Calculated: average(signal.score) for signals with LLM business validation. Measures whether your instruction files accurately describe the actual code structure and dependencies.',
        'Type & Environment Strictness': 'Language-aware type scoring. Statically typed languages (C#, Java, TS) get inherent credit. Python with type hints gets partial credit. Config files (JSON, YAML, KQL) are excluded.',
        'Semantic Density': 'Calculated: (commentLines / codeLines) × 150, capped at 100. Higher ratio of comments, docstrings, and descriptive names means agents pull better context when reasoning about code.',
        'Instruction/Reality Sync': 'Calculated: 60% instruction coverage (do files exist?) + 40% path accuracy (do referenced paths exist?). Having instructions is weighted higher than path perfection.',
        'Context Efficiency': 'Calculated: contextAudit.score based on total instruction tokens / context budget. If your instruction files consume too much of the agent context window, it has less room for code analysis.',
      };

      const metricCards = metrics.map(m => {
        const formula = formulaTooltips[m.dimension] || '';
        return `
        <div class="metric-card ${m.label}">
          <div class="metric-header">
            <span class="metric-name">${escapeHtml(m.dimension)}</span>
            <span class="metric-score ${m.label}">${m.score}/100</span>
          </div>
          <span class="metric-label ${m.label}">${m.label === 'excellent' ? '🟢' : m.label === 'strong' ? '🔵' : m.label === 'warning' ? '🟡' : '🔴'} ${m.label}</span>
          <div class="metric-narrative">${escapeHtml(m.narrative)}</div>
          ${formula ? `<div class="metric-formula"><span class="report-tooltip">📐 How is this calculated?<span class="report-tooltip-text">${escapeHtml(formula)}</span></span></div>` : ''}
        </div>`;
      }).join('');

      return `
      <div class="glass" style="margin-top:20px">
        <h2>📊 Platform Readiness Metrics</h2>
        <div class="radar-section">
          <div class="radar-chart">${svg}</div>
          <div class="metric-cards">${metricCards}</div>
        </div>
        ${coherenceHtml}
      </div>`;
    } catch (err) {
      logger.error('WebviewReportPanel: buildReadinessRadar failed', err);
      return '<div class="glass">⚠️ Error rendering readiness radar</div>';
    }
  }

  private computeFallbackMetrics(report: ReadinessReport): NarrativeMetric[] {
    const m = report.codebaseMetrics;
    const realityChecks = report.levels.flatMap(l => l.signals).filter(s => s.realityChecks?.length).flatMap(s => s.realityChecks!);
    const pathAccuracy = realityChecks.length > 0 ? Math.round((realityChecks.filter(r => r.status === 'valid').length / realityChecks.length) * 100) : 80;
    const allSignals = report.levels.flatMap(l => l.signals);
    const instrExist = allSignals.filter(s => s.detected && s.level <= 3).length;
    const instrExpected = allSignals.filter(s => s.level <= 3).length;
    const instrCoverage = instrExpected > 0 ? Math.round((instrExist / instrExpected) * 100) : 50;
    const syncScore = Math.round(instrCoverage * 0.6 + pathAccuracy * 0.4);

    const dims: [string, number][] = [
      ['Business Logic Alignment', report.overallScore],
      ['Type & Environment Strictness', m?.typeStrictnessIndex ?? 0],
      ['Semantic Density', m?.semanticDensity ?? 0],
      ['Instruction/Reality Sync', syncScore],
      ['Context Efficiency', report.contextAudit?.contextEfficiency?.score ?? 50],
    ];
    return dims.map(([dimension, score]) => ({
      dimension,
      score,
      label: (score >= 75 ? 'excellent' : score >= 55 ? 'strong' : score >= 35 ? 'warning' : 'critical') as NarrativeMetric['label'],
      narrative: score >= 75 ? `${dimension} is excellent.` : score >= 55 ? `${dimension} is solid.` : score >= 35 ? `${dimension} needs attention.` : `${dimension} is a critical friction point.`,
    }));
  }

  private buildToolingHealth(report: ReadinessReport): string {
    try {
      const ns = report.narrativeSections;
      const health = ns?.toolingHealth ?? {
        status: report.overallScore >= 50 ? 'Established' : 'Developing',
        items: [],
      };

      if (health.items.length === 0) return '';

      const sevIcon: Record<string, string> = { good: '🟢', warning: '🟡', critical: '🔴' };
      const sevBg: Record<string, string> = { good: 'rgba(46,213,115,0.08)', warning: 'rgba(255,165,2,0.08)', critical: 'rgba(255,71,87,0.08)' };

      return `
      <div class="glass">
        <h2>🔌 Tooling & Ecosystem Health</h2>
        <div class="tooling-status">
          <span class="status-label">Status:</span>
          <span class="status-badge" style="background:rgba(255,255,255,0.06)">${escapeHtml(health.status)}</span>
        </div>
        <div class="tooling-items">
          ${health.items.map(item => `
            <div class="tooling-item" style="background:${sevBg[item.severity] || sevBg.warning}">
              <span class="ti-icon">${sevIcon[item.severity] || '🟡'}</span>
              <div>
                <div class="ti-name">${escapeHtml(item.name)}</div>
                <div class="ti-narrative">${escapeHtml(item.narrative)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>`;
    } catch (err) {
      logger.error('WebviewReportPanel: buildToolingHealth failed', err);
      return '<div class="glass">⚠️ Error rendering tooling health</div>';
    }
  }

  private buildFrictionMap(report: ReadinessReport): string {
    try {
      const ns = report.narrativeSections;
      const steps = ns?.frictionMap ?? [];
      if (steps.length === 0) return '';

      const nextLevel = Math.min(6, report.primaryLevel + 1);
      const nextInfo = MATURITY_LEVELS[nextLevel as 1|2|3|4|5|6];

      return `
      <div class="glass">
        <h2>🗺️ Architectural Friction Map</h2>
        <p style="color:var(--text-dim);font-size:0.9em;margin:0 0 16px">Path to Level ${nextLevel}: ${escapeHtml(nextInfo.name)}</p>
        ${steps.map((step, i) => `
          <div class="friction-step">
            <div class="step-number">${i + 1}</div>
            <div class="step-title">${escapeHtml(step.title)}</div>
            <div class="step-narrative">${escapeHtml(step.narrative)}</div>
            ${(step.actions || []).map(a => `
              <div class="friction-action">
                <div class="fa-action">→ ${escapeHtml(a.action)}</div>
                ${a.impact ? `<div class="fa-impact">Impact: ${escapeHtml(a.impact)}</div>` : ''}
              </div>
            `).join('')}
          </div>
        `).join('')}
      </div>`;
    } catch (err) {
      logger.error('WebviewReportPanel: buildFrictionMap failed', err);
      return '<div class="glass">⚠️ Error rendering friction map</div>';
    }
  }

  private dispose(): void {
    WebviewReportPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
