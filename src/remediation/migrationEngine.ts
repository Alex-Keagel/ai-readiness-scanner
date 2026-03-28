import * as vscode from 'vscode';
import { AITool, AI_TOOLS, ProjectContext, FileContent } from '../scoring/types';
import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';

export interface MigrationPlan {
  sourceTool: AITool;
  targetTool: AITool;
  sourceFiles: FileContent[];
  targetFiles: MigrationFile[];
  explanation: string;
}

export interface MigrationFile {
  path: string;
  content: string;
  sourceFile: string;
  transformations: string[];
}

export class MigrationEngine {
  constructor(private copilotClient: CopilotClient) {}

  async detectExistingTools(workspaceUri: vscode.Uri): Promise<{ tool: AITool; files: FileContent[]; fileCount: number }[]> {
    const results: { tool: AITool; files: FileContent[]; fileCount: number }[] = [];
    const exclude = '**/node_modules/**,**/.git/**,**/dist/**,**/build/**';

    for (const [toolId, config] of Object.entries(AI_TOOLS)) {
      const allPatterns = [...config.level2Files, ...config.level3Files, ...config.level4Files, ...config.level5Files];
      const files: FileContent[] = [];

      for (const pattern of allPatterns) {
        const uris = await vscode.workspace.findFiles(
          new vscode.RelativePattern(workspaceUri, pattern), exclude, 10
        );
        for (const uri of uris) {
          try {
            const raw = await vscode.workspace.fs.readFile(uri);
            const content = Buffer.from(raw).toString('utf-8');
            if (content.length > 50) {
              files.push({
                path: uri.fsPath,
                content: content.split('\n').slice(0, 500).join('\n'),
                relativePath: vscode.workspace.asRelativePath(uri),
              });
            }
          } catch (err) { logger.warn('Failed to read file during tool detection', { error: err instanceof Error ? err.message : String(err) }); }
        }
      }

      if (files.length > 0) {
        results.push({ tool: toolId as AITool, files, fileCount: files.length });
      }
    }

    return results.sort((a, b) => b.fileCount - a.fileCount);
  }

