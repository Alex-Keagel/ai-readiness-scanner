import * as vscode from 'vscode';
import { ReadinessReport, MATURITY_LEVELS, AI_TOOLS, AITool } from '../scoring/types';
import { humanizeSignalId } from '../utils';
import { TACTICAL_GLASSBOX_CSS, getLevelColor } from './theme';
import { logger } from '../logging';

interface TreeNode {
  id: string;
  label: string;
  level: number;
  score: number;
  depth: number;
  language: string;
  type: string;
  description: string;
  signals: { name: string; present: boolean }[];
  color: string;
  parentPath?: string;
  dependencies: string[];
  children: TreeNode[];
}

export class GraphPanel {
  public static currentPanel: GraphPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, report: ReadinessReport) {
    this.panel = panel;
    try {
      this.panel.webview.html = this.getHtml(report);
    } catch (err) {
      logger.error('GraphPanel render failed', err);
      this.panel.webview.html = `<html><body><h1>❌ Error rendering graph</h1><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`;
    }
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static createOrShow(report: ReadinessReport): void {
    try {
    const column = vscode.ViewColumn.One;
    if (GraphPanel.currentPanel) {
      GraphPanel.currentPanel.panel.reveal(column);
      GraphPanel.currentPanel.panel.webview.html = GraphPanel.currentPanel.getHtml(report);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'aiReadinessGraph', '🏗️ Repository Structure',
      column, { enableScripts: true, retainContextWhenHidden: true }
    );
    GraphPanel.currentPanel = new GraphPanel(panel, report);
    } catch (err) {
      logger.error('GraphPanel: failed to create', err);
      vscode.window.showErrorMessage(`Failed to open panel: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getHtml(report: ReadinessReport): string {
    try {
    // Build dependency map from knowledge graph
    const depMap = new Map<string, string[]>();
    const graph = report.knowledgeGraph as any;
    const graphEdges = graph?.edges?.filter((e: any) => e.relation === 'DEPENDS_ON') || [];
    for (const e of graphEdges) {
      const source = (e.source as string).replace('comp-', '').replace(/_/g, '/');
      const target = (e.target as string).replace('comp-', '').replace(/_/g, '/');
      if (!depMap.has(source)) { depMap.set(source, []); }
      depMap.get(source)!.push(target);
    }

    // Build flat node list
    const flatNodes: TreeNode[] = report.componentScores.map(c => ({
      id: c.path,
      label: c.name,
      level: c.primaryLevel,
      score: c.overallScore,
      depth: c.depth,
      language: c.language,
      type: c.type,
      description: c.description || '',
      signals: c.signals
        .filter(s => {
          const name = ((s as any).signalId || (s as any).signal || '').toLowerCase();
          return name !== 'tests';
        })
        .map(s => ({
          name: humanizeSignalId((s as any).signalId || (s as any).signal || ''),
          present: !!(s as any).present || !!(s as any).detected,
        })),
      color: getLevelColor(c.primaryLevel),
      parentPath: c.parentPath,
      dependencies: depMap.get(c.path) || [],
      children: [],
    }));

    // Build tree: index by path, then nest children under parents
    const nodeMap = new Map<string, TreeNode>();
    for (const n of flatNodes) { nodeMap.set(n.id, n); }
    const roots: TreeNode[] = [];
    for (const n of flatNodes) {
      if (n.parentPath && nodeMap.has(n.parentPath)) {
        nodeMap.get(n.parentPath)!.children.push(n);
      } else {
        roots.push(n);
      }
    }

    // Sort children alphabetically at every level
    const sortChildren = (nodes: TreeNode[]): void => {
      nodes.sort((a, b) => a.label.localeCompare(b.label));
      for (const n of nodes) { sortChildren(n.children); }
    };
    sortChildren(roots);

    const toolMeta = AI_TOOLS[report.selectedTool as AITool];
    const toolName = toolMeta?.name ?? report.selectedTool;
    const levelName = MATURITY_LEVELS[report.primaryLevel].name;

    const treeJson = JSON.stringify(roots);
    // Serialize node map without children to avoid circular references
    const nodeMapObj: Record<string, any> = {};
    for (const [key, node] of nodeMap) {
      const { children, ...rest } = node;
      nodeMapObj[key] = rest;
    }
    const nodeMapJson = JSON.stringify(nodeMapObj);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Repository Structure</title>
  <style>
    ${TACTICAL_GLASSBOX_CSS}

    /* Panel-specific layout */
    html { height: 100%; }
    body { min-height: 100%; display: flex; flex-direction: column; overflow: auto; }

    .top-bar { display: flex; align-items: center; gap: 16px; padding: 10px 16px; border-bottom: 1px solid var(--border-subtle); flex-wrap: wrap; }
    .top-bar h1 { font-size: 1.1em; white-space: nowrap; }
    .top-bar .meta { color: var(--text-secondary); font-size: 0.85em; }
    .stats-bar { display: flex; gap: 12px; margin-left: auto; flex-wrap: wrap; }
    .stat { background: var(--bg-card); padding: 4px 10px; border-radius: 6px; font-size: 0.8em; white-space: nowrap; border: 1px solid var(--border-subtle); }
    .stat b { font-size: 1.1em; }

    .toolbar { display: flex; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--border-subtle); align-items: center; flex-wrap: wrap; }
    .toolbar .btn { padding: 4px 12px; font-size: 0.8em; }
    .legend { display: flex; gap: 8px; margin-left: auto; align-items: center; flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; gap: 3px; font-size: 0.75em; color: var(--text-secondary); }
    .legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

    .tree-container { flex: 1; overflow: auto; padding: 16px 16px 32px; }

    .tree-node { margin-bottom: 2px; }
    .tree-children { padding-left: 0; }
    .tree-children.collapsed { display: none; }

    .node-card {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px; border-radius: 8px;
      border: 1px solid transparent;
      cursor: pointer; user-select: none;
      transition: background 0.15s, border-color 0.2s, box-shadow 0.2s;
    }
    .node-card:hover { background: var(--bg-card-hover); border-color: var(--border-active); box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2); }

    .toggle-arrow {
      width: 18px; height: 18px; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.7em; color: var(--text-secondary);
      transition: transform 0.2s ease;
    }
    .toggle-arrow.expanded { transform: rotate(90deg); }
    .toggle-arrow.leaf { visibility: hidden; }

    .level-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }

    .node-name { font-size: 0.88em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }

    .node-badges { display: flex; gap: 4px; flex-shrink: 0; align-items: center; flex-wrap: wrap; }
    .badge-signals { background: transparent; color: var(--text-secondary); font-size: 0.7em; }

    .node-deps {
      margin: 0 0 4px 44px; padding: 2px 0;
      font-size: 0.72em; color: var(--text-secondary);
    }
    .node-deps a { color: var(--color-cyan); text-decoration: none; cursor: pointer; }
    .node-deps a:hover { text-decoration: underline; }

    .signal-detail {
      margin: 0 0 4px 44px; padding: 8px 12px;
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 8px; font-size: 0.82em;
      transition: opacity 0.2s ease, padding 0.2s ease;
    }
    .signal-detail.hidden { display: none; }
    .signal-detail h4 { font-size: 0.8em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 4px; letter-spacing: 0.5px; }
    .signal-detail .desc { color: var(--text-secondary); margin-bottom: 6px; }
    .signal-detail .signal-row { padding: 1px 0; }
    .signal-detail .detail-badges { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }

    .root-card {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px; margin-bottom: 8px;
      border-radius: 12px;
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .root-card:hover { border-color: var(--border-active); box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3); }
    .root-card .root-icon { font-size: 1.3em; }
    .root-card .root-name { font-size: 1em; font-weight: 700; }
    .root-card .root-meta { font-size: 0.8em; color: var(--text-secondary); }
  </style>
</head>
<body>
  <div class="top-bar">
    <h1>🏗️ Repository Structure</h1>
    <span class="meta">${this.escapeHtml(toolName)} readiness · L${report.primaryLevel} ${this.escapeHtml(levelName)}</span>
    <div class="stats-bar">
      <div class="stat"><b>${report.componentScores.length}</b> Components</div>
      <div class="stat"><b>L${report.primaryLevel}</b> ${this.escapeHtml(levelName)}</div>
      <div class="stat"><b>${report.overallScore}</b> Score</div>
    </div>
  </div>
  <div class="toolbar">
    <button class="btn" onclick="expandAll()">▶ Expand All</button>
    <button class="btn" onclick="collapseAll()">◀ Collapse All</button>
    <div class="legend">
      <span style="font-size:0.75em;color:var(--text-secondary);margin-right:2px;">Maturity:</span>
      <div class="legend-item"><div class="legend-dot" style="background:var(--level-1)"></div>L1</div>
      <div class="legend-item"><div class="legend-dot" style="background:var(--level-2)"></div>L2</div>
      <div class="legend-item"><div class="legend-dot" style="background:var(--level-3)"></div>L3</div>
      <div class="legend-item"><div class="legend-dot" style="background:var(--level-4)"></div>L4</div>
      <div class="legend-item"><div class="legend-dot" style="background:var(--level-5)"></div>L5</div>
      <div class="legend-item"><div class="legend-dot" style="background:var(--level-6)"></div>L6</div>
    </div>
  </div>
  <div class="tree-container" id="treeRoot"></div>

  <script>
  (function() {
    const tree = ${treeJson};
    const allNodes = ${nodeMapJson};
    const levelNames = {1:'Prompt-Only',2:'Instruction-Guided',3:'Skill-Equipped',4:'Playbook-Driven',5:'Self-Improving',6:'Autonomous Orchestration'};
    const container = document.getElementById('treeRoot');

    // Track expanded and detail-visible states
    const expandedSet = new Set();
    const detailSet = new Set();

    function esc(s) {
      const d = document.createElement('span');
      d.textContent = s;
      return d.innerHTML;
    }

    // Build root-level repo card
    const rootEl = document.createElement('div');
    rootEl.className = 'root-card';
    rootEl.innerHTML =
      '<span class="root-icon">📦</span>' +
      '<span class="root-name">' + esc(${JSON.stringify(report.projectName)}) + '</span>' +
      '<span class="root-meta">L' + ${report.primaryLevel} + ' ' + esc(${JSON.stringify(levelName)}) +
      ' · ' + ${report.componentScores.length} + ' components · Score ' + ${report.overallScore} + '</span>';
    container.appendChild(rootEl);

    function renderTree(nodes, parentEl, indentLevel) {
      for (const node of nodes) {
        const hasChildren = node.children && node.children.length > 0;
        const presentCount = node.signals.filter(function(s) { return s.present; }).length;
        const absentCount = node.signals.length - presentCount;

        // Wrapper div
        const wrapper = document.createElement('div');
        wrapper.className = 'tree-node';
        wrapper.style.paddingLeft = (indentLevel * 20) + 'px';

        // Card row
        const card = document.createElement('div');
        card.className = 'node-card';
        card.dataset.nodeId = node.id;

        // Toggle arrow
        const arrow = document.createElement('span');
        arrow.className = 'toggle-arrow' + (hasChildren ? ' expanded' : ' leaf');
        arrow.textContent = '▶';
        if (hasChildren) expandedSet.add(node.id);

        // Level dot
        const dot = document.createElement('span');
        dot.className = 'level-dot';
        dot.style.background = node.color;
        dot.title = 'L' + node.level + ' ' + (levelNames[node.level] || '');

        // Name
        const name = document.createElement('span');
        name.className = 'node-name';
        name.textContent = node.label || node.id.split('/').pop() || node.id;
        name.title = node.id;

        // Badges
        const badges = document.createElement('span');
        badges.className = 'node-badges';
        badges.innerHTML =
          '<span class="badge badge-level" style="background:' + node.color + '">L' + node.level + '</span>' +
          (node.language ? '<span class="badge badge-lang">' + esc(node.language) + '</span>' : '') +
          '<span class="badge badge-score">' + node.score + '%</span>' +
          '<span class="badge badge-signals">✅' + presentCount + ' ❌' + absentCount + '</span>';

        card.appendChild(arrow);
        card.appendChild(dot);
        card.appendChild(name);
        card.appendChild(badges);
        wrapper.appendChild(card);

        // Signal detail panel (hidden by default)
        const detail = document.createElement('div');
        detail.className = 'signal-detail hidden';
        detail.style.marginLeft = (indentLevel * 20) + 'px';
        let detailHtml = '';
        if (node.description) {
          detailHtml += '<div class="desc">' + esc(node.description) + '</div>';
        }
        detailHtml += '<div class="detail-badges">' +
          '<span class="badge badge-level" style="background:' + node.color + '">L' + node.level + ' ' + esc(levelNames[node.level] || '') + '</span>' +
          (node.language ? '<span class="badge badge-lang">' + esc(node.language) + '</span>' : '') +
          '<span class="badge badge-score">' + esc(node.type) + '</span>' +
          '<span class="badge badge-score">Score: ' + node.score + '</span>' +
          '<span class="badge badge-score">Depth: ' + node.depth + '</span>' +
          '</div>';
        if (node.signals.length > 0) {
          const present = node.signals.filter(function(s) { return s.present; });
          const absent = node.signals.filter(function(s) { return !s.present; });
          detailHtml += '<h4>Signals (' + presentCount + '/' + node.signals.length + ')</h4>';
          for (const s of present) detailHtml += '<div class="signal-row pass">' + esc(s.name) + '</div>';
          for (const s of absent) detailHtml += '<div class="signal-row fail">' + esc(s.name) + '</div>';
        }
        detail.innerHTML = detailHtml;

        // Dependencies links
        let depEl = null;
        if (node.dependencies && node.dependencies.length > 0) {
          depEl = document.createElement('div');
          depEl.className = 'node-deps';
          depEl.style.marginLeft = (indentLevel * 20) + 'px';
          let depHtml = '↗ depends on: ';
          depHtml += node.dependencies.map(function(d) {
            const depNode = allNodes[d];
            const depLabel = depNode ? depNode.label : d.split('/').pop();
            return '<a data-target="' + esc(d) + '" title="' + esc(d) + '">' + esc(depLabel) + '</a>';
          }).join(', ');
          depEl.innerHTML = depHtml;
        }

        // Children container
        let childrenEl = null;
        if (hasChildren) {
          childrenEl = document.createElement('div');
          childrenEl.className = 'tree-children';
          renderTree(node.children, childrenEl, indentLevel + 1);
        }

        // Click handlers
        card.addEventListener('click', function(e) {
          e.stopPropagation();
          // Toggle detail panel
          if (detailSet.has(node.id)) {
            detailSet.delete(node.id);
            detail.classList.add('hidden');
          } else {
            detailSet.add(node.id);
            detail.classList.remove('hidden');
          }
        });

        if (hasChildren) {
          arrow.addEventListener('click', function(e) {
            e.stopPropagation();
            if (expandedSet.has(node.id)) {
              expandedSet.delete(node.id);
              arrow.classList.remove('expanded');
              childrenEl.classList.add('collapsed');
            } else {
              expandedSet.add(node.id);
              arrow.classList.add('expanded');
              childrenEl.classList.remove('collapsed');
            }
          });
        }

        parentEl.appendChild(wrapper);
        parentEl.appendChild(detail);
        if (depEl) parentEl.appendChild(depEl);
        if (childrenEl) parentEl.appendChild(childrenEl);
      }
    }

    renderTree(tree, container, 0);

    // Dependency link click → scroll to target node and flash it
    container.addEventListener('click', function(e) {
      const link = e.target.closest('a[data-target]');
      if (!link) return;
      e.preventDefault();
      const targetId = link.dataset.target;
      const targetCard = container.querySelector('.node-card[data-node-id="' + CSS.escape(targetId) + '"]');
      if (targetCard) {
        targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetCard.style.outline = '2px solid var(--vscode-focusBorder)';
        targetCard.style.outlineOffset = '2px';
        setTimeout(function() {
          targetCard.style.outline = '';
          targetCard.style.outlineOffset = '';
        }, 1500);
      }
    });

    // Expand/collapse all
    window.expandAll = function() {
      container.querySelectorAll('.toggle-arrow:not(.leaf)').forEach(function(a) { a.classList.add('expanded'); });
      container.querySelectorAll('.tree-children').forEach(function(c) { c.classList.remove('collapsed'); });
      container.querySelectorAll('.node-card').forEach(function(card) {
        if (card.dataset.nodeId) expandedSet.add(card.dataset.nodeId);
      });
    };

    window.collapseAll = function() {
      container.querySelectorAll('.toggle-arrow:not(.leaf)').forEach(function(a) { a.classList.remove('expanded'); });
      container.querySelectorAll('.tree-children').forEach(function(c) { c.classList.add('collapsed'); });
      expandedSet.clear();
    };
  })();
  </script>
</body>
</html>`;
    } catch (err) {
      logger.error('GraphPanel: render failed', err);
      return `<html><body><h2>❌ Render Error</h2><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`;
    }
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private dispose(): void {
    GraphPanel.currentPanel = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
