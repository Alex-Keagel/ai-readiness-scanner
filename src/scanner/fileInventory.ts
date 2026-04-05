import * as vscode from 'vscode';
import { FileContent } from '../scoring/types';
import { logger } from '../logging';

const EXCLUDE_PATTERN = '**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/vendor/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/target/**,**/.next/**,**/coverage/**,**/site-packages/**,**/.tox/**,**/env/**';

export async function collectFileContents(
  workspaceUri: vscode.Uri,
  patterns: string[],
  maxFiles: number = 10
): Promise<FileContent[]> {
  const files: FileContent[] = [];

  for (const pattern of patterns) {
    if (files.length >= maxFiles) { break; }

    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceUri, pattern),
      EXCLUDE_PATTERN,
      maxFiles - files.length
    );

    for (const uri of uris) {
      try {
        const raw = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(raw).toString('utf-8');
        const lines = content.split('\n');
        const truncated =
          lines.length > 500
            ? lines.slice(0, 500).join('\n') + '\n... (truncated)'
            : content;

        files.push({
          path: uri.fsPath,
          content: truncated,
          relativePath: vscode.workspace.asRelativePath(uri),
        });
      } catch (err) {
        logger.warn('Failed to read file during inventory collection', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return files;
}

export async function fileExists(
  workspaceUri: vscode.Uri,
  pattern: string
): Promise<boolean> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceUri, pattern),
    EXCLUDE_PATTERN,
    1
  );
  return uris.length > 0;
}

export async function countFiles(
  workspaceUri: vscode.Uri,
  pattern: string
): Promise<number> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceUri, pattern),
    EXCLUDE_PATTERN,
    1000
  );
  return uris.length;
}