  async planMigration(
    sourceTool: AITool,
    targetTool: AITool,
    sourceFiles: FileContent[],
    context: ProjectContext,
    token?: vscode.CancellationToken
  ): Promise<MigrationPlan> {
    const sourceConfig = AI_TOOLS[sourceTool];
    const targetConfig = AI_TOOLS[targetTool];

    const fileMapping = this.getFileMapping(sourceTool, targetTool);

    const sourceContents = sourceFiles.slice(0, 10).map(f =>
      `### ${f.relativePath}\n\`\`\`\n${f.content.slice(0, 3000)}\n\`\`\``
    ).join('\n\n');

    const prompt = `You are migrating AI agent configuration from ${sourceConfig.name} to ${targetConfig.name}.

SOURCE TOOL: ${sourceConfig.name}
${sourceConfig?.reasoningContext?.structureExpectations ?? ''}

TARGET TOOL: ${targetConfig.name}
${targetConfig?.reasoningContext?.structureExpectations ?? ''}
${targetConfig?.reasoningContext?.instructionFormat ?? ''}

TARGET QUALITY MARKERS:
${targetConfig?.reasoningContext?.qualityMarkers ?? ''}

FILE MAPPING GUIDE:
${fileMapping}

SOURCE FILES TO MIGRATE:
${sourceContents}

PROJECT CONTEXT:
- Languages: ${context.languages.join(', ')}
- Type: ${context.projectType}
- Package manager: ${context.packageManager}

Generate the migrated files for ${targetConfig.name}. For each source file, create the equivalent target file following ${targetConfig.name}'s exact format, structure, and conventions.

Key transformations:
- Convert file structure to ${targetConfig.name}'s expected directory layout
- Add required frontmatter (${targetTool === 'copilot' ? 'applyTo:' : targetTool === 'cursor' ? 'paths:' : targetTool === 'claude' ? 'paths:' : targetTool === 'windsurf' ? 'trigger:' : targetTool === 'cline' ? 'paths: (if conditional)' : 'numbered filenames'})
- Preserve the actual project-specific content and rules
- Adapt syntax to target tool's conventions
- Keep the business logic and domain knowledge intact

Respond with ONLY valid JSON:
{
  "files": [
    {
      "path": "target/file/path.md",
      "content": "full file content with proper frontmatter",
      "sourceFile": "source/file/path.md",
      "transformations": ["added applyTo frontmatter", "converted to .instructions.md format"]
    }
  ],
  "explanation": "summary of what was migrated and key changes made"
}`;

    let targetFiles: MigrationFile[] = [];
    let explanation = '';

    if (this.copilotClient.isAvailable()) {
      try {
        const response = await this.copilotClient.analyze(prompt, token);
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          targetFiles = Array.isArray(parsed.files) ? parsed.files : [];
          explanation = parsed.explanation || '';
        }
      } catch (err) {
        logger.warn('LLM migration planning failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (targetFiles.length === 0) {
      targetFiles = this.deterministicMigration(sourceTool, targetTool, sourceFiles);
      explanation = `Deterministic migration from ${sourceConfig.name} to ${targetConfig.name}. Review and customize the generated files.`;
    }

    return { sourceTool, targetTool, sourceFiles, targetFiles, explanation };
  }

  private getFileMapping(source: AITool, target: AITool): string {
    const mappings: Record<string, string> = {
      'cline→copilot': `
.clinerules/default-rules.md → .github/copilot-instructions.md
.clinerules/core/project-overview.md → .github/copilot-instructions.md (merge)
.clinerules/core/development-standards.md → .github/instructions/development-standards.instructions.md
.clinerules/core/security-guidelines.md → .github/instructions/security-guidelines.instructions.md
.clinerules/domains/*.md → .github/instructions/{domain}.instructions.md (with applyTo: frontmatter)
.clinerules/safe-commands.md → (include in copilot-instructions.md as "Safe commands" section)
.clinerules/workflows/*.md → .github/prompts/{workflow}.prompt.md
memory-bank/productContext.md → .github/copilot-instructions.md (merge project context)
memory-bank/techContext.md → .github/copilot-instructions.md (merge tech context)`,

      'cline→cursor': `
.clinerules/default-rules.md → .cursor/rules/01-general.md
.clinerules/core/*.md → .cursor/rules/02-{name}.md
.clinerules/domains/*.md → .cursor/rules/03-{domain}.md (with paths: frontmatter)
.clinerules/safe-commands.md → .cursor/rules/04-safe-commands.md
.clinerules/workflows/*.md → .cursor/rules/05-workflows.md`,

      'cline→claude': `
.clinerules/default-rules.md → CLAUDE.md (condensed to <200 lines, use @imports)
.clinerules/core/*.md → .claude/rules/{name}.md
.clinerules/domains/*.md → .claude/rules/{domain}.md (with paths: frontmatter)
.clinerules/safe-commands.md → .claude/rules/safe-commands.md
.clinerules/workflows/*.md → .claude/rules/workflows.md
memory-bank/ → (reference via @import in CLAUDE.md)`,

      'cline→roo': `
.clinerules/default-rules.md → .roo/rules/01-general.md
.clinerules/core/*.md → .roo/rules/02-{name}.md
.clinerules/domains/*.md → .roo/rules-code/{domain}.md
.clinerules/safe-commands.md → .roo/rules/03-safe-commands.md
.clinerules/workflows/*.md → .roo/rules-architect/workflows.md`,

      'cline→windsurf': `
.clinerules/default-rules.md → .windsurf/rules/general.md (trigger: always_on)
.clinerules/core/*.md → .windsurf/rules/{name}.md (trigger: always_on)
.clinerules/domains/*.md → .windsurf/rules/{domain}.md (trigger: glob, globs matching domain paths)
.clinerules/safe-commands.md → .windsurf/rules/safe-commands.md (trigger: always_on)
.clinerules/workflows/*.md → .windsurf/workflows/{name}.md`,

      'copilot→cline': `
.github/copilot-instructions.md → .clinerules/default-rules.md + .clinerules/core/project-overview.md
.github/instructions/*.instructions.md → .clinerules/domains/{name}.md or .clinerules/core/{name}.md
.github/agents/*.agent.md → (no direct Cline equivalent — include agent descriptions in default-rules.md)
.github/skills/*/SKILL.md → .clinerules/workflows/{skill-name}.md`,

      'copilot→cursor': `
.github/copilot-instructions.md → .cursor/rules/01-general.md
.github/instructions/*.instructions.md → .cursor/rules/{name}.md (convert applyTo: to paths:)`,

      'copilot→claude': `
.github/copilot-instructions.md → CLAUDE.md (condensed)
.github/instructions/*.instructions.md → .claude/rules/{name}.md (convert applyTo: to paths:)`,
    };

    const key = `${source}→${target}`;
    return mappings[key] || `No predefined mapping for ${source} → ${target}. LLM will determine best mapping.`;
  }

  private deterministicMigration(source: AITool, target: AITool, sourceFiles: FileContent[]): MigrationFile[] {
    const targetConfig = AI_TOOLS[target];
    const files: MigrationFile[] = [];

    for (const sf of sourceFiles) {
      let targetPath = '';
      const baseName = sf.relativePath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'rules';

      switch (target) {
        case 'copilot':
          if (sf.relativePath.includes('default-rules') || sf.relativePath.includes('copilot-instructions')) {
            targetPath = '.github/copilot-instructions.md';
          } else {
            targetPath = `.github/instructions/${baseName}.instructions.md`;
          }
          break;
        case 'cline':
          if (sf.relativePath.includes('domain') || sf.relativePath.includes('instructions/')) {
            targetPath = `.clinerules/domains/${baseName}.md`;
          } else {
            targetPath = `.clinerules/core/${baseName}.md`;
          }
          break;
        case 'cursor':
          targetPath = `.cursor/rules/${baseName}.md`;
          break;
        case 'claude':
          if (sourceFiles.indexOf(sf) === 0) {
            targetPath = 'CLAUDE.md';
          } else {
            targetPath = `.claude/rules/${baseName}.md`;
          }
          break;
        case 'roo':
          targetPath = `.roo/rules/${baseName}.md`;
          break;
        case 'windsurf':
          targetPath = `.windsurf/rules/${baseName}.md`;
          break;
        default:
          targetPath = `${baseName}.md`;
      }

      files.push({
        path: targetPath,
        content: `# Migrated from ${AI_TOOLS[source].name}\n# Source: ${sf.relativePath}\n# Review and adapt to ${targetConfig.name} conventions\n\n${sf.content}`,
        sourceFile: sf.relativePath,
        transformations: ['copied content', 'needs manual review for target format'],
      });
    }

    return files;
  }

  async previewAndApply(
    plan: MigrationPlan,
    workspaceUri: vscode.Uri
  ): Promise<number> {
    const targetConfig = AI_TOOLS[plan.targetTool];

    const picks = plan.targetFiles.map(f => ({
      label: `$(file-add) ${f.path}`,
      description: `from ${f.sourceFile}`,
      detail: f.transformations.join(', '),
      picked: true,
      file: f,
    }));

    const selected = await vscode.window.showQuickPick(picks, {
      placeHolder: `Select ${targetConfig.name} files to create (${plan.targetFiles.length} files)`,
      canPickMany: true,
    });

    if (!selected || selected.length === 0) return 0;

    let created = 0;
    for (const pick of selected) {
      const uri = vscode.Uri.joinPath(workspaceUri, pick.file.path);
      const parentDir = vscode.Uri.joinPath(workspaceUri, pick.file.path.split('/').slice(0, -1).join('/'));
      try {
        await vscode.workspace.fs.createDirectory(parentDir);
      } catch (err) { logger.warn('Failed to create migration target directory', { error: err instanceof Error ? err.message : String(err) }); }

      try {
        await vscode.workspace.fs.stat(uri);
        const overwrite = await vscode.window.showWarningMessage(
          `${pick.file.path} already exists. Overwrite?`, 'Yes', 'No'
        );
        if (overwrite !== 'Yes') continue;
      } catch (err) { logger.warn('Target file does not exist, will create new', { error: err instanceof Error ? err.message : String(err) }); }

      await vscode.workspace.fs.writeFile(uri, Buffer.from(pick.file.content, 'utf-8'));
      created++;
    }

    return created;
  }
}
