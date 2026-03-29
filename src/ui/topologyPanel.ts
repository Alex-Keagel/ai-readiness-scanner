import * as vscode from 'vscode';
import { TACTICAL_GLASSBOX_CSS } from './theme';
import { logger } from '../logging';
import type { TopologyNode, TopologyEdge } from '../deep/complexityAnalyzer';

export class TopologyPanel {
  public static currentPanel: TopologyPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    nodes: TopologyNode[],
    edges: TopologyEdge[],
    products: string[]
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(nodes, edges, products);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static createOrShow(nodes: TopologyNode[], edges: TopologyEdge[], products: string[]): void {
    try {
      if (TopologyPanel.currentPanel) {
        TopologyPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
        TopologyPanel.currentPanel.panel.webview.html = TopologyPanel.currentPanel.getHtml(nodes, edges, products);
        return;
      }

      const panel = vscode.window.createWebviewPanel(
        'aiReadinessTopology', '🕸️ Semantic Topology', vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );

      TopologyPanel.currentPanel = new TopologyPanel(panel, nodes, edges, products);
    } catch (err) {
      logger.error('TopologyPanel: failed to create', err);
    }
  }

  private dispose(): void {
    TopologyPanel.currentPanel = undefined;
    for (const d of this.disposables) d.dispose();
  }

