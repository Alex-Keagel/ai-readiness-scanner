export { InstructionAnalyzer } from './instructionAnalyzer';
export { CodebaseProfiler } from './codebaseProfiler';
export { CrossRefEngine } from './crossRefEngine';
export { RecommendationSynthesizer } from './recommendationSynthesizer';
export { OutputValidator } from './outputValidator';
export { SkillEvaluator } from './skillEvaluator';
export { ComplexityAnalyzer } from './complexityAnalyzer';
export { ExclusionClassifierAgent, TestClassificationAgent, GapRelevanceAgent, RecommendationValidatorAgent } from './relevanceAgents';
export * from './types';

import { CopilotClient } from '../llm/copilotClient';
import { AITool } from '../scoring/types';
import { logger } from '../logging';
import * as vscode from 'vscode';
import { InstructionAnalyzer } from './instructionAnalyzer';
import { CodebaseProfiler } from './codebaseProfiler';
import { CrossRefEngine } from './crossRefEngine';
import { RecommendationSynthesizer } from './recommendationSynthesizer';
import { SkillEvaluator } from './skillEvaluator';
import { ComplexityAnalyzer } from './complexityAnalyzer';
import { CallGraphExtractor } from '../semantic/callGraph';
import { DataFlowAnalyzer } from '../semantic/dataFlow';
import { DeepRecommendation, CrossRefResult } from './types';
import type { SkillEvaluation } from './skillEvaluator';
import type { ComplexityAnalysisResult } from './complexityAnalyzer';
import type { CallGraphResult } from '../semantic/callGraph';
import type { DataFlowResult } from '../semantic/dataFlow';

export interface DeepAnalysisResult {
  recommendations: DeepRecommendation[];
  crossRef: CrossRefResult;
  skillEvaluations?: SkillEvaluation[];
  complexity?: ComplexityAnalysisResult;
  callGraph?: CallGraphResult;
  dataFlow?: DataFlowResult;
  deadExports?: { path: string; exportName: string; lines: number; role: string }[];
}

/**
 * Main entry point for deep recommendation analysis.
 * Full pipeline: instruction analysis → codebase profiling → call graph → data flow →
 * complexity analysis → cross-reference → skill evaluation → synthesis.
 */
