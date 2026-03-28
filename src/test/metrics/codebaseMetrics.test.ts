import { describe, it, expect } from 'vitest';
import { analyzeFileContent, calculateCodebaseMetrics, type FileAnalysis } from '../../metrics/codebaseMetrics';

// ─── analyzeFileContent ──────────────────────────────────────────────

describe('analyzeFileContent', () => {
  it('counts comments, imports, and type annotations in TypeScript', () => {
    const ts = [
      '// This is a comment',
      'import { Foo } from "./foo";',
      'import * as bar from "bar";',
      '',
      'interface Config {',
      '  name: string;',
      '  count: number;',
      '}',
      '',
      'const x: number = 42;',
      'function greet(name: string): void {}',
    ].join('\n');

    const result = analyzeFileContent('app.ts', ts, 'typescript');

    expect(result.path).toBe('app.ts');
    expect(result.language).toBe('typescript');
    expect(result.totalLines).toBe(11);
    expect(result.commentLines).toBe(1);
    expect(result.blankLines).toBe(2);
    expect(result.importCount).toBe(2);
    expect(result.typeAnnotationCount).toBeGreaterThanOrEqual(4); // string, number, Config, void
    expect(result.declarationCount).toBeGreaterThanOrEqual(3); // interface, const, function
  });

  it('counts docstrings, imports, and type hints in Python', () => {
    const py = [
      '# A utility module',
      'import os',
      'from typing import List',
      '',
      '"""',
      'Module-level docstring',
      '"""',
      '',
      'def greet(name: str) -> None:',
      '    count: int = 0',
      '    pass',
    ].join('\n');

    const result = analyzeFileContent('util.py', py, 'python');

    expect(result.commentLines).toBeGreaterThanOrEqual(3); // # comment + docstring block
    expect(result.importCount).toBe(2);
    expect(result.typeAnnotationCount).toBeGreaterThanOrEqual(2); // str, int, None
  });

  it('handles empty file gracefully', () => {
    const result = analyzeFileContent('empty.ts', '', 'typescript');

    expect(result.totalLines).toBe(1); // split('') gives ['']
    expect(result.commentLines).toBe(0);
    expect(result.blankLines).toBe(1);
    expect(result.importCount).toBe(0);
    expect(result.typeAnnotationCount).toBe(0);
    expect(result.declarationCount).toBe(0);
  });

  it('detects strict mode in TypeScript content', () => {
    const tsConfig = '{ "compilerOptions": { "strict": true } }';
    // analyzeFileContent checks the content itself for "strict": true
    const result = analyzeFileContent('tsconfig.json', tsConfig, 'typescript');
    // The strict check is `"strict"\s*:\s*true`
    expect(result.hasStrictMode).toBe(true);
  });

  it('detects strict mode in JavaScript', () => {
    const js = "'use strict';\nconst x = 1;";
    const result = analyzeFileContent('app.js', js, 'javascript');
    expect(result.hasStrictMode).toBe(true);
  });

  it('handles block comments spanning multiple lines', () => {
    const ts = [
      '/* block start',
      ' * middle line',
      ' * block end */',
      'const a = 1;',
    ].join('\n');

    const result = analyzeFileContent('block.ts', ts, 'typescript');
    expect(result.commentLines).toBe(3);
  });
});

// ─── calculateCodebaseMetrics ────────────────────────────────────────

describe('calculateCodebaseMetrics', () => {
  it('returns scores between 0 and 100 for mixed file analyses', () => {
    const files: FileAnalysis[] = [
      {
        path: 'a.ts', language: 'typescript',
        totalLines: 100, commentLines: 20, blankLines: 10,
        importCount: 5, typeAnnotationCount: 15, declarationCount: 20,
        hasStrictMode: true, totalProcedures: 10, documentedProcedures: 7,
      },
      {
        path: 'b.py', language: 'python',
        totalLines: 80, commentLines: 5, blankLines: 10,
        importCount: 3, typeAnnotationCount: 8, declarationCount: 10,
        hasStrictMode: false, totalProcedures: 5, documentedProcedures: 2,
      },
    ];

    const metrics = calculateCodebaseMetrics(files, []);

    expect(metrics.semanticDensity).toBeGreaterThanOrEqual(0);
    expect(metrics.semanticDensity).toBeLessThanOrEqual(100);
    expect(metrics.typeStrictnessIndex).toBeGreaterThanOrEqual(0);
    expect(metrics.typeStrictnessIndex).toBeLessThanOrEqual(100);
    expect(metrics.contextFragmentation).toBeGreaterThanOrEqual(0);
    expect(metrics.contextFragmentation).toBeLessThanOrEqual(100);
  });

  it('returns zero metrics for empty file list', () => {
    const metrics = calculateCodebaseMetrics([], []);
    expect(metrics.semanticDensity).toBe(0);
    expect(metrics.typeStrictnessIndex).toBe(0);
    expect(metrics.contextFragmentation).toBe(100);
  });
});

