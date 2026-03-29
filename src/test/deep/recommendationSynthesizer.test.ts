import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecommendationSynthesizer } from '../../deep/recommendationSynthesizer';
import {
  CrossRefResult, CoverageGap, DriftIssue, DeepRecommendation,
  CodebaseProfile, InstructionProfile, ModuleProfile, InstructionQuality,
} from '../../deep/types';

function makeModule(overrides: Partial<ModuleProfile> = {}): ModuleProfile {
  return {
    path: 'src/default.ts', language: 'TypeScript', lines: 100,
    exports: ['doStuff'], exportCount: 1, importCount: 2,
    fanIn: 0, hasTests: false, hasDocstring: false,
    complexity: 'low', role: 'core-logic',
    ...overrides,
  };
}

function makeQuality(overrides: Partial<InstructionQuality> = {}): InstructionQuality {
  return {
    specificity: 60, accuracy: 80, coverage: 70,
    freshness: 90, actionability: 50, efficiency: 60, overall: 68,
    ...overrides,
  };
}

function makeCodebase(overrides: Partial<CodebaseProfile> = {}): CodebaseProfile {
  return {
    name: 'test', languages: ['TypeScript'], frameworks: [],
    entryPoints: [], modules: [], pipelines: [],
    totalFiles: 0, totalExports: 0, hotspots: [],
    untestedModules: [], undocumentedModules: [],
    ...overrides,
  };
}

function makeInstructions(overrides: Partial<InstructionProfile> = {}): InstructionProfile {
  return {
    files: [], claims: [],
    coveredPaths: new Set<string>(), coveredWorkflows: [],
    mentionedTechStack: [], totalTokens: 0,
    ...overrides,
  };
}

