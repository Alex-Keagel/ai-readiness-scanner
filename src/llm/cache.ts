import * as vscode from 'vscode';
import * as crypto from 'crypto';

export interface CachedResult {
  result: 'pass' | 'fail' | 'skip';
  finding: string;
  confidence: 'high' | 'medium' | 'low';
  cachedAt: string;
  cachedAtMs?: number;
}

const CACHE_KEY_PREFIX = 'cache:';
function getCacheTTLMs(): number {
  try {
    const days = vscode.workspace.getConfiguration('ai-readiness').get<number>('cacheTTL') ?? 1;
    return days * 24 * 60 * 60 * 1000;
  } catch { return 7 * 24 * 60 * 60 * 1000; }
}

export class LLMCache {
  constructor(private context: vscode.ExtensionContext) {}

  private hashContent(contents: string[]): string {
    const joined = contents.join('');
    return crypto.createHash('sha256').update(joined).digest('hex');
  }

  get(signalId: string, fileContents: string[]): CachedResult | undefined {
    const hash = this.hashContent(fileContents);
    const key = `${CACHE_KEY_PREFIX}${signalId}:${hash}`;
    const entry = this.context.workspaceState.get<CachedResult>(key);
    if (!entry) { return undefined; }
    // Treat entries without cachedAtMs or older than TTL as expired
    if (!entry.cachedAtMs || Date.now() - entry.cachedAtMs > getCacheTTLMs()) {
      this.context.workspaceState.update(key, undefined);
      return undefined;
    }
    return entry;
  }

  set(signalId: string, fileContents: string[], result: CachedResult): void {
    const hash = this.hashContent(fileContents);
    const key = `${CACHE_KEY_PREFIX}${signalId}:${hash}`;
    this.context.workspaceState.update(key, { ...result, cachedAtMs: Date.now() });
  }

  clear(): void {
    const keys = this.context.workspaceState.keys();
    for (const key of keys) {
      if (key.startsWith(CACHE_KEY_PREFIX)) {
        this.context.workspaceState.update(key, undefined);
      }
    }
  }
}
