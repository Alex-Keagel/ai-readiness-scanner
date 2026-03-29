import { AITool } from '../scoring/types';

// ─── Instruction Analysis ───────────────────────────────────────────

export interface InstructionFile {
  path: string;
  content: string;
  tool: AITool | 'shared';
  type: 'root-instruction' | 'scoped-instruction' | 'skill' | 'agent' | 'workflow' | 'memory' | 'rules' | 'config';
  scope?: string; // applyTo/paths glob if present
  tokens: number;
}

export interface InstructionClaim {
  category: 'path-reference' | 'tech-stack' | 'convention' | 'architecture' | 'command' | 'workflow' | 'component-description' | 'testing';
  claim: string;
  sourceFile: string;
  sourceLine: number;
  confidence: number; // 0-1
}

export interface InstructionProfile {
  files: InstructionFile[];
  claims: InstructionClaim[];
  coveredPaths: Set<string>;
  coveredWorkflows: string[];
  mentionedTechStack: string[];
  totalTokens: number;
}

// ─── Codebase Analysis ──────────────────────────────────────────────

export interface ModuleProfile {
  path: string;
  language: string;
  lines: number;
  exports: string[];
  exportCount: number;
  importCount: number;
  fanIn: number; // how many files import this
  hasTests: boolean;
  hasDocstring: boolean;
  complexity: 'low' | 'medium' | 'high';
  role: 'entry-point' | 'core-logic' | 'utility' | 'ui' | 'config' | 'test' | 'type-def' | 'unknown';
}

export interface PipelineStep {
  file: string;
  function?: string;
  order: number;
}

export interface CodebasePipeline {
  name: string;
  steps: PipelineStep[];
  entryPoint: string;
}

export interface CodebaseProfile {
  name: string;
  languages: string[];
  frameworks: string[];
  entryPoints: string[];
  modules: ModuleProfile[];
  pipelines: CodebasePipeline[];
  totalFiles: number;
  totalExports: number;
  hotspots: string[]; // files with high fan-in + complexity
  untestedModules: string[];
  undocumentedModules: string[];
}

// ─── Gap Analysis ───────────────────────────────────────────────────

export type GapType = 'uncovered-module' | 'uncovered-pipeline' | 'stale-path' | 'missing-workflow' | 'missing-skill' | 'weak-description' | 'structural-drift' | 'semantic-drift';

export interface CoverageGap {
  type: GapType;
  severity: 'critical' | 'important' | 'suggestion';
  module: string; // file or directory path
  evidence: string; // why this is a gap
  metrics: {
    fanIn?: number;
    exports?: number;
    lines?: number;
    complexity?: string;
  };
}

export interface DriftIssue {
  type: 'path-drift' | 'structural-drift' | 'semantic-drift';
  claim: InstructionClaim;
  reality: string;
  severity: 'critical' | 'important' | 'suggestion';
  file: string;
}

export interface CrossRefResult {
  coverageGaps: CoverageGap[];
  driftIssues: DriftIssue[];
  instructionQuality: InstructionQuality;
  coveragePercent: number; // % of critical modules mentioned in instructions
}

// ─── Quality Scoring ────────────────────────────────────────────────

export interface InstructionQuality {
  specificity: number;    // 0-100: references real paths vs vague advice
  accuracy: number;       // 0-100: paths/commands exist on disk
  coverage: number;       // 0-100: % of modules mentioned
  freshness: number;      // 0-100: no stale dates/TODOs/deprecated refs
  actionability: number;  // 0-100: bullet rules vs essay prose
  efficiency: number;     // 0-100: information density per token
  overall: number;        // weighted composite
}

// ─── Deep Recommendations ───────────────────────────────────────────

export interface DeepRecommendation {
  id: string;
  type: GapType;
  severity: 'critical' | 'important' | 'suggestion';
  title: string;
  description: string;
  evidence: string[];
  targetFile: string; // file to create or modify
  suggestedContent?: string; // exact content to add
  impactScore: number; // 0-100
  affectedModules: string[];
  confidenceScore?: number; // 0.0-1.0 from validation pipeline
  validatorAgreed?: boolean;
  debateOutcome?: string;
}
