import { describe, it, expect, vi } from 'vitest';
import { ExclusionClassifierAgent, TestClassificationAgent, GapRelevanceAgent } from '../../deep/relevanceAgents';
import { CoverageGap, ModuleProfile } from '../../deep/types';

function makeModule(path: string, overrides: Partial<ModuleProfile> = {}): ModuleProfile {
  return {
    path, language: 'TypeScript', lines: 100, exports: [], exportCount: 0,
    importCount: 0, fanIn: 0, hasTests: false, hasDocstring: false,
    complexity: 'low', role: 'core-logic', ...overrides,
  };
}

function makeGap(module: string, overrides: Partial<CoverageGap> = {}): CoverageGap {
  return {
    type: 'uncovered-module', severity: 'important', module,
    evidence: 'Not covered', metrics: { lines: 100 }, ...overrides,
  };
}

function mockClient(result = '[]') {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    analyze: vi.fn().mockResolvedValue(result),
    analyzeFast: vi.fn().mockResolvedValue(result),
  } as any;
}

// ─── ExclusionClassifierAgent ───────────────────────────────────

describe('ExclusionClassifierAgent', () => {
  describe('isExcluded (static)', () => {
    it('excludes .venv paths', () => {
      expect(ExclusionClassifierAgent.isExcluded('.venv/lib/python3.13/site-packages/foo.py')).toBe(true);
      expect(ExclusionClassifierAgent.isExcluded('python-workspace/.venv/lib/typing.py')).toBe(true);
    });

    it('excludes venv paths', () => {
      expect(ExclusionClassifierAgent.isExcluded('venv/lib/foo.py')).toBe(true);
    });

    it('excludes .idea paths', () => {
      expect(ExclusionClassifierAgent.isExcluded('.idea/workspace.xml')).toBe(true);
    });

    it('excludes .vs paths', () => {
      expect(ExclusionClassifierAgent.isExcluded('.vs/settings.json')).toBe(true);
    });

    it('excludes node_modules', () => {
      expect(ExclusionClassifierAgent.isExcluded('node_modules/express/index.js')).toBe(true);
    });

    it('excludes __pycache__', () => {
      expect(ExclusionClassifierAgent.isExcluded('src/__pycache__/foo.pyc')).toBe(true);
    });

    it('does NOT exclude src paths', () => {
      expect(ExclusionClassifierAgent.isExcluded('src/app/main.ts')).toBe(false);
    });

    it('does NOT exclude .github paths', () => {
      expect(ExclusionClassifierAgent.isExcluded('.github/copilot-instructions.md')).toBe(false);
    });

    it('does NOT exclude regular paths', () => {
      expect(ExclusionClassifierAgent.isExcluded('python-workspace/components/baselines/src/baselines/core.py')).toBe(false);
    });
  });

  describe('classify', () => {
    it('static-excludes known patterns without LLM', async () => {
      const agent = new ExclusionClassifierAgent();
      const result = await agent.classify(['.venv/lib', '.idea/config', 'src/app'], 'test');
      expect(result.get('.venv/lib')).toBe('exclude');
      expect(result.get('.idea/config')).toBe('exclude');
      expect(result.get('src/app')).toBe('include');
    });

    it('uses LLM for unrecognized directories', async () => {
      const client = mockClient(JSON.stringify([
        { dir: 'generated-code', classification: 'exclude', reason: 'auto-generated' },
        { dir: 'src/core', classification: 'include', reason: 'production code' },
      ]));
      const agent = new ExclusionClassifierAgent(client);
      const result = await agent.classify(['generated-code', 'src/core'], 'test');
      expect(result.get('generated-code')).toBe('exclude');
      expect(result.get('src/core')).toBe('include');
      expect(client.analyzeFast).toHaveBeenCalled();
    });

    it('defaults to include when LLM fails', async () => {
      const client = mockClient();
      client.analyzeFast.mockRejectedValue(new Error('timeout'));
      const agent = new ExclusionClassifierAgent(client);
      const result = await agent.classify(['unknown-dir'], 'test');
      expect(result.get('unknown-dir')).toBe('include');
    });
  });
});

// ─── TestClassificationAgent ────────────────────────────────────

