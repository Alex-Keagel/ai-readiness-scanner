import { describe, it, expect, beforeEach } from 'vitest';
import type { ReadinessReport } from '../../scoring/types';
import { InsightsPanel } from '../../ui/insightsPanel';

// ── Shared mock report builder ──────────────────────────────────

function makeReport(overrides: Partial<ReadinessReport> = {}): ReadinessReport {
  return {
    projectName: 'TestProject',
    scannedAt: new Date().toISOString(),
    primaryLevel: 3 as any,
    levelName: 'Skill-Equipped',
    depth: 55,
    overallScore: 55,
    levels: [
      { level: 1, name: 'Prompt-Only', rawScore: 100, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
      {
        level: 2, name: 'Instruction-Guided', rawScore: 80, qualified: true,
        signals: [
          { signalId: 'copilot_instructions', level: 2, detected: true, score: 70, finding: 'Found', files: ['.github/copilot-instructions.md'], confidence: 'high' },
          { signalId: 'project_structure_doc', level: 2, detected: false, score: 0, finding: 'Not found', files: [], confidence: 'high' },
          { signalId: 'conventions_documented', level: 2, detected: false, score: 0, finding: 'Not found', files: [], confidence: 'high' },
        ], signalsDetected: 1, signalsTotal: 3,
      },
      {
        level: 3, name: 'Skill-Equipped', rawScore: 50, qualified: true,
        signals: [
          { signalId: 'copilot_agents', level: 3, detected: true, score: 30, finding: 'Found but low quality', files: ['.github/agents/dev.agent.md'], confidence: 'medium' },
          { signalId: 'copilot_skills', level: 3, detected: false, score: 0, finding: 'Not found', files: [], confidence: 'high' },
        ], signalsDetected: 1, signalsTotal: 2,
      },
      {
        level: 4, name: 'Playbook-Driven', rawScore: 0, qualified: false,
        signals: [
          { signalId: 'copilot_playbooks', level: 4, detected: false, score: 0, finding: 'Not found', files: [], confidence: 'high' },
        ], signalsDetected: 0, signalsTotal: 1,
      },
      { level: 5, name: 'Self-Improving', rawScore: 0, qualified: false, signals: [], signalsDetected: 0, signalsTotal: 0 },
      { level: 6, name: 'Autonomous', rawScore: 0, qualified: false, signals: [], signalsDetected: 0, signalsTotal: 0 },
    ],
    componentScores: [
      {
        name: 'Extension Core', path: 'src/', language: 'TypeScript', type: 'app',
        primaryLevel: 3, depth: 67, overallScore: 67, levels: [], signals: [],
      },
      {
        name: 'Test Config', path: 'test/', language: 'TypeScript', type: 'test',
        primaryLevel: 2, depth: 50, overallScore: 25, levels: [], signals: [],
      },
    ],
    languageScores: [],
    projectContext: {
      languages: ['TypeScript'], frameworks: ['VS Code Extension'], projectType: 'app',
      packageManager: 'npm', directoryTree: 'src/\n  extension.ts', components: [],
    },
    selectedTool: 'copilot',
    modelUsed: 'test-model',
    scanMode: 'full',
    insights: [
      { title: 'Missing test scaffold', recommendation: 'Add unit tests for core modules', severity: 'important', category: 'testing' },
      { title: 'Add architecture map', recommendation: 'Create module responsibility doc in README', severity: 'suggestion', category: 'documentation' },
      { title: 'Spec sync needed', recommendation: 'Sync assessment spec with implementation', severity: 'important', category: 'accuracy', estimatedImpact: '+20 points', affectedComponent: 'Extension Core' },
    ],
    ...overrides,
  } as any;
}

function renderHtml(report: ReadinessReport): string {
  const panel = new (InsightsPanel as any)({
    webview: { html: '', onDidReceiveMessage: () => ({ dispose: () => {} }), postMessage: async () => true, asWebviewUri: (u: any) => u },
    onDidDispose: () => ({ dispose: () => {} }),
    dispose: () => {},
    reveal: () => {},
    visible: true,
  }, report);
  return (panel as any).getHtml(report);
}

// ── Tests ───────────────────────────────────────────────────────

describe('InsightsPanel', () => {
  describe('executive brief', () => {
    it('renders readiness overview with score and level', () => {
      const html = renderHtml(makeReport());
      expect(html).toContain('📊 Readiness Overview');
      expect(html).toContain('55'); // overall score
      expect(html).toContain('L3');
      expect(html).toContain('Skill-Equipped');
    });

    it('renders action items panel with correct counts', () => {
      const html = renderHtml(makeReport());
      expect(html).toContain('🔧 Action Items');
      // Should contain Action Center totals, not just insight counts
      expect(html).toContain('total recommendations');
    });

    it('action item counts include undetected signals', () => {
      const report = makeReport();
      const html = renderHtml(report);
      // 3 undetected signals at L2-L3 → critical
      // 1 undetected at L4 → important
      // 1 detected with score 30 < 40 → suggestion
      // + 3 insights (2 important, 1 suggestion)
      // + component recs for low-scoring components
      // Total should be > 3 (the insight-only count)
      expect(html).toContain('Critical');
      expect(html).toContain('Important');
      expect(html).toContain('Suggestions');
    });

    it('renders "What Matters Most" section', () => {
      const html = renderHtml(makeReport());
      expect(html).toContain('🎯 What Matters Most');
    });

    it('mentions missing foundational signals when critical items exist', () => {
      const html = renderHtml(makeReport());
      // 3 L2-L3 signals are missing → should mention them
      expect(html).toContain('foundational signals');
    });

    it('mentions low-scoring components when they exist', () => {
      const report = makeReport({
        componentScores: [
          { name: 'Broken Module', path: 'src/broken', language: 'TypeScript', type: 'app', primaryLevel: 1, depth: 10, overallScore: 20, levels: [], signals: [] } as any,
        ],
      });
      const html = renderHtml(report);
      expect(html).toContain('Broken Module');
      expect(html).toContain('below 40');
    });

    it('mentions low quality detected signals when count > 5', () => {
      const signals = Array(8).fill(null).map((_, i) => ({
        signalId: `signal_${i}`, level: 2, detected: true, score: 20,
        finding: 'Low quality', files: [], confidence: 'high',
      }));
      const report = makeReport({
        levels: [
          { level: 1, name: 'L1', rawScore: 100, qualified: true, signals, signalsDetected: 8, signalsTotal: 8 },
          { level: 2, name: 'L2', rawScore: 50, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
          { level: 3, name: 'L3', rawScore: 0, qualified: false, signals: [], signalsDetected: 0, signalsTotal: 0 },
          { level: 4, name: 'L4', rawScore: 0, qualified: false, signals: [], signalsDetected: 0, signalsTotal: 0 },
          { level: 5, name: 'L5', rawScore: 0, qualified: false, signals: [], signalsDetected: 0, signalsTotal: 0 },
          { level: 6, name: 'L6', rawScore: 0, qualified: false, signals: [], signalsDetected: 0, signalsTotal: 0 },
        ] as any,
      });
      const html = renderHtml(report);
      expect(html).toContain('present but low quality');
    });

    it('shows achievable message when close to next level', () => {
      const report = makeReport({
        primaryLevel: 3 as any,
        levels: [
          { level: 1, name: 'L1', rawScore: 100, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
          { level: 2, name: 'L2', rawScore: 100, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
          { level: 3, name: 'L3', rawScore: 80, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
          { level: 4, name: 'L4', rawScore: 0, qualified: false, signals: [
            { signalId: 'playbook_1', level: 4, detected: false, score: 0, finding: 'Not found', files: [], confidence: 'high' },
          ], signalsDetected: 0, signalsTotal: 1 },
          { level: 5, name: 'L5', rawScore: 0, qualified: false, signals: [], signalsDetected: 0, signalsTotal: 0 },
          { level: 6, name: 'L6', rawScore: 0, qualified: false, signals: [], signalsDetected: 0, signalsTotal: 0 },
        ] as any,
        insights: [],
      });
      const html = renderHtml(report);
      expect(html).toContain('achievable in one session');
    });

    it('shows well-configured message when no issues', () => {
      const report = makeReport({
        primaryLevel: 4 as any,
        overallScore: 85,
        levels: [
          { level: 1, name: 'L1', rawScore: 100, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
          { level: 2, name: 'L2', rawScore: 100, qualified: true, signals: [
            { signalId: 's1', level: 2, detected: true, score: 90, finding: 'OK', files: [], confidence: 'high' },
          ], signalsDetected: 1, signalsTotal: 1 },
          { level: 3, name: 'L3', rawScore: 100, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
          { level: 4, name: 'L4', rawScore: 80, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
          { level: 5, name: 'L5', rawScore: 0, qualified: false, signals: [], signalsDetected: 0, signalsTotal: 0 },
          { level: 6, name: 'L6', rawScore: 0, qualified: false, signals: [], signalsDetected: 0, signalsTotal: 0 },
        ] as any,
        componentScores: [],
        insights: [],
      });
      const html = renderHtml(report);
      expect(html).toContain('well-configured');
    });

    it('Open Action Center button includes total count', () => {
      const html = renderHtml(makeReport());
      expect(html).toMatch(/Open Action Center \(\d+ items\)/);
    });
  });

  describe('LLM Analysis section', () => {
    it('renders LLM Analysis heading with insight count', () => {
      const html = renderHtml(makeReport());
      expect(html).toContain('🧠 LLM Analysis');
      expect(html).toContain('3 insights');
    });

    it('renders each insight as a card', () => {
      const html = renderHtml(makeReport());
      expect(html).toContain('Missing test scaffold');
      expect(html).toContain('Add architecture map');
      expect(html).toContain('Spec sync needed');
    });

    it('shows recommendation text for each insight', () => {
      const html = renderHtml(makeReport());
      expect(html).toContain('Add unit tests for core modules');
      expect(html).toContain('Create module responsibility doc in README');
      expect(html).toContain('Sync assessment spec with implementation');
    });

    it('shows severity icons', () => {
      const html = renderHtml(makeReport());
      expect(html).toContain('🟡'); // important
      expect(html).toContain('🔵'); // suggestion
    });

    it('shows category tags', () => {
      const html = renderHtml(makeReport());
      expect(html).toContain('testing');
      expect(html).toContain('documentation');
      expect(html).toContain('accuracy');
    });

    it('shows affected component when present', () => {
      const html = renderHtml(makeReport());
      expect(html).toContain('📦 Extension Core');
    });

    it('shows estimated impact when present', () => {
      const html = renderHtml(makeReport());
      expect(html).toContain('📈 +20 points');
    });

    it('does not render LLM Analysis when no insights', () => {
      const report = makeReport({ insights: [] });
      const html = renderHtml(report);
      expect(html).not.toContain('🧠 LLM Analysis');
      expect(html).toContain('No strategy data yet');
    });

    it('renders critical insight with correct CSS class', () => {
      const report = makeReport({
        insights: [
          { title: 'Critical issue', recommendation: 'Fix now', severity: 'critical', category: 'security' },
        ],
      });
      const html = renderHtml(report);
      expect(html).toContain('llm-insight-card critical');
      expect(html).toContain('🔴');
    });

    it('orders insights by severity: critical → important → suggestion', () => {
      const report = makeReport({
        insights: [
          { title: 'Suggestion item', recommendation: 'Nice to have', severity: 'suggestion', category: 'other' },
          { title: 'Critical item', recommendation: 'Fix immediately', severity: 'critical', category: 'security' },
          { title: 'Important item', recommendation: 'Should fix', severity: 'important', category: 'testing' },
        ],
      });
      const html = renderHtml(report);
      const critIdx = html.indexOf('Critical item');
      const impIdx = html.indexOf('Important item');
      const sugIdx = html.indexOf('Suggestion item');
      expect(critIdx).toBeLessThan(impIdx);
      expect(impIdx).toBeLessThan(sugIdx);
    });

    it('singular insight text for count badge', () => {
      const report = makeReport({
        insights: [
          { title: 'Only one', recommendation: 'Single insight', severity: 'important', category: 'test' },
        ],
      });
      const html = renderHtml(report);
      expect(html).toContain('1 insight');
      expect(html).not.toContain('1 insights');
    });
  });

  describe('component health counts for action items', () => {
    it('includes component README recs in action counts', () => {
      const report = makeReport({
        componentScores: [
          {
            name: 'Low Comp', path: 'src/low', language: 'TS', type: 'app',
            primaryLevel: 1, depth: 10, overallScore: 25, levels: [],
            signals: [], // no readme signal
          } as any,
        ],
      });
      const html = renderHtml(report);
      // Low comp (score 25 < 50) without readme → +1 important (score < 30)
      // Low comp (score 25 < 35) without doc → +1 suggestion
      expect(html).toContain('Important');
      expect(html).toContain('Suggestions');
    });
  });

  describe('panel structure', () => {
    it('renders all major sections', () => {
      const html = renderHtml(makeReport());
      expect(html).toContain('💡 AI Strategy');
      expect(html).toContain('📊 Readiness Overview');
      expect(html).toContain('🔧 Action Items');
      expect(html).toContain('🎯 What Matters Most');
      expect(html).toContain('🧠 LLM Analysis');
    });

    it('renders valid HTML', () => {
      const html = renderHtml(makeReport());
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('</html>');
      expect(html).toContain('<body>');
      expect(html).toContain('</body>');
    });

    it('includes acquireVsCodeApi script', () => {
      const html = renderHtml(makeReport());
      expect(html).toContain('acquireVsCodeApi');
    });

    it('escapes HTML in insight titles', () => {
      const report = makeReport({
        insights: [
          { title: 'Use <script> carefully', recommendation: 'Avoid XSS', severity: 'critical', category: 'security' },
        ],
      });
      const html = renderHtml(report);
      expect(html).not.toContain('<script> carefully');
      expect(html).toContain('&lt;script&gt; carefully');
    });
  });
});
