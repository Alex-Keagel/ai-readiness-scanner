import * as vscode from 'vscode';
import { ReadinessReport, MATURITY_LEVELS, AI_TOOLS, AITool } from '../scoring/types';

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem | undefined;

  create(context: vscode.ExtensionContext): void {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = 'ai-readiness.showReport';
    this.statusBarItem.text = '$(beaker) AI Readiness';
    this.statusBarItem.tooltip = 'Click to scan workspace';
    this.statusBarItem.show();
    context.subscriptions.push(this.statusBarItem);
  }

  update(report: ReadinessReport): void {
    if (!this.statusBarItem) return;

    const levelInfo = MATURITY_LEVELS[report.primaryLevel];
    const depthPct = report.depth;
    const toolMeta = AI_TOOLS[report.selectedTool as AITool];
    const toolName = toolMeta?.name ?? report.selectedTool;

    this.statusBarItem.text = `$(beaker) 🏆 L${report.primaryLevel}: ${levelInfo.name} (${depthPct}%)`;

    const levelLines = report.levels.map(ls => {
      const pct = ls.rawScore;
      const icon = ls.qualified ? '✅' : '❌';
      return `${icon} L${ls.level}: ${ls.name} — ${pct}% (${ls.signalsDetected}/${ls.signalsTotal})`;
    }).join('\n\n');

    this.statusBarItem.tooltip = new vscode.MarkdownString(
      `**🏆 Level ${report.primaryLevel}: ${levelInfo.name}**\n\n` +
      `Tool: ${toolName}\n\n` +
      `Depth: ${depthPct}% | Overall: ${report.overallScore}/100\n\n` +
      `---\n\n` +
      levelLines +
      `\n\n---\n\n` +
      `*Model: ${report.modelUsed} | Click to open report*`
    );
  }

  dispose(): void {
    this.statusBarItem?.dispose();
  }
}