// ─── Semantic density ────────────────────────────────────────────────

describe('semantic density', () => {
  it('well-documented file has higher density than undocumented file', () => {
    const documented: FileAnalysis = {
      path: 'documented.ts', language: 'typescript',
      totalLines: 100, commentLines: 40, blankLines: 10,
      importCount: 2, typeAnnotationCount: 5, declarationCount: 10, hasStrictMode: false, totalProcedures: 5, documentedProcedures: 2,
      totalProcedures: 10, documentedProcedures: 8,
    };
    const undocumented: FileAnalysis = {
      path: 'bare.ts', language: 'typescript',
      totalLines: 100, commentLines: 0, blankLines: 10,
      importCount: 2, typeAnnotationCount: 5, declarationCount: 10, hasStrictMode: false, totalProcedures: 5, documentedProcedures: 2,
      totalProcedures: 10, documentedProcedures: 0,
    };

    const withDocs = calculateCodebaseMetrics([documented], []);
    const withoutDocs = calculateCodebaseMetrics([undocumented], []);

    expect(withDocs.semanticDensity).toBeGreaterThan(withoutDocs.semanticDensity);
  });

  it('measures documented procedures ratio not comment line count', () => {
    // File with lots of inline comments but no function docs
    const verboseComments: FileAnalysis = {
      path: 'verbose.ts', language: 'typescript',
      totalLines: 100, commentLines: 50, blankLines: 10,
      importCount: 2, typeAnnotationCount: 5, declarationCount: 10, hasStrictMode: false, totalProcedures: 5, documentedProcedures: 2,
      totalProcedures: 10, documentedProcedures: 0,
    };
    // File with fewer comments but all functions documented
    const docstrings: FileAnalysis = {
      path: 'docstrings.ts', language: 'typescript',
      totalLines: 100, commentLines: 10, blankLines: 10,
      importCount: 2, typeAnnotationCount: 5, declarationCount: 10, hasStrictMode: false, totalProcedures: 5, documentedProcedures: 2,
      totalProcedures: 10, documentedProcedures: 10,
    };

    const verbose = calculateCodebaseMetrics([verboseComments], []);
    const withDocstrings = calculateCodebaseMetrics([docstrings], []);

    // Docstring-based file should score higher even with fewer comment lines
    expect(withDocstrings.semanticDensity).toBeGreaterThan(verbose.semanticDensity);
  });
});

// ─── Type strictness ─────────────────────────────────────────────────

describe('type strictness', () => {
  it('strict TS file scores higher than JS with no types', () => {
    const strictTs: FileAnalysis = {
      path: 'strict.ts', language: 'typescript',
      totalLines: 50, commentLines: 5, blankLines: 5,
      importCount: 2, typeAnnotationCount: 15, declarationCount: 10, hasStrictMode: true, totalProcedures: 5, documentedProcedures: 3,
    };
    const plainJs: FileAnalysis = {
      path: 'plain.js', language: 'javascript',
      totalLines: 50, commentLines: 5, blankLines: 5,
      importCount: 2, typeAnnotationCount: 0, declarationCount: 10, hasStrictMode: false, totalProcedures: 5, documentedProcedures: 2,
    };

    const tsMetrics = calculateCodebaseMetrics([strictTs], []);
    const jsMetrics = calculateCodebaseMetrics([plainJs], []);

    expect(tsMetrics.typeStrictnessIndex).toBeGreaterThan(jsMetrics.typeStrictnessIndex);
  });
});

// ─── Context fragmentation ───────────────────────────────────────────

describe('context fragmentation', () => {
  it('many imports produces lower fragmentation score than few imports', () => {
    const manyImports: FileAnalysis = {
      path: 'heavy.ts', language: 'typescript',
      totalLines: 100, commentLines: 5, blankLines: 5,
      importCount: 15, typeAnnotationCount: 5, declarationCount: 10, hasStrictMode: false, totalProcedures: 5, documentedProcedures: 2,
    };
    const fewImports: FileAnalysis = {
      path: 'light.ts', language: 'typescript',
      totalLines: 100, commentLines: 5, blankLines: 5,
      importCount: 1, typeAnnotationCount: 5, declarationCount: 10, hasStrictMode: false, totalProcedures: 5, documentedProcedures: 2,
    };

    const heavy = calculateCodebaseMetrics([manyImports], []);
    const light = calculateCodebaseMetrics([fewImports], []);

    // Higher imports → lower contextFragmentation (log scale)
    expect(heavy.contextFragmentation).toBeLessThan(light.contextFragmentation);
  });
});
