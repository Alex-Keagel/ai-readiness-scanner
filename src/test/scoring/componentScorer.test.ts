import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentScorer } from '../../scoring/componentScorer';
import { Uri, workspace, RelativePattern } from '../mocks/vscode';
import type { ProjectContext, ComponentInfo, AITool } from '../../scoring/types';

// ── Mock Setup ──────────────────────────────────────────────────

const workspaceUri = Uri.file('/mock-workspace');

function makeContext(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    languages: ['TypeScript'],
    frameworks: ['express'],
    projectType: 'app',
    packageManager: 'npm',
    directoryTree: '.',
    components: [],
    ...overrides,
  };
}

function makeComponent(overrides: Partial<ComponentInfo> = {}): ComponentInfo {
  return {
    name: 'my-component',
    path: 'src/my-component',
    language: 'TypeScript',
    type: 'app',
    ...overrides,
  };
}

describe('ComponentScorer', () => {
  let scorer: ComponentScorer;
  let findFilesSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scorer = new ComponentScorer();
    // Default: no files found
    findFilesSpy = vi.fn().mockResolvedValue([]);
    workspace.findFiles = findFilesSpy as typeof workspace.findFiles;
  });

  // ── Tests signal exclusion for non-programming languages ──────

  describe('language-aware signal selection', () => {
    it('does NOT include "Tests" signal for KQL language', async () => {
      const ctx = makeContext({ languages: ['KQL'], components: [makeComponent({ language: 'KQL', type: 'data' })] });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const signalNames = scores[0].signals.map(s => s.signal);
      expect(signalNames).not.toContain('Tests');
    });

    it('does NOT include "Build Config" signal for KQL language', async () => {
      const ctx = makeContext({ languages: ['KQL'], components: [makeComponent({ language: 'KQL', type: 'data' })] });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const signalNames = scores[0].signals.map(s => s.signal);
      expect(signalNames).not.toContain('Build Config');
    });

    it('does NOT include "Tests" signal for JSON language', async () => {
      const ctx = makeContext({ languages: ['JSON'], components: [makeComponent({ language: 'JSON', type: 'config' })] });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const signalNames = scores[0].signals.map(s => s.signal);
      expect(signalNames).not.toContain('Tests');
    });

    it('DOES include "Tests" signal for TypeScript app/library components', async () => {
      const ctx = makeContext({ languages: ['TypeScript'], components: [makeComponent({ language: 'TypeScript', type: 'library' })] });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const signalNames = scores[0].signals.map(s => s.signal);
      expect(signalNames).toContain('Tests');
    });

    it('DOES include "Build Config" signal for TypeScript', async () => {
      const ctx = makeContext({ languages: ['TypeScript'], components: [makeComponent({ language: 'TypeScript' })] });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const signalNames = scores[0].signals.map(s => s.signal);
      expect(signalNames).toContain('Build Config');
    });
  });

  // ── Signal detection: README ──────────────────────────────────

  describe('signal detection', () => {
    it('marks README as absent when no README file found', async () => {
      const ctx = makeContext({ components: [makeComponent()] });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const readme = scores[0].signals.find(s => s.signal === 'README');
      expect(readme).toBeDefined();
      expect(readme!.present).toBe(false);
    });

    it('marks README as present when findFiles returns a match', async () => {
      findFilesSpy.mockImplementation(async (pattern: any) => {
        const p = typeof pattern === 'string' ? pattern : (pattern.pattern || '');
        if (p.includes('README')) return [Uri.file('/mock-workspace/README.md')];
        return [];
      });
      const ctx = makeContext({ components: [makeComponent()] });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const readme = scores[0].signals.find(s => s.signal === 'README');
      expect(readme).toBeDefined();
      expect(readme!.present).toBe(true);
    });

    it('marks Documentation as absent when no docs found', async () => {
      const ctx = makeContext({ components: [makeComponent()] });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const docs = scores[0].signals.find(s => s.signal === 'Documentation');
      expect(docs).toBeDefined();
      expect(docs!.present).toBe(false);
    });
  });

  // ── scoreComponents with no components → single root entry ────

  describe('scoreComponents', () => {
    it('returns single root component when no components defined', async () => {
      const ctx = makeContext({ components: [] });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      expect(scores.length).toBe(1);
      expect(scores[0].path).toBe('.');
    });

    it('returns one score per component', async () => {
      const comps = [
        makeComponent({ name: 'api', path: 'src/api', language: 'TypeScript' }),
        makeComponent({ name: 'web', path: 'src/web', language: 'TypeScript' }),
      ];
      const ctx = makeContext({ components: comps });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      expect(scores.length).toBe(2);
      expect(scores.map(s => s.name)).toEqual(['api', 'web']);
    });
  });

  // ── Automation signal for config/data components ──────────────

  describe('config/data component signals', () => {
    it('includes "Automation" signal for JSON config component', async () => {
      const ctx = makeContext({
        components: [makeComponent({ language: 'JSON', type: 'config' })],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const signalNames = scores[0].signals.map(s => s.signal);
      expect(signalNames).toContain('Automation');
    });
  });
});
