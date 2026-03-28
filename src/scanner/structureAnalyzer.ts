import * as vscode from 'vscode';
import { AITool, AI_TOOLS, ProjectContext } from '../scoring/types';
import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';

export interface ExpectedFile {
  path: string;
  description: string;
  required: boolean;
  level: number;
  exists: boolean;
  actualPath?: string;
}

export interface StructureComparison {
  tool: string;
  toolName: string;
  expected: ExpectedFile[];
  presentCount: number;
  missingCount: number;
  completeness: number;
  visualTree: string;
}

export class StructureAnalyzer {
  constructor(private copilotClient: CopilotClient) {}

  async analyzeStructure(
    tool: AITool,
    workspaceUri: vscode.Uri,
    context: ProjectContext,
    docsContent: string,
    token?: vscode.CancellationToken
  ): Promise<StructureComparison> {
    const toolConfig = AI_TOOLS[tool];

    // Step 1: Ask LLM to extract expected structure from docs
    let expectedFiles: ExpectedFile[];

    if (this.copilotClient.isAvailable() && docsContent.length > 0) {
      expectedFiles = await this.extractExpectedFromDocs(tool, docsContent, context, token);
    } else {
      expectedFiles = this.getStaticExpected(tool, context);
    }

    // Step 2: Check which expected files actually exist
    const exclude = '**/node_modules/**,**/.git/**,**/dist/**,**/build/**';
    for (const ef of expectedFiles) {
      const pattern = ef.path.endsWith('/') ? ef.path + '**' : ef.path;
      try {
        const found = await vscode.workspace.findFiles(
          new vscode.RelativePattern(workspaceUri, pattern), exclude, 1
        );
        ef.exists = found.length > 0;
        if (found.length > 0) {
          ef.actualPath = vscode.workspace.asRelativePath(found[0]);
        }
      } catch (err) {
        logger.warn('Failed to check expected file existence', { error: err instanceof Error ? err.message : String(err) });
        ef.exists = false;
      }
    }

    const presentCount = expectedFiles.filter(f => f.exists).length;
    const missingCount = expectedFiles.filter(f => !f.exists).length;
    const completeness = expectedFiles.length > 0
      ? Math.round((presentCount / expectedFiles.length) * 100)
      : 0;

    // Step 3: Build visual tree
    const visualTree = this.buildVisualTree(expectedFiles, toolConfig.name);

    return {
      tool,
      toolName: toolConfig.name,
      expected: expectedFiles,
      presentCount,
      missingCount,
      completeness,
      visualTree,
    };
  }

  private async extractExpectedFromDocs(
    tool: AITool,
    docsContent: string,
    context: ProjectContext,
    token?: vscode.CancellationToken
  ): Promise<ExpectedFile[]> {
    const toolConfig = AI_TOOLS[tool];

    const prompt = `Read this official documentation for ${toolConfig.name} and extract the COMPLETE expected file/directory structure for a well-configured repository.

DOCUMENTATION:
${docsContent.slice(0, 4000)}

PROJECT CONTEXT:
- Languages: ${context.languages.join(', ')}
- Type: ${context.projectType}

Extract every file and directory that ${toolConfig.name} expects or recommends. For each, indicate:
- The exact path (relative to repo root)
- What it's for (1 sentence)
- Whether it's required or optional
- Which maturity level it represents (2=instructions, 3=skills/tools, 4=workflows, 5=memory/feedback)

Adapt paths to this project's languages and domains where relevant (e.g., if Python project, include python-specific domain rules).

Respond with ONLY valid JSON:
{
  "files": [
    { "path": ".clinerules/default-rules.md", "description": "Master behavior rules and session startup", "required": true, "level": 2 },
    { "path": ".clinerules/core/project-overview.md", "description": "Project structure and architecture for agent context", "required": true, "level": 2 }
  ]
}`;

    try {
      const response = await this.copilotClient.analyze(prompt, token);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.files)) {
          return parsed.files.map((f: Record<string, unknown>) => ({
            path: String(f.path || ''),
            description: String(f.description || ''),
            required: Boolean(f.required),
            level: Number(f.level) || 2,
            exists: false,
          }));
        }
      }
    } catch (err) { logger.warn('Failed to extract expected files from docs', { error: err instanceof Error ? err.message : String(err) }); }

    return this.getStaticExpected(tool, context);
  }

  private getStaticExpected(tool: AITool, _context: ProjectContext): ExpectedFile[] {
    const config = AI_TOOLS[tool];
    const files: ExpectedFile[] = [];

    const addFiles = (patterns: string[], level: number, required: boolean) => {
      for (const p of patterns) {
        const clean = p.replace(/\*\*/g, '').replace(/\*/g, '').replace(/\/+$/g, '');
        if (clean.length > 2) {
          files.push({ path: p, description: `${config.name} level ${level} file`, required, level, exists: false });
        }
      }
    };

    addFiles(config.level2Files, 2, true);
    addFiles(config.level3Files, 3, false);
    addFiles(config.level4Files, 4, false);
    addFiles(config.level5Files, 5, false);

    return files;
  }

  private buildVisualTree(files: ExpectedFile[], toolName: string): string {
    const lines: string[] = [`📁 Expected ${toolName} Structure:`];
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

    for (const f of sorted) {
      const icon = f.exists ? '✅' : (f.required ? '❌' : '⬜');
      const reqLabel = f.required ? '' : ' (optional)';
      const status = f.exists ? '' : ' — MISSING';
      lines.push(`  ${icon} ${f.path}${reqLabel}${status}`);
      if (f.description) {
        lines.push(`     ${f.description}`);
      }
    }

    return lines.join('\n');
  }
}
