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
import { buildGuidedFixPrompt, parseFixResponse } from '../fixPrompts';
import { validateFixFiles } from '../fixValidator';
import { logger } from '../../logging';

// Maps signal IDs to the config files they typically modify
const SIGNAL_FILE_MAP: Record<string, string[]> = {
  gitignore_comprehensive: ['.gitignore'],
  dependency_update_automation: ['.github/dependabot.yml', 'renovate.json'],
  pre_commit_hooks: ['.pre-commit-config.yaml', '.husky/pre-commit'],
  test_coverage_thresholds: ['jest.config.js', 'jest.config.ts', '.nycrc', 'vitest.config.ts'],
  single_command_setup: ['Makefile', 'package.json', 'scripts/setup.sh'],
  lint_config: ['.eslintrc.json', '.eslintrc.js', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs'],
  formatter: ['.prettierrc', '.prettierrc.json', '.editorconfig'],
  type_check: ['tsconfig.json', 'pyrightconfig.json', 'mypy.ini'],
  strict_typing: ['tsconfig.json', 'pyrightconfig.json', 'mypy.ini'],
  cyclomatic_complexity: ['.eslintrc.json', 'eslint.config.js', '.pylintrc'],
  dead_code_detection: ['tsconfig.json', '.eslintrc.json'],
  duplicate_code_detection: ['.jscpd.json', '.eslintrc.json'],
  tech_debt_tracking: ['.github/labels.yml', 'TODO.md'],
  code_quality_metrics: ['sonar-project.properties', '.codeclimate.yml'],
  issue_labeling_system: ['.github/labels.yml'],
  release_automation: ['.github/workflows/release.yml', '.releaserc.json'],
  release_notes_automation: ['.github/workflows/release.yml', 'cliff.toml'],
  unused_dependencies_detection: ['package.json', '.depcheckrc'],
  unit_tests_runnable: ['package.json', 'Makefile'],
  devcontainer_runnable: ['.devcontainer/devcontainer.json'],
  local_services_setup: ['docker-compose.yml', 'docker-compose.yaml'],
  instruction_accuracy: ['.github/copilot-instructions.md', '.clinerules/default-rules.md', '.cursorrules', 'CLAUDE.md', '.roorules', '.windsurf/rules/default.md'],
  memory_bank_accuracy: ['memory-bank/projectbrief.md', 'memory-bank/productContext.md', 'memory-bank/techContext.md'],
};

export class GuidedFixGenerator {
  constructor(private copilotClient: CopilotClient) {}

  async generateFix(
    signal: FailingSignal,
    context: ProjectContext,
    workspaceUri: vscode.Uri,
    selectedTool: AITool,
    token?: vscode.CancellationToken
  ): Promise<RemediationFix | null> {
    const candidateFiles = SIGNAL_FILE_MAP[signal.id] ?? [];
    let existingFilePath: string | undefined;
    let existingContent = '';

    // Find the first existing file to modify
    for (const candidatePath of candidateFiles) {
      const fileUri = vscode.Uri.joinPath(workspaceUri, candidatePath);
      try {
        const content = await vscode.workspace.fs.readFile(fileUri);
        existingContent = Buffer.from(content).toString('utf-8');
        existingFilePath = candidatePath;
        break;
      } catch (err) {
        logger.warn('Failed to read candidate file', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // If no existing file found, fall back to creating a new one
    if (!existingFilePath) {
      existingFilePath = candidateFiles[0] ?? `${signal.id}-config`;
      existingContent = '';
    }

    const prompt = await buildGuidedFixPrompt(signal, context, existingContent, selectedTool);

    let response: string;
    try {
      response = await this.copilotClient.analyze(prompt, token);
    } catch (error) {
      logger.error(
        `[GuidedFix] LLM call failed for ${signal.id}:`,
        error
      );
      return null;
    }

    const parsed = parseFixResponse(response);
    if (!parsed?.files || parsed.files.length === 0) {
      logger.error(
        `[GuidedFix] Failed to parse LLM response for ${signal.id}`
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
        `[GuidedFix] Validation failed for ${signal.id}: ${errors}`
      );
      return null;
    }

    const fixFiles: FixFile[] = parsed.files.map((f) => ({
      path: f.path,
      action: existingContent ? ('modify' as const) : ('create' as const),
      content: f.content,
      originalContent: existingContent || undefined,
    }));

    return {
      signalId: signal.id,
      tier: 'guided',
      files: fixFiles,
      explanation:
        parsed.explanation ?? `Guided fix for ${signal.id}`,
    };
  }
}
