import * as vscode from 'vscode';
import * as crypto from 'crypto';

export interface SemanticEntry {
  path: string;
  contentHash: string;
  language: string;
  summary: string;         // LLM-generated 1-sentence description
  purpose: string;         // what this file/chunk does
  dependencies: string[];  // import paths
  exports: string[];       // exported symbols
  complexity: 'low' | 'medium' | 'high';
  lastIndexed: string;     // ISO timestamp
}

export class SemanticCache {
  private static readonly KEY = 'ai-readiness.semanticCache';
  private static readonly VECTOR_STORE_KEY = 'ai-readiness.vectorStoreData';
  private entries = new Map<string, SemanticEntry>();
  private disposables: vscode.Disposable[] = [];
  private pendingInvalidations = new Map<string, NodeJS.Timeout>();

  constructor(private context: vscode.ExtensionContext) {
    // Load persisted cache
    const saved = context.workspaceState.get<Record<string, SemanticEntry>>(this.cacheKey());
    if (saved) {
      for (const [k, v] of Object.entries(saved)) {
        this.entries.set(k, v);
      }
    }

    // Set up file watchers for reactive invalidation
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.scheme === 'file') {
          this.invalidate(vscode.workspace.asRelativePath(e.document.uri));
        }
      }),
      vscode.workspace.onDidCreateFiles(e => {
        for (const uri of e.files) {
          this.invalidate(vscode.workspace.asRelativePath(uri));
        }
      }),
      vscode.workspace.onDidDeleteFiles(e => {
        for (const uri of e.files) {
          this.remove(vscode.workspace.asRelativePath(uri));
        }
      }),
      vscode.workspace.onDidRenameFiles(e => {
        for (const { oldUri, newUri } of e.files) {
          this.remove(vscode.workspace.asRelativePath(oldUri));
          this.invalidate(vscode.workspace.asRelativePath(newUri));
        }
      })
    );
  }

  private cacheKey(): string {
    const ws = vscode.workspace.workspaceFolders?.[0]?.name ?? 'default';
    return `${SemanticCache.KEY}.${ws}`;
  }

  /** Get cached entry if content hasn't changed */
  get(path: string, currentContent?: string): SemanticEntry | undefined {
    const entry = this.entries.get(path);
    if (!entry) return undefined;
    
    // If content provided, verify hash still matches
    if (currentContent) {
      const hash = this.hash(currentContent);
      if (hash !== entry.contentHash) {
        this.entries.delete(path);
        return undefined;
      }
    }
    return entry;
  }

  /** Store a semantic entry */
  set(path: string, content: string, entry: Omit<SemanticEntry, 'path' | 'contentHash' | 'lastIndexed'>): void {
    this.entries.set(path, {
      ...entry,
      path,
      contentHash: this.hash(content),
      lastIndexed: new Date().toISOString(),
    });
    // Persist asynchronously
    this.persist();
  }

  /** Check if a file needs re-indexing */
  needsReindex(path: string, currentContent: string): boolean {
    const entry = this.entries.get(path);
    if (!entry) return true;
    return entry.contentHash !== this.hash(currentContent);
  }

  /** Get all cached entries */
  getAll(): SemanticEntry[] {
    return [...this.entries.values()];
  }

  /** Get entries for a specific directory */
  getForDirectory(dirPath: string): SemanticEntry[] {
    return [...this.entries.values()].filter(e => e.path.startsWith(dirPath));
  }

  /** Get stats about the cache */
  getStats(): { total: number; languages: Record<string, number>; lastUpdate: string | null } {
    const languages: Record<string, number> = {};
    let lastUpdate: string | null = null;
    
    for (const entry of this.entries.values()) {
      languages[entry.language] = (languages[entry.language] || 0) + 1;
      if (!lastUpdate || entry.lastIndexed > lastUpdate) {
        lastUpdate = entry.lastIndexed;
      }
    }
    
    return { total: this.entries.size, languages, lastUpdate };
  }

  /** Debounce invalidation to coalesce rapid file changes */
  private scheduleInvalidation(path: string): void {
    const existing = this.pendingInvalidations.get(path);
    if (existing) clearTimeout(existing);
    this.pendingInvalidations.set(path, setTimeout(() => {
      this.entries.delete(path);
      this.pendingInvalidations.delete(path);
      this.persist();
    }, 500));
  }

  /** Invalidate a specific file (mark for re-indexing) */
  private invalidate(path: string): void {
    this.scheduleInvalidation(path);
  }

  /** Remove a file from cache entirely */
  private remove(path: string): void {
    this.entries.delete(path);
    this.persist();
  }

  /** Clear entire cache */
  async clear(): Promise<void> {
    this.entries.clear();
    await this.context.workspaceState.update(this.cacheKey(), {});
  }

  private hash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  private async persist(): Promise<void> {
    const obj: Record<string, SemanticEntry> = {};
    for (const [k, v] of this.entries) {
      obj[k] = v;
    }
    await this.context.workspaceState.update(this.cacheKey(), obj);
  }

  /** Get serialized vector store data from workspaceState */
  getVectorStoreData(): string | undefined {
    return this.context.workspaceState.get<string>(this.vectorStoreKey());
  }

  /** Persist serialized vector store data to workspaceState */
  setVectorStoreData(data: string): void {
    this.context.workspaceState.update(this.vectorStoreKey(), data);
  }

  private vectorStoreKey(): string {
    const ws = vscode.workspace.workspaceFolders?.[0]?.name ?? 'default';
    return `${SemanticCache.VECTOR_STORE_KEY}.${ws}`;
  }

  dispose(): void {
    for (const timeout of this.pendingInvalidations.values()) clearTimeout(timeout);
    this.pendingInvalidations.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
