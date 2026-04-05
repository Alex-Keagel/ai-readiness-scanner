import * as vscode from 'vscode';
import { RemediationFix, FixFile } from '../scoring/types';
import { logger } from '../logging';

export class FixPreview {
  async previewFix(
    fix: RemediationFix,
    workspaceUri: vscode.Uri
  ): Promise<boolean> {
    for (const file of fix.files) {
      const shown = await this.showFileDiff(file, fix.signalId, workspaceUri);
      if (!shown) {
        return false;
      }
    }

    const choice = await vscode.window.showInformationMessage(
      `Apply fix for "${fix.signalId}"?\n${fix.explanation}`,
      { modal: true },
      'Apply',
      'Skip'
    );

    return choice === 'Apply';
  }

  private async showFileDiff(
    file: FixFile,
    signalId: string,
    workspaceUri: vscode.Uri
  ): Promise<boolean> {
    const originalContent = file.originalContent ?? '';
    const originalUri = vscode.Uri.parse(
      `untitled:${file.path} (original)`
    ).with({
      scheme: 'ai-readiness-original',
    });
    const modifiedUri = vscode.Uri.parse(
      `untitled:${file.path} (proposed)`
    ).with({
      scheme: 'ai-readiness-proposed',
    });

    // Register temporary content providers
    const originalProvider = new InMemoryContentProvider(originalContent);
    const modifiedProvider = new InMemoryContentProvider(file.content);

    const disposables = [
      vscode.workspace.registerTextDocumentContentProvider(
        'ai-readiness-original',
        originalProvider
      ),
      vscode.workspace.registerTextDocumentContentProvider(
        'ai-readiness-proposed',
        modifiedProvider
      ),
    ];

    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        modifiedUri,
        `${signalId}: ${file.path} (${file.action})`
      );
      return true;
    } catch (error) {
      logger.error(`[FixPreview] Failed to show diff for ${file.path}:`, error);
      return false;
    } finally {
      disposables.forEach((d) => d.dispose());
    }
  }

  async applyFixes(
    fixes: RemediationFix[],
    workspaceUri: vscode.Uri
  ): Promise<number> {
    let filesWritten = 0;

    for (const fix of fixes) {
      for (const file of fix.files) {
        try {
          const fileUri = vscode.Uri.joinPath(workspaceUri, file.path);

          // Ensure parent directory exists
          const dirUri = vscode.Uri.joinPath(
            fileUri,
            '..'
          );
          try {
            await vscode.workspace.fs.createDirectory(dirUri);
          } catch (err) {
            logger.warn('Failed to create directory for fix', { error: err instanceof Error ? err.message : String(err) });
          }

          const encoder = new TextEncoder();
          await vscode.workspace.fs.writeFile(
            fileUri,
            encoder.encode(file.content)
          );
          filesWritten++;
        } catch (error) {
          logger.error(
            `[FixPreview] Failed to write ${file.path}:`,
            error
          );
        }
      }
    }

    return filesWritten;
  }

  async batchPreview(
    fixes: RemediationFix[],
    workspaceUri: vscode.Uri
  ): Promise<void> {
    if (fixes.length === 0) {
      vscode.window.showInformationMessage('No fixes to apply.');
      return;
    }

    const items: (vscode.QuickPickItem & { fix: RemediationFix })[] = fixes.map(
      (fix) => ({
        label: fix.signalId,
        description: `[${fix.tier}] ${fix.files.length} file(s)`,
        detail: fix.explanation,
        picked: fix.tier === 'auto',
        fix,
      })
    );

    const selected = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: 'Select Fixes to Apply',
      placeHolder: `${fixes.length} fix(es) available — select which to apply`,
    });

    if (!selected || selected.length === 0) {
      return;
    }

    const selectedFixes = selected.map((item) => item.fix);

    const totalFiles = selectedFixes.reduce(
      (sum, f) => sum + f.files.length,
      0
    );
    const confirm = await vscode.window.showInformationMessage(
      `Apply ${selected.length} fix(es) (${totalFiles} file(s))?`,
      { modal: true },
      'Apply',
      'Cancel'
    );

    if (confirm !== 'Apply') {
      return;
    }

    const applied = await this.applyFixes(selectedFixes, workspaceUri);
    vscode.window.showInformationMessage(
      `Applied ${applied} file(s) across ${selected.length} fix(es).`
    );
  }
}

class InMemoryContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private content: string) {}

  provideTextDocumentContent(): string {
    return this.content;
  }
}
