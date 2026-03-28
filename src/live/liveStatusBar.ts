import * as vscode from 'vscode';
import type { LiveMetrics } from './metricsEngine';

const COLOR_MAP: Record<string, vscode.ThemeColor> = {
  red: new vscode.ThemeColor('statusBarItem.errorBackground'),
  yellow: new vscode.ThemeColor('statusBarItem.warningBackground'),
  green: new vscode.ThemeColor('statusBarItem.prominentBackground'),
  purple: new vscode.ThemeColor('statusBarItem.prominentBackground'),
};

export class LiveStatusBar {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      200
    );
    this.item.command = 'ai-readiness.livePanel';
    this.item.text = '$(pulse) AIPM: --';
    this.item.tooltip = 'Click to open Live AIPM Dashboard';
  }

  show(): void {
    this.item.show();
  }

  hide(): void {
    this.item.hide();
  }

  update(metrics: LiveMetrics): void {
    const aipmFormatted = metrics.aipm.toLocaleString();
    const agentText = metrics.concurrency > 0
      ? ` | 🔄 ${metrics.concurrency}`
      : '';
    const platformIcons = metrics.activePlatforms.map(p => {
      if (p === 'copilot') { return '🤖'; }
      if (p === 'claude') { return '🧠'; }
      return '⚡';
    }).join('');

    const icon = metrics.color === 'purple' ? '$(zap)' :
                 metrics.color === 'green' ? '$(pulse)' :
                 metrics.color === 'yellow' ? '$(pulse)' :
                 '$(circle-slash)';

    this.item.text = `${icon} ${aipmFormatted} AIPM${agentText} ${platformIcons}`;
    this.item.backgroundColor = COLOR_MAP[metrics.color];

    const tooltip = new vscode.MarkdownString(
      `**⚡ Live AIPM Tracker**\n\n` +
      `| Metric | Value |\n|---|---|\n` +
      `| Current AIPM | **${aipmFormatted}** |\n` +
      `| Session Avg AIPM | ${metrics.sessionAipm.toLocaleString()} |\n` +
      `| Peak AIPM | ${metrics.peakAipm.toLocaleString()} |\n` +
      `| Active Agents | ${metrics.concurrency} (peak: ${metrics.peakConcurrency}) |\n` +
      `| AIPM per Agent | ${metrics.aipmPerAgent.toLocaleString()} |\n` +
      `| Session Tokens | ${metrics.sessionTokens.toLocaleString()} |\n` +
      `| Prompts | ${metrics.sessionPrompts} |\n` +
      `| Tool Calls | ${metrics.sessionToolCalls} |\n` +
      `| Duration | ${metrics.sessionDuration} |\n` +
      `| Platforms | ${metrics.activePlatforms.join(', ') || 'none'} |\n\n` +
      `*Click to open dashboard*`
    );
    tooltip.isTrusted = true;
    this.item.tooltip = tooltip;
  }

  dispose(): void {
    this.item.dispose();
  }
}
