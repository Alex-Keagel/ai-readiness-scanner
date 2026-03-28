import * as vscode from 'vscode';
import { CopilotClient } from '../llm/copilotClient';
import { AgentResult, ComponentFinding, AgentProgressCallback } from './types';
import { SemanticCache } from '../semantic/cache';

export class MapperAgent {
  constructor(
    private copilotClient: CopilotClient,
    private semanticCache: SemanticCache
  ) {}

  async run(
    workspaceUri: vscode.Uri,
    onProgress: AgentProgressCallback,
    token?: vscode.CancellationToken
  ): Promise<AgentResult> {
    const start = Date.now();
    onProgress('Mapper', 'Scanning workspace structure...');

    const components: ComponentFinding[] = [];

    // Use cached semantic data
    const entries = this.semanticCache.getAll();
    onProgress('Mapper', `Found ${entries.length} indexed files`);

    // Group by directory to find components
    const dirMap = new Map<string, typeof entries>();
    for (const entry of entries) {
      const dir = entry.path.split('/').slice(0, -1).join('/') || '.';
      if (!dirMap.has(dir)) dirMap.set(dir, []);
      dirMap.get(dir)!.push(entry);
    }

    // Build component findings from directory groupings
    for (const [dir, files] of dirMap) {
      if (files.length < 2) continue; // Skip trivial dirs

      const languages = [...new Set(files.map(f => f.language))];
      const allDeps = [...new Set(files.flatMap(f => f.dependencies))];

      components.push({
        path: dir,
        name: dir.split('/').pop() || dir,
        language: languages[0] || 'unknown',
        summary: files.map(f => f.summary).filter(Boolean).join('; ').slice(0, 200),
        dependencies: allDeps.slice(0, 20),
        maturitySignals: [],
        riskLevel: 'low',
        suggestions: [],
      });
    }

    onProgress('Mapper', `Identified ${components.length} components`);

    return {
      agentName: 'Mapper',
      model: 'deterministic',
      findings: [`Found ${entries.length} files in ${components.length} components`],
      components,
      duration: Date.now() - start,
    };
  }
}
