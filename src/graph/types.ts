export type NodeType = 'repository' | 'component' | 'subcomponent' | 'language' | 'ai-platform' | 'ai-file' | 'signal' | 'insight' | 'module' | 'function' | 'data-source' | 'data-sink' | 'domain';

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  description?: string;
  properties: Record<string, unknown>;
  // Visual
  icon?: string;
  color?: string;
  badge?: string;       // e.g., "L3 72%", "✅", "❌"
  status?: 'good' | 'warning' | 'error' | 'neutral';
}

export interface GraphEdge {
  source: string;       // node id
  target: string;       // node id
  relation: 'CONTAINS' | 'WRITTEN_IN' | 'CONFIGURED_BY' | 'BELONGS_TO' | 'DEPENDS_ON' | 'COVERS' | 'MISSING' | 'SUGGESTS' | 'CALLS' | 'DATA_FLOWS_TO' | 'EXTENDS' | 'IMPLEMENTS';
  label?: string;
  properties?: Record<string, unknown>;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootId: string;       // the repository node
  metadata: {
    projectName: string;
    scannedAt: string;
    selectedTool: string;
    nodeCount: number;
    edgeCount: number;
  };
}

// For the tree visualization — a node with its children resolved
export interface GraphTreeNode {
  node: GraphNode;
  children: GraphTreeNode[];
  edges: GraphEdge[];   // edges FROM this node
}
