import { KnowledgeGraph, GraphNode, GraphEdge, GraphTreeNode, NodeType } from './types';
import { ReadinessReport, AI_TOOLS, AITool, SignalResult } from '../scoring/types';
import { ValidationAgent } from '../deep/validationAgent';
import { PlatformSignalFilter } from '../scoring/signalFilter';

function normalizeGraphPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.?\//, '').replace(/\/$/, '');
}

function isSubProjectFile(filePath: string, subProjectPaths: string[]): boolean {
  const normalizedFile = normalizeGraphPath(filePath);
  return subProjectPaths.some(subProjectPath => {
    const normalizedSubProject = normalizeGraphPath(subProjectPath);
    if (!normalizedSubProject) { return false; }
    return normalizedFile === normalizedSubProject ||
      normalizedFile.startsWith(`${normalizedSubProject}/`) ||
      normalizedFile.includes(`/${normalizedSubProject}/`) ||
      normalizedFile.endsWith(`/${normalizedSubProject}`);
  });
}

export class GraphBuilder {
  private validationAgent: ValidationAgent;
  
  constructor() {
    this.validationAgent = new ValidationAgent();
  }
  
  buildGraph(report: ReadinessReport, dependencies?: Map<string, string[]>): KnowledgeGraph {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const repoId = 'repo';
    const monorepoSubProjectPaths = this.collectMonorepoSubProjectPaths(report);
    
    // 1. Repository node
    nodes.push({
      id: repoId,
      type: 'repository',
      label: report.projectName,
      description: `Level ${report.primaryLevel}: ${report.levelName} (${report.depth}% depth)`,
      properties: { level: report.primaryLevel, depth: report.depth, overallScore: report.overallScore },
      icon: '📁',
      badge: `L${report.primaryLevel} ${report.depth}%`,
      status: report.primaryLevel >= 3 ? 'good' : report.primaryLevel >= 2 ? 'warning' : 'error',
    });
    
    // 2. AI Platform nodes
    this.addPlatformNodes(nodes, edges, repoId, report, monorepoSubProjectPaths);
    
    // 3. Component nodes (with sub-components)
    this.addComponentNodes(nodes, edges, repoId, report);
    
    // 4. Language nodes
    this.addLanguageNodes(nodes, edges, report);
    
    // 5. Signal nodes (per level)
    this.addSignalNodes(nodes, edges, report, monorepoSubProjectPaths);
    
    // 6. Insight nodes
    this.addInsightNodes(nodes, edges, report);
    
    // 7. Dependency edges
    if (dependencies) {
      this.addDependencyEdges(edges, dependencies);
    }
    
    // 8. Coverage edges — which platforms cover which components
    this.addCoverageEdges(nodes, edges, report);
    
    return {
      nodes, edges, rootId: repoId,
      metadata: {
        projectName: report.projectName,
        scannedAt: report.scannedAt,
        selectedTool: report.selectedTool,
        nodeCount: nodes.length,
        edgeCount: edges.length,
      },
    };
  }

  // Build a tree representation for visualization
  buildTree(graph: KnowledgeGraph): GraphTreeNode {
    const rootNode = graph.nodes.find(n => n.id === graph.rootId)!;
    return {
      node: rootNode,
      children: [
        // Group 1: AI Platforms
        ...this.getGroupedChildren(graph, 'ai-platform'),
        // Group 2: Components (primary structure view)
        ...this.getGroupedChildren(graph, 'component'),
        // Group 3: Insights (actionable)
        ...this.getGroupedChildren(graph, 'insight'),
        // Note: Language nodes omitted from tree — already shown as badges on components
      ],
      edges: graph.edges.filter(e => e.source === graph.rootId),
    };
  }