describe('TestClassificationAgent', () => {
  describe('classify', () => {
    const agent = new TestClassificationAgent();

    it('classifies .test.ts files as test', async () => {
      const result = await agent.classify([makeModule('src/utils.test.ts')]);
      expect(result.get('src/utils.test.ts')).toBe('test');
    });

    it('classifies .spec.ts files as test', async () => {
      const result = await agent.classify([makeModule('src/engine.spec.ts')]);
      expect(result.get('src/engine.spec.ts')).toBe('test');
    });

    it('classifies __tests__/ files as test', async () => {
      const result = await agent.classify([makeModule('src/__tests__/engine.ts')]);
      expect(result.get('src/__tests__/engine.ts')).toBe('test');
    });

    it('classifies Python test_ files as test', async () => {
      const result = await agent.classify([makeModule('tests/test_baselines.py')]);
      expect(result.get('tests/test_baselines.py')).toBe('test');
    });

    it('classifies conftest.py as test-utility', async () => {
      const result = await agent.classify([makeModule('tests/conftest.py')]);
      expect(result.get('tests/conftest.py')).toBe('test-utility');
    });

    it('classifies test utils as test-utility', async () => {
      const result = await agent.classify([makeModule('tests/test_utils/data_generation.py')]);
      expect(result.get('tests/test_utils/data_generation.py')).toBe('test-utility');
    });

    it('classifies test fixtures as test-utility', async () => {
      const result = await agent.classify([makeModule('tests/fixtures/sample_data.py')]);
      expect(result.get('tests/fixtures/sample_data.py')).toBe('test-utility');
    });

    it('classifies test mocks as test-utility', async () => {
      const result = await agent.classify([makeModule('test/mocks/vscode.ts')]);
      expect(result.get('test/mocks/vscode.ts')).toBe('test-utility');
    });

    it('classifies tests/__init__.py as test-utility', async () => {
      const result = await agent.classify([makeModule('tests/__init__.py')]);
      expect(result.get('tests/__init__.py')).toBe('test-utility');
    });

    it('classifies regular source as production', async () => {
      const result = await agent.classify([makeModule('src/scoring/engine.ts')]);
      expect(result.get('src/scoring/engine.ts')).toBe('production');
    });

    it('classifies Go test files as test', async () => {
      const result = await agent.classify([makeModule('pkg/handler_test.go')]);
      expect(result.get('pkg/handler_test.go')).toBe('test');
    });
  });
});

// ─── GapRelevanceAgent ──────────────────────────────────────────

describe('GapRelevanceAgent', () => {
  describe('filterGaps', () => {
    const agent = new GapRelevanceAgent();

    it('removes gaps for .venv paths', async () => {
      const gaps = [
        makeGap('.venv/lib/python3.13/site-packages/foo.py'),
        makeGap('src/engine.ts'),
      ];
      const filtered = await agent.filterGaps(gaps);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].module).toBe('src/engine.ts');
    });

    it('removes gaps for test files', async () => {
      const gaps = [
        makeGap('tests/test_baselines.py'),
        makeGap('src/engine.ts'),
      ];
      const filtered = await agent.filterGaps(gaps);
      const testGap = filtered.find(g => g.module.includes('test_'));
      expect(testGap).toBeUndefined();
    });

    it('removes gaps for small __init__.py files', async () => {
      const gaps = [
        makeGap('src/__init__.py', { metrics: { lines: 5 } }),
        makeGap('src/engine.ts', { metrics: { lines: 200 } }),
      ];
      const filtered = await agent.filterGaps(gaps);
      const initGap = filtered.find(g => g.module === 'src/__init__.py');
      expect(initGap).toBeUndefined();
    });

    it('collapses 3+ per-file gaps into directory gap', async () => {
      const gaps = [
        makeGap('src/deep/a.ts'),
        makeGap('src/deep/b.ts'),
        makeGap('src/deep/c.ts'),
        makeGap('src/deep/d.ts'),
      ];
      const filtered = await agent.filterGaps(gaps);
      const dirGap = filtered.find(g => g.module === 'src/deep/');
      expect(dirGap).toBeDefined();
      expect(dirGap!.evidence).toContain('4 modules');
      // Should NOT have individual file gaps
      expect(filtered.find(g => g.module === 'src/deep/a.ts')).toBeUndefined();
    });

    it('keeps 2 per-file gaps as individual (no collapse)', async () => {
      const gaps = [
        makeGap('src/deep/a.ts'),
        makeGap('src/deep/b.ts'),
      ];
      const filtered = await agent.filterGaps(gaps);
      expect(filtered.find(g => g.module === 'src/deep/a.ts')).toBeDefined();
      expect(filtered.find(g => g.module === 'src/deep/b.ts')).toBeDefined();
    });

    it('preserves non-uncovered-module gaps', async () => {
      const gaps = [
        makeGap('deploy', { type: 'missing-skill' }),
        makeGap('.venv/lib/foo.py'),
      ];
      const filtered = await agent.filterGaps(gaps);
      expect(filtered).toContainEqual(expect.objectContaining({ type: 'missing-skill' }));
    });

    it('preserves directory-level gaps (ending with /)', async () => {
      const gaps = [
        makeGap('src/deep/', { type: 'uncovered-module' }),
      ];
      const filtered = await agent.filterGaps(gaps);
      expect(filtered).toHaveLength(1);
    });

    it('returns empty for empty input', async () => {
      const filtered = await agent.filterGaps([]);
      expect(filtered).toEqual([]);
    });

    it('uses worst severity when collapsing', async () => {
      const gaps = [
        makeGap('src/app/a.ts', { severity: 'suggestion' }),
        makeGap('src/app/b.ts', { severity: 'critical' }),
        makeGap('src/app/c.ts', { severity: 'important' }),
      ];
      const filtered = await agent.filterGaps(gaps);
      const dirGap = filtered.find(g => g.module === 'src/app/');
      expect(dirGap!.severity).toBe('critical');
    });
  });
});