export async function runDeepAnalysis(
  workspaceUri: vscode.Uri,
  copilotClient: CopilotClient,
  selectedTool: AITool,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  context?: vscode.ExtensionContext
): Promise<DeepAnalysisResult> {
  const timer = logger.time('DeepAnalysis');

  // Phase 1: Analyze instruction files
  progress?.report({ message: '📝 Analyzing instruction files...', increment: 5 });
  const instructionAnalyzer = new InstructionAnalyzer(copilotClient);
  const instructions = await instructionAnalyzer.analyze(workspaceUri, selectedTool);
  logger.info(`Deep: ${instructions.files.length} instruction files, ${instructions.claims.length} claims`);

  // Phase 2: Profile codebase
  progress?.report({ message: '🔍 Profiling codebase architecture...', increment: 10 });
  const profiler = new CodebaseProfiler(copilotClient);
  const codebase = await profiler.profile(workspaceUri);

  // Inject component/directory paths for path validation (directories not in module list)
  try {
    const fs = require('fs');
    const path = require('path');
    const rootPath = workspaceUri.fsPath;
    const allPaths: string[] = [];

    // Scan 2 levels deep for directories
    const topDirs = fs.readdirSync(rootPath, { withFileTypes: true })
      .filter((d: any) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && d.name !== '.venv')
      .map((d: any) => d.name);
    allPaths.push(...topDirs);

    for (const topDir of topDirs) {
      try {
        const subDirs = fs.readdirSync(path.join(rootPath, topDir), { withFileTypes: true })
          .filter((d: any) => d.isDirectory())
          .map((d: any) => `${topDir}/${d.name}`);
        allPaths.push(...subDirs);
      } catch { /* skip unreadable */ }
    }

    (codebase as any).componentPaths = allPaths;
    logger.info(`Deep: injected ${allPaths.length} directory paths for path validation`);
  } catch { /* non-critical */ }

  logger.info(`Deep: ${codebase.modules.length} modules, ${codebase.pipelines.length} pipelines, ${codebase.hotspots.length} hotspots`);

  // Phase 3: Call graph extraction (uses codebase modules)
  progress?.report({ message: '🔗 Extracting call graph...', increment: 10 });
  let callGraph: CallGraphResult = { nodes: [], edges: [], typeNodes: [], typeEdges: [] };
  try {
    const importGraph = new Map<string, string[]>();
    for (const mod of codebase.modules) {
      // Build import graph from module paths (profiler already computed this)
      importGraph.set(mod.path, []);
    }
    const callGraphExtractor = new CallGraphExtractor(copilotClient);
    callGraph = await callGraphExtractor.extract(workspaceUri, codebase.modules, importGraph, progress);
    logger.info(`Deep: call graph ${callGraph.nodes.length} nodes, ${callGraph.edges.length} edges`);
  } catch (err) {
    logger.warn('Deep: call graph extraction failed', err);
  }

  // Phase 4: Data flow analysis (uses call graph)
  progress?.report({ message: '📊 Tracing data flow...', increment: 10 });
  let dataFlow: DataFlowResult = { pipelines: [], concepts: [] };
  try {
    const dataFlowAnalyzer = new DataFlowAnalyzer(copilotClient);
    dataFlow = await dataFlowAnalyzer.analyze(callGraph, codebase.modules, codebase.entryPoints);
    logger.info(`Deep: ${dataFlow.pipelines.length} pipelines, ${dataFlow.concepts.length} domain concepts`);
  } catch (err) {
    logger.warn('Deep: data flow analysis failed', err);
  }

  // Phase 5: Complexity analysis (uses all layers)
  progress?.report({ message: '🧠 Computing complexity factors...', increment: 10 });
  let complexity: ComplexityAnalysisResult | undefined;
  try {
    const complexityAnalyzer = new ComplexityAnalyzer(copilotClient);
    complexity = await complexityAnalyzer.analyze(
      codebase.modules, callGraph, dataFlow,
      [], // componentScores not available yet — will be filled later
      context, progress
    );
    logger.info(`Deep: ${complexity.complexities.length} components analyzed, ${complexity.products.length} products detected`);
  } catch (err) {
    logger.warn('Deep: complexity analysis failed', err);
  }

  // Phase 6: Cross-reference (now uses call graph + complexity for deeper gaps)
  progress?.report({ message: '🔍 Cross-referencing instructions vs code...', increment: 10 });
  const crossRef = new CrossRefEngine(copilotClient);
  const crossRefResult = await crossRef.analyze(instructions, codebase, workspaceUri);
  logger.info(`Deep: ${crossRefResult.coverageGaps.length} gaps, ${crossRefResult.driftIssues.length} drift issues`);

  // Phase 7: Synthesize instruction recommendations
  progress?.report({ message: '💡 Generating deep recommendations...', increment: 10 });
  const synthesizer = new RecommendationSynthesizer(copilotClient);
  const recommendations = await synthesizer.synthesize(crossRefResult, codebase, instructions, selectedTool);

  // Enrich recommendations with complexity data
  if (complexity) {
    for (const rec of recommendations) {
      const comp = complexity.complexities.find(c =>
        rec.affectedModules.some(m => m.includes(c.path) || c.path.includes(m))
      );
      if (comp) {
        // Boost impact for product components, reduce for simple support
        rec.impactScore = Math.round(rec.impactScore * (0.5 + comp.factor * 0.5));
        if (comp.isProduct && rec.impactScore < 60) rec.impactScore = 60;
      }
    }
  }

  logger.info(`Deep: ${recommendations.length} instruction recommendations`);

  // Phase 8: Evaluate existing skills
  progress?.report({ message: '🎯 Evaluating skills...', increment: 10 });
  let skillEvaluations: SkillEvaluation[] = [];
  try {
    const skillEvaluator = new SkillEvaluator(copilotClient);
    const skillResult = await skillEvaluator.evaluate(workspaceUri, progress);
    skillEvaluations = skillResult.evaluations;
    recommendations.push(...skillResult.recommendations);
    logger.info(`Deep: ${skillEvaluations.length} skills evaluated`);
  } catch (err) {
    logger.warn('Deep: skill evaluation failed', err);
  }

  // Phase 9: Dead code detection
  let deadExports: { path: string; exportName: string; lines: number; role: string }[] = [];
  try {
    const { WorkspaceIndexer } = await import('../semantic/indexer');
    const indexer = new WorkspaceIndexer(new (await import('../semantic/cache')).SemanticCache(context!));
    const importGraph = new Map<string, string[]>();
    for (const mod of codebase.modules) {
      const { project } = indexer.separateImports(
        '', // content not needed, we use module data
        mod.path
      );
      importGraph.set(mod.path, project);
    }
    deadExports = indexer.detectDeadExports(codebase.modules as any, importGraph);
    if (deadExports.length > 0) {
      logger.info(`Deep: ${deadExports.length} potentially dead exports detected`);
      // Add recommendation for significant dead code
      const topDead = deadExports.slice(0, 5);
      if (topDead.length >= 3) {
        recommendations.push({
          id: 'dead-exports',
          type: 'dead-code',
          severity: 'important',
          title: `${deadExports.length} exported modules appear unused — potential dead code`,
          description: `These modules export symbols but are never imported by other project files. They may be dead code, entry points, or externally consumed. Review and either document their purpose or remove them.`,
          evidence: topDead.map(d => `${d.path} exports "${d.exportName}" (${d.lines} lines, role: ${d.role})`),
          targetFile: '(project-level)',
          impactScore: 30,
          affectedModules: topDead.map(d => d.path),
        });
      }
    }
  } catch (err) {
    logger.debug('Deep: dead code detection skipped', { error: String(err) });
  }

  // Re-sort all recommendations by impact
  recommendations.sort((a, b) => b.impactScore - a.impactScore);

  timer?.end?.();
  return { recommendations, crossRef: crossRefResult, skillEvaluations, complexity, callGraph, dataFlow, deadExports };
}
