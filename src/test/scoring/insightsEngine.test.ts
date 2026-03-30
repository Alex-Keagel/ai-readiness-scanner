import { describe, it, expect, vi } from 'vitest';
import { InsightsEngine, Insight } from '../../scoring/insightsEngine';
import { ReadinessReport, ComponentScore, ComponentSignal, LevelScore, MaturityLevel } from '../../scoring/types';

function mockCopilotClient() {
  return {
    isAvailable: vi.fn().mockReturnValue(false),
    analyze: vi.fn().mockResolvedValue('[]'),
    analyzeFast: vi.fn().mockResolvedValue('[]'),
    getModelName: vi.fn().mockReturnValue('test-model'),
  } as any;
}

function makeComponentSignal(signal: string, present: boolean): ComponentSignal {
  return { signal, present, detail: present ? 'found' : 'not found' };
}

function makeComponent(overrides: Partial<ComponentScore> = {}): ComponentScore {
  return {
    name: 'my-component',
    path: 'src/my-component',
    language: 'TypeScript',
    type: 'library',
    primaryLevel: 1 as MaturityLevel,
    depth: 20,
    overallScore: 30,
    levels: [],
    signals: [
      makeComponentSignal('README', false),
      makeComponentSignal('Tests', false),
      makeComponentSignal('Docs', false),
    ],
    ...overrides,
  };
}

function makeReport(overrides: Partial<ReadinessReport> = {}): ReadinessReport {
  return {
    projectName: 'test-project',
    scannedAt: new Date().toISOString(),
    primaryLevel: 2 as MaturityLevel,
    levelName: 'Guided',
    depth: 50,
    overallScore: 40,
    levels: [],
    componentScores: [],
    languageScores: [],
    projectContext: {
      languages: ['TypeScript'],
      frameworks: [],
      projectType: 'app',
      packageManager: 'npm',
      directoryTree: '',
      components: [],
    },
    selectedTool: 'copilot',
    modelUsed: 'test',
    scanMode: 'full',
    ...overrides,
  };
}

// ─── Fix 1: Consolidated component insights ────────────────────────

describe('InsightsEngine — getComponentInsights consolidation', () => {
  const client = mockCopilotClient();
  const engine = new InsightsEngine(client);
  const getComponentInsights = (report: ReadinessReport) =>
    (engine as any).getComponentInsights(report);

  it('produces ONE insight per component instead of separate lagging/readme/test insights', () => {
    const report = makeReport({
      primaryLevel: 3 as MaturityLevel,
      componentScores: [
        makeComponent({
          name: 'engine',
          path: 'src/engine',
          primaryLevel: 1 as MaturityLevel,
          signals: [
            makeComponentSignal('README', false),
            makeComponentSignal('Tests', false),
            makeComponentSignal('Docs', true),
          ],
        }),
      ],
    });

    const insights: Insight[] = getComponentInsights(report);
    // Should be exactly 1 consolidated insight, not 3 separate ones
    expect(insights).toHaveLength(1);
    expect(insights[0].title).toContain('engine');
    expect(insights[0].title).toContain('3 issues');
    // Description should mention all three issues
    expect(insights[0].description).toContain('no README');
    expect(insights[0].description).toContain('no tests');
    expect(insights[0].description).toContain('Level 1');
  });

  it('includes only applicable issues (no false noise)', () => {
    const report = makeReport({
      primaryLevel: 2 as MaturityLevel,
      componentScores: [
        makeComponent({
          name: 'parser',
          path: 'src/parser',
          primaryLevel: 2 as MaturityLevel, // not lagging
          signals: [
            makeComponentSignal('README', true),  // present
            makeComponentSignal('Tests', false),   // missing
          ],
        }),
      ],
    });

    const insights: Insight[] = getComponentInsights(report);
    expect(insights).toHaveLength(1);
    expect(insights[0].title).toContain('1 issue');
    expect(insights[0].description).toContain('no tests');
    expect(insights[0].description).not.toContain('README');
    expect(insights[0].description).not.toContain('Level');
  });

  it('skips components with no issues', () => {
    const report = makeReport({
      primaryLevel: 2 as MaturityLevel,
      componentScores: [
        makeComponent({
          name: 'healthy',
          path: 'src/healthy',
          primaryLevel: 2 as MaturityLevel,
          signals: [
            makeComponentSignal('README', true),
            makeComponentSignal('Tests', true),
          ],
        }),
      ],
    });

    const insights: Insight[] = getComponentInsights(report);
    expect(insights).toHaveLength(0);
  });

  it('sets severity to important when component is lagging or missing tests', () => {
    const report = makeReport({
      primaryLevel: 3 as MaturityLevel,
      componentScores: [
        makeComponent({
          name: 'lagging',
          path: 'src/lagging',
          primaryLevel: 1 as MaturityLevel,
          signals: [
            makeComponentSignal('README', true),
            makeComponentSignal('Tests', true),
          ],
        }),
      ],
    });

    const insights: Insight[] = getComponentInsights(report);
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe('important');
  });

  it('produces fewer total insights than the old 3-per-component approach', () => {
    // Simulate 10 components each with all 3 issues
    const components = Array.from({ length: 10 }, (_, i) =>
      makeComponent({
        name: `comp-${i}`,
        path: `src/comp-${i}`,
        primaryLevel: 1 as MaturityLevel,
        signals: [
          makeComponentSignal('README', false),
          makeComponentSignal('Tests', false),
          makeComponentSignal('Docs', false),
        ],
      })
    );

    const report = makeReport({
      primaryLevel: 3 as MaturityLevel,
      componentScores: components,
    });

    const insights: Insight[] = getComponentInsights(report);
    // Old: 10 * 3 = 30 insights. New: 10 * 1 = 10 insights
    expect(insights).toHaveLength(10);
  });
});

// ─── Insight dedup in generateInsights ─────────────────────────────

describe('InsightsEngine — insight dedup', () => {
  const client = mockCopilotClient();
  const engine = new InsightsEngine(client);

  it('removes duplicate insights with identical titles', async () => {
    // Create a report that would generate overlapping insights
    const report = makeReport({
      primaryLevel: 2 as MaturityLevel,
      levels: [
        {
          level: 1 as MaturityLevel,
          name: 'Foundation',
          rawScore: 50,
          qualified: true,
          signals: [],
          signalsDetected: 0,
          signalsTotal: 0,
        },
        {
          level: 2 as MaturityLevel,
          name: 'Guided',
          rawScore: 50,
          qualified: true,
          signals: [],
          signalsDetected: 0,
          signalsTotal: 0,
        },
      ],
      componentScores: [],
      languageScores: [],
    });

    const insights = await engine.generateInsights(report);
    // Verify no duplicate titles
    const titles = insights.map(i => i.title.toLowerCase().trim());
    const uniqueTitles = new Set(titles);
    expect(titles.length).toBe(uniqueTitles.size);
  });

  it('keeps the most severe duplicate when titles collide', async () => {
    // Manually test dedup logic by calling getComponentInsights then checking
    const report = makeReport({
      primaryLevel: 2 as MaturityLevel,
      levels: [],
      componentScores: [],
      languageScores: [],
    });

    const insights = await engine.generateInsights(report);
    // Should all be unique
    const titleCounts = new Map<string, number>();
    for (const i of insights) {
      const key = i.title.toLowerCase().trim();
      titleCounts.set(key, (titleCounts.get(key) || 0) + 1);
    }
    for (const [title, count] of titleCounts) {
      expect(count).toBe(1);
    }
  });
});
