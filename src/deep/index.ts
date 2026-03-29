export { InstructionAnalyzer } from './instructionAnalyzer';
export { CodebaseProfiler } from './codebaseProfiler';
export { CrossRefEngine } from './crossRefEngine';
export { RecommendationSynthesizer } from './recommendationSynthesizer';
export { OutputValidator } from './outputValidator';
export * from './types';

import { CopilotClient } from '../llm/copilotClient';
import { AITool } from '../scoring/types';
import { logger } from '../logging';
import * as vscode from 'vscode';
import { InstructionAnalyzer } from './instructionAnalyzer';
import { CodebaseProfiler } from './codebaseProfiler';
import { CrossRefEngine } from './crossRefEngine';
import { RecommendationSynthesizer } from './recommendationSynthesizer';
import { DeepRecommendation, CrossRefResult } from './types';

export interface DeepAnalysisResult {
  recommendations: DeepRecommendation[];
  crossRef: CrossRefResult;
}

/**
 * Main entry point for deep recommendation analysis.
 * Runs the full pipeline: instruction analysis → codebase profiling → cross-reference → synthesis.
 */
export async function runDeepAnalysis(
  workspaceUri: vscode.Uri,
  copilotClient: CopilotClient,
  selectedTool: AITool,
  progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<DeepAnalysisResult> {
  const timer = logger.time('DeepAnalysis');

  // Phase 1: Analyze instruction files
  progress?.report({ message: '📝 Analyzing instruction files...', increment: 10 });
  const instructionAnalyzer = new InstructionAnalyzer(copilotClient);
  const instructions = await instructionAnalyzer.analyze(workspaceUri, selectedTool);
  logger.info(`Deep: ${instructions.files.length} instruction files, ${instructions.claims.length} claims`);

  // Phase 2: Profile codebase
  progress?.report({ message: '🔍 Profiling codebase architecture...', increment: 20 });
  const profiler = new CodebaseProfiler(copilotClient);
  const codebase = await profiler.profile(workspaceUri);
  logger.info(`Deep: ${codebase.modules.length} modules, ${codebase.pipelines.length} pipelines, ${codebase.hotspots.length} hotspots`);

  // Phase 3: Cross-reference
  progress?.report({ message: '🔗 Cross-referencing instructions vs code...', increment: 20 });
  const crossRef = new CrossRefEngine(copilotClient);
  const crossRefResult = await crossRef.analyze(instructions, codebase, workspaceUri);
  logger.info(`Deep: ${crossRefResult.coverageGaps.length} gaps, ${crossRefResult.driftIssues.length} drift issues, quality ${crossRefResult.instructionQuality.overall}/100`);

  // Phase 4: Synthesize recommendations
  progress?.report({ message: '💡 Generating deep recommendations...', increment: 20 });
  const synthesizer = new RecommendationSynthesizer(copilotClient);
  const recommendations = await synthesizer.synthesize(crossRefResult, codebase, instructions, selectedTool);
  logger.info(`Deep: ${recommendations.length} recommendations generated`);

  timer?.end?.();
  return { recommendations, crossRef };
}
