import * as vscode from 'vscode';
import { CopilotClient } from '../llm/copilotClient';
import { AgentResult, ComponentFinding, AgentProgressCallback } from './types';
import { logger } from '../logging';

export class SpecialistAgent {
  constructor(
    private copilotClient: CopilotClient,
    private language: string
  ) {}

  async run(
    components: ComponentFinding[],
    onProgress: AgentProgressCallback,
    token?: vscode.CancellationToken
  ): Promise<AgentResult> {
    const start = Date.now();
    const langComponents = components.filter(c => c.language === this.language);
    onProgress(`${this.language} Specialist`, `Analyzing ${langComponents.length} ${this.language} components...`);

    if (langComponents.length === 0 || !this.copilotClient.isAvailable()) {
      return {
        agentName: `${this.language} Specialist`,
        model: 'skipped',
        findings: [],
        components: langComponents,
        duration: Date.now() - start,
      };
    }

    // Build a prompt with all components of this language
    const componentList = langComponents.map(c =>
      `- ${c.name} (${c.path}): ${c.summary}\n  Dependencies: ${c.dependencies.slice(0, 5).join(', ') || 'none'}`
    ).join('\n');

    const prompt = `You are a ${this.language} expert analyzing components for AI agent readiness.

Components:
${componentList}

For each component, assess:
1. Code complexity (low/medium/high)
2. Risk level for AI modification (low/medium/high/critical)
3. One specific suggestion to improve AI readiness

Respond with ONLY valid JSON array:
[{"path": "...", "complexity": "...", "risk": "...", "suggestion": "..."}]`;

    try {
      const response = await this.copilotClient.analyze(prompt, token);
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Array<{
          path: string; complexity: string; risk: string; suggestion: string;
        }>;

        for (const item of parsed) {
          const comp = langComponents.find(c => c.path === item.path || c.name === item.path);
          if (comp) {
            comp.riskLevel = (['low', 'medium', 'high', 'critical'].includes(item.risk)
              ? item.risk
              : 'medium') as ComponentFinding['riskLevel'];
            comp.suggestions.push(item.suggestion);
          }
        }
      }
    } catch (err) {
      logger.warn('Specialist LLM analysis failed', { error: err instanceof Error ? err.message : String(err) });
      onProgress(`${this.language} Specialist`, 'LLM analysis failed, using heuristics');
    }

    onProgress(`${this.language} Specialist`, `Done — ${langComponents.length} components analyzed`);

    return {
      agentName: `${this.language} Specialist`,
      model: this.copilotClient.getModelName(),
      findings: [`Analyzed ${langComponents.length} ${this.language} components`],
      components: langComponents,
      duration: Date.now() - start,
    };
  }
}
