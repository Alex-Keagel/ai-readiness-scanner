import * as vscode from 'vscode';
import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';
import { CallGraphResult } from '../semantic/callGraph';
import { DataFlowResult } from '../semantic/dataFlow';
import { validatedAnalyzeFast } from '../llm/validatedCall';

// ─── Types ──────────────────────────────────────────────────────

export interface ComponentComplexity {
  path: string;
  factor: number; // 0.0 - 1.0
  isProduct: boolean;
  domainClassification: string;
  securitySensitive: boolean;
  reasons: string[];
  metrics: {
    lines: number;
    fanIn: number;
    callGraphCentrality: number;
    exportCount: number;
    pipelinePosition: 'source' | 'middle' | 'sink' | 'standalone';
  };
}

export interface TopologyNode {
  id: string;
  label: string;
  factor: number;
  isProduct: boolean;
  coverageScore: number; // 0-100 from component score
  role: string;
  x?: number;
  y?: number;
}

export interface TopologyEdge {
  from: string;
  to: string;
  type: 'import' | 'call' | 'type-hierarchy';
}

export interface ComplexityAnalysisResult {
  complexities: ComponentComplexity[];
  products: string[];
  topology: { nodes: TopologyNode[]; edges: TopologyEdge[] };
}

// ─── Cache ──────────────────────────────────────────────────────

const CACHE_KEY = 'ai-readiness.complexityCache';

interface CachedComplexity {
  hash: string;
  result: ComplexityAnalysisResult;
  timestamp: string;
}

