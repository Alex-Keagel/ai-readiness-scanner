import * as vscode from 'vscode';
import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';
import { SemanticCache } from './cache';

// ─── Types ──────────────────────────────────────────────────────

export interface CallGraphNode {
  path: string;
  name: string; // function/class name
  type: 'function' | 'class' | 'method';
  line: number;
  exported: boolean;
}

export interface CallGraphEdge {
  from: { path: string; name: string };
  to: { path: string; name: string };
  callType: 'direct' | 'callback' | 'event' | 'dynamic';
}

export interface TypeNode {
  path: string;
  name: string;
  kind: 'class' | 'interface' | 'type' | 'enum';
}

export interface TypeEdge {
  child: string; // TypeNode name
  parent: string; // TypeNode name
  relation: 'extends' | 'implements';
  path: string;
}

export interface CallGraphResult {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
  typeNodes: TypeNode[];
  typeEdges: TypeEdge[];
}

// ─── Call Graph Extractor ───────────────────────────────────────

export class CallGraphExtractor {
  constructor(
    private copilotClient?: CopilotClient,
    _cache?: SemanticCache
  ) {}

  /**
   * Extract call graph + type hierarchy from source files.
   * Uses regex for direct calls + LLM for complex patterns.
   */
  async extract(
    workspaceUri: vscode.Uri,
    modules: { path: string; content?: string; exports: string[]; role: string }[],
    importGraph: Map<string, string[]>,
    progress?: vscode.Progress<{ message?: string }>
  ): Promise<CallGraphResult> {
    const timer = logger.time('CallGraphExtractor');
    const nodes: CallGraphNode[] = [];
    const edges: CallGraphEdge[] = [];
    const typeNodes: TypeNode[] = [];
    const typeEdges: TypeEdge[] = [];

    progress?.report({ message: '🔗 Extracting call graph...' });

    // Phase 1: Regex-based extraction (deterministic)
    for (const mod of modules) {
      if (mod.role === 'test' || mod.role === 'type-def' || mod.role === 'config') continue;
      const content = mod.content || await this.readFile(workspaceUri, mod.path);
      if (!content) continue;

      // Extract function/class declarations as nodes
      const declNodes = this.extractDeclarations(mod.path, content);
      nodes.push(...declNodes);

      // Extract type hierarchy (extends/implements)
      const { types, hierarchy } = this.extractTypeHierarchy(mod.path, content);
      typeNodes.push(...types);
      typeEdges.push(...hierarchy);

      // Extract direct function calls within this file
      const localEdges = this.extractDirectCalls(mod.path, content, declNodes, modules);
      edges.push(...localEdges);
    }

    // Phase 2: Cross-module call detection via import graph
    for (const [filePath, imports] of importGraph) {
      const mod = modules.find(m => m.path === filePath);
      if (!mod) continue;
      const content = mod.content || await this.readFile(workspaceUri, mod.path);
      if (!content) continue;

      for (const imp of imports) {
        // Find which imported symbols are actually called
        const targetMod = modules.find(m =>
          m.path.includes(imp.replace(/^[.\/]+/, '').replace(/\.[^.]+$/, ''))
        );
        if (!targetMod) continue;

        for (const exportedName of targetMod.exports) {
          // Check if this exported function is called in the importing file
          const callPattern = new RegExp(`\\b${exportedName}\\s*\\(`, 'g');
          if (callPattern.test(content)) {
            edges.push({
              from: { path: filePath, name: '(module)' },
              to: { path: targetMod.path, name: exportedName },
              callType: 'direct',
            });
          }
        }
      }
    }

    // Phase 3: LLM enrichment for complex call patterns (top 10 hotspot files)
    if (this.copilotClient?.isAvailable() && nodes.length > 0) {
      try {
        const hotspots = modules
          .filter(m => m.role === 'core-logic' || m.role === 'entry-point')
          .sort((a, b) => b.exports.length - a.exports.length)
          .slice(0, 10);

        if (hotspots.length > 0) {
          progress?.report({ message: '🧠 LLM analyzing call patterns...' });
          const llmEdges = await this.llmCallAnalysis(hotspots, workspaceUri);
          edges.push(...llmEdges);
        }
      } catch (err) {
        logger.debug('CallGraphExtractor: LLM analysis failed', err);
      }
    }

    // Deduplicate edges
    const edgeKeys = new Set<string>();
    const uniqueEdges = edges.filter(e => {
      const key = `${e.from.path}:${e.from.name}->${e.to.path}:${e.to.name}`;
      if (edgeKeys.has(key)) return false;
      edgeKeys.add(key);
      return true;
    });

    logger.info(`CallGraph: ${nodes.length} nodes, ${uniqueEdges.length} edges, ${typeNodes.length} types, ${typeEdges.length} hierarchy edges`);
    timer?.end?.();

    return { nodes, edges: uniqueEdges, typeNodes, typeEdges };
  }

  // ─── Regex Extractors ─────────────────────────────────────────

