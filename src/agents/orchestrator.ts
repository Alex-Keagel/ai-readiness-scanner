import * as vscode from 'vscode';
import { CopilotClient } from '../llm/copilotClient';
import { AITool } from '../scoring/types';
import { SemanticCache } from '../semantic/cache';
import { MapperAgent } from './mapper';
import { SpecialistAgent } from './specialist';
import { AuditorAgent } from './auditor';
import { OrchestrationResult, AgentProgressCallback, AgentResult } from './types';

export class AgentOrchestrator {
  constructor(
    private copilotClient: CopilotClient,
    private semanticCache: SemanticCache
  ) {}

  async orchestrate(
    workspaceUri: vscode.Uri,
    tool: AITool,
    onProgress: AgentProgressCallback,
    token?: vscode.CancellationToken
  ): Promise<OrchestrationResult> {
    const start = Date.now();

    // Phase 1: Mapper (fast, deterministic)
    const mapper = new MapperAgent(this.copilotClient, this.semanticCache);
    const mapperResult = await mapper.run(workspaceUri, onProgress, token);

    if (token?.isCancellationRequested) {
      return this.emptyResult(mapperResult, Date.now() - start);
    }

    // Phase 2: Specialists (parallel, one per detected language)
    const languages = [...new Set(mapperResult.components.map(c => c.language))].filter(l => l !== 'unknown');
    onProgress('Orchestrator', `Launching ${languages.length} language specialists...`);

    const specialistPromises = languages.map(lang => {
      const specialist = new SpecialistAgent(this.copilotClient, lang);
      return specialist.run(mapperResult.components, onProgress, token);
    });

    const specialistResults = await Promise.allSettled(specialistPromises);
    const successfulSpecialists = specialistResults
      .filter((r): r is PromiseFulfilledResult<AgentResult> => r.status === 'fulfilled')
      .map(r => r.value);

    if (token?.isCancellationRequested) {
      return this.emptyResult(mapperResult, Date.now() - start);
    }

    // Merge specialist findings into components
    for (const specialist of successfulSpecialists) {
      for (const specComp of specialist.components) {
        const original = mapperResult.components.find(c => c.path === specComp.path);
        if (original) {
          original.riskLevel = specComp.riskLevel;
          original.suggestions.push(...specComp.suggestions);
        }
      }
    }

    // Phase 3: Auditor (checks against platform guidelines)
    const auditor = new AuditorAgent(this.copilotClient);
    const auditorResult = await auditor.run(mapperResult.components, tool, workspaceUri, onProgress, token);

    onProgress('Orchestrator', `All agents complete (${Date.now() - start}ms)`);

    return {
      mapperResult,
      specialistResults: successfulSpecialists,
      auditorResult,
      mergedComponents: mapperResult.components,
      totalDuration: Date.now() - start,
    };
  }

  private emptyResult(mapperResult: AgentResult, duration: number): OrchestrationResult {
    return {
      mapperResult,
      specialistResults: [],
      auditorResult: { agentName: 'Auditor', model: 'cancelled', findings: [], components: [], duration: 0 },
      mergedComponents: mapperResult.components,
      totalDuration: duration,
    };
  }
}
