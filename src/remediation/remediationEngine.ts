import * as vscode from 'vscode';
import {
  AITool,
  ReadinessReport,
  FailingSignal,
  ProjectContext,
  RemediationFix,
} from '../scoring/types';
import { CopilotClient } from '../llm/copilotClient';
import { classifyFixes, getFixTier } from './fixClassifier';
import { AutoFixGenerator } from './fixGenerators/autoFix';
import { GuidedFixGenerator } from './fixGenerators/guidedFix';
import { RecommendGenerator } from './fixGenerators/recommend';
import { FixPreview } from './fixPreview';

export class RemediationEngine {
  private autoFix: AutoFixGenerator;
  private guidedFix: GuidedFixGenerator;
  private recommend: RecommendGenerator;
  private preview: FixPreview;

  constructor(private copilotClient: CopilotClient) {
    this.autoFix = new AutoFixGenerator(copilotClient);
    this.guidedFix = new GuidedFixGenerator(copilotClient);
    this.recommend = new RecommendGenerator(copilotClient);
    this.preview = new FixPreview();
  }

  async fixSignal(
    signal: FailingSignal,
    context: ProjectContext,
    workspaceUri: vscode.Uri,
    selectedTool: AITool,
    token?: vscode.CancellationToken
  ): Promise<RemediationFix | null> {
    const tier = getFixTier(signal.id);

    let fix: RemediationFix | null = null;

    switch (tier) {
      case 'auto':
        fix = await this.autoFix.generateFix(signal, context, selectedTool, token);
        break;
      case 'guided':
        fix = await this.guidedFix.generateFix(
          signal,
          context,
          workspaceUri,
          selectedTool,
          token
        );
        break;
      case 'recommend':
        fix = await this.recommend.generateRecommendation(
          signal,
          context,
          selectedTool,
          token
        );
        break;
    }

    if (!fix) {
      return null;
    }

    // For auto and guided fixes, preview before applying
    if (tier !== 'recommend' && fix.files.length > 0) {
      const approved = await this.preview.previewFix(fix, workspaceUri);
      if (!approved) {
        return null;
      }
      await this.preview.applyFixes([fix], workspaceUri);
    }

    return fix;
  }

  async fixAll(
    report: ReadinessReport,
    workspaceUri: vscode.Uri,
    progress: vscode.Progress<{ message?: string }>,
    token?: vscode.CancellationToken
  ): Promise<RemediationFix[]> {
    const { auto, guided } = classifyFixes(report);
    const context = report.projectContext;
    const selectedTool = report.selectedTool as AITool;

    // Generate auto-fixes in batches with concurrency limit
    progress.report({ message: `Generating ${auto.length} auto-fix(es)...` });

    const CONCURRENCY = 5;
    const autoFixes: RemediationFix[] = [];
    for (let i = 0; i < auto.length; i += CONCURRENCY) {
      if (token?.isCancellationRequested) break;
      const batch = auto.slice(i, i + CONCURRENCY);
      progress.report({ message: `Generating auto-fixes ${i + 1}-${Math.min(i + CONCURRENCY, auto.length)} of ${auto.length}...` });
      const results = await Promise.allSettled(
        batch.map(signal => this.autoFix.generateFix(signal, context, selectedTool, token))
      );
      autoFixes.push(...results
        .filter((r): r is PromiseFulfilledResult<RemediationFix | null> => r.status === 'fulfilled')
        .map(r => r.value)
        .filter((f): f is RemediationFix => f !== null)
      );
    }

    if (token?.isCancellationRequested) {
      return [];
    }

    // Generate guided fixes sequentially (they read workspace files)
    progress.report({
      message: `Generating ${guided.length} guided fix(es)...`,
    });

    const guidedFixes: RemediationFix[] = [];
    for (const signal of guided) {
      if (token?.isCancellationRequested) {
        break;
      }

      progress.report({
        message: `Generating guided fix: ${signal.id}...`,
      });

      const fix = await this.guidedFix.generateFix(
        signal,
        context,
        workspaceUri,
        selectedTool,
        token
      );
      if (fix) {
        guidedFixes.push(fix);
      }
    }

    const allFixes = [...autoFixes, ...guidedFixes];

    if (allFixes.length === 0) {
      vscode.window.showInformationMessage('No fixes were generated.');
      return [];
    }

    // Batch preview and apply
    progress.report({ message: 'Previewing fixes...' });
    await this.preview.batchPreview(allFixes, workspaceUri);

    return allFixes;
  }

