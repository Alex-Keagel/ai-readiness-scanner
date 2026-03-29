import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';

export interface GeneratedFile {
  filePath: string;
  content: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface ValidationIssue {
  file: string;
  severity: 'error' | 'warning';
  issue: string;
  suggestion?: string;
}

/**
 * Validates LLM-generated file output for format correctness and content quality.
 * Uses a separate LLM call (validator agent) to check the generator agent's output.
 */
export class OutputValidator {
  constructor(private copilotClient: CopilotClient) {}

  async validate(
    files: GeneratedFile[],
    originalTask: string,
  ): Promise<ValidationResult> {
    if (!this.copilotClient.isAvailable() || files.length === 0) {
      return { valid: true, issues: [] };
    }

    const timer = logger.time('OutputValidator');

    // Quick deterministic checks first (no LLM needed)
    const deterministicIssues = this.runDeterministicChecks(files);
    if (deterministicIssues.some(i => i.severity === 'error')) {
      timer?.end?.();
      return { valid: false, issues: deterministicIssues };
    }

    // LLM validation — check content quality and appropriateness
    try {
      const llmIssues = await this.runLLMValidation(files, originalTask);
      const allIssues = [...deterministicIssues, ...llmIssues];
      const valid = !allIssues.some(i => i.severity === 'error');

      timer?.end?.();
      logger.info(`OutputValidator: ${files.length} files, ${allIssues.length} issues, valid=${valid}`);
      return { valid, issues: allIssues };
    } catch (err) {
      timer?.end?.();
      logger.debug('OutputValidator: LLM validation failed, using deterministic only', err);
      return { valid: deterministicIssues.length === 0, issues: deterministicIssues };
    }
  }

  private runDeterministicChecks(files: GeneratedFile[]): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const f of files) {
      // Check: file path looks valid
      if (!f.filePath || f.filePath.includes('..') || f.filePath.startsWith('/')) {
        issues.push({ file: f.filePath, severity: 'error', issue: 'Invalid file path — must be relative, no ".." traversal', suggestion: 'Use a path relative to the workspace root' });
      }

      // Check: content is not empty
      if (!f.content || f.content.trim().length < 10) {
        issues.push({ file: f.filePath, severity: 'error', issue: 'File content is empty or too short', suggestion: 'Generate meaningful content for this file' });
      }

      // Check: content doesn't contain markdown code fences wrapping the whole thing
      if (f.content.trimStart().startsWith('```') && f.content.trimEnd().endsWith('```')) {
        issues.push({ file: f.filePath, severity: 'error', issue: 'Content is wrapped in markdown code fences — this would corrupt the file', suggestion: 'Remove the ``` wrapping and output raw file content' });
      }

      // Check: .json files are valid JSON
      if (f.filePath.endsWith('.json')) {
        try { JSON.parse(f.content); }
        catch { issues.push({ file: f.filePath, severity: 'error', issue: 'JSON file contains invalid JSON', suggestion: 'Fix JSON syntax errors' }); }
      }

      // Check: .json files don't have // comments
      if (f.filePath.endsWith('.json') && /^\s*\/\//m.test(f.content)) {
        issues.push({ file: f.filePath, severity: 'error', issue: 'JSON file contains // comments — JSON does not support comments', suggestion: 'Remove all comments from JSON content' });
      }

      // Check: .md instruction files have proper frontmatter if scoped
      if (f.filePath.includes('.instructions.md') && !f.content.includes('---')) {
        issues.push({ file: f.filePath, severity: 'warning', issue: 'Instruction file missing YAML frontmatter (---)', suggestion: 'Add applyTo frontmatter at the top' });
      }

      // Check: .agent.md files have required YAML frontmatter
      if (f.filePath.includes('.agent.md') && (!f.content.includes('name:') || !f.content.includes('description:'))) {
        issues.push({ file: f.filePath, severity: 'warning', issue: 'Agent file missing required name/description in YAML frontmatter' });
      }

      // Check: SKILL.md files have steps
      if (f.filePath.includes('SKILL.md') && !f.content.includes('## Steps') && !f.content.includes('## steps')) {
        issues.push({ file: f.filePath, severity: 'warning', issue: 'Skill file missing ## Steps section' });
      }

      // Check: content is not a description OF the file (meta-commentary)
      if (f.content.match(/^This file (is|contains|defines|provides|serves as)/m) && f.filePath.endsWith('.md')) {
        // OK for .md files
      } else if (f.content.match(/^This file (is|contains|defines)/m)) {
        issues.push({ file: f.filePath, severity: 'warning', issue: 'Content appears to be a description of the file rather than the actual file content' });
      }
    }

    return issues;
  }

  private async runLLMValidation(files: GeneratedFile[], originalTask: string): Promise<ValidationIssue[]> {
    const fileSummary = files.map(f => {
      const preview = f.content.slice(0, 500);
      return `FILE: ${f.filePath} (${f.content.length} chars)\nPREVIEW:\n${preview}${f.content.length > 500 ? '\n...(truncated)' : ''}`;
    }).join('\n\n---\n\n');

    const prompt = `You are a code review validator. Check if these generated files are correct and appropriate.

ORIGINAL TASK: ${originalTask}

GENERATED FILES:
${fileSummary}

Check each file for:
1. Does the file path make sense for this type of content? (e.g., .instructions.md should be in .github/instructions/)
2. Is the content appropriate for the file type? (not a README in a .ts file, not code in a .md meant for instructions)
3. Does the content actually address the original task?
4. Are there any hallucinated paths, functions, or modules referenced that likely don't exist?
5. Is the content specific enough, or is it generic boilerplate?

Only report actual problems. If everything looks good, return an empty array.

Respond ONLY as JSON: [{"file":"path","severity":"error|warning","issue":"description","suggestion":"how to fix"}]`;

    const response = await this.copilotClient.analyzeFast(prompt);
    const match = response.match(/\[[\s\S]*\]/);
    if (!match) return [];

    try {
      return JSON.parse(match[0]) as ValidationIssue[];
    } catch { return []; }
  }
}
