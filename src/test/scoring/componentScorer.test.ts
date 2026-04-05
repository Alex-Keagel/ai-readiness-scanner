import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentScorer } from '../../scoring/componentScorer';
import { Uri, workspace, RelativePattern } from '../mocks/vscode';
import { AI_TOOLS } from '../../scoring/types';
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

    it('filters phantom aggregators like .devconfig even WITH children', async () => {
      const ctx = makeContext({
        components: [
          makeComponent({ name: 'Dev Config', path: '.devconfig', language: 'Multi', type: 'config',
            children: ['.azuredevops', '.config', '.vscode'] } as any),
          makeComponent({ name: 'Infra', path: '.infrastructure', language: 'Multi', type: 'infra' }),
          makeComponent({ name: 'Real', path: 'src/real' }),
        ],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const paths = scores.map(s => s.path);
      expect(paths).not.toContain('.devconfig');
      expect(paths).not.toContain('.infrastructure');
      expect(paths).toContain('src/real');
    });

    it('keeps real dotfile dirs like .azuredevops, .clinerules, .config', async () => {
      const ctx = makeContext({
        components: [
          makeComponent({ name: 'CI/CD', path: '.azuredevops', language: 'YAML', type: 'config' }),
          makeComponent({ name: 'Cline', path: '.clinerules', language: 'Markdown', type: 'config' }),
          makeComponent({ name: 'Config', path: '.config', language: 'YAML', type: 'config' }),
        ],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const paths = scores.map(s => s.path);
      expect(paths).toContain('.azuredevops');
      expect(paths).toContain('.clinerules');
      expect(paths).toContain('.config');
    });
  });

  // ── Workspace signal scoping (Bug E) ───────────────────────────

  describe('workspace signal scoping', () => {
    it('does NOT leak workspace-level instruction files to components', async () => {
      // Workspace has .github/copilot-instructions.md, but component dir does not
      findFilesSpy.mockImplementation(async (pattern: any) => {
        const base = typeof pattern === 'string' ? '' : (pattern.base || '');
        const p = typeof pattern === 'string' ? pattern : (pattern.pattern || '');
        // Only return the workspace-root instructions file, not a component-prefixed fallback path
        if (base === '/mock-workspace' && p === '.github/copilot-instructions.md') {
          return [Uri.file('/mock-workspace/.github/copilot-instructions.md')];
        }
        return [];
      });
      const ctx = makeContext({
        components: [makeComponent({ name: 'api', path: 'src/api', language: 'TypeScript' })],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const instrSignal = scores[0].signals.find(s => s.signal.includes('Instructions'));
      expect(instrSignal).toBeDefined();
      expect(instrSignal!.present).toBe(false);
    });

    it('detects instruction files within the component directory', async () => {
      findFilesSpy.mockImplementation(async (pattern: any) => {
        const base = typeof pattern === 'string' ? '' : (pattern.base || '');
        const p = typeof pattern === 'string' ? pattern : (pattern.pattern || '');
        // Component has its own copilot-instructions.md
        if (base.includes('src/api') && p.includes('copilot-instructions')) {
          return [Uri.file('/mock-workspace/src/api/.github/copilot-instructions.md')];
        }
        return [];
      });
      const ctx = makeContext({
        components: [makeComponent({ name: 'api', path: 'src/api', language: 'TypeScript' })],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const instrSignal = scores[0].signals.find(s => s.signal.includes('Instructions'));
      expect(instrSignal).toBeDefined();
      expect(instrSignal!.present).toBe(true);
    });

    it('detects sub-project .github instructions via workspace-prefixed fallback', async () => {
      findFilesSpy.mockImplementation(async (pattern: any) => {
        const base = typeof pattern === 'string' ? '' : (pattern.base || '');
        const p = typeof pattern === 'string' ? pattern : (pattern.pattern || '');
        if (base === '/mock-workspace' && p === 'risk-register/.github/copilot-instructions.md') {
          return [Uri.file('/mock-workspace/risk-register/.github/copilot-instructions.md')];
        }
        return [];
      });

      const ctx = makeContext({
        components: [makeComponent({ name: 'risk-register', path: 'risk-register', language: 'TypeScript' })],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const instrSignal = scores[0].signals.find(s => s.signal.includes('Instructions'));
      expect(instrSignal).toBeDefined();
      expect(instrSignal!.present).toBe(true);
    });

    it('searches AI_TOOLS instruction patterns with component-relative RelativePatterns', async () => {
      const seenPatterns: Array<{ base: string; pattern: string }> = [];
      findFilesSpy.mockImplementation(async (pattern: any) => {
        seenPatterns.push({
          base: typeof pattern === 'string' ? '' : (pattern.base || ''),
          pattern: typeof pattern === 'string' ? pattern : (pattern.pattern || ''),
        });
        return [];
      });

      const ctx = makeContext({
        components: [makeComponent({ name: 'risk-register', path: 'risk-register', language: 'TypeScript' })],
      });
      await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');

      const copilotPatterns = [...AI_TOOLS.copilot.level2Files, ...AI_TOOLS.copilot.level3Files];
      for (const expectedPattern of copilotPatterns) {
        expect(seenPatterns).toContainEqual({
          base: '/mock-workspace/risk-register',
          pattern: expectedPattern,
        });
      }
    });

    it('keeps workspace CONTRIBUTING.md as a fallback for component Conventions signal', async () => {
      findFilesSpy.mockImplementation(async (pattern: any) => {
        const base = typeof pattern === 'string' ? '' : (pattern.base || '');
        const p = typeof pattern === 'string' ? pattern : (pattern.pattern || '');
        if (base.includes('/mock-workspace') && !base.includes('src/api') && p.includes('CONTRIBUTING')) {
          return [Uri.file('/mock-workspace/CONTRIBUTING.md')];
        }
        return [];
      });
      const ctx = makeContext({
        components: [makeComponent({ name: 'api', path: 'src/api', language: 'TypeScript' })],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const convSignal = scores[0].signals.find(s => s.signal === 'Conventions Documented');
      expect(convSignal).toBeDefined();
      expect(convSignal!.present).toBe(true);
    });

    it('keeps workspace ARCHITECTURE.md as a fallback for component Structure signal', async () => {
      findFilesSpy.mockImplementation(async (pattern: any) => {
        const base = typeof pattern === 'string' ? '' : (pattern.base || '');
        const p = typeof pattern === 'string' ? pattern : (pattern.pattern || '');
        if (base.includes('/mock-workspace') && !base.includes('src/api') && p.includes('ARCHITECTURE')) {
          return [Uri.file('/mock-workspace/ARCHITECTURE.md')];
        }
        return [];
      });
      const ctx = makeContext({
        components: [makeComponent({ name: 'api', path: 'src/api', language: 'TypeScript' })],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const structSignal = scores[0].signals.find(s => s.signal === 'Structure Documented');
      expect(structSignal).toBeDefined();
      expect(structSignal!.present).toBe(true);
    });

    it('keeps workspace deployment docs as a fallback for infra components', async () => {
      findFilesSpy.mockImplementation(async (pattern: any) => {
        const base = typeof pattern === 'string' ? '' : (pattern.base || '');
        const p = typeof pattern === 'string' ? pattern : (pattern.pattern || '');
        if (base.includes('/mock-workspace') && !base.includes('infra/network') && p.includes('docs/deploy')) {
          return [Uri.file('/mock-workspace/docs/deploy.md')];
        }
        return [];
      });
      const ctx = makeContext({
        components: [makeComponent({ name: 'network', path: 'infra/network', language: 'Bicep', type: 'infra' })],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const deploySignal = scores[0].signals.find(s => s.signal === 'Deployment Documented');
      expect(deploySignal).toBeDefined();
      expect(deploySignal!.present).toBe(true);
    });
  });

  // ── Shared test project detection ──────────────────────────────

  describe('shared test project detection', () => {
    it('detects Parent.Tests covering Parent.Domain (namespace-based)', async () => {
      const statSpy = vi.spyOn(workspace.fs, 'stat');
      statSpy.mockImplementation(async (uri) => {
        var path = uri.toString ? uri.toString() : String(uri);
        if (path.includes('DataProcessing.Tests')) {
          return { type: 2, ctime: 0, mtime: 0, size: 0 };
        }
        throw new Error('not found');
      });

      const ctx = makeContext({
        components: [makeComponent({
          name: 'DataProcessing.Domain',
          path: 'src/DataProcessing/DataProcessing.Domain',
          language: 'C#', type: 'library',
        })],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const testSignal = scores[0].signals.find(s => s.signal === 'Tests');
      expect(testSignal).toBeDefined();
      expect(testSignal!.present).toBe(true);
    });

    it('detects tests in grandparent directory (Sample.Console.Tests)', async () => {
      const statSpy = vi.spyOn(workspace.fs, 'stat');
      statSpy.mockImplementation(async (uri) => {
        var path = uri.toString ? uri.toString() : String(uri);
        if (path.includes('Console/Sample.Console.Tests')) {
          return { type: 2, ctime: 0, mtime: 0, size: 0 };
        }
        throw new Error('not found');
      });

      const ctx = makeContext({
        components: [makeComponent({
          name: 'Sample.Console.Application',
          path: 'src/sample/Console/Sample.Console.Application',
          language: 'C#', type: 'app',
        })],
      });
      const scores = await scorer.scoreComponents(workspaceUri as any, ctx, 'copilot');
      const testSignal = scores[0].signals.find(s => s.signal === 'Tests');
      expect(testSignal).toBeDefined();
      expect(testSignal!.present).toBe(true);
    });
  });
});
