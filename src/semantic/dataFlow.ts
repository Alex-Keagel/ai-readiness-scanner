import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';
import { CallGraphResult } from './callGraph';

// ─── Types ──────────────────────────────────────────────────────

export interface DataFlowSource {
  path: string;
  name: string;
  type: 'api-endpoint' | 'file-read' | 'database-query' | 'user-input' | 'event' | 'config' | 'external-service';
}

export interface DataFlowTransformation {
  path: string;
  name: string;
  inputType: string;
  outputType: string;
  description: string;
  order: number;
}

export interface DataFlowSink {
  path: string;
  name: string;
  type: 'api-response' | 'file-write' | 'database-write' | 'ui-render' | 'event-emit' | 'log' | 'external-service';
}

export interface DataPipeline {
  name: string;
  entryPoint: string;
  sources: DataFlowSource[];
  transformations: DataFlowTransformation[];
  sinks: DataFlowSink[];
  modules: string[]; // all files involved
}

export interface DataFlowResult {
  pipelines: DataPipeline[];
  concepts: DomainConcept[];
}

export interface DomainConcept {
  name: string;
  description: string;
  relatedModules: string[];
  complexity: 'simple' | 'moderate' | 'complex';
}

// ─── Data Flow Analyzer ─────────────────────────────────────────

export class DataFlowAnalyzer {
  constructor(private copilotClient?: CopilotClient) {}

  /**
   * Trace data flow through the codebase using call graph + LLM analysis.
   */
  async analyze(
    callGraph: CallGraphResult,
    modules: { path: string; exports: string[]; role: string; lines: number }[],
    entryPoints: string[]
  ): Promise<DataFlowResult> {
    const timer = logger.time('DataFlowAnalyzer');

    if (!this.copilotClient?.isAvailable()) {
      timer?.end?.();
      return { pipelines: this.inferPipelinesFromGraph(callGraph, entryPoints), concepts: [] };
    }

    // Build execution paths from entry points through the call graph
    const executionPaths = this.traceExecutionPaths(callGraph, entryPoints);

    // Ask LLM to identify pipelines and domain concepts
    const moduleList = modules
      .filter(m => m.role !== 'test' && m.role !== 'type-def')
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 25)
      .map(m => `${m.path} (${m.role}, ${m.lines}L, exports: ${m.exports.slice(0, 5).join(', ')})`)
      .join('\n');

    const pathSummary = executionPaths
      .slice(0, 10)
      .map(p => `${p.entry} → ${p.steps.join(' → ')}`)
      .join('\n');

    const edgeSummary = callGraph.edges
      .slice(0, 30)
      .map(e => `${e.from.path}:${e.from.name} → ${e.to.path}:${e.to.name}`)
      .join('\n');

    const prompt = `Analyze this codebase and identify:
1. Data pipelines — how data enters, transforms, and exits
2. Domain concepts — what business domains this code serves

MODULES:
${moduleList}

CALL GRAPH EDGES:
${edgeSummary}

EXECUTION PATHS FROM ENTRY POINTS:
${pathSummary}

Respond ONLY as JSON:
{
  "pipelines": [{
    "name": "pipeline name",
    "entryPoint": "file path",
    "sources": [{"name": "...", "type": "api-endpoint|file-read|database-query|user-input|event|config|external-service"}],
    "transformations": [{"name": "function name", "path": "file", "description": "what it does", "order": 1}],
    "sinks": [{"name": "...", "type": "api-response|file-write|database-write|ui-render|event-emit|log|external-service"}],
    "modules": ["file1", "file2"]
  }],
  "concepts": [{
    "name": "domain concept",
    "description": "what it represents",
    "relatedModules": ["file1"],
    "complexity": "simple|moderate|complex"
  }]
}`;

    try {
      const response = await this.copilotClient.analyze(prompt, undefined, 120_000);
      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as DataFlowResult;
        logger.info(`DataFlow: ${parsed.pipelines?.length || 0} pipelines, ${parsed.concepts?.length || 0} concepts`);
        timer?.end?.();
        return {
          pipelines: parsed.pipelines || [],
          concepts: parsed.concepts || [],
        };
      }
    } catch (err) {
      logger.debug('DataFlowAnalyzer: LLM analysis failed', err);
    }

    timer?.end?.();
    return { pipelines: this.inferPipelinesFromGraph(callGraph, entryPoints), concepts: [] };
  }

  /**
   * Trace execution paths from entry points through the call graph.
   */
  private traceExecutionPaths(
    graph: CallGraphResult,
    entryPoints: string[]
  ): { entry: string; steps: string[] }[] {
    const paths: { entry: string; steps: string[] }[] = [];

    for (const entry of entryPoints) {
      const visited = new Set<string>();
      const steps: string[] = [];

      const traverse = (path: string, depth: number) => {
        if (depth > 8 || visited.has(path)) return;
        visited.add(path);
        steps.push(path);

        // Find edges from this module
        const outgoing = graph.edges.filter(e => e.from.path === path);
        for (const edge of outgoing) {
          if (!visited.has(edge.to.path)) {
            traverse(edge.to.path, depth + 1);
          }
        }
      };

      traverse(entry, 0);
      if (steps.length > 1) {
        paths.push({ entry, steps });
      }
    }

    return paths;
  }

  /**
   * Fallback: infer pipelines from call graph structure without LLM.
   */
  private inferPipelinesFromGraph(
    graph: CallGraphResult,
    entryPoints: string[]
  ): DataPipeline[] {
    const executionPaths = this.traceExecutionPaths(graph, entryPoints);

    return executionPaths
      .filter(p => p.steps.length >= 3)
      .slice(0, 5)
      .map((p, i) => ({
        name: `Pipeline ${i + 1}: ${p.entry.split('/').pop()?.replace(/\.[^.]+$/, '') || 'unknown'}`,
        entryPoint: p.entry,
        sources: [{ path: p.entry, name: 'entry', type: 'event' as const }],
        transformations: p.steps.slice(1).map((s, j) => ({
          path: s, name: s.split('/').pop() || '', inputType: 'unknown',
          outputType: 'unknown', description: '', order: j + 1,
        })),
        sinks: [{ path: p.steps[p.steps.length - 1], name: 'output', type: 'log' as const }],
        modules: p.steps,
      }));
  }
}
