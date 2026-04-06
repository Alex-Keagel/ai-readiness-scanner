import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ReadinessReport } from '../scoring/types';
import { KnowledgeGraph, GraphNode, GraphEdge } from '../graph/types';
import { TACTICAL_GLASSBOX_CSS } from './theme';
import { logger } from '../logging';

export class KnowledgeGraphPanel {
  public static currentPanel: KnowledgeGraphPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, report: ReadinessReport, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    try {
      this.panel.webview.html = this.getHtml(report);
    } catch (err) {
      logger.error('KnowledgeGraphPanel render failed', err);
      this.panel.webview.html = '<html><body><h1>\u274C Error rendering knowledge graph</h1><pre>' +
        (err instanceof Error ? err.message : String(err)) + '</pre></body></html>';
    }

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message) => {
        if (message.command === 'open-file' && message.path) {
          const uri = vscode.Uri.file(message.path);
          vscode.workspace.openTextDocument(uri).then(
            (doc) => vscode.window.showTextDocument(doc),
            (err) => logger.error('KnowledgeGraphPanel: failed to open file', err)
          );
        }
      },
      null,
      this.disposables
    );
  }

  public static createOrShow(report: ReadinessReport, extensionUri: vscode.Uri): void {
    try {
      const column = vscode.ViewColumn.One;
      if (KnowledgeGraphPanel.currentPanel) {
        KnowledgeGraphPanel.currentPanel.panel.reveal(column);
        KnowledgeGraphPanel.currentPanel.panel.webview.html =
          KnowledgeGraphPanel.currentPanel.getHtml(report);
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        'aiReadinessKnowledgeGraph',
        '\uD83D\uDD17 Knowledge Graph',
        column,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      KnowledgeGraphPanel.currentPanel = new KnowledgeGraphPanel(panel, report, extensionUri);
    } catch (err) {
      logger.error('KnowledgeGraphPanel: failed to create', err);
      vscode.window.showErrorMessage(
        'Failed to open knowledge graph: ' + (err instanceof Error ? err.message : String(err))
      );
    }
  }

  private getHtml(report: ReadinessReport): string {
    try {
      const kg = report.knowledgeGraph as KnowledgeGraph | undefined;
      const nodes: GraphNode[] = kg?.nodes || [];
      const edges: GraphEdge[] = kg?.edges || [];

      const nodesJson = JSON.stringify(nodes);
      const edgesJson = JSON.stringify(edges);

      // Read D3 bundle
      const d3BundlePath = path.join(this.extensionUri.fsPath, 'dist', 'd3-bundle.js');
      const d3Code = fs.readFileSync(d3BundlePath, 'utf8');

      const script = this.buildGraphScript(nodesJson, edgesJson);
      const panelCss = this.getPanelCss();

      // Build Layer 1 — cross-platform overview cards
      const selectedTool = report.selectedTool || 'copilot';
      const platformCardsHtml = this.buildPlatformOverview(nodes, edges, selectedTool);

      return '<!DOCTYPE html>\n' +
        '<html lang="en">\n' +
        '<head>\n' +
        '<meta charset="UTF-8">\n' +
        '<title>Knowledge Graph</title>\n' +
        '<style>\n' + TACTICAL_GLASSBOX_CSS + '\n' + panelCss + '\n</style>\n' +
        '</head>\n' +
        '<body>\n' +
        // Layer 1 — Cross-Platform Overview
        '<div id="layer1">\n' +
        '  <div class="layer1-header">\n' +
        '    <h2>🔗 Knowledge Graph</h2>\n' +
        '    <p class="layer1-subtitle">Cross-platform AI readiness overview. Click a platform to explore its deep graph.</p>\n' +
        '  </div>\n' +
        '  <div class="platform-grid">\n' +
        platformCardsHtml +
        '  </div>\n' +
        '  <div class="layer1-footer">\n' +
        '    <button class="btn btn-primary" id="btn-show-full-graph">🔗 Show Full Knowledge Graph</button>\n' +
        '  </div>\n' +
        '</div>\n' +
        // Layer 2 — D3 Force Graph (hidden by default)
        '<div id="layer2" style="display:none">\n' +
        '<div id="toolbar">\n' +
        '  <button class="btn btn-small" id="btn-back-overview">← Overview</button>\n' +
        '  <div class="filter-group">\n' +
        '    <span class="filter-label">Platforms:</span>\n' +
        '    <label class="filter-cb"><input type="checkbox" id="p-copilot" checked> 🤖 Copilot</label>\n' +
        '    <label class="filter-cb"><input type="checkbox" id="p-cline" checked> 🔧 Cline</label>\n' +
        '    <label class="filter-cb"><input type="checkbox" id="p-cursor" checked> 📝 Cursor</label>\n' +
        '    <label class="filter-cb"><input type="checkbox" id="p-claude" checked> 🧠 Claude</label>\n' +
        '    <label class="filter-cb"><input type="checkbox" id="p-roo" checked> 🦘 Roo</label>\n' +
        '    <label class="filter-cb"><input type="checkbox" id="p-windsurf" checked> 🏄 Windsurf</label>\n' +
        '    <label class="filter-cb"><input type="checkbox" id="p-aider" checked> 🔨 Aider</label>\n' +
        '  </div>\n' +
        '  <div class="filter-group">\n' +
        '    <span class="filter-label">Nodes:</span>\n' +
        '    <label class="filter-cb"><input type="checkbox" id="f-component" checked> Components</label>\n' +
        '    <label class="filter-cb"><input type="checkbox" id="f-platform" checked> Platforms</label>\n' +
        '    <label class="filter-cb"><input type="checkbox" id="f-file" checked> Files</label>\n' +
        '    <label class="filter-cb"><input type="checkbox" id="f-signal"> Signals</label>\n' +
        '    <label class="filter-cb"><input type="checkbox" id="f-deps" checked> Dependencies</label>\n' +
        '  </div>\n' +
        '  <div class="filter-group">\n' +
        '    <span class="filter-label">Edges:</span>\n' +
        '    <label class="filter-cb"><input type="checkbox" id="e-contains" checked> CONTAINS</label>\n' +
        '    <label class="filter-cb"><input type="checkbox" id="e-depends" checked> DEPENDS_ON</label>\n' +
        '    <label class="filter-cb"><input type="checkbox" id="e-calls" checked> CALLS</label>\n' +
        '    <label class="filter-cb"><input type="checkbox" id="e-dataflow" checked> DATA_FLOWS_TO</label>\n' +
        '  </div>\n' +
        '  <button class="btn btn-small" id="btn-reset-view">↺ Reset View</button>\n' +
        '</div>\n' +
        '<div id="graph-container">\n' +
        '  <svg id="graph-svg"></svg>\n' +
        '  <div id="detail-panel" style="display:none;">\n' +
        '    <div id="detail-header">\n' +
        '      <span id="detail-icon"></span>\n' +
        '      <span id="detail-name"></span>\n' +
        '      <span id="detail-type" class="badge badge-lang"></span>\n' +
        '      <button id="detail-close" class="btn btn-small">✕</button>\n' +
        '    </div>\n' +
        '    <div id="detail-body"></div>\n' +
        '  </div>\n' +
        '</div>\n' +
        '</div>\n' +
        '<script>' + d3Code + '</script>\n' +
        '<script>' + script + '</script>\n' +
        '</body>\n</html>';
    } catch (err) {
      logger.error('KnowledgeGraphPanel: render failed', err);
      return '<html><body><h2>\u274C Render Error</h2><pre>' +
        (err instanceof Error ? err.message : String(err)) + '</pre></body></html>';
    }
  }

  private buildPlatformOverview(nodes: GraphNode[], edges: GraphEdge[], selectedTool: string): string {
    const platforms: Record<string, { icon: string; name: string }> = {
      copilot: { icon: '🤖', name: 'GitHub Copilot' },
      cline: { icon: '🔧', name: 'Cline' },
      cursor: { icon: '📝', name: 'Cursor' },
      claude: { icon: '🧠', name: 'Claude Code' },
      roo: { icon: '🦘', name: 'Roo Code' },
      windsurf: { icon: '🏄', name: 'Windsurf' },
      aider: { icon: '🔨', name: 'Aider' },
    };

    let html = '';
    for (const [toolId, meta] of Object.entries(platforms)) {
      const platformNode = nodes.find(n => n.type === 'ai-platform' && (n.properties as any)?.toolId === toolId);
      const configured = platformNode ? !!(platformNode.properties as any)?.configured : false;
      const fileCount = platformNode ? ((platformNode.properties as any)?.fileCount || 0) : 0;
      const isSelected = toolId === selectedTool;

      // Count files connected to this platform
      const fileNodes = platformNode ? edges
        .filter(e => e.source === platformNode.id && e.relation === 'CONTAINS')
        .map(e => nodes.find(n => n.id === e.target))
        .filter(Boolean) : [];

      const statusClass = configured ? (fileCount >= 3 ? 'good' : 'warning') : 'error';
      const statusIcon = configured ? (fileCount >= 3 ? '✅' : '⚠️') : '❌';
      const statusText = configured ? fileCount + ' file' + (fileCount !== 1 ? 's' : '') + ' configured' : 'Not configured';
      const selectedBadge = isSelected ? '<span class="selected-badge">SELECTED</span>' : '';

      html += '<div class="platform-card ' + statusClass + (isSelected ? ' selected' : '') + '" data-tool="' + toolId + '">'
        + '<div class="platform-card-header">'
        + '<span class="platform-icon">' + meta.icon + '</span>'
        + '<span class="platform-name">' + meta.name + '</span>'
        + selectedBadge
        + '</div>'
        + '<div class="platform-status">' + statusIcon + ' ' + statusText + '</div>';

      // Show file list
      if (fileNodes.length > 0) {
        html += '<div class="platform-files">';
        for (const fn of fileNodes.slice(0, 5)) {
          if (fn) {
            const score = (fn.properties as any)?.score;
            const scoreColor = score >= 80 ? '#2ed573' : score >= 50 ? '#ffa502' : '#ff4757';
            html += '<div class="platform-file">'
              + '<span class="file-icon">📄</span>'
              + '<span class="file-name">' + this.escHtml(fn.label) + '</span>'
              + (score !== undefined ? '<span class="file-score" style="color:' + scoreColor + '">' + score + '/100</span>' : '')
              + '</div>';
          }
        }
        if (fileNodes.length > 5) {
          html += '<div class="platform-file more">+' + (fileNodes.length - 5) + ' more</div>';
        }
        html += '</div>';
      }

      html += '<div class="platform-action">'
        + (isSelected ? '<button class="btn btn-small btn-primary platform-dive-btn">🔍 Deep Dive</button>' : '<span class="platform-hint">Select in settings to deep dive</span>')
        + '</div>'
        + '</div>';
    }
    return html;
  }

  private escHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/`/g, '&#96;');
  }

  private getPanelCss(): string {
    return [
      'html, body { height: 100%; margin: 0; overflow: hidden; }',
      'body { display: flex; flex-direction: column; }',

      // Layer 1 — Cross-platform overview
      '#layer1 { padding: 24px; overflow-y: auto; height: 100%; }',
      '.layer1-header { text-align: center; margin-bottom: 24px; }',
      '.layer1-header h2 { margin: 0 0 8px 0; font-size: 1.4em; }',
      '.layer1-subtitle { color: var(--text-secondary); font-size: 0.9em; margin: 0; }',
      '.platform-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; max-width: 1000px; margin: 0 auto; }',
      '.platform-card { background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 16px; cursor: pointer; transition: all 0.2s; }',
      '.platform-card:hover { transform: translateY(-2px); border-color: var(--color-cyan); box-shadow: 0 4px 16px rgba(0,0,0,0.2); }',
      '.platform-card.selected { border-color: var(--color-cyan); box-shadow: 0 0 0 1px var(--color-cyan); }',
      '.platform-card.good { border-left: 4px solid #2ed573; }',
      '.platform-card.warning { border-left: 4px solid #ffa502; }',
      '.platform-card.error { border-left: 4px solid #ff4757; }',
      '.platform-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }',
      '.platform-icon { font-size: 1.5em; }',
      '.platform-name { font-weight: 600; font-size: 1em; }',
      '.selected-badge { font-size: 0.65em; padding: 2px 6px; border-radius: 4px; background: var(--color-cyan); color: #000; font-weight: 600; margin-left: auto; }',
      '.platform-status { font-size: 0.85em; color: var(--text-secondary); margin-bottom: 8px; }',
      '.platform-files { margin: 8px 0; }',
      '.platform-file { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 0.82em; }',
      '.file-icon { font-size: 0.9em; }',
      '.file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.file-score { font-weight: 600; font-size: 0.85em; }',
      '.platform-file.more { color: var(--text-muted); font-style: italic; }',
      '.platform-action { margin-top: 12px; text-align: center; }',
      '.platform-dive-btn { width: 100%; }',
      '.platform-hint { font-size: 0.78em; color: var(--text-muted); font-style: italic; }',
      '.layer1-footer { text-align: center; margin-top: 24px; }',

      '#toolbar {',
      '  display: flex; gap: 16px; padding: 8px 16px;',
      '  border-bottom: 1px solid var(--border-subtle);',
      '  background: var(--bg-card); flex-wrap: wrap;',
      '  align-items: center; z-index: 10; min-height: 44px;',
      '}',

      '.filter-group { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }',

      '.filter-label {',
      '  font-size: 0.75em; color: var(--text-muted);',
      '  text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;',
      '}',

      '.filter-cb {',
      '  display: flex; align-items: center; gap: 4px;',
      '  font-size: 0.8em; color: var(--text-secondary);',
      '  cursor: pointer; user-select: none;',
      '}',
      '.filter-cb input[type="checkbox"] { accent-color: var(--color-cyan); cursor: pointer; }',

      '#graph-container { flex: 1; position: relative; overflow: hidden; }',
      '#graph-svg { display: block; }',

      /* Detail panel */
      '#detail-panel {',
      '  position: absolute; top: 0; right: 0;',
      '  width: 320px; height: 100%;',
      '  background: var(--bg-card);',
      '  border-left: 1px solid var(--border-subtle);',
      '  overflow-y: auto; z-index: 20;',
      '  box-shadow: -4px 0 24px rgba(0,0,0,0.3);',
      '}',

      '#detail-header {',
      '  display: flex; align-items: center; gap: 8px;',
      '  padding: 12px 16px;',
      '  border-bottom: 1px solid var(--border-subtle);',
      '  background: var(--bg-surface);',
      '}',
      '#detail-icon { font-size: 1.4em; }',
      '#detail-name {',
      '  font-weight: 700; font-size: 0.95em; flex: 1;',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
      '}',
      '#detail-close { margin-left: auto; flex-shrink: 0; }',
      '#detail-body { padding: 12px 16px; }',

      '.detail-section { margin-bottom: 16px; }',
      '.detail-section-title {',
      '  font-size: 0.75em; text-transform: uppercase;',
      '  color: var(--text-muted); letter-spacing: 0.05em;',
      '  font-weight: 600; margin-bottom: 6px;',
      '}',
      '.detail-desc { font-size: 0.85em; color: var(--text-secondary); line-height: 1.5; }',
      '.detail-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }',
      '.detail-label { font-size: 0.82em; color: var(--text-secondary); min-width: 50px; }',
      '.detail-signal { font-size: 0.82em; padding: 2px 0; }',
      '.detail-connected {',
      '  font-size: 0.82em; padding: 3px 0;',
      '  display: flex; align-items: center; gap: 4px;',
      '}',
      '.detail-conn-dir { color: var(--text-muted); font-family: var(--font-mono); }',
      '.detail-conn-rel { font-size: 0.7em !important; }',

      /* Edge animation for DATA_FLOWS_TO */
      '@keyframes dash-flow { to { stroke-dashoffset: -16; } }',
      '.link-animated { animation: dash-flow 0.8s linear infinite; }',

      /* Node hover glow */
      '.node-group circle { transition: stroke 0.15s, stroke-width 0.15s; }',
      '.node-group:hover circle { stroke: var(--color-cyan); stroke-width: 3; }',

      /* Empty state */
      '.empty-state {',
      '  display: flex; flex-direction: column; align-items: center;',
      '  justify-content: center; height: 100%; color: var(--text-muted);',
      '  font-size: 1.1em; gap: 12px;',
      '}',
      '.empty-state-icon { font-size: 3em; }',
    ].join('\n');
  }

  private buildGraphScript(nodesJson: string, edgesJson: string): string {
    const L: string[] = [];

    L.push('(function() {');
    L.push('var vscode = acquireVsCodeApi();');
    L.push('var rawNodes = ' + nodesJson + ';');
    L.push('var rawEdges = ' + edgesJson + ';');

    // Empty state check
    L.push('if (!rawNodes || rawNodes.length === 0) {');
    L.push('  var container = document.getElementById("graph-container");');
    L.push('  container.innerHTML = "<div class=\\"empty-state\\"><div class=\\"empty-state-icon\\">\\uD83D\\uDD78\\uFE0F</div>' +
      '<div>No knowledge graph data available</div>' +
      '<div style=\\"font-size:0.8em\\">Run a full scan to generate the graph</div></div>";');
    L.push('  return;');
    L.push('}');

    // Config maps
    L.push('var sizeMap = {');
    L.push('  "repository": 40, "component": 25, "subcomponent": 20,');
    L.push('  "ai-platform": 30, "ai-file": 15, "signal": 10,');
    L.push('  "insight": 10, "language": 18, "module": 20,');
    L.push('  "function": 12, "data-source": 18, "data-sink": 18, "domain": 22');
    L.push('};');

    L.push('var statusColors = {');
    L.push('  "good": "#2ed573", "warning": "#ffa502", "error": "#ff4757", "neutral": "#8b949e"');
    L.push('};');

    L.push('var defaultIcons = {');
    L.push('  "repository": "\\uD83D\\uDCE6", "component": "\\uD83E\\uDDE9", "subcomponent": "\\uD83D\\uDCC1",');
    L.push('  "language": "\\uD83D\\uDCAC", "ai-platform": "\\uD83E\\uDD16", "ai-file": "\\uD83D\\uDCC4",');
    L.push('  "signal": "\\uD83D\\uDCE1", "insight": "\\uD83D\\uDCA1", "module": "\\uD83D\\uDCE6",');
    L.push('  "function": "\\u26A1", "data-source": "\\uD83D\\uDCCA", "data-sink": "\\uD83C\\uDFAF", "domain": "\\uD83C\\uDF10"');
    L.push('};');

    L.push('var edgeStyleMap = {');
    L.push('  "CONTAINS":      { stroke: "#555",    width: 1,   dash: "",    animated: false },');
    L.push('  "WRITTEN_IN":    { stroke: "#555",    width: 1,   dash: "",    animated: false },');
    L.push('  "CONFIGURED_BY": { stroke: "#555",    width: 1,   dash: "",    animated: false },');
    L.push('  "BELONGS_TO":    { stroke: "#555",    width: 1,   dash: "",    animated: false },');
    L.push('  "DEPENDS_ON":    { stroke: "#3b82f6", width: 2.5, dash: "",    animated: false },');
    L.push('  "COVERS":        { stroke: "#888",    width: 1,   dash: "4,2", animated: false },');
    L.push('  "MISSING":       { stroke: "#ff4757", width: 1.5, dash: "2,4", animated: false },');
    L.push('  "SUGGESTS":      { stroke: "#888",    width: 1,   dash: "4,4", animated: false },');
    L.push('  "CALLS":         { stroke: "#00E5FF", width: 1.5, dash: "6,3", animated: false },');
    L.push('  "DATA_FLOWS_TO": { stroke: "#B388FF", width: 1.5, dash: "4,4", animated: true  },');
    L.push('  "EXTENDS":       { stroke: "#ffa502", width: 1.5, dash: "8,4", animated: false },');
    L.push('  "IMPLEMENTS":    { stroke: "#ffa502", width: 1.5, dash: "8,4", animated: false }');
    L.push('};');

    // Filter state
    L.push('var nodeFilters = { component: true, platform: true, file: true, signal: false, deps: true };');
    L.push('var edgeFilters = { CONTAINS: true, DEPENDS_ON: true, CALLS: true, DATA_FLOWS_TO: true };');
    L.push('var platformFilters = { copilot: true, cline: true, cursor: true, claude: true, roo: true, windsurf: true, aider: true };');

    // Helpers
    L.push('function copyObj(o) {');
    L.push('  var c = {}; for (var k in o) { if (o.hasOwnProperty(k)) c[k] = o[k]; } return c;');
    L.push('}');

    L.push('function nodeRadius(type) { return (sizeMap[type] || 15) / 2; }');
    L.push('function nodeColor(status) { return statusColors[status] || statusColors.neutral; }');
    L.push('function nodeIcon(node) { return node.icon || defaultIcons[node.type] || ""; }');

    L.push('function esc(s) {');
    L.push('  var d = document.createElement("span");');
    L.push('  d.textContent = s || "";');
    L.push('  return d.innerHTML;');
    L.push('}');

    // Filter functions
    L.push('function shouldShowNode(n) {');
    L.push('  if (n.type === "repository") return true;');
    L.push('  if (n.type === "component" || n.type === "subcomponent" || n.type === "module") return nodeFilters.component;');
    L.push('  if (n.type === "ai-platform") {');
    L.push('    if (!nodeFilters.platform) return false;');
    L.push('    var tid = n.properties && n.properties.toolId;');
    L.push('    return tid ? (platformFilters[tid] !== false) : true;');
    L.push('  }');
    L.push('  if (n.type === "ai-file") {');
    L.push('    if (!nodeFilters.file) return false;');
    L.push('    // Check if parent platform is visible');
    L.push('    var parentEdge = rawEdges.filter(function(e) {');
    L.push('      return edgeNodeId(e,"target") === n.id && e.relation === "CONTAINS";');
    L.push('    });');
    L.push('    for (var pe = 0; pe < parentEdge.length; pe++) {');
    L.push('      var parentId = edgeNodeId(parentEdge[pe], "source");');
    L.push('      var parent = rawNodes.filter(function(nn) { return nn.id === parentId; })[0];');
    L.push('      if (parent && parent.type === "ai-platform" && parent.properties && parent.properties.toolId) {');
    L.push('        if (platformFilters[parent.properties.toolId] === false) return false;');
    L.push('      }');
    L.push('    }');
    L.push('    return true;');
    L.push('  }');
    L.push('  if (n.type === "signal" || n.type === "insight") return nodeFilters.signal;');
    L.push('  return nodeFilters.deps;');
    L.push('}');

    L.push('function edgeNodeId(e, prop) {');
    L.push('  var v = e[prop]; return (typeof v === "object" && v !== null) ? v.id : v;');
    L.push('}');

    L.push('function shouldShowEdge(e, idSet) {');
    L.push('  var src = edgeNodeId(e, "source"), tgt = edgeNodeId(e, "target");');
    L.push('  if (!idSet[src] || !idSet[tgt]) return false;');
    L.push('  var r = e.relation;');
    L.push('  if (r === "CONTAINS" || r === "WRITTEN_IN" || r === "CONFIGURED_BY" || r === "BELONGS_TO") return edgeFilters.CONTAINS;');
    L.push('  if (r === "DEPENDS_ON" || r === "MISSING") return edgeFilters.DEPENDS_ON;');
    L.push('  if (r === "CALLS" || r === "EXTENDS" || r === "IMPLEMENTS") return edgeFilters.CALLS;');
    L.push('  if (r === "DATA_FLOWS_TO" || r === "COVERS" || r === "SUGGESTS") return edgeFilters.DATA_FLOWS_TO;');
    L.push('  return true;');
    L.push('}');

    L.push('function findRawNode(id) {');
    L.push('  for (var i = 0; i < rawNodes.length; i++) { if (rawNodes[i].id === id) return rawNodes[i]; }');
    L.push('  return null;');
    L.push('}');

    // SVG setup
    L.push('var TOOLBAR_H = 52;');
    L.push('var width = window.innerWidth;');
    L.push('var height = window.innerHeight - TOOLBAR_H;');
    L.push('var selectedNode = null;');
    L.push('var simulation = null;');
    L.push('var linkSel = null;');
    L.push('var nodeSel = null;');

    L.push('var svg = d3.select("#graph-svg").attr("width", width).attr("height", height);');
    L.push('var g = svg.append("g");');

    // Zoom
    L.push('var zoomBehavior = d3.zoom()');
    L.push('  .scaleExtent([0.1, 4])');
    L.push('  .on("zoom", function(event) { g.attr("transform", event.transform); });');
    L.push('svg.call(zoomBehavior);');
    L.push('svg.on("dblclick.zoom", null);');

    // Render function
    L.push('function render() {');
    L.push('  var filteredNodes = rawNodes.filter(shouldShowNode);');
    L.push('  var idSet = {};');
    L.push('  filteredNodes.forEach(function(n) { idSet[n.id] = true; });');
    L.push('  var filteredEdges = rawEdges.filter(function(e) { return shouldShowEdge(e, idSet); });');

    L.push('  var nodes = filteredNodes.map(function(n) { return copyObj(n); });');
    L.push('  var links = filteredEdges.map(function(e) {');
    L.push('    return { source: e.source, target: e.target, relation: e.relation, label: e.label || "" };');
    L.push('  });');

    L.push('  g.selectAll("*").remove();');

    // Arrow marker defs
    L.push('  var defs = g.append("defs");');
    L.push('  var markerColors = ["#555","#3b82f6","#00E5FF","#B388FF","#ff4757","#ffa502"];');
    L.push('  markerColors.forEach(function(c, i) {');
    L.push('    defs.append("marker")');
    L.push('      .attr("id", "arrow-" + i)');
    L.push('      .attr("viewBox", "0 -5 10 10").attr("refX", 20)');
    L.push('      .attr("refY", 0).attr("markerWidth", 6).attr("markerHeight", 6)');
    L.push('      .attr("orient", "auto")');
    L.push('      .append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", c);');
    L.push('  });');

    L.push('  function markerForRelation(rel) {');
    L.push('    var style = edgeStyleMap[rel] || edgeStyleMap.CONTAINS;');
    L.push('    var idx = markerColors.indexOf(style.stroke);');
    L.push('    return idx >= 0 ? "url(#arrow-" + idx + ")" : "url(#arrow-0)";');
    L.push('  }');

    // Draw links
    L.push('  linkSel = g.append("g").attr("class", "links")');
    L.push('    .selectAll("line").data(links).enter().append("line")');
    L.push('    .attr("class", function(d) {');
    L.push('      var s = edgeStyleMap[d.relation] || edgeStyleMap.CONTAINS;');
    L.push('      return "link" + (s.animated ? " link-animated" : "");');
    L.push('    })');
    L.push('    .attr("stroke", function(d) { return (edgeStyleMap[d.relation] || edgeStyleMap.CONTAINS).stroke; })');
    L.push('    .attr("stroke-width", function(d) { return (edgeStyleMap[d.relation] || edgeStyleMap.CONTAINS).width; })');
    L.push('    .attr("stroke-dasharray", function(d) { return (edgeStyleMap[d.relation] || edgeStyleMap.CONTAINS).dash; })');
    L.push('    .attr("stroke-opacity", 0.6)');
    L.push('    .attr("marker-end", function(d) { return markerForRelation(d.relation); });');

    // Draw node groups
    L.push('  var nodeGroup = g.append("g").attr("class", "nodes")');
    L.push('    .selectAll("g").data(nodes).enter().append("g")');
    L.push('    .attr("class", "node-group")');
    L.push('    .call(d3.drag()');
    L.push('      .on("start", function(event, d) {');
    L.push('        if (!event.active) simulation.alphaTarget(0.3).restart();');
    L.push('        d.fx = d.x; d.fy = d.y;');
    L.push('      })');
    L.push('      .on("drag", function(event, d) { d.fx = event.x; d.fy = event.y; })');
    L.push('      .on("end", function(event, d) {');
    L.push('        if (!event.active) simulation.alphaTarget(0);');
    L.push('        d.fx = null; d.fy = null;');
    L.push('      })');
    L.push('    );');

    // Node circles
    L.push('  nodeGroup.append("circle")');
    L.push('    .attr("r", function(d) { return nodeRadius(d.type); })');
    L.push('    .attr("fill", function(d) { return nodeColor(d.status); })');
    L.push('    .attr("stroke", "#1a1b26").attr("stroke-width", 2)');
    L.push('    .attr("cursor", "pointer");');

    // Emoji icon inside node
    L.push('  nodeGroup.append("text")');
    L.push('    .attr("text-anchor", "middle").attr("dominant-baseline", "central")');
    L.push('    .attr("font-size", function(d) { return Math.max(8, nodeRadius(d.type) * 0.9) + "px"; })');
    L.push('    .attr("pointer-events", "none")');
    L.push('    .text(function(d) { return nodeIcon(d); });');

    // Label below node
    L.push('  nodeGroup.append("text")');
    L.push('    .attr("class", "node-label")');
    L.push('    .attr("text-anchor", "middle")');
    L.push('    .attr("dy", function(d) { return nodeRadius(d.type) + 14; })');
    L.push('    .attr("font-size", "10px")');
    L.push('    .attr("fill", "#94A3B8")');
    L.push('    .attr("pointer-events", "none")');
    L.push('    .text(function(d) {');
    L.push('      var label = d.label || d.id;');
    L.push('      return label.length > 22 ? label.substring(0, 20) + "\\u2026" : label;');
    L.push('    });');

    L.push('  nodeSel = nodeGroup;');

    // Click → detail
    L.push('  nodeGroup.on("click", function(event, d) {');
    L.push('    event.stopPropagation();');
    L.push('    selectedNode = d;');
    L.push('    showDetailPanel(d, links);');
    L.push('  });');

    // Double-click → open file
    L.push('  nodeGroup.on("dblclick", function(event, d) {');
    L.push('    event.stopPropagation();');
    L.push('    event.preventDefault();');
    L.push('    var p = d.properties;');
    L.push('    var filePath = p ? (p.path || p.filePath || p.file || null) : null;');
    L.push('    if (filePath) vscode.postMessage({ command: "open-file", path: String(filePath) });');
    L.push('  });');

    // Hover → highlight
    L.push('  nodeGroup.on("mouseenter", function(event, d) { highlightConnected(d, links); });');
    L.push('  nodeGroup.on("mouseleave", function() { resetHighlight(); });');

    // Background click → deselect
    L.push('  svg.on("click", function() {');
    L.push('    selectedNode = null;');
    L.push('    document.getElementById("detail-panel").style.display = "none";');
    L.push('    resetHighlight();');
    L.push('  });');

    // Force simulation
    L.push('  if (simulation) simulation.stop();');
    L.push('  simulation = d3.forceSimulation(nodes)');
    L.push('    .force("link", d3.forceLink(links).id(function(d) { return d.id; }).distance(80))');
    L.push('    .force("charge", d3.forceManyBody().strength(-300))');
    L.push('    .force("center", d3.forceCenter(width / 2, height / 2))');
    L.push('    .force("collide", d3.forceCollide().radius(function(d) { return nodeRadius(d.type) + 8; }))');
    L.push('    .on("tick", function() {');
    L.push('      linkSel');
    L.push('        .attr("x1", function(d) { return d.source.x; })');
    L.push('        .attr("y1", function(d) { return d.source.y; })');
    L.push('        .attr("x2", function(d) { return d.target.x; })');
    L.push('        .attr("y2", function(d) { return d.target.y; });');
    L.push('      nodeSel.attr("transform", function(d) {');
    L.push('        return "translate(" + d.x + "," + d.y + ")";');
    L.push('      });');
    L.push('    });');
    L.push('}'); // end render

    // Highlight functions
    L.push('function highlightConnected(d, links) {');
    L.push('  var conn = {}; conn[d.id] = true;');
    L.push('  links.forEach(function(l) {');
    L.push('    var s = edgeNodeId(l, "source"), t = edgeNodeId(l, "target");');
    L.push('    if (s === d.id) conn[t] = true;');
    L.push('    if (t === d.id) conn[s] = true;');
    L.push('  });');
    L.push('  nodeSel.select("circle").attr("opacity", function(n) { return conn[n.id] ? 1 : 0.15; });');
    L.push('  nodeSel.select(".node-label").attr("opacity", function(n) { return conn[n.id] ? 1 : 0.15; });');
    L.push('  linkSel.attr("stroke-opacity", function(l) {');
    L.push('    var s = edgeNodeId(l, "source"), t = edgeNodeId(l, "target");');
    L.push('    return (s === d.id || t === d.id) ? 0.9 : 0.04;');
    L.push('  });');
    L.push('}');

    L.push('function resetHighlight() {');
    L.push('  if (!nodeSel || !linkSel) return;');
    L.push('  nodeSel.select("circle").attr("opacity", 1);');
    L.push('  nodeSel.select(".node-label").attr("opacity", 1);');
    L.push('  linkSel.attr("stroke-opacity", 0.6);');
    L.push('}');

    // Detail panel
    L.push('function showDetailPanel(d, links) {');
    L.push('  var panel = document.getElementById("detail-panel");');
    L.push('  document.getElementById("detail-icon").textContent = nodeIcon(d);');
    L.push('  document.getElementById("detail-name").textContent = d.label || d.id;');
    L.push('  document.getElementById("detail-type").textContent = d.type;');

    L.push('  var html = "";');

    // Description
    L.push('  if (d.description) {');
    L.push('    html += "<div class=\\"detail-section\\"><div class=\\"detail-desc\\">" + esc(d.description) + "</div></div>";');
    L.push('  }');

    // Badge
    L.push('  if (d.badge) {');
    L.push('    html += "<div class=\\"detail-section\\"><span class=\\"badge badge-score\\">" + esc(d.badge) + "</span></div>";');
    L.push('  }');

    // Level & score from properties
    L.push('  var props = d.properties || {};');
    L.push('  if (props.level !== undefined || props.score !== undefined) {');
    L.push('    html += "<div class=\\"detail-section\\">";');
    L.push('    if (props.level !== undefined) {');
    L.push('      html += "<div class=\\"detail-row\\"><span class=\\"detail-label\\">Level</span>"');
    L.push('        + "<span class=\\"badge badge-level badge-l" + props.level + "\\">L" + props.level + "</span></div>";');
    L.push('    }');
    L.push('    if (props.score !== undefined) {');
    L.push('      var sc = Number(props.score) || 0;');
    L.push('      html += "<div class=\\"detail-row\\"><span class=\\"detail-label\\">Score</span>"');
    L.push('        + "<div class=\\"metric-bar\\" style=\\"flex:1\\"><div class=\\"metric-bar-fill\\" style=\\"width:"');
    L.push('        + sc + "%;background:" + nodeColor(d.status) + "\\"></div></div>"');
    L.push('        + "<span class=\\"metric-value\\">" + sc + "%</span></div>";');
    L.push('    }');
    L.push('    html += "</div>";');
    L.push('  }');

    // Signals list
    L.push('  var signals = props.signals;');
    L.push('  if (signals && signals.length) {');
    L.push('    html += "<div class=\\"detail-section\\"><div class=\\"detail-section-title\\">Signals</div>";');
    L.push('    for (var si = 0; si < signals.length; si++) {');
    L.push('      var sg = signals[si];');
    L.push('      var sgIcon = (sg.present || sg.detected) ? "\\u2705" : "\\u274C";');
    L.push('      var sgName = sg.signalId || sg.signal || sg.name || "";');
    L.push('      html += "<div class=\\"detail-signal\\">" + sgIcon + " " + esc(String(sgName)) + "</div>";');
    L.push('    }');
    L.push('    html += "</div>";');
    L.push('  }');

    // Connected nodes
    L.push('  var connected = [];');
    L.push('  links.forEach(function(l) {');
    L.push('    var s = edgeNodeId(l, "source"), t = edgeNodeId(l, "target");');
    L.push('    if (s === d.id) { var tn = findRawNode(t); if (tn) connected.push({ node: tn, relation: l.relation, dir: "\\u2192" }); }');
    L.push('    if (t === d.id) { var sn = findRawNode(s); if (sn) connected.push({ node: sn, relation: l.relation, dir: "\\u2190" }); }');
    L.push('  });');

    L.push('  if (connected.length > 0) {');
    L.push('    html += "<div class=\\"detail-section\\"><div class=\\"detail-section-title\\">Connected (" + connected.length + ")</div>";');
    L.push('    for (var ci = 0; ci < connected.length; ci++) {');
    L.push('      var c = connected[ci];');
    L.push('      html += "<div class=\\"detail-connected\\">"');
    L.push('        + "<span class=\\"detail-conn-dir\\">" + c.dir + "</span> "');
    L.push('        + "<span class=\\"detail-conn-rel badge badge-lang\\">" + esc(c.relation) + "</span> "');
    L.push('        + "<span>" + esc(nodeIcon(c.node)) + " " + esc(c.node.label) + "</span></div>";');
    L.push('    }');
    L.push('    html += "</div>";');
    L.push('  }');

    L.push('  document.getElementById("detail-body").innerHTML = html;');
    L.push('  panel.style.display = "block";');
    L.push('}');

    // Detail close handler
    L.push('document.getElementById("detail-close").addEventListener("click", function(e) {');
    L.push('  e.stopPropagation();');
    L.push('  document.getElementById("detail-panel").style.display = "none";');
    L.push('  selectedNode = null;');
    L.push('});');

    // Filter bindings
    L.push('function bindFilter(elId, filterKey, isNode) {');
    L.push('  var el = document.getElementById(elId);');
    L.push('  if (!el) return;');
    L.push('  el.addEventListener("change", function() {');
    L.push('    if (isNode) { nodeFilters[filterKey] = el.checked; }');
    L.push('    else { edgeFilters[filterKey] = el.checked; }');
    L.push('    render();');
    L.push('  });');
    L.push('}');
    L.push('bindFilter("f-component", "component", true);');
    L.push('bindFilter("f-platform",  "platform",  true);');
    L.push('bindFilter("f-file",      "file",      true);');
    L.push('bindFilter("f-signal",    "signal",     true);');
    L.push('bindFilter("f-deps",      "deps",       true);');
    L.push('bindFilter("e-contains",  "CONTAINS",     false);');
    L.push('bindFilter("e-depends",   "DEPENDS_ON",   false);');
    L.push('bindFilter("e-calls",     "CALLS",        false);');
    L.push('bindFilter("e-dataflow",  "DATA_FLOWS_TO", false);');

    // Platform filter bindings
    L.push('var platformIds = ["copilot","cline","cursor","claude","roo","windsurf","aider"];');
    L.push('for (var pi = 0; pi < platformIds.length; pi++) {');
    L.push('  (function(pid) {');
    L.push('    var el = document.getElementById("p-" + pid);');
    L.push('    if (el) el.addEventListener("change", function() {');
    L.push('      platformFilters[pid] = el.checked;');
    L.push('      render();');
    L.push('    });');
    L.push('  })(platformIds[pi]);');
    L.push('}');

    // Reset view button
    L.push('document.getElementById("btn-reset-view").addEventListener("click", function(e) {');
    L.push('  e.stopPropagation();');
    L.push('  svg.transition().duration(500).call(zoomBehavior.transform, d3.zoomIdentity);');
    L.push('  if (simulation) {');
    L.push('    simulation.force("center", d3.forceCenter(width / 2, height / 2));');
    L.push('    simulation.alpha(0.3).restart();');
    L.push('  }');
    L.push('});');

    // Resize handler
    L.push('window.addEventListener("resize", function() {');
    L.push('  width = window.innerWidth;');
    L.push('  height = window.innerHeight - TOOLBAR_H;');
    L.push('  svg.attr("width", width).attr("height", height);');
    L.push('  if (simulation) {');
    L.push('    simulation.force("center", d3.forceCenter(width / 2, height / 2));');
    L.push('    simulation.alpha(0.3).restart();');
    L.push('  }');
    L.push('});');

    // Don't render on load — Layer 2 starts hidden, render when shown
    L.push('// render() called when layer2 is shown');

    // Layer navigation
    L.push('var layer1 = document.getElementById("layer1");');
    L.push('var layer2 = document.getElementById("layer2");');
    L.push('var graphInited = false;');
    L.push('');
    L.push('function showLayer2() {');
    L.push('  if (layer1) layer1.style.display = "none";');
    L.push('  if (layer2) layer2.style.display = "";');
    L.push('  if (!graphInited) { graphInited = true; setTimeout(render, 50); }');
    L.push('}');
    L.push('function showLayer1() {');
    L.push('  if (layer2) layer2.style.display = "none";');
    L.push('  if (layer1) layer1.style.display = "";');
    L.push('}');
    L.push('');
    L.push('var showFullBtn = document.getElementById("btn-show-full-graph");');
    L.push('if (showFullBtn) showFullBtn.addEventListener("click", showLayer2);');
    L.push('var backBtn = document.getElementById("btn-back-overview");');
    L.push('if (backBtn) backBtn.addEventListener("click", showLayer1);');
    L.push('');
    L.push('// Platform card click → deep dive');
    L.push('var cards = document.querySelectorAll(".platform-dive-btn");');
    L.push('for (var ci = 0; ci < cards.length; ci++) {');
    L.push('  cards[ci].addEventListener("click", function(e) { e.stopPropagation(); showLayer2(); });');
    L.push('}');

    L.push('})();');

    return L.join('\n');
  }


  private dispose(): void {
    KnowledgeGraphPanel.currentPanel = undefined;
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
  }
}