  private extractDeclarations(path: string, content: string): CallGraphNode[] {
    const nodes: CallGraphNode[] = [];
    const patterns = [
      { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm, type: 'function' as const },
      { regex: /^(?:export\s+)?class\s+(\w+)/gm, type: 'class' as const },
      { regex: /(?:async\s+)?def\s+(\w+)\s*\(/gm, type: 'function' as const },
      { regex: /^class\s+(\w+)/gm, type: 'class' as const },
    ];

    for (const { regex, type } of patterns) {
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(content)) !== null) {
        const line = content.substring(0, m.index).split('\n').length;
        nodes.push({
          path,
          name: m[1],
          type,
          line,
          exported: m[0].includes('export') || !m[0].includes('_'), // Python: no underscore = public
        });
      }
    }

    return nodes;
  }

  private extractTypeHierarchy(path: string, content: string): { types: TypeNode[]; hierarchy: TypeEdge[] } {
    const types: TypeNode[] = [];
    const hierarchy: TypeEdge[] = [];

    // TypeScript/Java: class Foo extends Bar implements Baz
    const classPattern = /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/g;
    let m;
    while ((m = classPattern.exec(content)) !== null) {
      types.push({ path, name: m[1], kind: 'class' });
      if (m[2]) hierarchy.push({ child: m[1], parent: m[2], relation: 'extends', path });
      if (m[3]) {
        for (const iface of m[3].split(',').map(s => s.trim()).filter(Boolean)) {
          hierarchy.push({ child: m[1], parent: iface, relation: 'implements', path });
        }
      }
    }

    // TypeScript: interface Foo extends Bar
    const ifacePattern = /(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([\w,\s]+))?/g;
    while ((m = ifacePattern.exec(content)) !== null) {
      types.push({ path, name: m[1], kind: 'interface' });
      if (m[2]) {
        for (const parent of m[2].split(',').map(s => s.trim()).filter(Boolean)) {
          hierarchy.push({ child: m[1], parent, relation: 'extends', path });
        }
      }
    }

    // Python: class Foo(Bar, Baz)
    const pyClassPattern = /^class\s+(\w+)\(([^)]+)\)/gm;
    while ((m = pyClassPattern.exec(content)) !== null) {
      types.push({ path, name: m[1], kind: 'class' });
      for (const parent of m[2].split(',').map(s => s.trim()).filter(Boolean)) {
        if (parent !== 'object' && parent !== 'ABC' && parent !== 'metaclass') {
          hierarchy.push({ child: m[1], parent, relation: 'extends', path });
        }
      }
    }

    return { types, hierarchy };
  }

  private extractDirectCalls(
    path: string,
    content: string,
    localNodes: CallGraphNode[],
    _allModules: { path: string; exports: string[] }[]
  ): CallGraphEdge[] {
    const edges: CallGraphEdge[] = [];
    const localNames = new Set(localNodes.map(n => n.name));

    // For each function body, find calls to other local functions
    for (const node of localNodes) {
      if (node.type !== 'function') continue;
      // Get function body (rough: from declaration to next declaration or EOF)
      const startIdx = content.indexOf(node.name);
      if (startIdx < 0) continue;
      const bodyEnd = content.indexOf('\nfunction ', startIdx + 1);
      const body = content.substring(startIdx, bodyEnd > 0 ? bodyEnd : Math.min(startIdx + 2000, content.length));

      for (const otherName of localNames) {
        if (otherName === node.name) continue;
        if (new RegExp(`\\b${otherName}\\s*\\(`).test(body)) {
          edges.push({
            from: { path, name: node.name },
            to: { path, name: otherName },
            callType: 'direct',
          });
        }
      }
    }

    return edges;
  }

  // ─── LLM Analysis ────────────────────────────────────────────

  private async llmCallAnalysis(
    modules: { path: string; content?: string; exports: string[] }[],
    workspaceUri: vscode.Uri
  ): Promise<CallGraphEdge[]> {
    const summaries = [];
    for (const mod of modules) {
      const content = mod.content || await this.readFile(workspaceUri, mod.path);
      if (!content) continue;
      const preview = content.split('\n').slice(0, 60).join('\n');
      summaries.push(`FILE: ${mod.path}\nEXPORTS: ${mod.exports.join(', ')}\n${preview}`);
    }

    const prompt = `Analyze these code files and identify function call relationships that cross module boundaries.
For each call, specify: which function in which file calls which function in which other file.
Only report calls between the files shown — not to external packages.

${summaries.join('\n\n---\n\n')}

Respond ONLY as JSON:
[{"from_file":"path","from_func":"name","to_file":"path","to_func":"name","call_type":"direct|callback|event"}]`;

    const response = await this.copilotClient!.analyzeFast(prompt);
    const match = response.match(/\[[\s\S]*\]/);
    if (!match) return [];

    try {
      const parsed = JSON.parse(match[0]) as { from_file: string; from_func: string; to_file: string; to_func: string; call_type: string }[];
      return parsed.map(p => ({
        from: { path: p.from_file, name: p.from_func },
        to: { path: p.to_file, name: p.to_func },
        callType: (p.call_type || 'direct') as CallGraphEdge['callType'],
      }));
    } catch { return []; }
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private async readFile(workspaceUri: vscode.Uri, path: string): Promise<string | null> {
    try {
      const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspaceUri, path));
      return Buffer.from(content).toString('utf-8');
    } catch { return null; }
  }
}
