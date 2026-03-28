import * as vscode from 'vscode';
import { CopilotClient } from '../llm/copilotClient';
import { AITool, AI_TOOLS } from '../scoring/types';
import { AgentResult, ComponentFinding, AgentProgressCallback } from './types';
import { logger } from '../logging';

export class AuditorAgent {
  constructor(private copilotClient: CopilotClient) {}

  async run(
    components: ComponentFinding[],
    tool: AITool,
    workspaceUri: vscode.Uri,
    onProgress: AgentProgressCallback,
    token?: vscode.CancellationToken
  ): Promise<AgentResult> {
    const start = Date.now();
    const toolConfig = AI_TOOLS[tool];
    onProgress('Auditor', `Checking compliance against ${toolConfig.name} guidelines...`);

    // Check which platform files exist
    const allPatterns = [
      ...toolConfig.level2Files,
      ...toolConfig.level3Files,
      ...toolConfig.level4Files,
      ...toolConfig.level5Files,
    ];

    const existingFiles: string[] = [];
    for (const pattern of allPatterns) {
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceUri, pattern),
        '{**/node_modules/**,**/.git/**}', 5
      );
      existingFiles.push(...found.map(f => vscode.workspace.asRelativePath(f)));
    }

    onProgress('Auditor', `Found ${existingFiles.length} ${toolConfig.name} config files`);

    // For each component, check if it has platform-specific coverage
    for (const comp of components) {
      const hasInstructions = existingFiles.length > 0;
      comp.maturitySignals.push({
        signal: `${toolConfig.name} Instructions`,
        present: hasInstructions,
        detail: hasInstructions
          ? `${existingFiles.length} ${toolConfig.name} files found`
          : `No ${toolConfig.name} configuration files`,
      });
    }

    // LLM audit of existing config files
    if (existingFiles.length > 0 && this.copilotClient.isAvailable()) {
      onProgress('Auditor', 'Deep-checking config file accuracy...');
      try {
        const fileContents: string[] = [];
        for (const filePath of existingFiles.slice(0, 5)) {
          try {
            const uri = vscode.Uri.joinPath(workspaceUri, filePath);
            const bytes = await vscode.workspace.fs.readFile(uri);
            const content = Buffer.from(bytes).toString('utf-8');
            fileContents.push(`### ${filePath}\n${content.slice(0, 1000)}`);
          } catch (err) { logger.warn('Failed to read config file during audit', { error: err instanceof Error ? err.message : String(err) }); }
        }

        if (fileContents.length > 0) {
          const auditPrompt = `You are auditing ${toolConfig.name} configuration files.

Platform rules:
${toolConfig.reasoningContext?.qualityMarkers ?? ''}
Anti-patterns: ${toolConfig.reasoningContext?.antiPatterns ?? ''}

Files:
${fileContents.join('\n\n')}

Rate each file 1-5 (1=poor, 5=excellent) and give ONE specific improvement.
Respond with JSON: [{"file": "path", "rating": N, "improvement": "..."}]`;

          const response = await this.copilotClient.analyze(auditPrompt, token);
          const jsonMatch = response.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const audits = JSON.parse(jsonMatch[0]) as Array<{
              file: string; rating: number; improvement: string;
            }>;
            for (const audit of audits) {
              onProgress('Auditor', `  ${audit.file}: ${audit.rating}/5 — ${audit.improvement}`);
            }
          }
        }
      } catch (err) {
        logger.warn('Config audit LLM analysis failed', { error: err instanceof Error ? err.message : String(err) });
        onProgress('Auditor', 'Config audit failed, continuing...');
      }
    }

    onProgress('Auditor', 'Audit complete');

    return {
      agentName: 'Auditor',
      model: this.copilotClient.isAvailable() ? this.copilotClient.getModelName() : 'deterministic',
      findings: [
        `${existingFiles.length} ${toolConfig.name} files found`,
        `${components.length} components checked for platform compliance`,
      ],
      components,
      duration: Date.now() - start,
    };
  }
}
