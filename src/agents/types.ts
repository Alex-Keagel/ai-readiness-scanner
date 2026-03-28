import { AITool } from '../scoring/types';

export interface AgentResult {
  agentName: string;
  model: string;
  findings: string[];
  components: ComponentFinding[];
  duration: number;
}

export interface ComponentFinding {
  path: string;
  name: string;
  language: string;
  summary: string;
  dependencies: string[];
  maturitySignals: { signal: string; present: boolean; detail: string }[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  suggestions: string[];
}

export interface OrchestrationResult {
  mapperResult: AgentResult;
  specialistResults: AgentResult[];
  auditorResult: AgentResult;
  mergedComponents: ComponentFinding[];
  totalDuration: number;
}

export type AgentProgressCallback = (agent: string, message: string) => void;

// Re-export for convenience
export type { AITool };
