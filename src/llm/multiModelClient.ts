import * as vscode from 'vscode';
import { logger } from '../logging';

interface ModelFamily {
  pattern: string;
  exclude?: string;
}

const MODEL_FAMILIES: ModelFamily[] = [
  { pattern: 'opus' },
  { pattern: 'gpt-5.4', exclude: 'mini' },
  { pattern: 'gemini-pro' },
  { pattern: 'sonnet' },
  { pattern: 'gpt-5', exclude: 'mini' },
  { pattern: 'gemini' },
  { pattern: 'gpt-4', exclude: 'mini' },
];

export class MultiModelClient {
  private models: vscode.LanguageModelChat[] = [];
  private synthesizer: vscode.LanguageModelChat | undefined;

  async initialize(): Promise<boolean> {
    const allModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (allModels.length === 0) return false;

    // Pick up to 3 diverse models from different families
    const selected: vscode.LanguageModelChat[] = [];
    const usedFamilies = new Set<string>();

    for (const pref of MODEL_FAMILIES) {
      if (selected.length >= 3) break;
      const match = allModels.find(m => {
        const searchIn = `${m.family} ${m.name} ${m.id}`.toLowerCase();
        const familyKey = searchIn.includes('opus') || searchIn.includes('sonnet') || searchIn.includes('haiku') ? 'claude' :
          searchIn.includes('gpt') ? 'gpt' :
          searchIn.includes('gemini') ? 'gemini' : searchIn;
        if (usedFamilies.has(familyKey)) return false;
        const matches = searchIn.includes(pref.pattern.toLowerCase()) &&
          (!pref.exclude || !searchIn.includes(pref.exclude.toLowerCase()));
        if (matches) usedFamilies.add(familyKey);
        return matches;
      });
      if (match) selected.push(match);
    }

    // Fallback: if none matched, use whatever is available
    if (selected.length === 0) {
      selected.push(allModels[0]);
    }

    this.models = selected;
    // Synthesizer = best available model (first in our preference order)
    this.synthesizer = selected[0];
    
    logger.info(`MultiModel: Selected ${selected.length} models: ${selected.map(m => m.name).join(', ')}`);
    logger.info(`MultiModel: Synthesizer: ${this.synthesizer.name}`);
    return true;
  }

  isAvailable(): boolean {
    return this.models.length > 0;
  }

  getModelNames(): string[] {
    return this.models.map(m => m.name);
  }

  /**
   * Run a prompt across all available models in parallel, then synthesize results.
   * Returns the synthesized output + individual model outputs for attribution.
   */
  async generateWithConsensus(
    systemPrompt: string,
    userPrompt: string,
    token?: vscode.CancellationToken
  ): Promise<{ synthesized: string; modelOutputs: { model: string; output: string }[] }> {
    if (this.models.length === 0) {
      throw new Error('MultiModelClient not initialized');
    }

    // If only 1 model, just use it directly
    if (this.models.length === 1) {
      const output = await this.sendToModel(this.models[0], systemPrompt, userPrompt, token);
      return { synthesized: output, modelOutputs: [{ model: this.models[0].name, output }] };
    }

    // Run all models in parallel with timeout
    const results = await Promise.allSettled(
      this.models.map(async (model) => {
        const output = await this.sendToModel(model, systemPrompt, userPrompt, token);
        return { model: model.name, output };
      })
    );

    const successful = results
      .filter((r): r is PromiseFulfilledResult<{ model: string; output: string }> => r.status === 'fulfilled')
      .map(r => r.value);

    if (successful.length === 0) {
      throw new Error('All models failed');
    }

    // If only 1 succeeded, return it directly
    if (successful.length === 1) {
      return { synthesized: successful[0].output, modelOutputs: successful };
    }

    // Synthesize with the best model
    const synthesisPrompt = `You received recommendations from ${successful.length} different AI models. Synthesize them into ONE coherent, best-of-breed recommendation.

Rules:
- Take the BEST ideas from each model
- Resolve any contradictions by picking the most accurate/specific option
- Keep the output concise — under 150 lines per file
- Maintain the exact JSON output format requested in the original prompt
- Do NOT add commentary — just output the synthesized result

${successful.map((s, i) => `### Model ${i + 1}: ${s.model}\n${s.output}`).join('\n\n---\n\n')}

Output the synthesized result in the SAME JSON format as the individual outputs above.`;

    try {
      const synthesized = await this.sendToModel(
        this.synthesizer!, 
        'You are a synthesis expert. Combine multiple AI model outputs into one optimal result.',
        synthesisPrompt, 
        token
      );
      return { synthesized, modelOutputs: successful };
    } catch (err) {
      logger.warn('Model synthesis failed, using first model output', { error: err instanceof Error ? err.message : String(err) });
      return { synthesized: successful[0].output, modelOutputs: successful };
    }
  }

  /**
   * Simple single-model call (for non-consensus tasks)
   */
  async analyze(prompt: string, token?: vscode.CancellationToken): Promise<string> {
    if (this.models.length === 0) throw new Error('Not initialized');
    return this.sendToModel(this.models[0], '', prompt, token);
  }

  private async sendToModel(
    model: vscode.LanguageModelChat,
    systemPrompt: string,
    userPrompt: string,
    token?: vscode.CancellationToken
  ): Promise<string> {
    const messages: vscode.LanguageModelChatMessage[] = [];
    if (systemPrompt) {
      messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));
    }
    messages.push(vscode.LanguageModelChatMessage.User(userPrompt));

    const timeoutMs = 60_000; // 60s per model
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Model ${model.name} timed out`)), timeoutMs)
    );

    const llmPromise = (async () => {
      const response = await model.sendRequest(messages, {}, token);
      const parts: string[] = [];
      for await (const fragment of response.text) {
        parts.push(fragment);
      }
      return parts.join('');
    })();

    return Promise.race([llmPromise, timeoutPromise]);
  }
}
