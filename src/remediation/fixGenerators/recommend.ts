import { logger } from '../../logging';
import * as vscode from 'vscode';
import {
  AITool,
  FailingSignal,
  ProjectContext,
  RemediationFix,
} from '../../scoring/types';
import { CopilotClient } from '../../llm/copilotClient';
import { buildRecommendPrompt, parseFixResponse } from '../fixPrompts';

export class RecommendGenerator {
  constructor(private copilotClient: CopilotClient) {}

  async generateRecommendation(
    signal: FailingSignal,
    context: ProjectContext,
    selectedTool: AITool,
    token?: vscode.CancellationToken
  ): Promise<RemediationFix | null> {
    const prompt = buildRecommendPrompt(signal, context, selectedTool);

    let response: string;
    try {
      response = await this.copilotClient.analyze(prompt, token);
    } catch (error) {
      logger.error(
        `[Recommend] LLM call failed for ${signal.id}:`,
        error
      );
      return null;
    }

    const parsed = parseFixResponse(response);
    if (!parsed) {
      logger.error(
        `[Recommend] Failed to parse LLM response for ${signal.id}`
      );
      return null;
    }

    const explanation = this.formatRecommendation(parsed, signal);

    return {
      signalId: signal.id,
      tier: 'recommend',
      files: [],
      explanation,
    };
  }

  private formatRecommendation(
    parsed: {
      steps?: string[];
      codeSnippets?: { file: string; code: string }[];
      explanation?: string;
    },
    signal: FailingSignal
  ): string {
    const sections: string[] = [];

    sections.push(`## Recommendation: ${signal.id}`);
    sections.push('');

    if (parsed.explanation) {
      sections.push(parsed.explanation);
      sections.push('');
    }

    if (parsed.steps && parsed.steps.length > 0) {
      sections.push('### Steps');
      sections.push('');
      for (const step of parsed.steps) {
        sections.push(`- ${step}`);
      }
      sections.push('');
    }

    if (parsed.codeSnippets && parsed.codeSnippets.length > 0) {
      sections.push('### Code Examples');
      sections.push('');
      for (const snippet of parsed.codeSnippets) {
        sections.push(`**${snippet.file}**`);
        sections.push('```');
        sections.push(snippet.code);
        sections.push('```');
        sections.push('');
      }
    }

    return sections.join('\n');
  }
}
