import * as vscode from 'vscode';
import { logger } from '../logging';

const MODEL_PREFERENCE: { pattern: string; exclude?: string }[] = [
  { pattern: 'opus' },
  { pattern: 'gemini-pro' },
  { pattern: 'gpt-5.4', exclude: 'mini' },
  { pattern: 'gpt-5', exclude: 'mini' },
  { pattern: 'sonnet' },
  { pattern: 'gemini' },
  { pattern: 'gpt-4o', exclude: 'mini' },
  { pattern: 'gpt-4' },
  // haiku/mini are last resort — don't list them, they'll be caught by fallback
];

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

function getLLMTimeoutMs(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscodeModule = require('vscode') as typeof import('vscode');
    const config = vscodeModule.workspace.getConfiguration('ai-readiness');
    return ((config.get('llmTimeout') as number) ?? 45) * 1000;
  } catch { return 45_000; }
}

// Fast models for high-volume tasks — prioritize speed over quality
const FAST_MODEL_PREFERENCE: { pattern: string }[] = [
  { pattern: 'flash' },          // Gemini Flash — fastest available
  { pattern: 'gpt-4.1' },        // GPT-4.1 — very fast
  { pattern: 'gpt-5.4-mini' },   // GPT-5.4 mini
  { pattern: 'gpt-5-mini' },     // GPT-5 mini
  { pattern: 'gpt-5.1-codex-mini' },
  { pattern: 'haiku' },          // Claude Haiku
  { pattern: 'gpt-4o-mini' },
  { pattern: 'mini' },           // Any mini model
];

export class CopilotClient {
  private model: vscode.LanguageModelChat | undefined;
  private fastModel: vscode.LanguageModelChat | undefined;

  async initialize(): Promise<boolean> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });

    if (models.length === 0) {
      this.model = undefined;
      this.fastModel = undefined;
      return false;
    }

    this.model = this.selectBestModel(models);
    this.fastModel = this.selectFastModel(models) || this.model;
    return true;
  }

  private selectBestModel(models: vscode.LanguageModelChat[]): vscode.LanguageModelChat {
    // Log available models for debugging
    const available = models.map(m => `${m.name} (family: ${m.family}, id: ${m.id})`);
    logger.info(`Available models: ${available.join(', ')}`);

    for (const pref of MODEL_PREFERENCE) {
      const match = models.find(
        (m) => {
          const searchIn = `${m.family} ${m.name} ${m.id}`.toLowerCase();
          return searchIn.includes(pref.pattern.toLowerCase()) &&
            (!pref.exclude || !searchIn.includes(pref.exclude.toLowerCase()));
        }
      );
      if (match) {
        logger.info(`Selected model: ${match.name} (family: ${match.family}) matched pattern '${pref.pattern}'`);
        return match;
      }
    }
    logger.info(`No preferred model found, using fallback: ${models[0].name} (family: ${models[0].family})`);
    return models[0];
  }

  private selectFastModel(models: vscode.LanguageModelChat[]): vscode.LanguageModelChat | undefined {
    for (const pref of FAST_MODEL_PREFERENCE) {
      const match = models.find(m => {
        const searchIn = `${m.family} ${m.name} ${m.id}`.toLowerCase();
        return searchIn.includes(pref.pattern.toLowerCase());
      });
      if (match && match !== this.model) {
        logger.info(`Fast model selected: ${match.name} (family: ${match.family})`);
        return match;
      }
    }
    return undefined;
  }

  /** Use the fastest available model for high-volume tasks (enrichment, summaries) */
  async analyzeFast(
    prompt: string,
    cancellationToken?: vscode.CancellationToken
  ): Promise<string> {
    const model = this.fastModel || this.model;
    if (!model) throw new Error('No LLM model available');
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    return this.sendWithRetry(messages, cancellationToken, model);
  }

  async analyze(
    prompt: string,
    cancellationToken?: vscode.CancellationToken,
    timeoutMs?: number
  ): Promise<string> {
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    return this.sendWithRetry(messages, cancellationToken, undefined, timeoutMs);
  }

  async analyzeWithSystemPrompt(
    systemPrompt: string,
    userPrompt: string,
    token?: vscode.CancellationToken
  ): Promise<string> {
    const messages = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
      vscode.LanguageModelChatMessage.User(userPrompt),
    ];
    return this.sendWithRetry(messages, token);
  }

  isAvailable(): boolean {
    return this.model !== undefined;
  }

  getModelName(): string {
    return this.model?.family ?? 'unknown';
  }

  getFastModelName(): string {
    return this.fastModel?.family ?? this.model?.family ?? 'unknown';
  }

  private async sendWithRetry(
    messages: vscode.LanguageModelChatMessage[],
    token?: vscode.CancellationToken,
    modelOverride?: vscode.LanguageModelChat,
    timeoutMs?: number
  ): Promise<string> {
    if (!this.model && !modelOverride) {
      throw new Error('CopilotClient is not initialized. Call initialize() first.');
    }

    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.send(messages, token, modelOverride, timeoutMs);
      } catch (error) {
        lastError = error;

        if (token?.isCancellationRequested) {
          throw error;
        }

        const isRetryable =
          error instanceof vscode.LanguageModelError &&
          error.code === vscode.LanguageModelError.NotFound.name
            ? false
            : true;

        if (!isRetryable || attempt === MAX_RETRIES) {
          throw error;
        }

        await this.delay(RETRY_DELAY_MS);
      }
    }

    throw lastError;
  }

  private async send(
    messages: vscode.LanguageModelChatMessage[],
    token?: vscode.CancellationToken,
    modelOverride?: vscode.LanguageModelChat,
    timeoutMs?: number
  ): Promise<string> {
    const useModel = modelOverride || this.model!;
    const timeout = timeoutMs || getLLMTimeoutMs();
    const timeoutSec = Math.round(timeout / 1000);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`LLM call timed out after ${timeoutSec}s`)), timeout)
    );

    const llmPromise = (async () => {
      const response = await useModel.sendRequest(messages, {}, token);
      const parts: string[] = [];
      for await (const fragment of response.text) {
        parts.push(fragment);
      }
      return parts.join('');
    })();

    return Promise.race([llmPromise, timeoutPromise]);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
