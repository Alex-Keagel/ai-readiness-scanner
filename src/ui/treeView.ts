import * as vscode from 'vscode';
import {
ReadinessReport
} from '../scoring/types';
import { RunStorage,ScanRun } from '../storage/runStorage';

type NodeType = 'scan-history' | 'repo-group' | 'platform-group' | 'date-group';

export class ReadinessTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private runStorage?: RunStorage) {}

  update(_report: ReadinessReport): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!element) {
      return this.buildRootItems();
    }

    switch (element.nodeType) {
      case 'scan-history':
        return this.buildRepoGroups();
      case 'repo-group':
        return this.buildPlatformGroups(element.groupKey!);
      case 'platform-group':
        return this.buildDateGroups(element.groupKey!, element.parentGroupKey!);
      case 'date-group':
        return this.buildRunItems(element.runs!);
      default:
        return [];
    }
  }

  private buildRootItems(): TreeItem[] {
    const items: TreeItem[] = [];

    // Single quick action
    const scanItem = new TreeItem('Scan Repository', vscode.TreeItemCollapsibleState.None);
    scanItem.command = { command: 'ai-readiness.fullScan', title: 'Scan' };
    scanItem.iconPath = new vscode.ThemeIcon('search');
    scanItem.description = 'Evaluate your repo';
    items.push(scanItem);

    // Scan History
    const runs = this.runStorage?.getRuns() || [];
    if (runs.length > 0) {
      const repoCount = new Set(runs.map(r => r.projectName)).size;
      const historyItem = new TreeItem(
        `Scan History`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      historyItem.nodeType = 'scan-history';
      historyItem.iconPath = new vscode.ThemeIcon('history');
      historyItem.description = `${runs.length} scans · ${repoCount} repo${repoCount > 1 ? 's' : ''}`;
      items.push(historyItem);
    }

    return items;
  }

  // ── Level 1: Group by repository ──
  private buildRepoGroups(): TreeItem[] {
    const runs = this.runStorage?.getRuns() || [];
    const byRepo = new Map<string, ScanRun[]>();
    for (const run of runs) {
      const key = run.projectName;
      if (!byRepo.has(key)) byRepo.set(key, []);
      byRepo.get(key)!.push(run);
    }

    return [...byRepo.entries()].map(([repoName, repoRuns]) => {
      const platformCount = new Set(repoRuns.map(r => r.tool)).size;
      const latest = repoRuns[0];
      const item = new TreeItem(
        `📂 ${repoName}`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.description = `${repoRuns.length} scan${repoRuns.length > 1 ? 's' : ''} · ${platformCount} platform${platformCount > 1 ? 's' : ''}`;
      item.nodeType = 'repo-group';
      item.groupKey = repoName;
      item.iconPath = new vscode.ThemeIcon('repo');
      item.tooltip = new vscode.MarkdownString(
        `**${repoName}**\n\n` +
        `Latest: L${latest.level} ${latest.levelName} (${latest.depth}%) — ${latest.toolName}\n\n` +
        `${repoRuns.length} scans across ${platformCount} platform(s)`
      );
      return item;
    });
  }

  // ── Level 2: Group by AI platform within a repo ──
  private buildPlatformGroups(repoName: string): TreeItem[] {
    const runs = this.runStorage?.getRuns() || [];
    const repoRuns = runs.filter(r => r.projectName === repoName);
    const byPlatform = new Map<string, ScanRun[]>();
    for (const run of repoRuns) {
      const key = run.tool;
      if (!byPlatform.has(key)) byPlatform.set(key, []);
      byPlatform.get(key)!.push(run);
    }

    return [...byPlatform.entries()].map(([tool, platformRuns]) => {
      const latest = platformRuns[0];
      const item = new TreeItem(
        `${latest.toolIcon} ${latest.toolName}`,
        platformRuns.length > 3 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded
      );
      item.description = `L${latest.level} ${latest.levelName} · ${platformRuns.length} scan${platformRuns.length > 1 ? 's' : ''}`;
      item.nodeType = 'platform-group';
      item.groupKey = tool;
      item.parentGroupKey = repoName;
      item.iconPath = new vscode.ThemeIcon(
        latest.level >= 4 ? 'star-full' : latest.level >= 2 ? 'star-half' : 'star-empty'
      );
      item.tooltip = new vscode.MarkdownString(
        `**${latest.toolName}** on ${repoName}\n\n` +
        `Latest: L${latest.level} ${latest.levelName} | Depth: ${latest.depth}% | Score: ${latest.overallScore}/100\n\n` +
        `${platformRuns.length} scan(s)`
      );
      return item;
    });
  }

  // ── Level 3: Group by date within a platform ──
  private buildDateGroups(tool: string, repoName: string): TreeItem[] {
    const runs = this.runStorage?.getRuns() || [];
    const filtered = runs.filter(r => r.projectName === repoName && r.tool === tool);

    const byDate = new Map<string, ScanRun[]>();
    for (const run of filtered) {
      const dateKey = new Date(run.timestamp).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
      });
      if (!byDate.has(dateKey)) byDate.set(dateKey, []);
      byDate.get(dateKey)!.push(run);
    }

    // If only 1 date, skip the date grouping — show runs directly
    if (byDate.size === 1) {
      const allRuns = [...byDate.values()][0];
      return this.buildRunItems(allRuns);
    }

    return [...byDate.entries()].map(([dateStr, dateRuns]) => {
      const item = new TreeItem(
        `📅 ${dateStr}`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.description = `${dateRuns.length} scan${dateRuns.length > 1 ? 's' : ''}`;
      item.nodeType = 'date-group';
      item.runs = dateRuns;
      item.iconPath = new vscode.ThemeIcon('calendar');
      return item;
    });
  }

  // ── Leaf level: individual scan runs ──
  private buildRunItems(runs: ScanRun[]): TreeItem[] {
    return runs.map(run => {
      const timeStr = new Date(run.timestamp).toLocaleString(undefined, {
        hour: '2-digit', minute: '2-digit',
      });
      const item = new TreeItem(
        `L${run.level} ${run.levelName} (${run.depth}%)`,
        vscode.TreeItemCollapsibleState.None
      );
      item.description = `${run.overallScore}/100 · ${timeStr}`;
      item.tooltip = new vscode.MarkdownString(
        `**${run.projectName}** — ${run.toolName}\n\n` +
        `Level ${run.level}: ${run.levelName} | Depth: ${run.depth}% | Score: ${run.overallScore}/100\n\n` +
        `${run.componentCount} components | ${new Date(run.timestamp).toLocaleString()}`
      );
      item.command = {
        command: 'ai-readiness.openRun',
        title: 'Open Run',
        arguments: [run.id],
      };
      item.iconPath = new vscode.ThemeIcon(
        run.level >= 4 ? 'star-full' : run.level >= 2 ? 'star-half' : 'star-empty'
      );
      item.contextValue = 'scan-run';
      return item;
    });
  }


}

class TreeItem extends vscode.TreeItem {
  nodeType?: NodeType;
  groupKey?: string;
  parentGroupKey?: string;
  runs?: ScanRun[];
}
