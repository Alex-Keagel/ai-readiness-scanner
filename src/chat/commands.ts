import { GraphBuilder } from '../graph';
import { GraphTreeNode,KnowledgeGraph } from '../graph/types';
import {
AITool,
AI_TOOLS,
MATURITY_LEVELS,
MaturityLevel,
ReadinessReport,
StructureComparison
} from '../scoring/types';

const LEVEL_EMOJIS: Record<number, string> = {
  1: '🟤', 2: '📘', 3: '🟢', 4: '🟣', 5: '🏅', 6: '🏆',
};

/** Format a full report as compact chat-friendly markdown. */
export function formatReportForChat(report: ReadinessReport): string {
  const lines: string[] = [];
  const depthPct = report.depth;
  const emoji = LEVEL_EMOJIS[report.primaryLevel] ?? '📊';

  lines.push(
    `${emoji} **Level ${report.primaryLevel} — ${report.levelName}** ` +
    `(Depth: ${depthPct}%, Overall: ${report.overallScore}/100)`
  );
  lines.push('');

  lines.push('**Maturity Ladder**');
  for (const ls of report.levels) {
    const pct = ls.rawScore;
    const icon = ls.qualified ? '✅' : '❌';
    lines.push(`- ${icon} L${ls.level}: ${ls.name} — ${pct}% (${ls.signalsDetected}/${ls.signalsTotal} signals)`);
  }
  lines.push('');

  if (report.componentScores.length > 0) {
    lines.push('**🕸️ Repository Structure**');
    const rootComponents = report.componentScores.filter(c => !c.parentPath);
    const childMap = new Map<string, typeof report.componentScores>();
    for (const comp of report.componentScores) {
      if (comp.parentPath) {
        if (!childMap.has(comp.parentPath)) { childMap.set(comp.parentPath, []); }
        childMap.get(comp.parentPath)!.push(comp);
      }
    }

    for (const comp of rootComponents) {
      const dp = comp.depth;
      const descSuffix = comp.description ? ` — "${comp.description}"` : '';
      const signalSummary = comp.signals.map(s => s.present ? `✅` : `❌`).join('');
      lines.push(`- 📦 ${comp.path} [${comp.language}] L${comp.primaryLevel} (${dp}%) ${signalSummary}${descSuffix}`);

      const children = childMap.get(comp.path) || [];
      for (const child of children) {
        const childSignals = child.signals.map(s => s.present ? `✅` : `❌`).join('');
        lines.push(`  - 📦 ${child.path} [${child.language}] L${child.primaryLevel} ${childSignals}`);
      }
    }
  }

  return lines.join('\n');
}

/** Format a single maturity level's results for the chat panel. */
export function formatLevelForChat(report: ReadinessReport, level: MaturityLevel): string {
  const ls = report.levels.find(l => l.level === level);
  if (!ls) {
    return `Level ${level} not found in the scan results.`;
  }

  const pct = ls.rawScore;
  const lines: string[] = [];
  lines.push(`### Level ${ls.level}: ${ls.name} — ${pct}%`);
  lines.push('');
  lines.push(MATURITY_LEVELS[ls.level].description);
  lines.push('');
  lines.push(`✅ ${ls.signalsDetected} detected · ❌ ${ls.signalsTotal - ls.signalsDetected} missing · ${ls.qualified ? '🟢 Qualified' : '🔴 Not qualified'}`);
  lines.push('');

  const failed = ls.signals.filter(s => !s.detected);
  if (failed.length > 0) {
    lines.push('**Missing signals:**');
    for (const s of failed) {
      lines.push(`- ❌ \`${s.signalId}\` — ${s.finding}`);
    }
    lines.push('');
  }

  const passed = ls.signals.filter(s => s.detected);
  if (passed.length > 0) {
    lines.push('**Detected signals:**');
    for (const s of passed) {
      lines.push(`- ✅ \`${s.signalId}\` (${s.score}/100) — ${s.finding}`);
    }
  }

  return lines.join('\n');
}

/** Format the top N actionable missing signals for the chat panel. */
export function formatActionsForChat(report: ReadinessReport, count: number): string {
  const missingSignals = report.levels
    .flatMap(ls => ls.signals.filter(s => !s.detected))
    .sort((a, b) => a.level - b.level);

  if (missingSignals.length === 0) {
    return '🎉 All signals detected — great job!';
  }

  const top = missingSignals.slice(0, count);
  const lines: string[] = [];
  lines.push(`**Top ${top.length} Actions to Improve**`);
  for (const s of top) {
    lines.push(`1. \`${s.signalId}\` (L${s.level}) — ${s.finding}`);
  }
  return lines.join('\n');
}

