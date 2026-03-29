import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { CrossRefEngine } from '../../deep/crossRefEngine';
import { InstructionProfile, CodebaseProfile, ModuleProfile, InstructionClaim, CoverageGap } from '../../deep/types';

function makeModule(overrides: Partial<ModuleProfile> = {}): ModuleProfile {
  return {
    path: 'src/default.ts',
    language: 'TypeScript',
    lines: 100,
    exports: ['doStuff'],
    exportCount: 1,
    importCount: 2,
    fanIn: 0,
    hasTests: false,
    hasDocstring: false,
    complexity: 'low',
    role: 'core-logic',
    ...overrides,
  };
}

function makeInstructions(overrides: Partial<InstructionProfile> = {}): InstructionProfile {
  return {
    files: [],
    claims: [],
    coveredPaths: new Set<string>(),
    coveredWorkflows: [],
    mentionedTechStack: [],
    totalTokens: 0,
    ...overrides,
  };
}

function makeCodebase(overrides: Partial<CodebaseProfile> = {}): CodebaseProfile {
  return {
    name: 'test-workspace',
    languages: ['TypeScript'],
    frameworks: [],
    entryPoints: [],
    modules: [],
    pipelines: [],
    totalFiles: 0,
    totalExports: 0,
    hotspots: [],
    untestedModules: [],
    undocumentedModules: [],
    ...overrides,
  };
}

function makeClaim(overrides: Partial<InstructionClaim> = {}): InstructionClaim {
  return {
    category: 'path-reference',
    claim: 'src/utils.ts',
    sourceFile: '.github/copilot-instructions.md',
    sourceLine: 5,
    confidence: 0.9,
    ...overrides,
  };
}

function mockCopilotClient(analyzeResult = '[]') {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    analyze: vi.fn().mockResolvedValue(analyzeResult),
    analyzeFast: vi.fn().mockResolvedValue(analyzeResult),
  } as any;
}

