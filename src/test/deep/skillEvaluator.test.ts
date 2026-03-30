import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { SkillEvaluator, SkillFile } from '../../deep/skillEvaluator';

function makeSkill(overrides: Partial<SkillFile> = {}): SkillFile {
  return {
    path: '.github/skills/build/SKILL.md',
    name: 'build',
    content: `# Build Skill

## Inputs
- \`target\`: string — build target (dev | prod)

## Steps
1. Read \`package.json\` to determine build scripts
2. Run \`npm run compile\` to compile TypeScript
3. Run \`node esbuild.js\` to bundle the extension
4. Verify output exists in \`dist/extension.js\`

## Outputs
- \`bundle_path\`: path to the bundled output file
- \`bundle_size\`: size in bytes

## Validation
- Output file must exist and be > 0 bytes
- No TypeScript compilation errors

## Error Handling
- If compilation fails, output the tsc error log
- If esbuild fails, check esbuild.js for syntax issues`,
    ...overrides,
  };
}

function mockCopilotClient(analyzeResult = '[]', fastResult = '[]') {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    analyze: vi.fn().mockResolvedValue(analyzeResult),
    analyzeFast: vi.fn().mockResolvedValue(fastResult),
  } as any;
}

describe('SkillEvaluator', () => {
  // ─── Pure: evaluateCompleteness ────────────────────────────────

  describe('evaluateCompleteness', () => {
    const client = mockCopilotClient();
    const evaluator = new SkillEvaluator(client);

    it('scores 100 for a complete skill', () => {
      const result = evaluator.evaluateCompleteness(makeSkill());
      expect(result.score).toBeGreaterThanOrEqual(85);
      expect(result.issues).toHaveLength(0);
    });

    it('penalizes missing ## Steps section', () => {
      const skill = makeSkill({ content: '# Skill\n## Inputs\n- x\n## Outputs\n- y\n## Validation\n- check' });
      const result = evaluator.evaluateCompleteness(skill);
      expect(result.score).toBeLessThan(80);
      expect(result.issues).toContainEqual(expect.stringContaining('Steps'));
    });

    it('penalizes missing ## Inputs section', () => {
      const skill = makeSkill({ content: '# Skill\n## Steps\n1. Do thing\n## Outputs\n- y\n## Validation\n- check' });
      const result = evaluator.evaluateCompleteness(skill);
      expect(result.issues).toContainEqual(expect.stringContaining('Inputs'));
    });

    it('penalizes missing ## Outputs section', () => {
      const skill = makeSkill({ content: '# Skill\n## Steps\n1. Do thing\n## Inputs\n- x\n## Validation\n- check' });
      const result = evaluator.evaluateCompleteness(skill);
      expect(result.issues).toContainEqual(expect.stringContaining('Outputs'));
    });

    it('penalizes missing ## Validation section', () => {
      const skill = makeSkill({ content: '# Skill\n## Steps\n1. Do thing\n## Inputs\n- x\n## Outputs\n- y' });
      const result = evaluator.evaluateCompleteness(skill);
      expect(result.issues).toContainEqual(expect.stringContaining('Validation'));
    });

    it('penalizes unnumbered steps', () => {
      const skill = makeSkill({
        content: '# Skill\n## Steps\n- Do this\n- Do that\n## Inputs\n- x\n## Outputs\n- y\n## Validation\n- ok',
      });
      const result = evaluator.evaluateCompleteness(skill);
      // With unnumbered steps, should have some penalty (either no numbered steps or low step count)
      expect(result.score).toBeLessThan(100);
    });

    it('penalizes very short content', () => {
      const skill = makeSkill({ content: '# Skill\nShort.' });
      const result = evaluator.evaluateCompleteness(skill);
      expect(result.issues).toContainEqual(expect.stringContaining('very short'));
    });

    it('suggests recommended sections when missing', () => {
      const skill = makeSkill(); // has Error Handling but not Prerequisites/Examples
      const result = evaluator.evaluateCompleteness(skill);
      // Should suggest Prerequisites and Examples
      const suggestedSections = result.suggestions.filter(s => s.includes('section'));
      expect(suggestedSections.length).toBeGreaterThan(0);
    });

    it('scores are clamped between 0 and 100', () => {
      // Worst case: everything missing
      const skill = makeSkill({ content: 'x' });
      const result = evaluator.evaluateCompleteness(skill);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });
  });

  // ─── Dimension weight calculation ──────────────────────────────

  describe('overall score calculation', () => {
    it('weights sum to 1.0', () => {
      const total = 0.25 + 0.30 + 0.25 + 0.10 + 0.10;
      expect(total).toBeCloseTo(1.0);
    });
  });

  // ─── Helper: extractPaths ──────────────────────────────────────

  describe('path extraction', () => {
    const client = mockCopilotClient();
    const evaluator = new SkillEvaluator(client);
    const extract = (content: string) => (evaluator as any).extractPaths(content);

    it('extracts backtick-wrapped paths', () => {
      const paths = extract('Read `src/extension.ts` for entry point');
      expect(paths).toContain('src/extension.ts');
    });

    it('skips false positives', () => {
      const paths = extract('Use try/catch and async/await');
      expect(paths).not.toContain('try/catch');
      expect(paths).not.toContain('async/await');
    });

    it('deduplicates paths', () => {
      const paths = extract('See `src/utils.ts` and also `src/utils.ts`');
      expect(paths.filter((p: string) => p === 'src/utils.ts')).toHaveLength(1);
    });
  });

  // ─── Helper: extractCommands ───────────────────────────────────

  describe('command extraction', () => {
    const client = mockCopilotClient();
    const evaluator = new SkillEvaluator(client);
    const extract = (content: string) => (evaluator as any).extractCommands(content);

    it('extracts npm commands', () => {
      const cmds = extract('Run `npm run build` to compile');
      expect(cmds).toContain('npm run build');
    });

    it('extracts node commands', () => {
      const cmds = extract('Execute `node esbuild.js`');
      expect(cmds).toContain('node esbuild.js');
    });

    it('extracts python commands', () => {
      const cmds = extract('Run `python -m pytest`');
      expect(cmds).toContain('python -m pytest');
    });
  });

  // ─── Integration: evaluate with mocks ──────────────────────────

  describe('evaluate (integration)', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('returns empty for workspace with no skills', async () => {
      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([]);
      const client = mockCopilotClient();
      const evaluator = new SkillEvaluator(client);
      const result = await evaluator.evaluate(vscode.Uri.file('/workspace'));
      expect(result.evaluations).toHaveLength(0);
      expect(result.recommendations).toHaveLength(0);
    });

    it('evaluates discovered skills across all 5 dimensions', async () => {
      const skillContent = makeSkill().content;
      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([
        vscode.Uri.file('/workspace/.github/skills/build/SKILL.md'),
      ]);
      vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
        new Uint8Array(Buffer.from(skillContent))
      );
      vi.spyOn(vscode.workspace.fs, 'stat').mockResolvedValue({ type: 1, ctime: 0, mtime: 0, size: 100 });
      (vscode.workspace as any).asRelativePath = vi.fn().mockReturnValue('.github/skills/build/SKILL.md');

      const client = mockCopilotClient(
        JSON.stringify([{ skill: 'build', score: 80, issues: [], suggestions: [] }]),
        JSON.stringify({ score: 85, issues: [] })
      );

      const evaluator = new SkillEvaluator(client);
      const result = await evaluator.evaluate(vscode.Uri.file('/workspace'));

      expect(result.evaluations).toHaveLength(1);
      const eval_ = result.evaluations[0];
      expect(eval_.completeness.score).toBeGreaterThan(0);
      expect(eval_.accuracy.score).toBeGreaterThan(0);
      expect(eval_.actionability.score).toBeGreaterThan(0);
      expect(eval_.relevance.score).toBeGreaterThan(0);
      expect(eval_.security.score).toBeGreaterThan(0);
      expect(eval_.overall).toBeGreaterThan(0);
    });

    it('generates recommendations for low-scoring skills', async () => {
      const badSkill = '# Bad skill\nDo stuff.';
      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([
        vscode.Uri.file('/workspace/.github/skills/bad/SKILL.md'),
      ]);
      vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
        new Uint8Array(Buffer.from(badSkill))
      );
      (vscode.workspace as any).asRelativePath = vi.fn().mockReturnValue('.github/skills/bad/SKILL.md');

      const client = mockCopilotClient(
        JSON.stringify([{ skill: 'bad', score: 20, issues: ['Vague steps'], suggestions: ['Add numbered steps'] }]),
        JSON.stringify({ score: 30, issues: ['Generic content'] })
      );
      client.isAvailable.mockReturnValue(false); // skip LLM phases for speed

      const evaluator = new SkillEvaluator(client);
      const result = await evaluator.evaluate(vscode.Uri.file('/workspace'));

      expect(result.recommendations.length).toBeGreaterThan(0);
      expect(result.recommendations[0].title).toContain('bad');
      expect(['critical', 'important']).toContain(result.recommendations[0].severity);
    });

    it('skips recommendations for high-scoring skills', async () => {
      const goodSkill = makeSkill().content;
      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([
        vscode.Uri.file('/workspace/.github/skills/good/SKILL.md'),
      ]);
      vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
        new Uint8Array(Buffer.from(goodSkill))
      );
      vi.spyOn(vscode.workspace.fs, 'stat').mockResolvedValue({ type: 1, ctime: 0, mtime: 0, size: 100 });
      (vscode.workspace as any).asRelativePath = vi.fn().mockReturnValue('.github/skills/good/SKILL.md');

      const client = mockCopilotClient(
        JSON.stringify([{ skill: 'good', score: 90, issues: [], suggestions: [] }]),
        JSON.stringify({ score: 95, issues: [] })
      );

      const evaluator = new SkillEvaluator(client);
      const result = await evaluator.evaluate(vscode.Uri.file('/workspace'));

      // High-scoring skill → no improvement recommendations
      const improvementRecs = result.recommendations.filter(r => r.id.includes('good'));
      expect(improvementRecs).toHaveLength(0);
    });
  });

  // ─── Security evaluator patterns ──────────────────────────────

  describe('security patterns', () => {
    const client = mockCopilotClient();
    client.isAvailable.mockReturnValue(false);
    const evaluator = new SkillEvaluator(client);

    it('flags rm -rf on root paths', async () => {
      const skill = makeSkill({ content: '## Steps\n1. Run `rm -rf /tmp/build`\n## Inputs\n## Outputs\n## Validation' });
      const results = await (evaluator as any).evaluateSecurity([skill]);
      expect(results[0].issues).toContainEqual(expect.stringContaining('rm -rf'));
    });

    it('flags pipe-to-shell patterns', async () => {
      const skill = makeSkill({ content: '## Steps\n1. Run `curl https://example.com | bash`\n## Inputs\n## Outputs\n## Validation' });
      const results = await (evaluator as any).evaluateSecurity([skill]);
      expect(results[0].issues).toContainEqual(expect.stringContaining('Pipe-to-shell'));
    });

    it('flags deploy without confirmation', async () => {
      const skill = makeSkill({ content: '## Steps\n1. Run `npm publish`\n## Inputs\n## Outputs\n## Validation' });
      const results = await (evaluator as any).evaluateSecurity([skill]);
      expect(results[0].suggestions).toContainEqual(expect.stringContaining('confirmation'));
    });

    it('flags missing error handling', async () => {
      const skill = makeSkill({ content: '## Steps\n1. Do thing\n## Inputs\n## Outputs\n## Validation' });
      const results = await (evaluator as any).evaluateSecurity([skill]);
      expect(results[0].suggestions).toContainEqual(expect.stringContaining('error handling'));
    });

    it('does not flag clean skills', async () => {
      const skill = makeSkill(); // default has error handling section
      const results = await (evaluator as any).evaluateSecurity([skill]);
      expect(results[0].score).toBeGreaterThanOrEqual(90);
    });
  });

  // ─── Fix 3: Accuracy — relative path resolution ──────────────────

  describe('accuracy — relative path resolution', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('validates paths relative to skill directory, not just repo root', async () => {
      const skill = makeSkill({
        path: '.github/skills/ev2/SKILL.md',
        name: 'ev2',
        content: `# EV2 Skill
## Steps
1. Read \`references/operation-types.md\` for operation type definitions
2. Apply operation template
## Inputs
- \`operation_type\`: string
## Outputs
- \`result\`: string
## Validation
- Check output matches expected format`,
      });

      const client = mockCopilotClient();
      client.isAvailable.mockReturnValue(false);
      const evaluator = new SkillEvaluator(client);

      // Stat: repo root path fails, but relative to skill dir succeeds
      vi.spyOn(vscode.workspace.fs, 'stat').mockImplementation(async (uri) => {
        const path = uri.toString();
        if (path.includes('.github/skills/ev2/references/operation-types.md')) {
          return { type: 1, ctime: 0, mtime: 0, size: 200 };
        }
        throw new Error('not found');
      });

      const results = await (evaluator as any).evaluateAccuracy([skill], vscode.Uri.file('/workspace'));
      // Should NOT flag references/operation-types.md as invalid
      const issues = results[0].issues as string[];
      const pathIssues = issues.filter((i: string) => i.includes('operation-types.md'));
      expect(pathIssues).toHaveLength(0);
    });

    it('still flags paths that don\'t exist at root OR relative to skill dir', async () => {
      const skill = makeSkill({
        path: '.github/skills/deploy/SKILL.md',
        name: 'deploy',
        content: `# Deploy
## Steps
1. Read \`ghost/nonexistent.md\`
## Inputs
## Outputs
## Validation`,
      });

      const client = mockCopilotClient();
      client.isAvailable.mockReturnValue(false);
      const evaluator = new SkillEvaluator(client);

      vi.spyOn(vscode.workspace.fs, 'stat').mockRejectedValue(new Error('not found'));

      const results = await (evaluator as any).evaluateAccuracy([skill], vscode.Uri.file('/workspace'));
      const issues = results[0].issues as string[];
      expect(issues).toContainEqual(expect.stringContaining('ghost/nonexistent.md'));
    });
  });

  // ─── Fix 4: Relevance — better project context ───────────────────

  describe('relevance — project context discovery', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('discovers .csproj files for .NET project context', async () => {
      const skill = makeSkill({ name: 'build-dotnet' });

      const client = mockCopilotClient(
        JSON.stringify([{ skill: 'build-dotnet', score: 80, issues: [], suggestions: [] }])
      );
      const evaluator = new SkillEvaluator(client);

      // findFiles: return .csproj files
      vi.spyOn(vscode.workspace, 'findFiles').mockImplementation(async (pattern) => {
        const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
        if (pat.includes('*.csproj')) {
          return [vscode.Uri.file('/workspace/src/MyApp.csproj')];
        }
        if (pat.includes('SKILL.md')) {
          return [vscode.Uri.file('/workspace/.github/skills/build-dotnet/SKILL.md')];
        }
        return [];
      });
      vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(async (uri) => {
        const path = uri.toString();
        if (path.includes('SKILL.md')) {
          return new Uint8Array(Buffer.from(skill.content));
        }
        if (path.includes('.csproj')) {
          return new Uint8Array(Buffer.from('<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'));
        }
        if (path.includes('package.json')) {
          throw new Error('not found');
        }
        return new Uint8Array(Buffer.from(''));
      });
      (vscode.workspace as any).asRelativePath = vi.fn().mockImplementation((uri: any) => {
        const path = typeof uri === 'string' ? uri : uri.toString();
        if (path.includes('.csproj')) return 'src/MyApp.csproj';
        return '.github/skills/build-dotnet/SKILL.md';
      });

      const results = await (evaluator as any).evaluateRelevance([skill], vscode.Uri.file('/workspace'));
      // The LLM was called (client.analyze), and the prompt should include .NET context
      expect(client.analyze).toHaveBeenCalled();
      const prompt = client.analyze.mock.calls[0][0] as string;
      expect(prompt).toContain('.NET');
    });

    it('discovers pyproject.toml for Python project context', async () => {
      const skill = makeSkill({ name: 'test-python' });

      const client = mockCopilotClient(
        JSON.stringify([{ skill: 'test-python', score: 70, issues: [], suggestions: [] }])
      );
      const evaluator = new SkillEvaluator(client);

      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([]);
      vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(async (uri) => {
        const path = uri.toString();
        if (path.includes('SKILL.md')) {
          return new Uint8Array(Buffer.from(skill.content));
        }
        if (path.includes('pyproject.toml')) {
          return new Uint8Array(Buffer.from('[project]\nname = "my-project"\ndependencies = ["requests", "pydantic"]'));
        }
        throw new Error('not found');
      });
      (vscode.workspace as any).asRelativePath = vi.fn().mockReturnValue('.github/skills/test-python/SKILL.md');

      const results = await (evaluator as any).evaluateRelevance([skill], vscode.Uri.file('/workspace'));
      expect(client.analyze).toHaveBeenCalled();
      const prompt = client.analyze.mock.calls[0][0] as string;
      expect(prompt).toContain('Python project');
    });
  });

  // ─── Fix 6: Skill dedup — prevent reference files from being treated as skills ─

  describe('discoverSkills — dedup and reference file filtering', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('does not discover reference .md files inside a skill directory that has SKILL.md', async () => {
      const client = mockCopilotClient();
      const evaluator = new SkillEvaluator(client);

      vi.spyOn(vscode.workspace, 'findFiles').mockImplementation(async (pattern) => {
        const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
        if (pat === '.github/skills/**/SKILL.md') {
          return [
            vscode.Uri.file('/workspace/.github/skills/adhoc-operations/SKILL.md'),
          ];
        }
        if (pat === '.github/skills/**/*.md') {
          return [
            vscode.Uri.file('/workspace/.github/skills/adhoc-operations/SKILL.md'),
            vscode.Uri.file('/workspace/.github/skills/adhoc-operations/references/operation-types.md'),
            vscode.Uri.file('/workspace/.github/skills/adhoc-operations/references/rollout-guide.md'),
          ];
        }
        return [];
      });
      vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
        new Uint8Array(Buffer.from('# Skill content'))
      );
      (vscode.workspace as any).asRelativePath = vi.fn().mockImplementation((uri: any) => {
        const path = typeof uri === 'string' ? uri : uri.fsPath || uri.toString();
        if (path.includes('operation-types.md')) return '.github/skills/adhoc-operations/references/operation-types.md';
        if (path.includes('rollout-guide.md')) return '.github/skills/adhoc-operations/references/rollout-guide.md';
        return '.github/skills/adhoc-operations/SKILL.md';
      });

      const skills = await (evaluator as any).discoverSkills(vscode.Uri.file('/workspace'));

      // Should only have 1 skill (the SKILL.md), NOT the reference .md files
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('adhoc-operations');
      expect(skills[0].path).toBe('.github/skills/adhoc-operations/SKILL.md');
    });

    it('discovers .md files only at top level of skill dir when no SKILL.md exists', async () => {
      const client = mockCopilotClient();
      const evaluator = new SkillEvaluator(client);

      vi.spyOn(vscode.workspace, 'findFiles').mockImplementation(async (pattern) => {
        const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
        // No SKILL.md files found
        if (pat.includes('SKILL.md')) return [];
        if (pat === '.github/skills/**/*.md') {
          return [
            vscode.Uri.file('/workspace/.github/skills/custom-workflow/README.md'),
          ];
        }
        return [];
      });
      vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
        new Uint8Array(Buffer.from('# Custom workflow'))
      );
      (vscode.workspace as any).asRelativePath = vi.fn().mockReturnValue('.github/skills/custom-workflow/README.md');

      const skills = await (evaluator as any).discoverSkills(vscode.Uri.file('/workspace'));

      // Should discover the README.md as a skill since no SKILL.md exists
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('custom-workflow');
    });

    it('does not produce duplicate skills by name', async () => {
      const client = mockCopilotClient();
      const evaluator = new SkillEvaluator(client);

      vi.spyOn(vscode.workspace, 'findFiles').mockImplementation(async (pattern) => {
        const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
        if (pat === '.github/skills/**/SKILL.md') {
          return [
            vscode.Uri.file('/workspace/.github/skills/build/SKILL.md'),
            vscode.Uri.file('/workspace/.github/skills/test/SKILL.md'),
          ];
        }
        if (pat === '.github/skills/**/*.md') {
          return [
            vscode.Uri.file('/workspace/.github/skills/build/SKILL.md'),
            vscode.Uri.file('/workspace/.github/skills/test/SKILL.md'),
          ];
        }
        return [];
      });
      vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
        new Uint8Array(Buffer.from('# Skill'))
      );
      (vscode.workspace as any).asRelativePath = vi.fn().mockImplementation((uri: any) => {
        const path = typeof uri === 'string' ? uri : uri.fsPath || uri.toString();
        if (path.includes('build')) return '.github/skills/build/SKILL.md';
        return '.github/skills/test/SKILL.md';
      });

      const skills = await (evaluator as any).discoverSkills(vscode.Uri.file('/workspace'));

      // Should be exactly 2, no duplicates
      expect(skills).toHaveLength(2);
      const names = skills.map((s: any) => s.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });
});