/** Format the full platform guide for a specific AI tool. */
export function formatToolGuide(tool: AITool): string {
  const config = AI_TOOLS[tool];
  if (!config || !config.reasoningContext) { return 'No guide available.'; }
  const rc = config.reasoningContext;

  let docLinksBlock = '';
  if (config.docUrls?.main) {
    const links: string[] = [];
    if (config.docUrls.main) { links.push(`- [📄 Main Documentation](${config.docUrls.main})`); }
    if (config.docUrls.rules) { links.push(`- [📋 Rules & Instructions](${config.docUrls.rules})`); }
    if (config.docUrls.memory) { links.push(`- [🧠 Memory & Context](${config.docUrls.memory})`); }
    if (config.docUrls.bestPractices) { links.push(`- [⭐ Best Practices](${config.docUrls.bestPractices})`); }
    docLinksBlock = `### 📖 Official Documentation\n${links.join('\n')}\n\n`;
  }

  return `## ${config.icon} ${config.name} — Platform Guide\n\n` +
    docLinksBlock +
    `### 📁 Expected File Structure\n${rc.structureExpectations}\n\n` +
    `### ✅ Quality Markers\n${rc.qualityMarkers}\n\n` +
    `### ❌ Anti-Patterns\n${rc.antiPatterns}\n\n` +
    `### 📝 Instruction Format\n${rc.instructionFormat}`;
}

/** Format structure comparison for chat display. */
export function formatStructureComparison(sc: StructureComparison): string {
  const lines: string[] = [];
  lines.push(`## 📁 ${sc.toolName} — Expected vs Actual Structure (${sc.completeness}% complete)\n`);
  lines.push(`> ✅ ${sc.presentCount} present · ❌ ${sc.missingCount} missing · ${sc.expected.length} total\n`);
  lines.push('| Status | Path | Description | Required |');
  lines.push('|--------|------|-------------|----------|');
  const sorted = [...sc.expected].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    const icon = f.exists ? '✅' : (f.required ? '❌' : '⬜');
    const req = f.required ? 'Yes' : 'No';
    lines.push(`| ${icon} | \`${f.path}\` | ${f.description} | ${req} |`);
  }
  return lines.join('\n');
}

/** Match user input to a maturity level number. */
export function matchLevel(input: string): MaturityLevel | undefined {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return undefined;

  // Try numeric match
  const num = parseInt(trimmed.replace(/^l/i, ''), 10);
  if (num >= 1 && num <= 6) return num as MaturityLevel;

  // Try name match
  for (const [key, info] of Object.entries(MATURITY_LEVELS)) {
    if (info.name.toLowerCase().includes(trimmed)) {
      return parseInt(key) as MaturityLevel;
    }
  }

  return undefined;
}

/** Format the knowledge graph as a compact text tree for chat display. */
export function formatGraphForChat(graph: KnowledgeGraph): string {
  const builder = new GraphBuilder();
  const tree = builder.buildTree(graph);
  const lines: string[] = [];

  lines.push(`## 🕸️ Knowledge Graph — ${graph.metadata.projectName}`);
  lines.push(`> ${graph.metadata.nodeCount} nodes, ${graph.metadata.edgeCount} edges | ${graph.metadata.selectedTool} | ${new Date(graph.metadata.scannedAt).toLocaleDateString()}`);
  lines.push('');

  renderTreeForChat(tree, lines, 0);

  return lines.join('\n');
}

function renderTreeForChat(treeNode: GraphTreeNode, lines: string[], depth: number): void {
  const indent = '  '.repeat(depth);
  const { node, children, edges } = treeNode;

  const badge = node.badge ? ` \`${node.badge}\`` : '';
  const desc = node.description ? ` — *${node.description}*` : '';
  const icon = node.icon || '•';

  lines.push(`${indent}- ${icon} **${node.label}**${desc}${badge}`);

  // Show dependency edges
  const depEdges = edges.filter(e => e.relation === 'DEPENDS_ON');
  if (depEdges.length > 0) {
    const depLabels = depEdges.map(e => e.label || e.target).join(', ');
    lines.push(`${indent}  🔗 *depends on: ${depLabels}*`);
  }

  for (const child of children) {
    renderTreeForChat(child, lines, depth + 1);
  }
}
