import { logger } from '../../logging';
import * as vscode from 'vscode';
import {
  AITool,
  FailingSignal,
  ProjectContext,
  RemediationFix,
  FixFile,
} from '../../scoring/types';
import { CopilotClient } from '../../llm/copilotClient';
import { buildAutoFixPrompt, parseFixResponse } from '../fixPrompts';
import { validateFixFiles } from '../fixValidator';

export class AutoFixGenerator {
  constructor(private copilotClient: CopilotClient) {}

  async generateFix(
    signal: FailingSignal,
    context: ProjectContext,
    selectedTool: AITool,
    token?: vscode.CancellationToken
  ): Promise<RemediationFix | null> {
    const prompt = await buildAutoFixPrompt(signal, context, selectedTool);

    let response: string;
    try {
      response = await this.copilotClient.analyze(prompt, token);
    } catch (error) {
      logger.error(
        `[AutoFix] LLM call failed for ${signal.id}:`,
        error
      );
      return null;
    }

    const parsed = parseFixResponse(response);
    if (!parsed?.files || parsed.files.length === 0) {
      logger.error(
        `[AutoFix] Failed to parse LLM response for ${signal.id}`
      );
      return null;
    }

    const validation = validateFixFiles(parsed.files);
    if (!validation.allValid) {
      const errors = validation.results
        .filter((r) => !r.valid)
        .map((r) => `${r.path}: ${r.error}`)
        .join('; ');
      logger.error(
        `[AutoFix] Validation failed for ${signal.id}: ${errors}`
      );
      return null;
    }

    const fixFiles: FixFile[] = parsed.files.map((f) => ({
      path: f.path,
      action: 'create' as const,
      content: f.content,
    }));

    return {
      signalId: signal.id,
      tier: 'auto',
      files: fixFiles,
      explanation: parsed.explanation ?? `Auto-generated fix for ${signal.id}`,
    };
  }
}
