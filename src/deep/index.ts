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
import type {
  HyDEResult, RollUpSummary, LabeledEdge, BlastRadiusResult,
  ComponentHealthCard, DeadBranch,
} from '../semantic/advancedFeatures';

export interface DeepAnalysisResult {
  recommendations: DeepRecommendation[];
  crossRef: CrossRefResult;
  skillEvaluations?: SkillEvaluation[];
  complexity?: ComplexityAnalysisResult;
  callGraph?: CallGraphResult;
  dataFlow?: DataFlowResult;
  deadExports?: { path: string; exportName: string; lines: number; role: string }[];
  // Advanced semantic features
  hydeQueries?: HyDEResult[];
  rollUpSummaries?: RollUpSummary[];
  labeledEdges?: LabeledEdge[];
  blastRadius?: BlastRadiusResult[];
  healthCards?: ComponentHealthCard[];
  deadBranches?: DeadBranch[];
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

  // ── Advanced Semantic Features (Phases 10-15) ──
  let hydeQueries: HyDEResult[] = [];
  let rollUpSummaries: RollUpSummary[] = [];
  let labeledEdges: LabeledEdge[] = [];
  let blastRadiusResults: BlastRadiusResult[] = [];
  let healthCards: ComponentHealthCard[] = [];
  let deadBranches: DeadBranch[] = [];

  try {
    const {
      generateHyDEQueries, generateRollUpSummaries, labelEdges,
      analyzeBlastRadius, auditComponent, detectDeadBranches,
    } = await import('../semantic/advancedFeatures');

    const moduleSummaries = new Map<string, string>();
    for (const mod of codebase.modules) {
      moduleSummaries.set(mod.path, `${mod.role} module (${mod.lines} lines, ${mod.exportCount} exports)`);
    }

    // Phase 10: HyDE — hypothetical search queries
    progress?.report({ message: '🔍 Generating search intent embeddings...', increment: 3 });
    try {
      hydeQueries = await generateHyDEQueries(copilotClient, codebase.modules as any);
      logger.info(`Deep: HyDE generated ${hydeQueries.length} query sets`);
    } catch (err) { logger.debug('Deep: HyDE skipped', { error: String(err) }); }

    // Phase 11: Hierarchical roll-up summaries
    progress?.report({ message: '📚 Building hierarchical summaries...', increment: 3 });
    try {
      const fileSummaries = codebase.modules.map(m => ({
        path: m.path,
        summary: moduleSummaries.get(m.path) || '',
      }));
      rollUpSummaries = await generateRollUpSummaries(copilotClient, fileSummaries);
      logger.info(`Deep: Roll-up generated ${rollUpSummaries.length} summaries`);
    } catch (err) { logger.debug('Deep: Roll-up skipped', { error: String(err) }); }

    // Phase 12: Semantic edge labeling
    progress?.report({ message: '🏷️ Labeling call graph edges...', increment: 3 });
    try {
      if (callGraph.edges.length > 0) {
        labeledEdges = await labelEdges(copilotClient, callGraph.edges, moduleSummaries);
        logger.info(`Deep: Labeled ${labeledEdges.length} edges with intent`);
      }
    } catch (err) { logger.debug('Deep: Edge labeling skipped', { error: String(err) }); }

    // Phase 13: Blast radius for entry points
    progress?.report({ message: '💥 Analyzing blast radius...', increment: 3 });
    try {
      const entryPoints = codebase.modules
        .filter(m => m.role === 'entry-point')
        .slice(0, 3);
      for (const ep of entryPoints) {
        const result = await analyzeBlastRadius(copilotClient, ep.path, callGraph.edges, moduleSummaries);
        if (result.affectedModules.length > 0) {
          blastRadiusResults.push(result);
        }
      }
      logger.info(`Deep: Blast radius analyzed ${blastRadiusResults.length} entry points`);
    } catch (err) { logger.debug('Deep: Blast radius skipped', { error: String(err) }); }

    // Phase 14: Multi-agent health cards for top 3 critical components
    progress?.report({ message: '🏥 Auditing critical components...', increment: 3 });
    try {
      const criticalModules = codebase.modules
        .filter(m => m.role === 'core-logic' && m.lines > 200)
        .sort((a, b) => b.lines - a.lines)
        .slice(0, 3);
      for (const mod of criticalModules) {
        const card = await auditComponent(
          copilotClient, mod.path, mod.path.split('/').pop() || mod.path,
          moduleSummaries.get(mod.path) || '',
          '' // code snippet not available at this stage
        );
        healthCards.push(card);
      }
      logger.info(`Deep: Audited ${healthCards.length} components`);
    } catch (err) { logger.debug('Deep: Component audit skipped', { error: String(err) }); }

    // Phase 15: Semantic dead branches (feature-flagged code)
    progress?.report({ message: '🔇 Detecting feature-flagged dead code...', increment: 2 });
    try {
      // Find config files
      const configPatterns = ['**/config.{json,yaml,yml,toml}', '**/.env', '**/settings.json', '**/appsettings*.json'];
      const configFiles: { path: string; content: string }[] = [];
      for (const pat of configPatterns) {
        const found = await vscode.workspace.findFiles(
          new vscode.RelativePattern(workspaceUri, pat),
          '**/node_modules/**,**/.git/**,**/.venv/**', 5
        );
        for (const f of found) {
          try {
            const raw = await vscode.workspace.fs.readFile(f);
            configFiles.push({
              path: vscode.workspace.asRelativePath(f, false),
              content: Buffer.from(raw).toString('utf-8').slice(0, 2000),
            });
          } catch { /* skip */ }
        }
      }
      if (configFiles.length > 0) {
        deadBranches = await detectDeadBranches(copilotClient, codebase.modules as any, configFiles);
        logger.info(`Deep: Found ${deadBranches.length} potentially dead branches`);
      }
    } catch (err) { logger.debug('Deep: Dead branch detection skipped', { error: String(err) }); }

  } catch (err) {
    logger.warn('Deep: Advanced semantic features failed, continuing', { error: String(err) });
  }

  // Re-sort all recommendations by impact
  recommendations.sort((a, b) => b.impactScore - a.impactScore);

  timer?.end?.();
  return {
    recommendations, crossRef: crossRefResult, skillEvaluations, complexity, callGraph, dataFlow,
    deadExports, hydeQueries, rollUpSummaries, labeledEdges,
    blastRadius: blastRadiusResults, healthCards, deadBranches,
  };
}