function makeCrossRef(overrides: Partial<CrossRefResult> = {}): CrossRefResult {
  return {
    coverageGaps: [], driftIssues: [],
    instructionQuality: makeQuality(),
    coveragePercent: 50,
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

describe('RecommendationSynthesizer', () => {
  // ─── Pure: gapToRec ────────────────────────────────────────────────

  describe('gapToRec', () => {
    const client = mockCopilotClient();
    const synth = new RecommendationSynthesizer(client);
    const gapToRec = (gap: CoverageGap, codebase: CodebaseProfile) =>
      (synth as any).gapToRec(gap, codebase, 'copilot');

    it('converts uncovered-module gap to recommendation', () => {
      const gap: CoverageGap = {
        type: 'uncovered-module', severity: 'critical',
        module: 'src/engine.ts', evidence: 'Not covered',
        metrics: { fanIn: 5, exports: 3, lines: 200 },
      };
      const codebase = makeCodebase({
        modules: [makeModule({ path: 'src/engine.ts', exports: ['run', 'init', 'stop'] })],
      });

      const rec = gapToRec(gap, codebase);
      expect(rec).not.toBeNull();
      expect(rec!.type).toBe('uncovered-module');
      expect(rec!.severity).toBe('critical');
      expect(rec!.impactScore).toBe(80);
      expect(rec!.title).toContain('src/engine.ts');
      expect(rec!.targetFile).toBe('.github/copilot-instructions.md');
    });

    it('converts uncovered-pipeline gap', () => {
      const gap: CoverageGap = {
        type: 'uncovered-pipeline', severity: 'important',
        module: 'src/extension.ts', evidence: 'Pipeline not covered',
        metrics: {},
      };
      const rec = gapToRec(gap, makeCodebase());
      expect(rec).not.toBeNull();
      expect(rec!.type).toBe('uncovered-pipeline');
      expect(rec!.impactScore).toBe(65);
      expect(rec!.targetFile).toContain('SKILL.md');
    });

    it('converts missing-skill gap', () => {
      const gap: CoverageGap = {
        type: 'missing-skill', severity: 'suggestion',
        module: 'test', evidence: 'No test skill',
        metrics: {},
      };
      const rec = gapToRec(gap, makeCodebase());
      expect(rec).not.toBeNull();
      expect(rec!.type).toBe('missing-skill');
      expect(rec!.impactScore).toBe(50);
      expect(rec!.targetFile).toContain('.github/skills/test/SKILL.md');
    });

    it('converts weak-description gap', () => {
      const gap: CoverageGap = {
        type: 'weak-description', severity: 'suggestion',
        module: 'src/engine.ts', evidence: 'No docstring',
        metrics: {},
      };
      const rec = gapToRec(gap, makeCodebase());
      expect(rec).not.toBeNull();
      expect(rec!.type).toBe('weak-description');
      expect(rec!.targetFile).toContain('.suggestions.md');
    });

    it('returns null for unknown gap type', () => {
      const gap: CoverageGap = {
        type: 'stale-path' as any, severity: 'suggestion',
        module: 'x', evidence: 'x', metrics: {},
      };
      const rec = gapToRec(gap, makeCodebase());
      expect(rec).toBeNull();
    });

    it('assigns higher impact for critical severity', () => {
      const critical: CoverageGap = {
        type: 'uncovered-module', severity: 'critical',
        module: 'src/a.ts', evidence: 'x', metrics: {},
      };
      const suggestion: CoverageGap = {
        type: 'uncovered-module', severity: 'suggestion',
        module: 'src/b.ts', evidence: 'x', metrics: {},
      };
      const recCritical = gapToRec(critical, makeCodebase());
      const recSuggestion = gapToRec(suggestion, makeCodebase());
      expect(recCritical!.impactScore).toBeGreaterThan(recSuggestion!.impactScore);
    });
  });

  // ─── Pure: driftToRec ──────────────────────────────────────────────

  describe('driftToRec', () => {
    const client = mockCopilotClient();
    const synth = new RecommendationSynthesizer(client);
    const driftToRec = (drift: DriftIssue) =>
      (synth as any).driftToRec(drift, 'copilot');

    it('converts path-drift to stale-path recommendation', () => {
      const drift: DriftIssue = {
        type: 'path-drift',
        claim: { category: 'path-reference', claim: 'src/old.ts', sourceFile: 'inst.md', sourceLine: 5, confidence: 0.9 },
        reality: 'File does not exist',
        severity: 'important',
        file: 'inst.md',
      };
      const rec = driftToRec(drift);
      expect(rec.type).toBe('stale-path');
      expect(rec.title).toContain('stale path');
      expect(rec.impactScore).toBe(60);
    });

    it('converts structural-drift to recommendation', () => {
      const drift: DriftIssue = {
        type: 'structural-drift',
        claim: { category: 'architecture', claim: '10 modules', sourceFile: 'inst.md', sourceLine: 3, confidence: 0.7 },
        reality: 'Actually 25 modules',
        severity: 'important',
        file: 'inst.md',
      };
      const rec = driftToRec(drift);
      expect(rec.type).toBe('structural-drift');
      expect(rec.title).toContain('outdated architecture');
    });

    it('converts semantic-drift to recommendation', () => {
      const drift: DriftIssue = {
        type: 'semantic-drift',
        claim: { category: 'architecture', claim: 'Engine does scoring', sourceFile: 'inst.md', sourceLine: 7, confidence: 0.7 },
        reality: 'Engine actually validates',
        severity: 'critical',
        file: 'inst.md',
      };
      const rec = driftToRec(drift);
      expect(rec.type).toBe('semantic-drift');
      expect(rec.title).toContain('semantic mismatch');
      expect(rec.impactScore).toBe(85); // critical
    });

    it('includes evidence from claim and reality', () => {
      const drift: DriftIssue = {
        type: 'path-drift',
        claim: { category: 'path-reference', claim: 'src/x.ts', sourceFile: 'inst.md', sourceLine: 1, confidence: 0.9 },
        reality: 'Does not exist',
        severity: 'important',
        file: 'inst.md',
      };
      const rec = driftToRec(drift);
      expect(rec.evidence).toHaveLength(2);
      expect(rec.evidence[0]).toContain('src/x.ts');
      expect(rec.evidence[1]).toContain('Does not exist');
    });
  });

  // ─── Pure: gapsToRecommendations ───────────────────────────────────

  describe('gapsToRecommendations', () => {
    const client = mockCopilotClient();
    const synth = new RecommendationSynthesizer(client);
    const gapsToRecs = (crossRef: CrossRefResult, codebase: CodebaseProfile, instructions: InstructionProfile) =>
      (synth as any).gapsToRecommendations(crossRef, codebase, instructions, 'copilot');

    it('converts coverage gaps and drift issues to recommendations', () => {
      const crossRef = makeCrossRef({
        coverageGaps: [
          { type: 'uncovered-module', severity: 'critical', module: 'src/engine.ts', evidence: 'Not covered', metrics: {} },
        ],
        driftIssues: [
          { type: 'path-drift', claim: { category: 'path-reference', claim: 'src/old.ts', sourceFile: 'x', sourceLine: 1, confidence: 0.9 }, reality: 'gone', severity: 'important', file: 'x' },
        ],
      });
      const recs = gapsToRecs(crossRef, makeCodebase(), makeInstructions());
      const types = recs.map((r: DeepRecommendation) => r.type);
      expect(types).toContain('uncovered-module');
      expect(types).toContain('stale-path');
    });

    it('adds quality-specificity rec when specificity < 40', () => {
      const crossRef = makeCrossRef({
        instructionQuality: makeQuality({ specificity: 20 }),
      });
      const recs = gapsToRecs(crossRef, makeCodebase(), makeInstructions());
      const specRec = recs.find((r: DeepRecommendation) => r.id === 'quality-specificity');
      expect(specRec).toBeDefined();
      expect(specRec!.impactScore).toBe(70);
    });

    it('does not add specificity rec when specificity >= 40', () => {
      const crossRef = makeCrossRef({
        instructionQuality: makeQuality({ specificity: 60 }),
      });
      const recs = gapsToRecs(crossRef, makeCodebase(), makeInstructions());
      expect(recs.find((r: DeepRecommendation) => r.id === 'quality-specificity')).toBeUndefined();
    });

    it('adds quality-coverage rec when coverage < 50', () => {
      const crossRef = makeCrossRef({
        instructionQuality: makeQuality({ coverage: 30 }),
      });
      const recs = gapsToRecs(crossRef, makeCodebase(), makeInstructions());
      const covRec = recs.find((r: DeepRecommendation) => r.id === 'quality-coverage');
      expect(covRec).toBeDefined();
      expect(covRec!.severity).toBe('critical');
    });

    it('adds quality-accuracy rec when accuracy < 60', () => {
      const crossRef = makeCrossRef({
        instructionQuality: makeQuality({ accuracy: 40 }),
      });
      const claims = [
        { category: 'path-reference' as const, claim: 'src/nonexistent.ts', sourceFile: 'inst.md', sourceLine: 1, confidence: 0.9 },
      ];
      const recs = gapsToRecs(crossRef, makeCodebase(), makeInstructions({ claims }));
      const accRec = recs.find((r: DeepRecommendation) => r.id === 'quality-accuracy');
      expect(accRec).toBeDefined();
      expect(accRec!.impactScore).toBe(90);
    });
  });

  // ─── Pure: getMainInstructionFile ──────────────────────────────────

  describe('getMainInstructionFile', () => {
    const client = mockCopilotClient();
    const synth = new RecommendationSynthesizer(client);
    const getFile = (tool: string) => (synth as any).getMainInstructionFile(tool);

    it('returns correct file for each platform', () => {
      expect(getFile('copilot')).toBe('.github/copilot-instructions.md');
      expect(getFile('cline')).toBe('.clinerules/default-rules.md');
      expect(getFile('cursor')).toBe('.cursor/rules/default.md');
      expect(getFile('claude')).toBe('CLAUDE.md');
      expect(getFile('roo')).toBe('.roo/rules/default.md');
      expect(getFile('windsurf')).toBe('.windsurf/rules/default.md');
      expect(getFile('aider')).toBe('.aider.conf.yml');
    });

    it('falls back to copilot for unknown platform', () => {
      expect(getFile('unknown')).toBe('.github/copilot-instructions.md');
    });
  });

  // ─── With mocks: synthesize ────────────────────────────────────────

  describe('synthesize', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('produces recommendations from cross-ref results', async () => {
      const client = mockCopilotClient();
      client.isAvailable.mockReturnValue(false); // skip LLM enrichment

      const synth = new RecommendationSynthesizer(client);
      const crossRef = makeCrossRef({
        coverageGaps: [
          { type: 'uncovered-module', severity: 'critical', module: 'src/engine.ts', evidence: 'Not covered', metrics: { fanIn: 5 } },
          { type: 'missing-skill', severity: 'suggestion', module: 'build', evidence: 'No build skill', metrics: {} },
        ],
        instructionQuality: makeQuality({ specificity: 20, coverage: 30 }),
      });

      const recs = await synth.synthesize(crossRef, makeCodebase(), makeInstructions(), 'copilot');

      expect(recs.length).toBeGreaterThan(0);
      // Should be sorted by impactScore descending
      for (let i = 1; i < recs.length; i++) {
        expect(recs[i - 1].impactScore).toBeGreaterThanOrEqual(recs[i].impactScore);
      }
    });

    it('enriches recommendations with LLM when available', async () => {
      const client = mockCopilotClient(JSON.stringify([
        { gapIndex: 0, suggestedContent: '## Engine\nThis module processes data.', revisedTitle: 'Document the data engine' }
      ]));

      const synth = new RecommendationSynthesizer(client);
      const crossRef = makeCrossRef({
        coverageGaps: [
          { type: 'uncovered-module', severity: 'critical', module: 'src/engine.ts', evidence: 'Not covered', metrics: {} },
        ],
      });

      const recs = await synth.synthesize(
        crossRef,
        makeCodebase({ modules: [makeModule({ path: 'src/engine.ts' })] }),
        makeInstructions({ files: [{ path: 'inst.md', content: '# Test', tool: 'copilot', type: 'root-instruction', tokens: 10 }] }),
        'copilot'
      );

      expect(client.analyze).toHaveBeenCalled();
      const engineRec = recs.find(r => r.affectedModules.includes('src/engine.ts'));
      expect(engineRec).toBeDefined();
      expect(engineRec!.suggestedContent).toContain('Engine');
      expect(engineRec!.title).toBe('Document the data engine');
    });

    it('handles LLM enrichment failure gracefully', async () => {
      const client = mockCopilotClient();
      client.analyze.mockRejectedValue(new Error('LLM timeout'));

      const synth = new RecommendationSynthesizer(client);
      const crossRef = makeCrossRef({
        coverageGaps: [
          { type: 'uncovered-module', severity: 'critical', module: 'src/engine.ts', evidence: 'Not covered', metrics: {} },
        ],
      });

      const recs = await synth.synthesize(crossRef, makeCodebase(), makeInstructions(), 'copilot');

      // Should still have recommendations (from deterministic phase)
      expect(recs.length).toBeGreaterThan(0);
    });
  });
});