describe('CrossRefEngine', () => {
  // ─── Pure: findCoverageGaps ────────────────────────────────────────

  describe('findCoverageGaps', () => {
    const engine = new CrossRefEngine();
    const findGaps = (instructions: InstructionProfile, codebase: CodebaseProfile) =>
      (engine as any).findCoverageGaps(instructions, codebase);

    it('returns only missing-skill gaps for empty codebase (no modules to cover)', () => {
      const gaps = findGaps(makeInstructions(), makeCodebase());
      // No uncovered-module gaps, but still generates missing-skill for core workflows
      const moduleGaps = gaps.filter((g: CoverageGap) => g.type === 'uncovered-module');
      expect(moduleGaps).toHaveLength(0);
      const skillGaps = gaps.filter((g: CoverageGap) => g.type === 'missing-skill');
      expect(skillGaps.length).toBe(5);
    });

    it('detects uncovered critical modules (high fan-in)', () => {
      const codebase = makeCodebase({
        modules: [
          makeModule({ path: 'src/engine.ts', fanIn: 5, lines: 200, role: 'core-logic' }),
        ],
      });
      const gaps = findGaps(makeInstructions(), codebase);
      expect(gaps).toContainEqual(
        expect.objectContaining({ type: 'uncovered-module', severity: 'critical', module: 'src/engine.ts' })
      );
    });

    it('detects uncovered entry points as critical', () => {
      const codebase = makeCodebase({
        modules: [
          makeModule({ path: 'src/extension.ts', role: 'entry-point', fanIn: 0, lines: 300 }),
        ],
      });
      const gaps = findGaps(makeInstructions(), codebase);
      expect(gaps).toContainEqual(
        expect.objectContaining({ type: 'uncovered-module', severity: 'critical', module: 'src/extension.ts' })
      );
    });

    it('marks medium fan-in modules as important', () => {
      const codebase = makeCodebase({
        modules: [
          makeModule({ path: 'src/helper.ts', fanIn: 3, lines: 150, role: 'core-logic' }),
        ],
      });
      const gaps = findGaps(makeInstructions(), codebase);
      expect(gaps).toContainEqual(
        expect.objectContaining({ severity: 'important', module: 'src/helper.ts' })
      );
    });

    it('marks low-priority modules as suggestion', () => {
      const codebase = makeCodebase({
        modules: [
          makeModule({ path: 'src/small.ts', fanIn: 2, lines: 250, role: 'core-logic' }),
        ],
      });
      const gaps = findGaps(makeInstructions(), codebase);
      expect(gaps).toContainEqual(
        expect.objectContaining({ severity: 'suggestion', module: 'src/small.ts' })
      );
    });

    it('does not flag modules that are covered by instructions', () => {
      const instructions = makeInstructions({
        coveredPaths: new Set(['src/engine.ts']),
      });
      const codebase = makeCodebase({
        modules: [
          makeModule({ path: 'src/engine.ts', fanIn: 5, lines: 200 }),
        ],
      });
      const gaps = findGaps(instructions, codebase);
      const engineGap = gaps.find((g: CoverageGap) => g.module === 'src/engine.ts');
      expect(engineGap).toBeUndefined();
    });

    it('does not flag modules covered by directory match', () => {
      const instructions = makeInstructions({
        coveredPaths: new Set(['src/scoring']),
      });
      const codebase = makeCodebase({
        modules: [
          makeModule({ path: 'src/scoring/engine.ts', fanIn: 4, lines: 300 }),
        ],
      });
      const gaps = findGaps(instructions, codebase);
      const scoringGap = gaps.find((g: CoverageGap) => g.module === 'src/scoring/engine.ts');
      expect(scoringGap).toBeUndefined();
    });

    it('skips test and type-def modules', () => {
      const codebase = makeCodebase({
        modules: [
          makeModule({ path: 'src/engine.test.ts', role: 'test', fanIn: 0 }),
          makeModule({ path: 'src/types.ts', role: 'type-def', fanIn: 3 }),
        ],
      });
      const gaps = findGaps(makeInstructions(), codebase);
      // No uncovered-module gaps for test/type-def (only missing-skill suggestions)
      const moduleGaps = gaps.filter((g: CoverageGap) => g.type === 'uncovered-module');
      expect(moduleGaps).toHaveLength(0);
    });

    it('skips config modules', () => {
      const codebase = makeCodebase({
        modules: [
          makeModule({ path: 'vitest.config.ts', role: 'config', fanIn: 5, lines: 50 }),
        ],
      });
      const gaps = findGaps(makeInstructions(), codebase);
      // No uncovered-module gaps for config (only missing-skill suggestions)
      const moduleGaps = gaps.filter((g: CoverageGap) => g.type === 'uncovered-module');
      expect(moduleGaps).toHaveLength(0);
    });

    it('detects uncovered directories with 3+ modules', () => {
      const codebase = makeCodebase({
        modules: [
          makeModule({ path: 'src/deep/a.ts', fanIn: 2, lines: 100, role: 'core-logic' }),
          makeModule({ path: 'src/deep/b.ts', fanIn: 2, lines: 100, role: 'core-logic' }),
          makeModule({ path: 'src/deep/c.ts', fanIn: 2, lines: 100, role: 'core-logic' }),
        ],
      });
      const gaps = findGaps(makeInstructions(), codebase);
      const dirGap = gaps.find((g: CoverageGap) => g.module === 'src/deep/');
      expect(dirGap).toBeDefined();
      expect(dirGap!.severity).toBe('important');
    });

    it('detects uncovered pipelines', () => {
      const codebase = makeCodebase({
        pipelines: [
          { name: 'scan-pipeline', entryPoint: 'src/extension.ts', steps: [{ file: 'src/extension.ts', order: 1 }, { file: 'src/scanner.ts', order: 2 }] },
        ],
      });
      const gaps = findGaps(makeInstructions(), codebase);
      expect(gaps).toContainEqual(
        expect.objectContaining({ type: 'uncovered-pipeline', severity: 'important' })
      );
    });

    it('does not flag pipelines when workflow files exist', () => {
      const instructions = makeInstructions({
        files: [{ path: '.github/skills/scan/SKILL.md', content: '', tool: 'copilot', type: 'workflow', tokens: 10 }],
      });
      const codebase = makeCodebase({
        pipelines: [
          { name: 'scan-pipeline', entryPoint: 'src/ext.ts', steps: [{ file: 'src/ext.ts', order: 1 }] },
        ],
      });
      const gaps = findGaps(instructions, codebase);
      const pipelineGap = gaps.find((g: CoverageGap) => g.type === 'uncovered-pipeline');
      expect(pipelineGap).toBeUndefined();
    });

    it('detects hotspots without docstrings', () => {
      const codebase = makeCodebase({
        hotspots: ['src/engine.ts'],
        modules: [
          makeModule({ path: 'src/engine.ts', hasDocstring: false, fanIn: 5, lines: 500 }),
        ],
      });
      const gaps = findGaps(makeInstructions(), codebase);
      expect(gaps).toContainEqual(
        expect.objectContaining({ type: 'weak-description', module: 'src/engine.ts' })
      );
    });

    it('detects missing core skills (build, test, deploy, lint, release)', () => {
      const gaps = findGaps(makeInstructions(), makeCodebase());
      const skillGaps = gaps.filter((g: CoverageGap) => g.type === 'missing-skill');
      expect(skillGaps.length).toBe(5);
      const names = skillGaps.map((g: CoverageGap) => g.module);
      expect(names).toContain('build');
      expect(names).toContain('test');
      expect(names).toContain('deploy');
      expect(names).toContain('lint');
      expect(names).toContain('release');
    });

    it('sorts gaps by severity: critical > important > suggestion', () => {
      const codebase = makeCodebase({
        modules: [
          makeModule({ path: 'src/critical.ts', fanIn: 5, role: 'entry-point', lines: 300 }),
          makeModule({ path: 'src/important.ts', fanIn: 3, lines: 200, role: 'core-logic' }),
          makeModule({ path: 'src/suggestion.ts', fanIn: 2, lines: 250, role: 'core-logic' }),
        ],
      });
      const gaps: CoverageGap[] = findGaps(makeInstructions(), codebase);
      const moduleGaps = gaps.filter(g => g.type === 'uncovered-module');
      expect(moduleGaps[0].severity).toBe('critical');
    });
  });

  // ─── Pure: scoreQuality ────────────────────────────────────────────

  describe('scoreQuality', () => {
    const engine = new CrossRefEngine();
    const score = (instructions: InstructionProfile, codebase: CodebaseProfile) =>
      (engine as any).scoreQuality(instructions, codebase);

    it('returns 0 specificity for instructions with no path references', () => {
      const q = score(
        makeInstructions({ files: [{ path: 'test.md', content: 'Some general advice', tool: 'copilot', type: 'root-instruction', tokens: 10 }] }),
        makeCodebase()
      );
      expect(q.specificity).toBe(0);
    });

    it('increases specificity with more path references per line', () => {
      const claims = Array(10).fill(null).map((_, i) => makeClaim({ claim: `src/file${i}.ts` }));
      const content = Array(20).fill('some line').join('\n');
      const q = score(
        makeInstructions({
          claims,
          files: [{ path: 'inst.md', content, tool: 'copilot', type: 'root-instruction', tokens: 100 }],
        }),
        makeCodebase()
      );
      expect(q.specificity).toBeGreaterThan(0);
    });

    it('gives 50 accuracy when no path references exist', () => {
      const q = score(makeInstructions(), makeCodebase());
      expect(q.accuracy).toBe(50);
    });

    it('gives 100 accuracy when all referenced paths exist', () => {
      const claims = [makeClaim({ claim: 'src/engine.ts' })];
      const modules = [makeModule({ path: 'src/engine.ts' })];
      const q = score(
        makeInstructions({ claims }),
        makeCodebase({ modules })
      );
      expect(q.accuracy).toBe(100);
    });

    it('gives 0 accuracy when no referenced paths exist', () => {
      const claims = [makeClaim({ claim: 'src/nonexistent.ts' })];
      const q = score(
        makeInstructions({ claims }),
        makeCodebase({ modules: [makeModule({ path: 'src/other.ts' })] })
      );
      expect(q.accuracy).toBe(0);
    });

    it('calculates coverage based on critical modules', () => {
      const modules = [
        makeModule({ path: 'src/engine.ts', role: 'core-logic', lines: 200 }),
        makeModule({ path: 'src/parser.ts', role: 'core-logic', lines: 150 }),
      ];
      const instructions = makeInstructions({
        coveredPaths: new Set(['src/engine.ts']),
      });
      const q = score(instructions, makeCodebase({ modules }));
      expect(q.coverage).toBe(50); // 1 of 2 critical modules covered
    });

    it('penalizes freshness for TODO/FIXME markers', () => {
      const content = 'TODO: fix this\nFIXME: broken\nTBD: decide later';
      const q = score(
        makeInstructions({
          files: [{ path: 'test.md', content, tool: 'copilot', type: 'root-instruction', tokens: 10 }],
        }),
        makeCodebase()
      );
      expect(q.freshness).toBeLessThan(100);
    });

    it('gives 100 freshness for clean content', () => {
      const content = 'Clean instructions with no issues';
      const q = score(
        makeInstructions({
          files: [{ path: 'test.md', content, tool: 'copilot', type: 'root-instruction', tokens: 10 }],
        }),
        makeCodebase()
      );
      expect(q.freshness).toBe(100);
    });

    it('increases actionability with more bullet points', () => {
      const bulletContent = '- Rule one\n- Rule two\n- Rule three\n- Rule four\n- Rule five';
      const proseContent = 'This is a long paragraph explaining things in detail without any structure.';
      const qBullet = score(
        makeInstructions({
          files: [{ path: 'test.md', content: bulletContent, tool: 'copilot', type: 'root-instruction', tokens: 10 }],
        }),
        makeCodebase()
      );
      const qProse = score(
        makeInstructions({
          files: [{ path: 'test.md', content: proseContent, tool: 'copilot', type: 'root-instruction', tokens: 10 }],
        }),
        makeCodebase()
      );
      expect(qBullet.actionability).toBeGreaterThan(qProse.actionability);
    });

    it('overall is a weighted composite of all dimensions', () => {
      const q = score(makeInstructions(), makeCodebase());
      expect(q.overall).toBeGreaterThanOrEqual(0);
      expect(q.overall).toBeLessThanOrEqual(100);
      // Verify it's roughly the weighted sum
      const expected = Math.round(
        q.specificity * 0.15 + q.accuracy * 0.25 + q.coverage * 0.25 +
        q.freshness * 0.10 + q.actionability * 0.15 + q.efficiency * 0.10
      );
      expect(q.overall).toBe(expected);
    });

    it('all dimensions are 0-100', () => {
      const q = score(
        makeInstructions({
          claims: Array(100).fill(null).map((_, i) => makeClaim({ claim: `path${i}`, confidence: 0.9 })),
          files: [{ path: 'test.md', content: 'x\n'.repeat(5), tool: 'copilot', type: 'root-instruction', tokens: 50 }],
          totalTokens: 50,
        }),
        makeCodebase()
      );
      for (const key of ['specificity', 'accuracy', 'coverage', 'freshness', 'actionability', 'efficiency']) {
        expect(q[key]).toBeGreaterThanOrEqual(0);
        expect(q[key]).toBeLessThanOrEqual(100);
      }
    });
  });

  // ─── With mocks: full analyze ──────────────────────────────────────

  describe('analyze (integration)', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('combines gaps, drift, and quality into CrossRefResult', async () => {
      const instructions = makeInstructions({
        claims: [makeClaim({ claim: 'src/missing.ts' })],
        coveredPaths: new Set<string>(),
        files: [{ path: 'inst.md', content: '# Instructions', tool: 'copilot', type: 'root-instruction', tokens: 10 }],
      });
      const codebase = makeCodebase({
        modules: [
          makeModule({ path: 'src/engine.ts', fanIn: 5, lines: 200, role: 'entry-point' }),
        ],
      });

      // Mock vscode.workspace.fs.stat to reject (path doesn't exist)
      vi.spyOn(vscode.workspace.fs, 'stat').mockRejectedValue(new Error('not found'));

      const engine = new CrossRefEngine();
      const result = await engine.analyze(instructions, codebase, vscode.Uri.file('/workspace'));

      expect(result.coverageGaps.length).toBeGreaterThan(0);
      expect(result.driftIssues.length).toBeGreaterThan(0); // path drift for src/missing.ts
      expect(result.instructionQuality).toBeDefined();
      expect(result.coveragePercent).toBeDefined();
      expect(result.coveragePercent).toBe(0); // engine.ts not in coveredPaths
    });

    it('calculates correct coverage percent', async () => {
      // Use different directories so directory-level match doesn't cover both
      const instructions = makeInstructions({
        coveredPaths: new Set(['lib/engine.ts']),
        files: [{ path: 'inst.md', content: '`lib/engine.ts`', tool: 'copilot', type: 'root-instruction', tokens: 10 }],
      });
      const codebase = makeCodebase({
        modules: [
          makeModule({ path: 'lib/engine.ts', role: 'core-logic', lines: 200 }),
          makeModule({ path: 'pkg/parser.ts', role: 'core-logic', lines: 150 }),
        ],
      });

      const engine = new CrossRefEngine();
      const result = await engine.analyze(instructions, codebase, vscode.Uri.file('/workspace'));

      expect(result.coveragePercent).toBe(50); // 1/2 critical modules
    });

    it('uses LLM for semantic drift when available', async () => {
      const instructions = makeInstructions({
        claims: [makeClaim({ category: 'architecture', claim: 'Engine is a scoring module' })],
        coveredPaths: new Set(['src/engine.ts']),
        files: [{ path: 'inst.md', content: '`src/engine.ts`', tool: 'copilot', type: 'root-instruction', tokens: 10 }],
      });
      const codebase = makeCodebase({
        modules: [makeModule({ path: 'src/engine.ts', fanIn: 5, lines: 200 })],
        hotspots: ['src/engine.ts'],
      });

      vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
        new Uint8Array(Buffer.from('export function validate() {}'))
      );

      const client = mockCopilotClient(JSON.stringify([
        { file: 'src/engine.ts', issue: 'Claims scoring but actually validates', severity: 'important' }
      ]));

      const engine = new CrossRefEngine(client);
      const result = await engine.analyze(instructions, codebase, vscode.Uri.file('/workspace'));

      expect(client.analyze).toHaveBeenCalled();
      const semanticDrift = result.driftIssues.filter(d => d.type === 'semantic-drift');
      expect(semanticDrift.length).toBeGreaterThan(0);
    });
  });
});