  async fixLevel(
    report: ReadinessReport,
    targetLevel: number,
    workspaceUri: vscode.Uri,
    token?: vscode.CancellationToken
  ): Promise<RemediationFix[]> {
    const levelScore = report.levels.find((ls) => ls.level === targetLevel);
    if (!levelScore) {
      vscode.window.showErrorMessage(`Level ${targetLevel} not found.`);
      return [];
    }

    const missingSignals = levelScore.signals.filter((s) => !s.detected);
    if (missingSignals.length === 0) {
      vscode.window.showInformationMessage(
        `All signals at Level ${targetLevel} are passing.`
      );
      return [];
    }

    const context = report.projectContext;
    const selectedTool = report.selectedTool as AITool;
    const fixes: RemediationFix[] = [];

    for (const signal of missingSignals) {
      if (token?.isCancellationRequested) {
        break;
      }

      const failingSignal: FailingSignal = {
        id: signal.signalId,
        level: signal.level,
        finding: signal.finding,
        confidence: signal.confidence,
        modelUsed: signal.modelUsed,
      };

      const tier = getFixTier(failingSignal.id);
      let fix: RemediationFix | null = null;

      switch (tier) {
        case 'auto':
          fix = await this.autoFix.generateFix(failingSignal, context, selectedTool, token);
          break;
        case 'guided':
          fix = await this.guidedFix.generateFix(
            failingSignal,
            context,
            workspaceUri,
            selectedTool,
            token
          );
          break;
        case 'recommend':
          fix = await this.recommend.generateRecommendation(
            failingSignal,
            context,
            selectedTool,
            token
          );
          break;
      }

      if (fix) {
        fixes.push(fix);
      }
    }

    // Preview and apply non-recommendation fixes
    const actionableFixes = fixes.filter(
      (f) => f.tier !== 'recommend' && f.files.length > 0
    );
    if (actionableFixes.length > 0) {
      await this.preview.batchPreview(actionableFixes, workspaceUri);
    }

    // Show recommendations separately
    const recommendations = fixes.filter((f) => f.tier === 'recommend');
    if (recommendations.length > 0) {
      const doc = await vscode.workspace.openTextDocument({
        content: recommendations.map((r) => r.explanation).join('\n\n---\n\n'),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }

    return fixes;
  }

  async previewSignal(
    signal: FailingSignal,
    context: ProjectContext,
    workspaceUri: vscode.Uri,
    selectedTool: AITool,
    token?: vscode.CancellationToken
  ): Promise<{ path: string; content: string }[]> {
    const tier = getFixTier(signal.id);
    let fix: RemediationFix | null = null;

    switch (tier) {
      case 'auto':
        fix = await this.autoFix.generateFix(signal, context, selectedTool, token);
        break;
      case 'guided':
        fix = await this.guidedFix.generateFix(signal, context, workspaceUri, selectedTool, token);
        break;
      case 'recommend':
        fix = await this.recommend.generateRecommendation(signal, context, selectedTool, token);
        break;
    }

    if (!fix || fix.files.length === 0) {
      return [{ path: fix?.explanation ? '(recommendation)' : '(no content generated)', content: fix?.explanation || 'No preview available for this signal.' }];
    }

    return fix.files.map(f => ({ path: f.path, content: f.content }));
  }

  async getRecommendations(
    report: ReadinessReport,
    context: ProjectContext,
    token?: vscode.CancellationToken
  ): Promise<RemediationFix[]> {
    const { recommend: recommendSignals } = classifyFixes(report);
    const selectedTool = report.selectedTool as AITool;

    const recommendations: RemediationFix[] = [];

    for (const signal of recommendSignals) {
      if (token?.isCancellationRequested) {
        break;
      }

      const rec = await this.recommend.generateRecommendation(
        signal,
        context,
        selectedTool,
        token
      );
      if (rec) {
        recommendations.push(rec);
      }
    }

    return recommendations;
  }
}
