import * as vscode from 'vscode';
import * as crypto from 'crypto';

export interface PersistedFix {
  signalId: string;
  files: { path: string; contentHash: string }[];
  timestamp: string;
  status: 'pending-review' | 'approved' | 'declined';
  workspace: string;
}

export type FileCheckResult = 'unchanged' | 'modified' | 'deleted';

export class FixStorage {
  private static readonly KEY = 'ai-readiness.appliedFixes';

  constructor(private context: vscode.ExtensionContext) {}

  static hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  getFixes(workspace?: string): PersistedFix[] {
    const all = this.context.globalState.get<PersistedFix[]>(FixStorage.KEY, []);
    if (!workspace) return all;
    return all.filter(f => f.workspace === workspace);
  }

  getFix(signalId: string, workspace: string): PersistedFix | undefined {
    return this.getFixes().find(f => f.signalId === signalId && f.workspace === workspace);
  }

  async saveFix(fix: PersistedFix): Promise<void> {
    const all = this.getFixes();
    const idx = all.findIndex(f => f.signalId === fix.signalId && f.workspace === fix.workspace);
    if (idx >= 0) {
      all[idx] = fix;
    } else {
      all.push(fix);
    }
    await this.context.globalState.update(FixStorage.KEY, all);
  }

  async updateStatus(signalId: string, workspace: string, status: PersistedFix['status']): Promise<void> {
    const all = this.getFixes();
    const fix = all.find(f => f.signalId === signalId && f.workspace === workspace);
    if (fix) {
      fix.status = status;
      await this.context.globalState.update(FixStorage.KEY, all);
    }
  }

  async removeFix(signalId: string, workspace: string): Promise<void> {
    const all = this.getFixes().filter(f => !(f.signalId === signalId && f.workspace === workspace));
    await this.context.globalState.update(FixStorage.KEY, all);
  }

  async clearAll(): Promise<void> {
    await this.context.globalState.update(FixStorage.KEY, []);
  }

  async checkFileStatus(
    fix: PersistedFix,
    workspaceUri: vscode.Uri
  ): Promise<Map<string, FileCheckResult>> {
    const results = new Map<string, FileCheckResult>();
    for (const file of fix.files) {
      const fileUri = vscode.Uri.joinPath(workspaceUri, file.path);
      try {
        const content = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf-8');
        const currentHash = FixStorage.hashContent(content);
        results.set(file.path, currentHash === file.contentHash ? 'unchanged' : 'modified');
      } catch {
        results.set(file.path, 'deleted');
      }
    }
    return results;
  }
}