  private getGroupedChildren(graph: KnowledgeGraph, type: NodeType): GraphTreeNode[] {
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
    
    // Build set of node IDs that are children of another node of the same type
    const childNodeIds = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.relation === 'CONTAINS') {
        const source = nodeMap.get(edge.source);
        const target = nodeMap.get(edge.target);
        if (source && target && (target.type === type || target.type === 'subcomponent')) {
          if (source.type === type || source.type === 'subcomponent') {
            childNodeIds.add(edge.target);
          }
        }
      }
    }
    
    const resolveChildren = (parentId: string): GraphTreeNode[] => {
      const childEdges = graph.edges.filter(e => e.source === parentId && e.relation === 'CONTAINS');
      return childEdges.map(e => {
        const node = nodeMap.get(e.target);
        if (!node) return null;
        return {
          node,
          children: resolveChildren(e.target),
          edges: graph.edges.filter(ed => ed.source === e.target),
        };
      }).filter(Boolean) as GraphTreeNode[];
    };
    
    // Only return top-level nodes of this type (not sub-components)
    const typesToMatch = type === 'component' ? ['component', 'subcomponent'] : [type];
    return graph.nodes
      .filter(n => typesToMatch.includes(n.type) && !childNodeIds.has(n.id))
      .map(n => ({
        node: n,
        children: resolveChildren(n.id),
        edges: graph.edges.filter(e => e.source === n.id),
      }));
  }

  private addPlatformNodes(nodes: GraphNode[], edges: GraphEdge[], repoId: string, report: ReadinessReport, subProjectPaths: string[]): void {
    const selectedTool = report.selectedTool as AITool;
    
    for (const [toolId, config] of Object.entries(AI_TOOLS)) {
      const nodeId = `platform-${toolId}`;
      const isSelected = selectedTool === toolId;
      // Check if this tool has any detected signals using central filter (exclude shared signals)
      const isConfigured = report.levels.some(l => l.signals.some(s => 
        s.detected && !PlatformSignalFilter.SHARED_SIGNALS.has(s.signalId) && (
          PlatformSignalFilter.isRelevant(s.signalId, toolId as AITool) ||
          s.signalId.startsWith(`${toolId}_`)
        )
      ));
      
      // Count files for this platform (exclude shared signals to avoid duplicate counts)
      const platformFiles = report.levels.flatMap(l => l.signals)
        .filter(s => s.detected && !PlatformSignalFilter.SHARED_SIGNALS.has(s.signalId) && (
          PlatformSignalFilter.isRelevant(s.signalId, toolId as AITool) ||
          s.signalId.startsWith(`${toolId}_`)
        ))
        .flatMap(s => s.files);
      
      nodes.push({
        id: nodeId,
        type: 'ai-platform',
        label: config.name,
        description: isConfigured ? `${platformFiles.length} files configured` : 'Not configured',
        properties: { configured: isConfigured, fileCount: platformFiles.length, toolId, isSelected },
        icon: config.icon,
        badge: isConfigured ? '✅' : '❌',
        status: isConfigured ? 'good' : 'neutral',
      });
      
      edges.push({ source: repoId, target: nodeId, relation: 'CONTAINS' });
      
      // Add AI file nodes under this platform
      if (isConfigured) {
        for (const filePath of new Set(platformFiles)) {
          const fileId = `file-${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
          if (!nodes.find(n => n.id === fileId)) {
            const signal = report.levels.flatMap(l => l.signals)
              .find(s => s.files.includes(filePath));
            
            nodes.push({
              id: fileId,
              type: 'ai-file',
              label: filePath,
              description: signal ? this.describeSignalScope(report, signal, subProjectPaths) : undefined,
              properties: { 
                tool: toolId, 
                level: signal?.level, 
                score: signal?.score,
                accuracy: signal?.realityChecks ? 'checked' : 'unchecked',
              },
              icon: '📄',
              badge: signal?.score !== undefined ? `${signal.score}/100` : undefined,
              status: (signal?.score ?? 0) >= 70 ? 'good' : (signal?.score ?? 0) >= 40 ? 'warning' : 'error',
            });
          }
          edges.push({ source: nodeId, target: fileId, relation: 'CONTAINS' });
        }
      }
    }
  }

  private addComponentNodes(nodes: GraphNode[], edges: GraphEdge[], repoId: string, report: ReadinessReport): void {
    const iconMap: Record<string, string> = { app: '🚀', library: '📦', service: '⚙️', infra: '🏗️' };

    // First pass: create all component nodes
    for (const comp of report.componentScores) {
      const compId = this.nodeId('comp', comp.path);
      
      nodes.push({
        id: compId,
        type: comp.parentPath ? 'subcomponent' : 'component',
        label: comp.name,
        description: comp.description || `${comp.language} ${comp.type}`,
        properties: { 
          path: comp.path, language: comp.language, type: comp.type,
          level: comp.primaryLevel, depth: comp.depth, score: comp.overallScore,
          signals: comp.signals,
          isGenerated: comp.isGenerated || false,
          children: comp.children || [],
        },
        icon: comp.isGenerated ? '🔄' : (iconMap[comp.type] || '📁'),
        badge: `L${comp.primaryLevel} ${comp.depth}%`,
        status: comp.isGenerated ? 'neutral' : comp.primaryLevel >= 3 ? 'good' : comp.primaryLevel >= 2 ? 'warning' : 'error',
      });
    }

    // Second pass: create edges using parentPath
    for (const comp of report.componentScores) {
      const compId = this.nodeId('comp', comp.path);

      if (comp.parentPath) {
        // This is a sub-component — connect to parent
        const parentId = this.nodeId('comp', comp.parentPath);
        edges.push({ source: parentId, target: compId, relation: 'CONTAINS' });
      } else {
        // This is a top-level component — connect to repo
        edges.push({ source: repoId, target: compId, relation: 'CONTAINS' });
      }
      
      // Add signal details as sub-nodes
      for (const signal of comp.signals) {
        const sigId = `${compId}-sig-${signal.signal.replace(/[^a-zA-Z0-9]/g, '_')}`;
        nodes.push({
          id: sigId,
          type: 'signal',
          label: signal.signal,
          description: signal.detail,
          properties: { present: signal.present },
          icon: signal.present ? '✅' : '❌',
          status: signal.present ? 'good' : 'error',
        });
        edges.push({ source: compId, target: sigId, relation: 'CONTAINS' });
      }
      
      // Language edge
      edges.push({ source: compId, target: `lang-${comp.language}`, relation: 'WRITTEN_IN', properties: { primary: true } });
    }
  }

  private nodeId(prefix: string, path: string): string {
    return `${prefix}-${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
  }

  private addLanguageNodes(nodes: GraphNode[], edges: GraphEdge[], report: ReadinessReport): void {
    for (const lang of report.languageScores) {
      const langId = `lang-${lang.language}`;
      if (!nodes.find(n => n.id === langId)) {
        nodes.push({
          id: langId,
          type: 'language',
          label: lang.language,
          description: `${lang.fileCount} files`,
          properties: { fileCount: lang.fileCount, level: lang.primaryLevel, depth: lang.depth },
          icon: '🌐',
          badge: `L${lang.primaryLevel}`,
          status: lang.primaryLevel >= 3 ? 'good' : lang.primaryLevel >= 2 ? 'warning' : 'error',
        });
      }
    }
  }

  private addSignalNodes(nodes: GraphNode[], edges: GraphEdge[], report: ReadinessReport, subProjectPaths: string[]): void {
    for (const level of report.levels) {
      for (const signal of level.signals) {
        const sigId = `signal-${signal.signalId}`;
        if (!nodes.find(n => n.id === sigId)) {
          nodes.push({
            id: sigId,
            type: 'signal',
            label: signal.signalId,
            description: this.describeSignalScope(report, signal, subProjectPaths),
            properties: { level: signal.level, detected: signal.detected, score: signal.score, model: signal.modelUsed },
            icon: signal.detected ? '✅' : '❌',
            badge: signal.detected ? `${signal.score}/100` : undefined,
            status: signal.detected && signal.score >= 70 ? 'good' : signal.detected ? 'warning' : 'error',
          });
        }
      }
    }
  }

  private describeSignalScope(report: ReadinessReport, signal: SignalResult, subProjectPaths: string[] = []): string {
    const finding = this.validationAgent.sanitizeFinding(signal.finding, signal.realityChecks || []);
    if (report.projectContext.projectType !== 'monorepo' || !signal.detected) {
      return finding;
    }

    const hasFiles = (signal.files || []).length > 0;
    if (!hasFiles) {
      return finding;
    }

    const hasSubProjectFiles = signal.files.some(file => isSubProjectFile(file, subProjectPaths));
    const hasRootFiles = signal.files.some(file => !isSubProjectFile(file, subProjectPaths));

    if (hasRootFiles && hasSubProjectFiles) {
      return `Detected at root level (also present in sub-projects). ${finding}`;
    }
    if (hasRootFiles) {
      return `Detected at root level. ${finding}`;
    }
    if (hasSubProjectFiles) {
      return `Detected at sub-project level only. ${finding}`;
    }
    return finding;
  }

  private collectMonorepoSubProjectPaths(report: ReadinessReport): string[] {
    if (report.projectContext.projectType !== 'monorepo') {
      return [];
    }

    const subProjectPaths = new Set<string>();
    for (const level of report.levels) {
      for (const signal of level.signals) {
        for (const file of signal.files || []) {
          const normalized = normalizeGraphPath(file);
          const githubIndex = normalized.indexOf('/.github/');
          if (githubIndex > 0) {
            const prefix = normalized.slice(0, githubIndex);
            if (prefix && !prefix.startsWith('.')) {
              subProjectPaths.add(prefix);
            }
          }
        }
      }
    }
    return [...subProjectPaths];
  }

  private addInsightNodes(nodes: GraphNode[], edges: GraphEdge[], report: ReadinessReport): void {
    if (!report.insights) return;
    for (const insight of report.insights) {
      const insightId = `insight-${insight.title.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)}`;
      nodes.push({
        id: insightId,
        type: 'insight',
        label: insight.title,
        description: insight.recommendation,
        properties: { severity: insight.severity, category: insight.category, impact: insight.estimatedImpact },
        icon: insight.severity === 'critical' ? '🔴' : insight.severity === 'important' ? '🟠' : '🟡',
        status: insight.severity === 'critical' ? 'error' : insight.severity === 'important' ? 'warning' : 'neutral',
      });
      
      // Link insight to affected component
      if (insight.affectedComponent) {
        const compId = `comp-${insight.affectedComponent.replace(/[^a-zA-Z0-9]/g, '_')}`;
        edges.push({ source: insightId, target: compId, relation: 'SUGGESTS' });
      }
    }
  }

  private addDependencyEdges(edges: GraphEdge[], dependencies: Map<string, string[]>): void {
    for (const [from, deps] of dependencies) {
      const fromId = this.nodeId('comp', from);
      for (const dep of deps) {
        const toId = this.nodeId('comp', dep);
        edges.push({ source: fromId, target: toId, relation: 'DEPENDS_ON', label: dep });
      }
    }
  }

  private addCoverageEdges(nodes: GraphNode[], edges: GraphEdge[], report: ReadinessReport): void {
    for (const comp of report.componentScores) {
      const compId = this.nodeId('comp', comp.path);
      
      for (const [toolId] of Object.entries(AI_TOOLS)) {
        const platformId = `platform-${toolId}`;
        
        const hasAgentInstructions = comp.signals.some(s => 
          s.signal === 'Agent Instructions' && s.present
        );
        
        if (hasAgentInstructions) {
          edges.push({ source: platformId, target: compId, relation: 'COVERS' });
        } else {
          edges.push({ source: platformId, target: compId, relation: 'MISSING', label: 'needs agent config' });
        }
      }
    }
  }

  /**
   * Enrich the knowledge graph with deep analysis data:
   * call graph edges, data flow paths, labeled edges, complexity, health cards.
   */
  enrichWithDeepAnalysis(
    graph: KnowledgeGraph,
    deepAnalysis: {
      callGraph?: { nodes: { path: string; name: string; type: string; exported: boolean }[]; edges: { from: { path: string; name: string }; to: { path: string; name: string }; callType: string }[]; typeEdges?: { from: { path: string; name: string }; to: { path: string; name: string }; relation: string }[] };
      dataFlow?: { pipelines: { name: string; sources: { path: string; type: string }[]; transformations: { path: string; name: string }[]; sinks: { path: string; type: string }[] }[] };
      labeledEdges?: { from: string; to: string; intent: string; confidence: number }[];
      complexity?: { complexities: { path: string; factor: number; isProduct: boolean }[] };
      healthCards?: { componentPath: string; componentName: string; purpose: string; risks: string[]; overallHealth: string }[];
      rollUpSummaries?: { directory: string; summary: string; depth: number }[];
    }
  ): void {
    const existingNodeIds = new Set(graph.nodes.map(n => n.id));
    const existingEdgeKeys = new Set(graph.edges.map(e => `${e.source}→${e.target}→${e.relation}`));

    const addEdge = (edge: GraphEdge) => {
      const key = `${edge.source}→${edge.target}→${edge.relation}`;
      if (!existingEdgeKeys.has(key)) {
        existingEdgeKeys.add(key);
        graph.edges.push(edge);
      }
    };

    // ── Call graph: add CALLS edges between modules ──
    if (deepAnalysis.callGraph?.edges) {
      for (const e of deepAnalysis.callGraph.edges) {
        if (!e.from?.path || !e.to?.path) continue;
        const sourceComp = this.findComponentNode(graph, e.from.path);
        const targetComp = this.findComponentNode(graph, e.to.path);
        if (sourceComp && targetComp && sourceComp !== targetComp) {
          const labeledEdge = deepAnalysis.labeledEdges?.find(le =>
            le.from.includes(e.from.path) && le.to.includes(e.to.path)
          );
          addEdge({
            source: sourceComp, target: targetComp,
            relation: 'CALLS',
            label: labeledEdge?.intent || `${e.from.name || '?'} → ${e.to.name || '?'}`,
            properties: { callType: e.callType, confidence: labeledEdge?.confidence },
          });
        }
      }
    }

    // ── Type hierarchy: add EXTENDS/IMPLEMENTS edges ──
    if (deepAnalysis.callGraph?.typeEdges) {
      for (const e of deepAnalysis.callGraph.typeEdges) {
        if (!e.from?.path || !e.to?.path) continue;
        const sourceComp = this.findComponentNode(graph, e.from.path);
        const targetComp = this.findComponentNode(graph, e.to.path);
        if (sourceComp && targetComp && sourceComp !== targetComp) {
          addEdge({
            source: sourceComp, target: targetComp,
            relation: e.relation === 'extends' ? 'EXTENDS' : 'IMPLEMENTS',
            label: `${e.from.name} ${e.relation} ${e.to.name}`,
          });
        }
      }
    }

    // ── Data flow: add DATA_FLOWS_TO edges + source/sink nodes ──
    if (deepAnalysis.dataFlow?.pipelines) {
      for (const pipeline of deepAnalysis.dataFlow.pipelines) {
        // Add pipeline as a virtual node
        const pipelineId = `pipeline-${pipeline.name.replace(/[^a-z0-9]/gi, '_')}`;
        if (!existingNodeIds.has(pipelineId)) {
          existingNodeIds.add(pipelineId);
          graph.nodes.push({
            id: pipelineId, type: 'data-source', label: pipeline.name,
            description: `Data pipeline: ${pipeline.sources.length} sources → ${pipeline.transformations.length} transforms → ${pipeline.sinks.length} sinks`,
            properties: { sourceCount: pipeline.sources.length, sinkCount: pipeline.sinks.length },
            icon: '🔄', status: 'neutral',
          });
        }

        // Connect sources → transformations → sinks
        for (const src of pipeline.sources) {
          if (!src?.path) continue;
          const srcComp = this.findComponentNode(graph, src.path);
          if (srcComp) addEdge({ source: srcComp, target: pipelineId, relation: 'DATA_FLOWS_TO', label: `source: ${src.type}` });
        }
        for (const sink of pipeline.sinks) {
          if (!sink?.path) continue;
          const sinkComp = this.findComponentNode(graph, sink.path);
          if (sinkComp) addEdge({ source: pipelineId, target: sinkComp, relation: 'DATA_FLOWS_TO', label: `sink: ${sink.type}` });
        }
      }
    }

    // ── Complexity: enrich existing component nodes with factor ──
    if (deepAnalysis.complexity?.complexities) {
      for (const comp of deepAnalysis.complexity.complexities) {
        if (!comp?.path) continue;
        const nodeId = this.findComponentNode(graph, comp.path);
        if (nodeId) {
          const node = graph.nodes.find(n => n.id === nodeId);
          if (node) {
            node.properties.complexityFactor = comp.factor;
            node.properties.isProduct = comp.isProduct;
            if (comp.isProduct) node.icon = '🏭';
          }
        }
      }
    }

    // ── Health cards: enrich component nodes ──
    if (deepAnalysis.healthCards) {
      for (const card of deepAnalysis.healthCards) {
        const nodeId = this.findComponentNode(graph, card.componentPath);
        if (nodeId) {
          const node = graph.nodes.find(n => n.id === nodeId);
          if (node) {
            node.properties.healthCard = {
              purpose: card.purpose,
              risks: card.risks,
              overallHealth: card.overallHealth,
            };
            if (card.overallHealth === 'at-risk') node.status = 'error';
            else if (card.overallHealth === 'needs-attention') node.status = 'warning';
          }
        }
      }
    }

    // ── Roll-up summaries: enrich component/domain nodes ──
    if (deepAnalysis.rollUpSummaries) {
      for (const summary of deepAnalysis.rollUpSummaries) {
        if (summary.directory === '.') {
          // Architecture-level summary goes on the root node
          const root = graph.nodes.find(n => n.id === graph.rootId);
          if (root) root.properties.architectureSummary = summary.summary;
        } else {
          const nodeId = this.findComponentNode(graph, summary.directory);
          if (nodeId) {
            const node = graph.nodes.find(n => n.id === nodeId);
            if (node) node.properties.rollUpSummary = summary.summary;
          }
        }
      }
    }

    // Update metadata
    graph.metadata.nodeCount = graph.nodes.length;
    graph.metadata.edgeCount = graph.edges.length;
  }

  /** Find the component node ID that best matches a file path */
  private findComponentNode(graph: KnowledgeGraph, filePath: string): string | undefined {
    // Exact match on component path
    const exact = graph.nodes.find(n =>
      (n.type === 'component' || n.type === 'subcomponent') && n.id === `comp-${filePath}`
    );
    if (exact) return exact.id;

    // Partial match — find component whose path is a prefix of the file path
    const partial = graph.nodes
      .filter(n => n.type === 'component' || n.type === 'subcomponent')
      .find(n => {
        const compPath = n.id.replace('comp-', '');
        return filePath.startsWith(compPath + '/') || filePath === compPath;
      });
    return partial?.id;
  }
}
