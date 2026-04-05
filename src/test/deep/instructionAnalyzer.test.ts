import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { InstructionAnalyzer } from '../../deep/instructionAnalyzer';
import { InstructionFile } from '../../deep/types';

function makeFile(overrides: Partial<InstructionFile> = {}): InstructionFile {
  return {
    path: '.github/copilot-instructions.md',
    content: '# Instructions\n',
    tool: 'copilot',
    type: 'root-instruction',
    tokens: 10,
    ...overrides,
  };
}

function mockCopilotClient(analyzeResult = '{}') {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    analyze: vi.fn().mockResolvedValue(analyzeResult),
    analyzeFast: vi.fn().mockResolvedValue(analyzeResult),
    getModelName: vi.fn().mockReturnValue('gpt-4'),
    getFastModelName: vi.fn().mockReturnValue('gpt-4-mini'),
  } as any;
}

describe('InstructionAnalyzer', () => {
  // ─── Pure: extractRegexClaims ──────────────────────────────────────

  describe('extractRegexClaims', () => {
    const analyzer = new InstructionAnalyzer();
    const extract = (content: string) =>
      (analyzer as any).extractRegexClaims(makeFile({ content }));

    it('finds backtick-wrapped path references', () => {
      const claims = extract('See `src/utils/helper.ts` for details');
      expect(claims).toContainEqual(
        expect.objectContaining({ category: 'path-reference', claim: 'src/utils/helper.ts' })
      );
    });

    it('finds path references after prepositions', () => {
      const claims = extract('Look in src/scoring/types.ts for types');
      expect(claims).toContainEqual(
        expect.objectContaining({ category: 'path-reference', claim: 'src/scoring/types.ts' })
      );
    });

    it('skips false positive paths like try/catch', () => {
      const claims = extract('Use try/catch for error handling');
      const pathClaims = claims.filter((c: any) => c.category === 'path-reference');
      expect(pathClaims).not.toContainEqual(
        expect.objectContaining({ claim: 'try/catch' })
      );
    });

    it('skips false positive paths like async/await', () => {
      const claims = extract('Always use async/await');
      const pathClaims = claims.filter((c: any) => c.category === 'path-reference');
      expect(pathClaims).not.toContainEqual(
        expect.objectContaining({ claim: 'async/await' })
      );
    });

    it('skips false positive paths like input/output', () => {
      const claims = extract('Handle input/output carefully');
      const pathClaims = claims.filter((c: any) => c.category === 'path-reference');
      expect(pathClaims).not.toContainEqual(
        expect.objectContaining({ claim: 'input/output' })
      );
    });

    it('strips leading ./ from paths', () => {
      const claims = extract('Edit `./src/extension.ts`');
      expect(claims).toContainEqual(
        expect.objectContaining({ claim: 'src/extension.ts' })
      );
    });

    it('finds npm/npx commands', () => {
      const claims = extract('Run `npm run build` to compile');
      expect(claims).toContainEqual(
        expect.objectContaining({ category: 'command', claim: 'npm run build' })
      );
    });

    it('finds yarn/pnpm commands', () => {
      const claims = extract('Execute `yarn test` and `pnpm install`');
      expect(claims).toContainEqual(
        expect.objectContaining({ category: 'command', claim: 'yarn test' })
      );
      expect(claims).toContainEqual(
        expect.objectContaining({ category: 'command', claim: 'pnpm install' })
      );
    });

    it('finds go/cargo commands', () => {
      const claims = extract('Run `go test ./...` or `cargo build`');
      expect(claims).toContainEqual(
        expect.objectContaining({ category: 'command', claim: 'go test ./...' })
      );
      expect(claims).toContainEqual(
        expect.objectContaining({ category: 'command', claim: 'cargo build' })
      );
    });

    it('finds tech stack mentions', () => {
      const claims = extract('This project uses TypeScript with Node.js');
      expect(claims).toContainEqual(
        expect.objectContaining({ category: 'tech-stack' })
      );
    });

    it('finds convention claims starting with always/never/must', () => {
      const claims = extract('- Always use strict mode\n- Never use any types');
      const conventions = claims.filter((c: any) => c.category === 'convention');
      expect(conventions.length).toBe(2);
      expect(conventions[0].claim).toContain('Always use strict mode');
      expect(conventions[1].claim).toContain('Never use any types');
    });

    it('finds convention claims with should/prefer/avoid', () => {
      const claims = extract('- Should use interfaces\n* Prefer const over let\n- Avoid global state');
      const conventions = claims.filter((c: any) => c.category === 'convention');
      expect(conventions.length).toBe(3);
    });

    it('does not match convention on non-bullet lines', () => {
      const claims = extract('Always use strict mode');
      const conventions = claims.filter((c: any) => c.category === 'convention');
      expect(conventions.length).toBe(0);
    });

    it('records correct source file and line numbers', () => {
      const claims = extract('Line1\n`src/app/main.ts`\nLine3');
      const pathClaim = claims.find((c: any) => c.category === 'path-reference');
      expect(pathClaim).toBeDefined();
      expect(pathClaim.sourceFile).toBe('.github/copilot-instructions.md');
      expect(pathClaim.sourceLine).toBe(2);
    });

    it('handles empty content', () => {
      const claims = extract('');
      expect(claims).toEqual([]);
    });

    it('handles content with no claims', () => {
      const claims = extract('This is a simple paragraph with no paths or commands.');
      expect(claims).toEqual([]);
    });

    it('finds multiple paths on the same line', () => {
      const claims = extract('See `src/a/b.ts` and `src/c/d.ts`');
      const pathClaims = claims.filter((c: any) => c.category === 'path-reference');
      // Both regex patterns may match, producing duplicates — at least 2 unique paths
      const uniquePaths = new Set(pathClaims.map((c: any) => c.claim));
      expect(uniquePaths.has('src/a/b.ts')).toBe(true);
      expect(uniquePaths.has('src/c/d.ts')).toBe(true);
    });

    it('skips paths shorter than 4 chars', () => {
      const claims = extract('See `a/b`');
      const pathClaims = claims.filter((c: any) => c.category === 'path-reference');
      expect(pathClaims.length).toBe(0);
    });

    // ─── isLikelyPath filter tests ─────────────────────────────────

    it('rejects ARM/Ev2 as a prose reference, not a filesystem path', () => {
      const claims = extract('Never commit secrets in ARM/Ev2 artifacts');
      const pathClaims = claims.filter((c: any) => c.category === 'path-reference');
      expect(pathClaims).not.toContainEqual(
        expect.objectContaining({ claim: 'ARM/Ev2' })
      );
    });

    it('rejects OneBranch/ZTS as Azure DevOps folder, not filesystem path', () => {
      const claims = extract('Pipeline runs in the `OneBranch/ZTS` folder');
      const pathClaims = claims.filter((c: any) => c.category === 'path-reference');
      expect(pathClaims).not.toContainEqual(
        expect.objectContaining({ claim: 'OneBranch/ZTS' })
      );
    });

    it('rejects CI/CD as prose concept', () => {
      const claims = extract('Set up CI/CD pipelines');
      const pathClaims = claims.filter((c: any) => c.category === 'path-reference');
      expect(pathClaims).not.toContainEqual(
        expect.objectContaining({ claim: 'CI/CD' })
      );
    });

    it('accepts real paths with file extensions', () => {
      const claims = extract('Edit `references/operation-types.md` for details');
      const pathClaims = claims.filter((c: any) => c.category === 'path-reference');
      expect(pathClaims).toContainEqual(
        expect.objectContaining({ claim: 'references/operation-types.md' })
      );
    });

    it('accepts paths with known directory prefixes like src/', () => {
      const claims = extract('See `src/common` for shared code');
      const pathClaims = claims.filter((c: any) => c.category === 'path-reference');
      expect(pathClaims).toContainEqual(
        expect.objectContaining({ claim: 'src/common' })
      );
    });

    it('accepts paths starting with .github/', () => {
      const claims = extract('Look at `.github/workflows`');
      const pathClaims = claims.filter((c: any) => c.category === 'path-reference');
      expect(pathClaims).toContainEqual(
        expect.objectContaining({ claim: '.github/workflows' })
      );
    });

    it('accepts deep paths with 3+ segments', () => {
      const claims = extract('The file at `deploy/ev2/biceps/main.bicep`');
      const pathClaims = claims.filter((c: any) => c.category === 'path-reference');
      expect(pathClaims).toContainEqual(
        expect.objectContaining({ claim: 'deploy/ev2/biceps/main.bicep' })
      );
    });

    it('accepts paths with dots/dashes/underscores in segments', () => {
      const claims = extract('Edit `python-workspace/components/bot_detection`');
      const pathClaims = claims.filter((c: any) => c.category === 'path-reference');
      expect(pathClaims).toContainEqual(
        expect.objectContaining({ claim: 'python-workspace/components/bot_detection' })
      );
    });

    it('resolves paths relative to cd context', () => {
      // The line wraps the whole command in backticks — the command extractor fires,
      // then path extraction from within the command resolves cd context
      const claims = extract('1. Run the formatter:\n```powershell\ncd python-workspace && ./scripts/format.ps1\n```');
      const pathClaims = claims.filter((c: any) => c.category === 'path-reference');
      expect(pathClaims).toContainEqual(
        expect.objectContaining({ claim: 'python-workspace/scripts/format.ps1' })
      );
    });

    it('does not double-prefix when path already starts with cd target', () => {
      const claims = extract('Run `cd python-workspace && python-workspace/scripts/lint.ps1`');
      const pathClaims = claims.filter((c: any) => c.category === 'path-reference');
      // Should NOT produce python-workspace/python-workspace/scripts/lint.ps1
      const doublePrefix = pathClaims.filter((c: any) => c.claim.includes('python-workspace/python-workspace'));
      expect(doublePrefix).toHaveLength(0);
    });
  });

  // ─── Pure: extractScope ────────────────────────────────────────────

  describe('extractScope', () => {
    const analyzer = new InstructionAnalyzer();
    const scope = (content: string) => (analyzer as any).extractScope(content);

    it('extracts applyTo from YAML frontmatter', () => {
      // Regex captures the value after the key, trimmed — quotes are part of content
      const result = scope('---\napplyTo: "src/**/*.ts"\n---');
      expect(result).toContain('src/**/*.ts');
    });

    it('extracts paths directive', () => {
      expect(scope('paths: src/scoring/')).toBe('src/scoring/');
    });

    it('extracts glob directive', () => {
      expect(scope('glob: **/*.test.ts')).toBe('**/*.test.ts');
    });

    it('returns undefined when no scope found', () => {
      expect(scope('# Just a heading\nSome content')).toBeUndefined();
    });
  });

  // ─── With mocks: analyze ───────────────────────────────────────────

  describe('analyze', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('returns empty profile when no files found', async () => {
      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([]);
      const analyzer = new InstructionAnalyzer();
      const profile = await analyzer.analyze(vscode.Uri.file('/workspace'));

      expect(profile.files).toHaveLength(0);
      expect(profile.claims).toHaveLength(0);
      expect(profile.totalTokens).toBe(0);
    });

    it('discovers and parses instruction files', async () => {
      const content = '# Instructions\nSee `src/extension.ts` for entry point\n- Always use strict mode';
      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([
        vscode.Uri.file('/workspace/.github/copilot-instructions.md'),
      ]);
      vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
        new Uint8Array(Buffer.from(content))
      );
      // Add asRelativePath mock
      (vscode.workspace as any).asRelativePath = vi.fn().mockReturnValue('.github/copilot-instructions.md');

      const analyzer = new InstructionAnalyzer();
      const profile = await analyzer.analyze(vscode.Uri.file('/workspace'), 'copilot');

      expect(profile.files.length).toBeGreaterThanOrEqual(1);
      expect(profile.claims.length).toBeGreaterThan(0);
      expect(profile.coveredPaths.has('src/extension.ts')).toBe(true);
    });

    it('uses LLM claims when copilotClient is available', async () => {
      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([
        vscode.Uri.file('/workspace/.github/copilot-instructions.md'),
      ]);
      vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
        new Uint8Array(Buffer.from('# Instructions'))
      );
      (vscode.workspace as any).asRelativePath = vi.fn().mockReturnValue('.github/copilot-instructions.md');

      const client = mockCopilotClient(JSON.stringify({
        architectureClaims: [{ claim: 'Extension uses command pattern', confidence: 0.8 }],
        workflowClaims: [{ claim: 'Build via esbuild', confidence: 0.9 }],
      }));

      const analyzer = new InstructionAnalyzer(client);
      const profile = await analyzer.analyze(vscode.Uri.file('/workspace'), 'copilot');

      expect(client.analyze).toHaveBeenCalled();
      const archClaims = profile.claims.filter(c => c.category === 'architecture');
      expect(archClaims.length).toBeGreaterThan(0);
    });

    it('gracefully handles LLM failure', async () => {
      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([
        vscode.Uri.file('/workspace/.github/copilot-instructions.md'),
      ]);
      vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
        new Uint8Array(Buffer.from('# Test'))
      );
      (vscode.workspace as any).asRelativePath = vi.fn().mockReturnValue('.github/copilot-instructions.md');

      const client = mockCopilotClient();
      client.analyze.mockRejectedValue(new Error('LLM service unavailable'));

      const analyzer = new InstructionAnalyzer(client);
      const profile = await analyzer.analyze(vscode.Uri.file('/workspace'), 'copilot');

      // Should not throw, just use regex claims
      expect(profile).toBeDefined();
      expect(profile.files.length).toBeGreaterThanOrEqual(1);
    });

    it('handles LLM returning invalid JSON', async () => {
      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([
        vscode.Uri.file('/workspace/CLAUDE.md'),
      ]);
      vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
        new Uint8Array(Buffer.from('# Claude instructions'))
      );
      (vscode.workspace as any).asRelativePath = vi.fn().mockReturnValue('CLAUDE.md');

      const client = mockCopilotClient('Not valid JSON at all');
      const analyzer = new InstructionAnalyzer(client);
      const profile = await analyzer.analyze(vscode.Uri.file('/workspace'), 'claude');

      expect(profile).toBeDefined();
    });
  });
});
