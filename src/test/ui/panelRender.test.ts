import { describe, it, expect, beforeEach } from 'vitest';
import { window } from '../mocks/vscode';
import type { ReadinessReport } from '../../scoring/types';
import { GraphPanel } from '../../ui/graphPanel';

// ── Shared mock report ──────────────────────────────────────────

const mockReport: ReadinessReport = {
  projectName: 'TestProject',
  scannedAt: new Date().toISOString(),
  primaryLevel: 2 as any,
  levelName: 'Instruction-Guided',
  depth: 65,
  overallScore: 42,
  levels: [
    { level: 1, name: 'Prompt-Only', rawScore: 100, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
    {
      level: 2, name: 'Instruction-Guided', rawScore: 65, qualified: true, signals: [
        { signalId: 'copilot_l2_instructions', level: 2, detected: true, score: 70, finding: 'Found', files: ['.github/copilot-instructions.md'], confidence: 'high' },
      ], signalsDetected: 1, signalsTotal: 1,
    },
    { level: 3, name: 'Skill-Equipped', rawScore: 30, qualified: false, signals: [], signalsDetected: 0, signalsTotal: 2 },
    { level: 4, name: 'Playbook-Driven', rawScore: 0, qualified: false, signals: [], signalsDetected: 0, signalsTotal: 1 },
    { level: 5, name: 'Self-Improving', rawScore: 0, qualified: false, signals: [], signalsDetected: 0, signalsTotal: 2 },
    { level: 6, name: 'Autonomous', rawScore: 0, qualified: false, signals: [], signalsDetected: 0, signalsTotal: 0 },
  ],
  componentScores: [
    {
      name: 'api', path: 'src/api', language: 'TypeScript', type: 'app',
      primaryLevel: 2, depth: 50, overallScore: 50, levels: [], signals: [
        { signal: 'README', present: true, detail: 'Found' },
        { signal: 'Documentation', present: false, detail: 'Not found' },
      ],
    },
  ],
  languageScores: [],
  projectContext: {
    languages: ['TypeScript'], frameworks: ['Express'], projectType: 'app',
    packageManager: 'npm', directoryTree: 'src/\n  api/\n  lib/', components: [],
  },
  selectedTool: 'copilot',
  modelUsed: 'test-model',
  scanMode: 'full',
  insights: [
    { title: 'Missing README', recommendation: 'Add README.md', severity: 'important', category: 'improvement' },
    { title: 'Add tests', recommendation: 'Create test suite', severity: 'suggestion', category: 'improvement' },
  ],
} as any;

// ── Panel rendering tests ───────────────────────────────────────

describe('GraphPanel rendering', () => {
  beforeEach(() => {
    (GraphPanel as any).currentPanel = undefined;
  });

  it('renders without crashing', () => {
    expect(() => GraphPanel.createOrShow(mockReport)).not.toThrow();
  });

  it('sets webview html containing <html and </html>', () => {
    GraphPanel.createOrShow(mockReport);
    const panel = (GraphPanel as any).currentPanel;
    const html: string = panel.panel.webview.html;
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  it('includes TACTICAL_GLASSBOX_CSS content', () => {
    GraphPanel.createOrShow(mockReport);
    const html: string = (GraphPanel as any).currentPanel.panel.webview.html;
    expect(html).toContain('--bg-primary');
  });

  it('does not contain literal "undefined" or "null" text', () => {
    GraphPanel.createOrShow(mockReport);
    const html: string = (GraphPanel as any).currentPanel.panel.webview.html;
    expect(html).not.toMatch(/>\s*undefined\s*</);
    expect(html).not.toMatch(/>\s*null\s*</);
  });

  it('contains expected section headers', () => {
    GraphPanel.createOrShow(mockReport);
    const html: string = (GraphPanel as any).currentPanel.panel.webview.html;
    expect(html).toContain('Repository Structure');
  });

  it('renders component data in the output', () => {
    GraphPanel.createOrShow(mockReport);
    const html: string = (GraphPanel as any).currentPanel.panel.webview.html;
    expect(html).toContain('TestProject');
    expect(html).toContain('1');  // component count
  });

  it('includes level information', () => {
    GraphPanel.createOrShow(mockReport);
    const html: string = (GraphPanel as any).currentPanel.panel.webview.html;
    expect(html).toContain('L2');
    expect(html).toContain('42'); // score
  });

  it('renders with empty componentScores without crashing', () => {
    const emptyReport = { ...mockReport, componentScores: [] } as any;
    (GraphPanel as any).currentPanel = undefined;
    expect(() => GraphPanel.createOrShow(emptyReport)).not.toThrow();
  });
});