  private getHtml(nodes: TopologyNode[], edges: TopologyEdge[], products: string[]): string {
    // Compute layout positions
    const layout = this.computeLayout(nodes, edges, products);

    // SVG dimensions
    const width = 900;
    const height = 600;
    const padding = 60;

    // Scale positions to SVG viewport
    if (layout.length > 0) {
      const minX = Math.min(...layout.map(n => n.x));
      const maxX = Math.max(...layout.map(n => n.x));
      const minY = Math.min(...layout.map(n => n.y));
      const maxY = Math.max(...layout.map(n => n.y));
      const scaleX = maxX > minX ? (width - 2 * padding) / (maxX - minX) : 1;
      const scaleY = maxY > minY ? (height - 2 * padding) / (maxY - minY) : 1;
      const scale = Math.min(scaleX, scaleY);
      for (const n of layout) {
        n.x = padding + (n.x - minX) * scale;
        n.y = padding + (n.y - minY) * scale;
      }
    }

    const nodeMap = new Map(layout.map(n => [n.id, n]));

    // Generate SVG edges
    const edgeSvg = edges.map(e => {
      const from = nodeMap.get(e.from);
      const to = nodeMap.get(e.to);
      if (!from || !to) return '';
      const strokeColor = e.type === 'call' ? 'rgba(0,210,255,0.3)' : e.type === 'type-hierarchy' ? 'rgba(179,136,255,0.3)' : 'rgba(255,255,255,0.1)';
      return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${strokeColor}" stroke-width="1" class="topo-edge" data-from="${this.esc(e.from)}" data-to="${this.esc(e.to)}"/>`;
    }).join('\n');

    // Generate SVG nodes
    const nodeSvg = layout.map(n => {
      const radius = 8 + n.factor * 20; // 8-28px based on complexity
      const hue = n.coverageScore > 70 ? 140 : n.coverageScore > 40 ? 50 : 0; // green/yellow/red
      const fill = `hsla(${hue}, 70%, 50%, 0.7)`;
      const stroke = n.isProduct ? '#FFD700' : 'rgba(255,255,255,0.2)';
      const strokeWidth = n.isProduct ? 3 : 1;
      const labelY = n.y + radius + 14;
      return `
        <circle cx="${n.x}" cy="${n.y}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"
          class="topo-node" data-id="${this.esc(n.id)}" data-factor="${n.factor}" data-coverage="${n.coverageScore}" data-product="${n.isProduct}"/>
        <text x="${n.x}" y="${labelY}" text-anchor="middle" fill="var(--text-secondary)" font-size="10" class="topo-label">${this.esc(n.label)}</text>
      `;
    }).join('\n');

    // Node details JSON for interactivity
    const nodeDataJson = JSON.stringify(layout.map(n => ({
      id: n.id, label: n.label, factor: n.factor, isProduct: n.isProduct,
      coverageScore: n.coverageScore, role: n.role,
    })));

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Semantic Topology</title>
<style>
  ${TACTICAL_GLASSBOX_CSS}
  body { padding: 16px; margin: 0; overflow: hidden; }
  h1 { font-size: 1.2em; border-bottom: 2px solid var(--border-subtle); padding-bottom: 8px; margin: 0 0 12px; }
  .topo-container { position: relative; width: 100%; height: calc(100vh - 120px); }
  .topo-svg { width: 100%; height: 100%; cursor: grab; }
  .topo-svg:active { cursor: grabbing; }
  .topo-node { cursor: pointer; transition: opacity 0.15s; }
  .topo-node:hover { opacity: 0.8; filter: brightness(1.3); }
  .topo-edge { pointer-events: none; }
  .topo-label { pointer-events: none; user-select: none; }

  .legend { display: flex; gap: 16px; margin: 8px 0; font-size: 0.8em; color: var(--text-secondary); flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-dot { width: 12px; height: 12px; border-radius: 50%; }

  .detail-panel { position: absolute; right: 12px; top: 12px; width: 260px; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 14px; display: none; backdrop-filter: blur(12px); z-index: 10; }
  .detail-panel.visible { display: block; }
  .detail-panel h3 { margin: 0 0 8px; font-size: 1em; }
  .detail-row { display: flex; justify-content: space-between; font-size: 0.85em; padding: 3px 0; }
  .detail-row .label { color: var(--text-secondary); }
  .detail-row .value { font-weight: 600; }
  .detail-tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.78em; margin: 2px; }
  .detail-tag.product { background: rgba(255,215,0,0.2); color: #FFD700; border: 1px solid rgba(255,215,0,0.3); }
  .detail-tag.support { background: var(--bg-elevated); color: var(--text-secondary); }

  @media (max-width: 600px) {
    .detail-panel { width: 100%; right: 0; top: auto; bottom: 0; border-radius: 10px 10px 0 0; }
    .legend { font-size: 0.7em; }
  }
</style>
</head>
<body>
  <h1>🕸️ Semantic Topology</h1>
  <div class="legend">
    <div class="legend-item"><div class="legend-dot" style="background:#FFD700;border:2px solid #FFD700"></div> Product Core</div>
    <div class="legend-item"><div class="legend-dot" style="background:hsl(140,70%,50%)"></div> Well-Covered</div>
    <div class="legend-item"><div class="legend-dot" style="background:hsl(50,70%,50%)"></div> Partial Coverage</div>
    <div class="legend-item"><div class="legend-dot" style="background:hsl(0,70%,50%)"></div> Low Coverage</div>
    <div class="legend-item">Size = Complexity Factor</div>
  </div>

  <div class="topo-container">
    <svg class="topo-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" id="topoSvg">
      <defs>
        <marker id="arrow" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="8" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 3 L 0 6 z" fill="rgba(0,210,255,0.4)"/>
        </marker>
      </defs>
      <g id="topoGroup">
        ${edgeSvg}
        ${nodeSvg}
      </g>
    </svg>

    <div class="detail-panel" id="detailPanel">
      <h3 id="detailName">—</h3>
      <div id="detailContent"></div>
    </div>
  </div>

  <script>
    const nodeData = ${nodeDataJson};
    const vscode = acquireVsCodeApi();

    // Click on node → show details
    document.querySelectorAll('.topo-node').forEach(el => {
      el.addEventListener('click', function() {
        const id = this.dataset.id;
        const node = nodeData.find(n => n.id === id);
        if (!node) return;
        const panel = document.getElementById('detailPanel');
        document.getElementById('detailName').textContent = node.label;
        document.getElementById('detailContent').innerHTML =
          '<div class="detail-row"><span class="label">Complexity</span><span class="value">' + (node.factor * 100).toFixed(0) + '%<\\/span><\\/div>' +
          '<div class="detail-row"><span class="label">Coverage</span><span class="value">' + node.coverageScore + '/100<\\/span><\\/div>' +
          '<div class="detail-row"><span class="label">Role</span><span class="value">' + (node.role || 'unknown') + '<\\/span><\\/div>' +
          '<div class="detail-row"><span class="label">Path</span><span class="value" style="font-size:0.75em">' + node.id + '<\\/span><\\/div>' +
          '<div style="margin-top:8px"><span class="detail-tag ' + (node.isProduct ? 'product' : 'support') + '">' + (node.isProduct ? '⭐ Product Core' : '🔧 Support') + '<\\/span><\\/div>';
        panel.classList.add('visible');
      });
    });

    // Click outside → hide details
    document.getElementById('topoSvg').addEventListener('click', function(e) {
      if (!e.target.classList.contains('topo-node')) {
        document.getElementById('detailPanel').classList.remove('visible');
      }
    });

    // Zoom + pan
    let scale = 1, panX = 0, panY = 0, isPanning = false, startX, startY;
    const svg = document.getElementById('topoSvg');
    const group = document.getElementById('topoGroup');

    svg.addEventListener('wheel', function(e) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      scale *= delta;
      scale = Math.max(0.3, Math.min(3, scale));
      group.setAttribute('transform', 'translate(' + panX + ',' + panY + ') scale(' + scale + ')');
    });

    svg.addEventListener('mousedown', function(e) {
      if (e.target.classList.contains('topo-node')) return;
      isPanning = true;
      startX = e.clientX - panX;
      startY = e.clientY - panY;
    });
    svg.addEventListener('mousemove', function(e) {
      if (!isPanning) return;
      panX = e.clientX - startX;
      panY = e.clientY - startY;
      group.setAttribute('transform', 'translate(' + panX + ',' + panY + ') scale(' + scale + ')');
    });
    svg.addEventListener('mouseup', function() { isPanning = false; });
    svg.addEventListener('mouseleave', function() { isPanning = false; });
  </script>
</body>
</html>`;
  }

  // ─── Layout Algorithm ─────────────────────────────────────────

  private computeLayout(
    nodes: TopologyNode[],
    edges: TopologyEdge[],
    products: string[]
  ): (TopologyNode & { x: number; y: number })[] {
    if (nodes.length === 0) return [];

    const productSet = new Set(products);
    const productNodes = nodes.filter(n => productSet.has(n.id));
    const supportNodes = nodes.filter(n => !productSet.has(n.id));

    const cx = 450, cy = 300;

    if (nodes.length <= 10) {
      // Radial layout: products at center, support in ring
      return this.radialLayout(productNodes, supportNodes, cx, cy);
    } else if (nodes.length <= 30) {
      // Force-directed with gravity toward center
      return this.forceDirectedLayout(nodes, edges, productSet, cx, cy);
    } else {
      // Clustered: group by directory
      return this.clusteredLayout(nodes, edges, productSet, cx, cy);
    }
  }

  private radialLayout(
    products: TopologyNode[],
    support: TopologyNode[],
    cx: number, cy: number
  ): (TopologyNode & { x: number; y: number })[] {
    const result: (TopologyNode & { x: number; y: number })[] = [];

    // Products in inner ring
    const pRadius = products.length > 1 ? 80 : 0;
    products.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, products.length) - Math.PI / 2;
      result.push({ ...n, x: cx + pRadius * Math.cos(angle), y: cy + pRadius * Math.sin(angle) });
    });

    // Support in outer ring
    const sRadius = 200;
    support.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, support.length) - Math.PI / 2;
      result.push({ ...n, x: cx + sRadius * Math.cos(angle), y: cy + sRadius * Math.sin(angle) });
    });

    return result;
  }

  private forceDirectedLayout(
    nodes: TopologyNode[],
    edges: TopologyEdge[],
    products: Set<string>,
    cx: number, cy: number
  ): (TopologyNode & { x: number; y: number })[] {
    // Initialize positions randomly around center
    const positions = nodes.map((n, i) => {
      const angle = (2 * Math.PI * i) / nodes.length;
      const radius = products.has(n.id) ? 50 + Math.random() * 50 : 150 + Math.random() * 100;
      return { ...n, x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
    });

    // Simple force-directed: 30 iterations
    const edgeMap = new Map<string, string[]>();
    for (const e of edges) {
      if (!edgeMap.has(e.from)) edgeMap.set(e.from, []);
      edgeMap.get(e.from)!.push(e.to);
    }

    for (let iter = 0; iter < 30; iter++) {
      for (let i = 0; i < positions.length; i++) {
        let fx = 0, fy = 0;

        // Repulsion from all other nodes
        for (let j = 0; j < positions.length; j++) {
          if (i === j) continue;
          const dx = positions[i].x - positions[j].x;
          const dy = positions[i].y - positions[j].y;
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const force = 500 / (dist * dist);
          fx += (dx / dist) * force;
          fy += (dy / dist) * force;
        }

        // Attraction along edges
        const connected = edgeMap.get(positions[i].id) || [];
        for (const targetId of connected) {
          const j = positions.findIndex(p => p.id === targetId);
          if (j < 0) continue;
          const dx = positions[j].x - positions[i].x;
          const dy = positions[j].y - positions[i].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          fx += dx * 0.01;
          fy += dy * 0.01;
        }

        // Gravity toward center (stronger for products)
        const gravity = products.has(positions[i].id) ? 0.05 : 0.01;
        fx += (cx - positions[i].x) * gravity;
        fy += (cy - positions[i].y) * gravity;

        positions[i].x += fx * 0.5;
        positions[i].y += fy * 0.5;
      }
    }

    return positions;
  }

  private clusteredLayout(
    nodes: TopologyNode[],
    edges: TopologyEdge[],
    products: Set<string>,
    cx: number, cy: number
  ): (TopologyNode & { x: number; y: number })[] {
    // Group by first directory segment
    const groups = new Map<string, TopologyNode[]>();
    for (const n of nodes) {
      const dir = n.id.split('/').slice(0, 2).join('/');
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir)!.push(n);
    }

    const result: (TopologyNode & { x: number; y: number })[] = [];
    const groupArr = [...groups.entries()];
    const groupRadius = 250;

    groupArr.forEach(([dir, groupNodes], gi) => {
      const groupAngle = (2 * Math.PI * gi) / groupArr.length - Math.PI / 2;
      const gcx = cx + groupRadius * Math.cos(groupAngle);
      const gcy = cy + groupRadius * Math.sin(groupAngle);

      // Arrange nodes within group in small cluster
      const innerRadius = Math.min(60, 15 * groupNodes.length);
      groupNodes.forEach((n, ni) => {
        const nodeAngle = (2 * Math.PI * ni) / groupNodes.length;
        result.push({
          ...n,
          x: gcx + innerRadius * Math.cos(nodeAngle),
          y: gcy + innerRadius * Math.sin(nodeAngle),
        });
      });
    });

    return result;
  }

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
