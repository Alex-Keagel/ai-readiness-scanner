import * as vscode from 'vscode';
import { SemanticCache, SemanticEntry } from './cache';
import { VectorStore, SearchResult } from './vectorStore';

/**
 * Exposes semantic graph data as VS Code commands that can be consumed
 * by MCP clients or other extensions.
 */
export class SemanticMCPProvider {
  constructor(
    private cache: SemanticCache,
    private vectorStore?: VectorStore,
  ) {}

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand('ai-readiness.mcp.searchCode', async (query: string) => {
        return this.searchCode(query);
      }),
      vscode.commands.registerCommand('ai-readiness.mcp.getComponent', async (path: string) => {
        return this.getComponent(path);
      }),
      vscode.commands.registerCommand('ai-readiness.mcp.getDependencies', async (path: string) => {
        return this.getDependencies(path);
      }),
      vscode.commands.registerCommand('ai-readiness.mcp.getGraph', async () => {
        return this.getGraph();
      })
    );
  }

  /** Search indexed code — uses TF-IDF vector search when available, falls back to substring */
  searchCode(query: string): (SearchResult | SemanticEntry)[] {
    if (this.vectorStore) {
      const results = this.vectorStore.search(query, 10);
      if (results.length > 0) return results;
    }
    // Fallback to substring matching on cache
    const queryLower = query.toLowerCase();
    return this.cache.getAll().filter(e =>
      e.summary.toLowerCase().includes(queryLower) ||
      e.purpose.toLowerCase().includes(queryLower) ||
      e.path.toLowerCase().includes(queryLower) ||
      e.exports.some(ex => ex.toLowerCase().includes(queryLower))
    );
  }

  /** Get semantic info for a specific file/component */
  getComponent(path: string): SemanticEntry | undefined {
    return this.cache.get(path);
  }

  /** Get dependencies for a file */
  getDependencies(path: string): { imports: string[]; importedBy: string[] } {
    const entry = this.cache.get(path);
    const imports = entry?.dependencies ?? [];

    // Find files that import this one
    const allEntries = this.cache.getAll();
    const importedBy = allEntries
      .filter(e => e.dependencies.some(d => d.includes(path.replace(/\.[^.]+$/, ''))))
      .map(e => e.path);

    return { imports, importedBy };
  }

  /** Get the full semantic graph */
  getGraph(): { nodes: SemanticEntry[]; edges: { from: string; to: string; type: string }[] } {
    const nodes = this.cache.getAll();
    const edges: { from: string; to: string; type: string }[] = [];

    for (const node of nodes) {
      for (const dep of node.dependencies) {
        // Try to resolve the dependency to an actual indexed file
        const target = nodes.find(n =>
          n.path.includes(dep.replace(/\./g, '/')) ||
          n.exports.some(e => dep.includes(e))
        );
        if (target) {
          edges.push({ from: node.path, to: target.path, type: 'imports' });
        }
      }
    }

    return { nodes, edges };
  }
}
