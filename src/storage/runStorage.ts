import * as vscode from 'vscode';
import { ReadinessReport, AI_TOOLS, AITool } from '../scoring/types';

export interface ScanRun {
  id: string;
  timestamp: string;
  tool: string;
  toolName: string;
  toolIcon: string;
  level: number;
  levelName: string;
  depth: number;
  overallScore: number;
  componentCount: number;       // filtered count (excludes test projects)
  totalComponentCount: number;  // unfiltered count (all components including tests)
  projectName: string;
  report: ReadinessReport;
}

export class RunStorage {
  private static readonly KEY = 'ai-readiness.runs';
  private static readonly MAX_RUNS = 20;

  constructor(private context: vscode.ExtensionContext) {}

  async saveRun(report: ReadinessReport): Promise<ScanRun> {
    const meta = AI_TOOLS[report.selectedTool as AITool];
    const run: ScanRun = {
      id: this.generateId(),
      timestamp: report.scannedAt,
      tool: report.selectedTool,
      toolName: meta?.name ?? report.selectedTool,
      toolIcon: meta?.icon ?? '🔧',
      level: report.primaryLevel,
      levelName: report.levelName,
      depth: report.depth,
      overallScore: report.overallScore,
      componentCount: report.componentScores.filter(c => {
        const n = c.name.toLowerCase();
        return !n.endsWith('.tests') && !n.endsWith('.test') && !n.startsWith('testfx') && !n.includes('testutils');
      }).length,
      totalComponentCount: report.componentScores.length,
      projectName: report.projectName,
      report,
    };

    const runs = this.getRuns();
    runs.unshift(run);
    if (runs.length > RunStorage.MAX_RUNS) {
      runs.length = RunStorage.MAX_RUNS;
    }
    await this.context.workspaceState.update(RunStorage.KEY, runs);
    return run;
  }

  getRuns(): ScanRun[] {
    return this.context.workspaceState.get<ScanRun[]>(RunStorage.KEY) || [];
  }

  getRun(id: string): ScanRun | undefined {
    return this.getRuns().find(r => r.id === id);
  }

  getLatestRun(): ScanRun | undefined {
    const runs = this.getRuns();
    return runs.length > 0 ? runs[0] : undefined;
  }

  async deleteRun(id: string): Promise<void> {
    const runs = this.getRuns().filter(r => r.id !== id);
    await this.context.workspaceState.update(RunStorage.KEY, runs);
  }

  async updateLatestReport(report: ReadinessReport): Promise<void> {
    const runs = this.getRuns();
    if (runs.length > 0) {
      runs[0].report = report;
      await this.context.workspaceState.update(RunStorage.KEY, runs);
    }
  }

  async clearAll(): Promise<void> {
    await this.context.workspaceState.update(RunStorage.KEY, []);
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
