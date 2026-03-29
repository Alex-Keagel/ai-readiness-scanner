import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { CodebaseProfiler } from '../../deep/codebaseProfiler';

function mockCopilotClient(analyzeResult = '[]') {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    analyze: vi.fn().mockResolvedValue(analyzeResult),
    analyzeFast: vi.fn().mockResolvedValue(analyzeResult),
  } as any;
}

describe('CodebaseProfiler', () => {
  // ─── Pure: analyzeModule ───────────────────────────────────────────

  describe('analyzeModule', () => {
    const profiler = new CodebaseProfiler();
    const analyze = (path: string, content: string) =>
      (profiler as any).analyzeModule(path, content);

    it('detects TypeScript language from .ts extension', () => {
      const mod = analyze('src/main.ts', 'export const x = 1;');
      expect(mod.language).toBe('TypeScript');
    });

    it('detects JavaScript language from .js extension', () => {
      const mod = analyze('esbuild.js', 'const x = require("esbuild");');
      expect(mod.language).toBe('JavaScript');
    });

    it('detects Python language from .py extension', () => {
      const mod = analyze('main.py', 'def main(): pass');
      expect(mod.language).toBe('Python');
    });

    it('detects Go language from .go extension', () => {
      const mod = analyze('main.go', 'package main\nfunc main() {}');
      expect(mod.language).toBe('Go');
    });

    it('counts exports correctly', () => {
      const content = `
export function foo() {}
export class Bar {}
export const baz = 1;
export interface Qux {}
export type MyType = string;
const internal = 2;
`;
      const mod = analyze('src/utils.ts', content);
      expect(mod.exportCount).toBe(5);
      expect(mod.exports).toContain('foo');
      expect(mod.exports).toContain('Bar');
      expect(mod.exports).toContain('baz');
      expect(mod.exports).toContain('Qux');
      expect(mod.exports).toContain('MyType');
    });

    it('counts async function exports', () => {
      const content = 'export async function fetchData() {}\nexport async function loadConfig() {}';
      const mod = analyze('src/api.ts', content);
      expect(mod.exportCount).toBe(2);
      expect(mod.exports).toContain('fetchData');
      expect(mod.exports).toContain('loadConfig');
    });

    it('counts import statements', () => {
      const content = `import * as vscode from 'vscode';
import { foo } from './utils';
import path from 'path';
const x = 1;`;
      const mod = analyze('src/ext.ts', content);
      expect(mod.importCount).toBe(3);
    });

    it('detects entry-point role for extension.ts', () => {
      const mod = analyze('src/extension.ts', 'export function activate() {}');
      expect(mod.role).toBe('entry-point');
    });

    it('detects entry-point role for main.ts', () => {
      const mod = analyze('src/main.ts', 'export function main() {}');
      expect(mod.role).toBe('entry-point');
    });

    it('detects entry-point role for index.ts', () => {
      const mod = analyze('src/index.ts', 'export * from "./app";');
      expect(mod.role).toBe('entry-point');
    });

    it('detects test role for .test.ts files', () => {
      const mod = analyze('src/utils.test.ts', 'describe("utils", () => {});');
      expect(mod.role).toBe('test');
    });

    it('detects test role for .spec.ts files', () => {
      const mod = analyze('src/utils.spec.ts', 'describe("utils", () => {});');
      expect(mod.role).toBe('test');
    });

    it('detects test role for __tests__ files', () => {
      const mod = analyze('src/__tests__/utils.ts', 'test("works", () => {});');
      expect(mod.role).toBe('test');
    });

    it('detects type-def role for types files', () => {
      const mod = analyze('src/scoring/types.ts', 'export interface Score {}');
      expect(mod.role).toBe('type-def');
    });

    it('detects ui role', () => {
      const mod = analyze('src/ui/sidebar.ts', 'export function render() {}');
      expect(mod.role).toBe('ui');
    });

    it('detects utility role', () => {
      const mod = analyze('src/utils/helpers.ts', 'export function format() {}');
      expect(mod.role).toBe('utility');
    });

    it('detects config role', () => {
      const mod = analyze('vitest.config.ts', 'export default {}');
      expect(mod.role).toBe('config');
    });

    it('detects core-logic for files with exports and >30 lines', () => {
      const lines = Array(40).fill('const x = 1;');
      lines[0] = 'export function process() {}';
      const mod = analyze('src/scoring/engine.ts', lines.join('\n'));
      expect(mod.role).toBe('core-logic');
    });

    it('detects JSDoc presence', () => {
      const content = '/** This module does things */\nexport function foo() {}';
      const mod = analyze('src/foo.ts', content);
      expect(mod.hasDocstring).toBe(true);
    });

    it('detects Python docstring presence', () => {
      const content = '"""\nModule docstring\n"""\ndef foo(): pass';
      const mod = analyze('main.py', content);
      expect(mod.hasDocstring).toBe(true);
    });

    it('reports no docstring when absent', () => {
      const mod = analyze('src/bare.ts', 'export const x = 1;');
      expect(mod.hasDocstring).toBe(false);
    });

    it('classifies complexity by line count', () => {
      const low = analyze('src/small.ts', 'const x = 1;\n'.repeat(50));
      const medium = analyze('src/mid.ts', 'const x = 1;\n'.repeat(200));
      const high = analyze('src/big.ts', 'const x = 1;\n'.repeat(600));
      expect(low.complexity).toBe('low');
      expect(medium.complexity).toBe('medium');
      expect(high.complexity).toBe('high');
    });

    it('detects inline test patterns', () => {
      const mod = analyze('src/runner.ts', 'describe("test", () => { it("works", () => {}) });');
      expect(mod.hasTests).toBe(true);
    });

    it('initializes fanIn to 0', () => {
      const mod = analyze('src/foo.ts', 'export const x = 1;');
      expect(mod.fanIn).toBe(0);
    });
  });

  // ─── Pure: extractImportPaths ──────────────────────────────────────

  describe('extractImportPaths', () => {
    const profiler = new CodebaseProfiler();
    const extract = (content: string, filePath = 'src/app.ts') =>
      (profiler as any).extractImportPaths(content, filePath);

    it('extracts ES module imports', () => {
      const imports = extract("import { foo } from './utils';");
      expect(imports.length).toBe(1);
      expect(imports[0]).toContain('utils');
    });

    it('extracts multiple imports', () => {
      const imports = extract("import { a } from './a';\nimport { b } from './b';");
      expect(imports.length).toBe(2);
    });

    it('extracts require() calls', () => {
      const imports = extract("const fs = require('fs');");
      expect(imports).toContain('fs');
    });

    it('resolves relative paths', () => {
      const imports = extract("import { x } from '../scoring/engine';", 'src/ui/panel.ts');
      expect(imports[0]).toContain('scoring');
    });

    it('keeps package names as-is', () => {
      const imports = extract("import * as vscode from 'vscode';");
      expect(imports).toContain('vscode');
    });

    it('handles default imports', () => {
      const imports = extract("import path from 'path';");
      expect(imports).toContain('path');
    });

    it('handles namespace imports', () => {
      const imports = extract("import * as fs from 'fs';");
      expect(imports).toContain('fs');
    });

    it('returns empty array for content with no imports', () => {
      const imports = extract('const x = 1;\nconsole.log(x);');
      expect(imports).toEqual([]);
    });
  });

  // ─── With mocks: profile ───────────────────────────────────────────

  describe('profile', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('returns empty profile when no files found', async () => {
      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([]);
      const profiler = new CodebaseProfiler();
      const profile = await profiler.profile(vscode.Uri.file('/workspace'));

      expect(profile.modules).toHaveLength(0);
      expect(profile.totalFiles).toBe(0);
      expect(profile.hotspots).toHaveLength(0);
    });

    it('profiles discovered modules', async () => {
      const extensionTs = 'export function activate() {}\nexport function deactivate() {}';
      const utilsTs = 'export function helper() {}\nimport { activate } from "./extension";';

      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([
        vscode.Uri.file('/workspace/src/extension.ts'),
        vscode.Uri.file('/workspace/src/utils.ts'),
      ]);
      vi.spyOn(vscode.workspace.fs, 'readFile')
        .mockResolvedValueOnce(new Uint8Array(Buffer.from(extensionTs)))
        .mockResolvedValueOnce(new Uint8Array(Buffer.from(utilsTs)));
      (vscode.workspace as any).asRelativePath = vi.fn()
        .mockReturnValueOnce('src/extension.ts')
        .mockReturnValueOnce('src/utils.ts');

      const profiler = new CodebaseProfiler();
      const profile = await profiler.profile(vscode.Uri.file('/workspace'));

      expect(profile.modules.length).toBe(2);
      expect(profile.totalFiles).toBe(2);
      expect(profile.entryPoints).toContain('src/extension.ts');
    });

    it('calculates fan-in from import graph', async () => {
      // utils.ts is imported by both extension.ts and panel.ts
      const files = [
        { path: 'src/extension.ts', content: "import { helper } from './utils';\nexport function activate() {}" },
        { path: 'src/utils.ts', content: 'export function helper() {}' },
        { path: 'src/ui/panel.ts', content: "import { helper } from '../utils';\nexport function render() {}" },
      ];

      let findIdx = 0;
      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue(
        files.map(f => vscode.Uri.file(`/workspace/${f.path}`))
      );
      let readIdx = 0;
      vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(async () =>
        new Uint8Array(Buffer.from(files[readIdx++]?.content || ''))
      );
      let relIdx = 0;
      (vscode.workspace as any).asRelativePath = vi.fn().mockImplementation(() => {
        return files[relIdx++]?.path || '';
      });

      const profiler = new CodebaseProfiler();
      const profile = await profiler.profile(vscode.Uri.file('/workspace'));

      const utilsMod = profile.modules.find(m => m.path === 'src/utils.ts');
      expect(utilsMod).toBeDefined();
      // utils is imported by extension and panel → fan-in >= 1
      expect(utilsMod!.fanIn).toBeGreaterThanOrEqual(1);
    });

    it('identifies hotspots (high fan-in + >100 lines)', async () => {
      const bigModule = 'export function process() {}\n' + 'const x = 1;\n'.repeat(150);
      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([
        vscode.Uri.file('/workspace/src/engine.ts'),
      ]);
      vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
        new Uint8Array(Buffer.from(bigModule))
      );
      (vscode.workspace as any).asRelativePath = vi.fn().mockReturnValue('src/engine.ts');

      const profiler = new CodebaseProfiler();
      const profile = await profiler.profile(vscode.Uri.file('/workspace'));

      // Single module with 0 fan-in won't be a hotspot (needs >=3)
      expect(profile.hotspots).toHaveLength(0);
    });

    it('finds untested modules', async () => {
      const lines = Array(60).fill('const x = 1;');
      lines[0] = 'export function doStuff() {}';
      const content = lines.join('\n');

      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([
        vscode.Uri.file('/workspace/src/engine.ts'),
      ]);
      vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
        new Uint8Array(Buffer.from(content))
      );
      (vscode.workspace as any).asRelativePath = vi.fn().mockReturnValue('src/engine.ts');

      const profiler = new CodebaseProfiler();
      const profile = await profiler.profile(vscode.Uri.file('/workspace'));

      expect(profile.untestedModules).toContain('src/engine.ts');
    });

    it('uses LLM for pipeline discovery when available', async () => {
      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([
        vscode.Uri.file('/workspace/src/extension.ts'),
      ]);
      vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
        new Uint8Array(Buffer.from('export function activate() {}'))
      );
      (vscode.workspace as any).asRelativePath = vi.fn().mockReturnValue('src/extension.ts');

      const client = mockCopilotClient(JSON.stringify([
        { name: 'scan pipeline', entryPoint: 'src/extension.ts', steps: [{ file: 'src/extension.ts', order: 1 }] }
      ]));

      const profiler = new CodebaseProfiler(client);
      const profile = await profiler.profile(vscode.Uri.file('/workspace'));

      expect(client.analyze).toHaveBeenCalled();
      expect(profile.pipelines.length).toBe(1);
      expect(profile.pipelines[0].name).toBe('scan pipeline');
    });

    it('gracefully handles LLM pipeline discovery failure', async () => {
      vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([
        vscode.Uri.file('/workspace/src/extension.ts'),
      ]);
      vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
        new Uint8Array(Buffer.from('export function activate() {}'))
      );
      (vscode.workspace as any).asRelativePath = vi.fn().mockReturnValue('src/extension.ts');

      const client = mockCopilotClient();
      client.analyze.mockRejectedValue(new Error('LLM timeout'));

      const profiler = new CodebaseProfiler(client);
      const profile = await profiler.profile(vscode.Uri.file('/workspace'));

      expect(profile.pipelines).toHaveLength(0);
      expect(profile.modules.length).toBe(1); // still profiled the module
    });
  });
});
