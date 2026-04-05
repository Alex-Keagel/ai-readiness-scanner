import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutputValidator, GeneratedFile, ValidationIssue } from '../../deep/outputValidator';

function mockCopilotClient(fastResult = '[]') {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    analyze: vi.fn().mockResolvedValue(fastResult),
    analyzeFast: vi.fn().mockResolvedValue(fastResult),
  } as any;
}

describe('OutputValidator', () => {
  // ─── Pure: runDeterministicChecks ──────────────────────────────────

  describe('runDeterministicChecks', () => {
    const client = mockCopilotClient();
    const validator = new OutputValidator(client);
    const check = (files: GeneratedFile[]) =>
      (validator as any).runDeterministicChecks(files);

    it('returns empty for valid files', () => {
      const issues = check([
        { filePath: '.github/copilot-instructions.md', content: '# Instructions\nUse strict mode always.' },
      ]);
      expect(issues).toEqual([]);
    });

    // ── Path validation ──

    it('rejects empty file path', () => {
      const issues: ValidationIssue[] = check([{ filePath: '', content: 'content' }]);
      expect(issues).toContainEqual(
        expect.objectContaining({ severity: 'error', issue: expect.stringContaining('Invalid file path') })
      );
    });

    it('rejects paths with .. traversal', () => {
      const issues: ValidationIssue[] = check([{ filePath: '../../../etc/passwd', content: 'content' }]);
      expect(issues).toContainEqual(
        expect.objectContaining({ severity: 'error', issue: expect.stringContaining('Invalid file path') })
      );
    });

    it('rejects absolute paths', () => {
      const issues: ValidationIssue[] = check([{ filePath: '/usr/bin/evil', content: 'content' }]);
      expect(issues).toContainEqual(
        expect.objectContaining({ severity: 'error', issue: expect.stringContaining('Invalid file path') })
      );
    });

    // ── Content validation ──

    it('rejects empty content', () => {
      const issues: ValidationIssue[] = check([{ filePath: 'test.md', content: '' }]);
      expect(issues).toContainEqual(
        expect.objectContaining({ severity: 'error', issue: expect.stringContaining('empty') })
      );
    });

    it('rejects very short content', () => {
      const issues: ValidationIssue[] = check([{ filePath: 'test.md', content: 'hi' }]);
      expect(issues).toContainEqual(
        expect.objectContaining({ severity: 'error', issue: expect.stringContaining('empty or too short') })
      );
    });

    // ── Code fence wrapping ──

    it('rejects content wrapped in code fences', () => {
      const issues: ValidationIssue[] = check([
        { filePath: 'test.md', content: '```markdown\n# Title\nContent\n```' },
      ]);
      expect(issues).toContainEqual(
        expect.objectContaining({ severity: 'error', issue: expect.stringContaining('code fences') })
      );
    });

    it('allows content with code fences in the middle (not wrapping)', () => {
      const issues: ValidationIssue[] = check([
        { filePath: 'test.md', content: '# Title\n\nSome text\n```js\nconst x = 1;\n```\nMore text.' },
      ]);
      const fenceIssue = issues.find(i => i.issue.includes('code fences'));
      expect(fenceIssue).toBeUndefined();
    });

    // ── JSON validation ──

    it('rejects invalid JSON in .json files', () => {
      const issues: ValidationIssue[] = check([
        { filePath: 'config.json', content: '{ invalid json }' },
      ]);
      expect(issues).toContainEqual(
        expect.objectContaining({ severity: 'error', issue: expect.stringContaining('invalid JSON') })
      );
    });

    it('accepts valid JSON in .json files', () => {
      const issues: ValidationIssue[] = check([
        { filePath: 'config.json', content: '{"key": "value", "num": 42}' },
      ]);
      const jsonIssue = issues.find(i => i.issue.includes('JSON'));
      expect(jsonIssue).toBeUndefined();
    });

    it('rejects JSON files with // comments', () => {
      const issues: ValidationIssue[] = check([
        { filePath: 'tsconfig.json', content: '{\n  // This is a comment\n  "key": "value"\n}' },
      ]);
      expect(issues).toContainEqual(
        expect.objectContaining({ severity: 'error', issue: expect.stringContaining('comments') })
      );
    });

    // ── Instruction file frontmatter ──

    it('warns about .instructions.md without frontmatter', () => {
      const issues: ValidationIssue[] = check([
        { filePath: '.github/instructions/utils.instructions.md', content: '# Utils Instructions\nSome rules here.' },
      ]);
      expect(issues).toContainEqual(
        expect.objectContaining({ severity: 'warning', issue: expect.stringContaining('frontmatter') })
      );
    });

    it('does not warn about .instructions.md with frontmatter', () => {
      const issues: ValidationIssue[] = check([
        { filePath: '.github/instructions/utils.instructions.md', content: '---\napplyTo: "src/utils.ts"\n---\n# Utils' },
      ]);
      const fmIssue = issues.find(i => i.issue.includes('frontmatter'));
      expect(fmIssue).toBeUndefined();
    });

    // ── Agent file validation ──

    it('warns about .agent.md missing name/description', () => {
      const issues: ValidationIssue[] = check([
        { filePath: '.github/agents/scanner.agent.md', content: '# Scanner Agent\nDoes scanning stuff.' },
      ]);
      expect(issues).toContainEqual(
        expect.objectContaining({ severity: 'warning', issue: expect.stringContaining('name/description') })
      );
    });

    it('does not warn about .agent.md with proper frontmatter', () => {
      const issues: ValidationIssue[] = check([
        { filePath: '.github/agents/scanner.agent.md', content: '---\nname: scanner\ndescription: Scans repos\n---\n# Scanner' },
      ]);
      const agentIssue = issues.find(i => i.issue.includes('name/description'));
      expect(agentIssue).toBeUndefined();
    });

    // ── Skill file validation ──

    it('warns about SKILL.md missing ## Steps', () => {
      const issues: ValidationIssue[] = check([
        { filePath: '.github/skills/build/SKILL.md', content: '# Build Skill\nBuild things.\n## Usage\nDo stuff.' },
      ]);
      expect(issues).toContainEqual(
        expect.objectContaining({ severity: 'warning', issue: expect.stringContaining('Steps') })
      );
    });

    it('does not warn about SKILL.md with ## Steps', () => {
      const issues: ValidationIssue[] = check([
        { filePath: '.github/skills/build/SKILL.md', content: '# Build Skill\n## Steps\n1. Run npm build' },
      ]);
      const stepIssue = issues.find(i => i.issue.includes('Steps'));
      expect(stepIssue).toBeUndefined();
    });

    // ── Meta-commentary detection ──

    it('warns about meta-commentary in non-md files', () => {
      const issues: ValidationIssue[] = check([
        { filePath: 'src/config.ts', content: 'This file is the main configuration module for the app.' },
      ]);
      expect(issues).toContainEqual(
        expect.objectContaining({ severity: 'warning', issue: expect.stringContaining('description of the file') })
      );
    });

    it('does not warn about meta-commentary in .md files', () => {
      const issues: ValidationIssue[] = check([
        { filePath: 'docs/README.md', content: 'This file is the main documentation for the project.' },
      ]);
      const metaIssue = issues.find(i => i.issue.includes('description of the file'));
      expect(metaIssue).toBeUndefined();
    });

    // ── Multiple files ──

    it('validates multiple files independently', () => {
      const issues: ValidationIssue[] = check([
        { filePath: 'good.md', content: '# Good file with enough content here' },
        { filePath: '', content: 'bad path' },
        { filePath: 'config.json', content: '{invalid}' },
      ]);
      // Should have issues for the bad path and invalid JSON
      expect(issues.length).toBeGreaterThanOrEqual(2);
      const pathIssue = issues.find(i => i.file === '');
      const jsonIssue = issues.find(i => i.file === 'config.json');
      expect(pathIssue).toBeDefined();
      expect(jsonIssue).toBeDefined();
    });
  });

  // ─── Integration: validate ─────────────────────────────────────────

  describe('validate', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('returns valid=true for empty file list', async () => {
      const client = mockCopilotClient();
      const validator = new OutputValidator(client);
      const result = await validator.validate([], 'test task');
      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('returns valid=true when client is unavailable', async () => {
      const client = mockCopilotClient();
      client.isAvailable.mockReturnValue(false);
      const validator = new OutputValidator(client);
      const result = await validator.validate(
        [{ filePath: 'test.md', content: '# Valid content' }],
        'test task'
      );
      expect(result.valid).toBe(true);
    });

    it('short-circuits on deterministic errors without calling LLM', async () => {
      const client = mockCopilotClient();
      const validator = new OutputValidator(client);
      const result = await validator.validate(
        [{ filePath: '', content: '' }],
        'test task'
      );
      expect(result.valid).toBe(false);
      expect(client.analyzeFast).not.toHaveBeenCalled();
    });

    it('calls LLM validation after deterministic checks pass', async () => {
      const client = mockCopilotClient('[]');
      const validator = new OutputValidator(client);
      const result = await validator.validate(
        [{ filePath: '.github/copilot-instructions.md', content: '# Instructions\nUse strict TypeScript.' }],
        'Generate instructions'
      );
      expect(result.valid).toBe(true);
      expect(client.analyzeFast).toHaveBeenCalled();
    });

    it('combines deterministic warnings with LLM issues', async () => {
      const client = mockCopilotClient(JSON.stringify([
        { file: 'test.instructions.md', severity: 'warning', issue: 'Content is too generic' }
      ]));
      const validator = new OutputValidator(client);
      const result = await validator.validate(
        [{ filePath: '.github/instructions/test.instructions.md', content: '# Test instructions without frontmatter but long enough to pass.' }],
        'Generate instructions'
      );
      // Should have both the frontmatter warning and the LLM warning
      expect(result.issues.length).toBeGreaterThanOrEqual(2);
    });

    it('marks as invalid when LLM returns error-severity issue', async () => {
      const client = mockCopilotClient(JSON.stringify([
        { file: 'wrong.ts', severity: 'error', issue: 'Hallucinated module references' }
      ]));
      const validator = new OutputValidator(client);
      const result = await validator.validate(
        [{ filePath: 'wrong.ts', content: 'This file contains valid-looking TypeScript content for testing.' }],
        'Generate code'
      );
      expect(result.valid).toBe(false);
    });

    it('handles LLM returning invalid JSON gracefully', async () => {
      const client = mockCopilotClient('not valid json');
      const validator = new OutputValidator(client);
      const result = await validator.validate(
        [{ filePath: 'test.md', content: '# Valid content with enough text here' }],
        'test task'
      );
      // Should fall back to deterministic only
      expect(result.valid).toBe(true);
    });

    it('handles LLM throwing error gracefully', async () => {
      const client = mockCopilotClient();
      client.analyzeFast.mockRejectedValue(new Error('Network error'));
      const validator = new OutputValidator(client);
      const result = await validator.validate(
        [{ filePath: 'test.md', content: '# Valid content with enough text here' }],
        'test task'
      );
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });
  });
});