function computeCacheHash(modules: { path: string; lines: number; exportCount: number }[]): string {
  const data = modules.map(m => `${m.path}:${m.lines}:${m.exportCount}`).sort().join('|');
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

// ─── Complexity Analyzer ────────────────────────────────────────

export class ComplexityAnalyzer {
  constructor(private copilotClient?: CopilotClient) {}

  async analyze(
    modules: { path: string; lines: number; exports: string[]; exportCount: number; importCount: number; fanIn: number; role: string; hasDocstring: boolean; complexity: string }[],
    callGraph: CallGraphResult,
    dataFlow: DataFlowResult,
    componentScores: { path: string; overallScore: number }[],
    context?: vscode.ExtensionContext,
    progress?: vscode.Progress<{ message?: string }>
  ): Promise<ComplexityAnalysisResult> {
    const timer = logger.time('ComplexityAnalyzer');

    // Check cache
    const cacheHash = computeCacheHash(modules);
    if (context) {
      const cached = context.globalState.get<CachedComplexity>(CACHE_KEY);
      if (cached && cached.hash === cacheHash) {
        logger.info(`ComplexityAnalyzer: cache hit (${cached.result.complexities.length} components)`);
        timer?.end?.();
        return cached.result;
      }
    }

    progress?.report({ message: '📊 Computing complexity factors...' });

    // Phase 1: Static metrics (deterministic)
    const complexities: ComponentComplexity[] = modules
      .filter(m => m.role !== 'test' && m.role !== 'type-def')
      .map(m => this.computeStaticFactor(m, callGraph, dataFlow));

    // Phase 2: Always-critical overrides
    for (const c of complexities) {
      if (c.securitySensitive) c.factor = Math.max(c.factor, 1.0);
      if (modules.find(m => m.path === c.path)?.role === 'entry-point') c.factor = Math.max(c.factor, 0.8);
      if (c.metrics.fanIn >= 5) c.factor = Math.max(c.factor, 0.7);
    }

    // Phase 3: LLM product detection + business logic analysis
    if (this.copilotClient?.isAvailable() && modules.length > 0) {
      progress?.report({ message: '🧠 Detecting core products...' });
      try {
        await this.detectProducts(complexities, modules, callGraph, dataFlow);
      } catch (err) {
        logger.debug('ComplexityAnalyzer: product detection failed', err);
      }
    }

    // Apply product override
    for (const c of complexities) {
      if (c.isProduct) c.factor = Math.max(c.factor, 0.85);
    }

    // Clamp all factors
    for (const c of complexities) {
      c.factor = Math.max(0, Math.min(1, c.factor));
    }

    const products = complexities.filter(c => c.isProduct).map(c => c.path);

    // Build topology metadata
    const scoreMap = new Map(componentScores.map(c => [c.path, c.overallScore]));
    const topology = this.buildTopology(complexities, callGraph, scoreMap);

    const result: ComplexityAnalysisResult = { complexities, products, topology };

    // Cache result
    if (context) {
      await context.globalState.update(CACHE_KEY, {
        hash: cacheHash,
        result,
        timestamp: new Date().toISOString(),
      } satisfies CachedComplexity);
    }

    logger.info(`ComplexityAnalyzer: ${complexities.length} components, ${products.length} products, factors ${complexities.map(c => c.factor.toFixed(2)).join(', ')}`);
    timer?.end?.();
    return result;
  }

  // ─── Static Factor Computation ────────────────────────────────

  private computeStaticFactor(
    mod: { path: string; lines: number; exports: string[]; exportCount: number; importCount: number; fanIn: number; role: string; hasDocstring: boolean; complexity: string },
    callGraph: CallGraphResult,
    dataFlow: DataFlowResult
  ): ComponentComplexity {
    // Count call graph centrality (incoming + outgoing call edges)
    const incomingCalls = callGraph.edges.filter(e => e.to.path === mod.path).length;
    const outgoingCalls = callGraph.edges.filter(e => e.from.path === mod.path).length;
    const centrality = incomingCalls + outgoingCalls;

    // Pipeline position
    let pipelinePosition: ComponentComplexity['metrics']['pipelinePosition'] = 'standalone';
    for (const pipeline of dataFlow.pipelines) {
      if (pipeline.modules.includes(mod.path)) {
        const idx = pipeline.modules.indexOf(mod.path);
        if (idx === 0) pipelinePosition = 'source';
        else if (idx === pipeline.modules.length - 1) pipelinePosition = 'sink';
        else pipelinePosition = 'middle';
        break;
      }
    }

    // Role weight
    const roleWeights: Record<string, number> = {
      'entry-point': 1.0, 'core-logic': 0.8, 'ui': 0.6,
      'utility': 0.4, 'config': 0.2, 'unknown': 0.5,
    };
    const roleWeight = roleWeights[mod.role] ?? 0.5;

    // Cyclomatic heuristic (not real cyclomatic — just branching keyword count)
    // We don't have content here, so use line count as proxy
    const cyclomaticProxy = Math.min(1, mod.lines / 500);

    // Static factor formula
    const factor =
      0.25 * Math.min(1, mod.lines / 500) +       // Size
      0.25 * Math.min(1, mod.fanIn / 5) +          // Import fan-in
      0.15 * Math.min(1, mod.exportCount / 10) +    // API surface
      0.15 * Math.min(1, centrality / 10) +         // Call graph centrality
      0.10 * roleWeight +                           // Role
      0.10 * (pipelinePosition !== 'standalone' ? 0.8 : 0); // Pipeline involvement

    // Security detection from path patterns
    const pathLower = mod.path.toLowerCase();
    const securitySensitive = /auth|crypto|secret|password|credential|token|permission|security|oauth|jwt/.test(pathLower);

    return {
      path: mod.path,
      factor: Math.round(factor * 100) / 100,
      isProduct: false, // determined by LLM in Phase 3
      domainClassification: 'unknown',
      securitySensitive,
      reasons: this.buildReasons(mod, centrality, pipelinePosition, securitySensitive),
      metrics: {
        lines: mod.lines,
        fanIn: mod.fanIn,
        callGraphCentrality: centrality,
        exportCount: mod.exportCount,
        pipelinePosition,
      },
    };
  }

  private buildReasons(
    mod: { lines: number; fanIn: number; exportCount: number; role: string },
    centrality: number,
    pipelinePosition: string,
    securitySensitive: boolean
  ): string[] {
    const reasons: string[] = [];
    if (mod.lines > 500) reasons.push(`${mod.lines} lines (high complexity)`);
    if (mod.fanIn >= 5) reasons.push(`${mod.fanIn} dependents (hub module)`);
    if (mod.exportCount >= 10) reasons.push(`${mod.exportCount} exports (large API surface)`);
    if (centrality >= 8) reasons.push(`${centrality} call graph connections (central node)`);
    if (pipelinePosition !== 'standalone') reasons.push(`Pipeline ${pipelinePosition}`);
    if (securitySensitive) reasons.push('Security-sensitive code');
    if (mod.role === 'entry-point') reasons.push('Entry point');
    return reasons;
  }

  // ─── LLM Product Detection ───────────────────────────────────

  private async detectProducts(
    complexities: ComponentComplexity[],
    modules: { path: string; lines: number; exports: string[]; role: string }[],
    callGraph: CallGraphResult,
    dataFlow: DataFlowResult
  ): Promise<void> {
    const moduleList = modules
      .filter(m => m.role !== 'test' && m.role !== 'type-def' && m.role !== 'config')
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 30)
      .map(m => `${m.path} (${m.role}, ${m.lines}L, ${m.exports.length} exports)`)
      .join('\n');

    const pipelineList = dataFlow.pipelines
      .map(p => `${p.name}: ${p.modules.join(' → ')}`)
      .join('\n');

    const conceptList = dataFlow.concepts
      .map(c => `${c.name}: ${c.description} (${c.complexity})`)
      .join('\n');

    const prompt = `Analyze this codebase and identify ALL core products — the main deliverables this repository exists to create. There is NO limit on product count.

A "product" is a component that delivers value to end users or consumers. NOT build tools, NOT shared utilities, NOT test infrastructure.

MODULES:
${moduleList}

DATA PIPELINES:
${pipelineList || 'None detected'}

DOMAIN CONCEPTS:
${conceptList || 'None detected'}

For each module, classify as:
- "product": core deliverable (app, service, pipeline, extension, CLI tool)
- "support": shared library, utility, infrastructure, build tool
- "peripheral": config, docs, scripts, data

Also rate business logic density (0-100) and identify the domain.

Respond ONLY as JSON:
[{"path":"module path","classification":"product|support|peripheral","businessLogicDensity":0-100,"domain":"description"}]`;

    const validated = await validatedAnalyzeFast(
      this.copilotClient!,
      prompt,
      { tier: 'critical', agentName: 'business-logic-analyst' }
    );

    const match = validated.result.match(/\[[\s\S]*\]/);
    if (!match) return;

    try {
      const parsed = JSON.parse(match[0]) as { path: string; classification: string; businessLogicDensity: number; domain: string }[];
      for (const p of parsed) {
        const comp = complexities.find(c => c.path === p.path || p.path.includes(c.path) || c.path.includes(p.path));
        if (comp) {
          comp.isProduct = p.classification === 'product';
          comp.domainClassification = p.domain || 'unknown';
          // Blend business logic density into factor
          const densityBonus = (p.businessLogicDensity || 0) / 100 * 0.2;
          comp.factor = Math.min(1, comp.factor + densityBonus);
          if (comp.isProduct) comp.reasons.push(`Product: ${p.domain}`);
        }
      }
    } catch { /* parse failed */ }
  }

  // ─── Topology Builder ─────────────────────────────────────────

  private buildTopology(
    complexities: ComponentComplexity[],
    callGraph: CallGraphResult,
    scoreMap: Map<string, number>
  ): { nodes: TopologyNode[]; edges: TopologyEdge[] } {
    const nodes: TopologyNode[] = complexities.map(c => ({
      id: c.path,
      label: c.path.split('/').pop()?.replace(/\.[^.]+$/, '') || c.path,
      factor: c.factor,
      isProduct: c.isProduct,
      coverageScore: scoreMap.get(c.path) || 0,
      role: c.domainClassification,
    }));

    const nodeIds = new Set(nodes.map(n => n.id));
    const edges: TopologyEdge[] = [];

    // Add call graph edges (only between known nodes)
    for (const edge of callGraph.edges) {
      if (nodeIds.has(edge.from.path) && nodeIds.has(edge.to.path) && edge.from.path !== edge.to.path) {
        edges.push({ from: edge.from.path, to: edge.to.path, type: 'call' });
      }
    }

    // Add type hierarchy edges
    for (const te of callGraph.typeEdges) {
      const childNode = nodes.find(n => n.id === te.path);
      const parentNode = complexities.find(c => c.path !== te.path && callGraph.typeNodes.some(t => t.path === c.path && t.name === te.parent));
      if (childNode && parentNode && nodeIds.has(parentNode.path)) {
        edges.push({ from: te.path, to: parentNode.path, type: 'type-hierarchy' });
      }
    }

    // Deduplicate edges
    const seen = new Set<string>();
    const uniqueEdges = edges.filter(e => {
      const key = `${e.from}->${e.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { nodes, edges: uniqueEdges };
  }
}
