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

  // ── Companion .Tests project detection ──────────────────────────

  describe('companion test project detection', () => {
    it('detects companion .Tests project for C# component', async () => {
      // No test files in component dir, but Storage.Tests exists as sibling
      const statSpy = vi.spyOn(workspace.fs, 'stat');
      statSpy.mockImplementation(async (uri: any) => {
        const path = uri.toString?.() || uri.fsPath || String(uri);
        if (path.includes('Storage.Tests')) {
          return { type: 2, ctime: 0, mtime: 0, size: 0 };
        }
        throw new Error('not found');
      });

      const ctx = makeContext({
        components: [makeComponent({ name: 'Storage', path: 'src/common/Storage', language: 'C#', type: 'library' })],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const testSignal = scores[0].signals.find(s => s.signal === 'Tests');
      expect(testSignal).toBeDefined();
      expect(testSignal!.present).toBe(true);
    });

    it('detects companion .Integration.Tests project', async () => {
      const statSpy = vi.spyOn(workspace.fs, 'stat');
      statSpy.mockImplementation(async (uri: any) => {
        const path = uri.toString?.() || uri.fsPath || String(uri);
        if (path.includes('LogAnalytics.Query.Integration.Tests')) {
          return { type: 2, ctime: 0, mtime: 0, size: 0 };
        }
        throw new Error('not found');
      });

      const ctx = makeContext({
        components: [makeComponent({ name: 'LogAnalytics.Query', path: 'src/DataAcquisition/LogAnalytics.Query', language: 'C#', type: 'library' })],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const testSignal = scores[0].signals.find(s => s.signal === 'Tests');
      expect(testSignal).toBeDefined();
      expect(testSignal!.present).toBe(true);
    });

    it('marks Tests absent when no companion project exists either', async () => {
      const statSpy = vi.spyOn(workspace.fs, 'stat');
      statSpy.mockRejectedValue(new Error('not found'));

      const ctx = makeContext({
        components: [makeComponent({ name: 'Orphan', path: 'src/common/Orphan', language: 'C#', type: 'library' })],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const testSignal = scores[0].signals.find(s => s.signal === 'Tests');
      expect(testSignal).toBeDefined();
      expect(testSignal!.present).toBe(false);
    });
  });

  // ── Phantom component filtering ────────────────────────────────

  describe('phantom component filtering', () => {
    it('filters out .group-* virtual components from output', async () => {
      const ctx = makeContext({
        components: [
          makeComponent({ name: 'RealComp', path: 'src/RealComp' }),
          makeComponent({ name: 'Hosting', path: 'src/common/.group-Hosting', children: ['src/common/Hosting', 'src/common/Hosting.Web'] }),
          makeComponent({ name: 'Storage', path: 'src/common/.group-Storage', children: ['src/common/Storage'] }),
        ],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const paths = scores.map(s => s.path);
      expect(paths).toContain('src/RealComp');
      expect(paths).not.toContain('src/common/.group-Hosting');
      expect(paths).not.toContain('src/common/.group-Storage');
    });

    it('keeps .github and .vscode components (they are real dirs)', async () => {
      const ctx = makeContext({
        components: [
          makeComponent({ name: 'GitHub', path: '.github', language: 'Multi', type: 'config' }),
          makeComponent({ name: 'VSCode', path: '.vscode', language: 'JSON', type: 'config' }),
        ],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const paths = scores.map(s => s.path);
      expect(paths).toContain('.github');
      expect(paths).toContain('.vscode');
    });

    it('filters phantom aggregators like .devconfig without children', async () => {
      const ctx = makeContext({
        components: [
          makeComponent({ name: 'Dev Config', path: '.devconfig', language: 'Multi', type: 'config' }),
          makeComponent({ name: 'Real', path: 'src/real' }),
        ],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const paths = scores.map(s => s.path);
      expect(paths).not.toContain('.devconfig');
      expect(paths).toContain('src/real');
    });
  });
});
