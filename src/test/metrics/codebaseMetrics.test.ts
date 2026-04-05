import { describe, it, expect } from 'vitest';
import { analyzeFileContent, calculateCodebaseMetrics, computeBlendedSemanticDensity, computeWeightedSemanticDensity, type FileAnalysis } from '../../metrics/codebaseMetrics';

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
      totalLines: 200, commentLines: 40, blankLines: 10,
      importCount: 2, typeAnnotationCount: 5, declarationCount: 10, hasStrictMode: false,
      totalProcedures: 25, documentedProcedures: 20,
    };
    const undocumented: FileAnalysis = {
      path: 'bare.ts', language: 'typescript',
      totalLines: 200, commentLines: 0, blankLines: 10,
      importCount: 2, typeAnnotationCount: 5, declarationCount: 10, hasStrictMode: false,
      totalProcedures: 25, documentedProcedures: 0,
    };

    const withDocs = calculateCodebaseMetrics([documented], []);
    const withoutDocs = calculateCodebaseMetrics([undocumented], []);

    expect(withDocs.semanticDensity).toBeGreaterThan(withoutDocs.semanticDensity);
  });

  it('measures documented procedures ratio not comment line count', () => {
    // File with lots of inline comments but no function docs
    const verboseComments: FileAnalysis = {
      path: 'verbose.ts', language: 'typescript',
      totalLines: 200, commentLines: 50, blankLines: 10,
      importCount: 2, typeAnnotationCount: 5, declarationCount: 10, hasStrictMode: false,
      totalProcedures: 25, documentedProcedures: 0,
    };
    // File with fewer comments but all functions documented
    const docstrings: FileAnalysis = {
      path: 'docstrings.ts', language: 'typescript',
      totalLines: 200, commentLines: 10, blankLines: 10,
      importCount: 2, typeAnnotationCount: 5, declarationCount: 10, hasStrictMode: false,
      totalProcedures: 25, documentedProcedures: 25,
    };

    const verbose = calculateCodebaseMetrics([verboseComments], []);
    const withDocstrings = calculateCodebaseMetrics([docstrings], []);

    // Docstring-based file should score higher even with fewer comment lines
    expect(withDocstrings.semanticDensity).toBeGreaterThan(verbose.semanticDensity);
  });
});

// ─── computeBlendedSemanticDensity caps ──────────────────────────────

describe('computeBlendedSemanticDensity', () => {
  it('normal case: 500 procs, 200 documented → reasonable score (~50-60)', () => {
    const score = computeBlendedSemanticDensity(500, 200, 10_000, 1_000);
    expect(score).toBeGreaterThanOrEqual(40);
    expect(score).toBeLessThanOrEqual(65);
  });

  it('LLM-inflated case: 84% proc ratio → capped at 85', () => {
    const score = computeBlendedSemanticDensity(500, 420, 10_000, 1_000);
    expect(score).toBeLessThanOrEqual(85);
  });

  it('very well documented: 95% proc ratio → capped at 85', () => {
    const score = computeBlendedSemanticDensity(500, 475, 10_000, 2_500);
    expect(score).toBeLessThanOrEqual(85);
  });

  it('50 procedures with >80% documented is capped at 85', () => {
    const score = computeBlendedSemanticDensity(50, 45, 5_000, 1_000);
    expect(score).toBe(85);
  });

  it('small sample: 30 procs, 29 documented → existing caps fire', () => {
    const score = computeBlendedSemanticDensity(30, 29, 2_000, 400);
    // 30 procs > 20 so blend fires, but <100 and >95% ratio → capped at 80
    expect(score).toBeLessThanOrEqual(80);
  });
});

describe('computeWeightedSemanticDensity', () => {
  it('large mixed sample lands in a reasonable middle band', () => {
    const documentedPython = Array.from({ length: 8 }, (_, index): FileAnalysis => ({
      path: `src/pipeline_${index}.py`,
      language: 'python',
      totalLines: 140,
      commentLines: 28,
      blankLines: 20,
      importCount: 3,
      typeAnnotationCount: 4,
      declarationCount: 8,
      hasStrictMode: false,
      totalProcedures: 6,
      documentedProcedures: 6,
    }));
    const lightlyDocumentedTs = Array.from({ length: 4 }, (_, index): FileAnalysis => ({
      path: `src/worker_${index}.ts`,
      language: 'typescript',
      totalLines: 160,
      commentLines: 8,
      blankLines: 20,
      importCount: 4,
      typeAnnotationCount: 6,
      declarationCount: 10,
      hasStrictMode: false,
      totalProcedures: 10,
      documentedProcedures: 2,
    }));

    const score = computeWeightedSemanticDensity([...documentedPython, ...lightlyDocumentedTs]);
    expect(score).toBeGreaterThanOrEqual(50);
    expect(score).toBeLessThanOrEqual(75);
  });

  it('weights larger files more heavily than smaller ones', () => {
    const largeUndocumented: FileAnalysis = {
      path: 'src/large.ts',
      language: 'typescript',
      totalLines: 800,
      commentLines: 8,
      blankLines: 80,
      importCount: 5,
      typeAnnotationCount: 10,
      declarationCount: 30,
      hasStrictMode: false,
      totalProcedures: 30,
      documentedProcedures: 0,
    };
    const smallDocumented: FileAnalysis = {
      path: 'src/small.ts',
      language: 'typescript',
      totalLines: 80,
      commentLines: 20,
      blankLines: 10,
      importCount: 2,
      typeAnnotationCount: 4,
      declarationCount: 6,
      hasStrictMode: false,
      totalProcedures: 6,
      documentedProcedures: 6,
    };
    const largeDocumented: FileAnalysis = {
      ...largeUndocumented,
      path: 'src/large-doc.ts',
      commentLines: 160,
      documentedProcedures: 24,
    };
    const smallUndocumented: FileAnalysis = {
      ...smallDocumented,
      path: 'src/small-bare.ts',
      commentLines: 0,
      documentedProcedures: 0,
    };

    const largeWins = computeWeightedSemanticDensity([largeDocumented, smallUndocumented]);
    const smallWins = computeWeightedSemanticDensity([largeUndocumented, smallDocumented]);

    expect(largeWins).toBeGreaterThan(smallWins);
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

  it('pure C# repo scores ≥ 75', () => {
    const csharpFiles: FileAnalysis[] = [
      {
        path: 'src/Program.cs', language: 'csharp',
        totalLines: 500, commentLines: 50, blankLines: 50,
        importCount: 10, typeAnnotationCount: 100, declarationCount: 120,
        hasStrictMode: false, totalProcedures: 30, documentedProcedures: 15,
      },
      {
        path: 'src/Services/UserService.cs', language: 'csharp',
        totalLines: 300, commentLines: 30, blankLines: 30,
        importCount: 8, typeAnnotationCount: 60, declarationCount: 70,
        hasStrictMode: false, totalProcedures: 20, documentedProcedures: 10,
      },
    ];
    const metrics = calculateCodebaseMetrics(csharpFiles, []);
    expect(metrics.typeStrictnessIndex).toBeGreaterThanOrEqual(75);
  });

  it('C# with Nullable=enable scores ≥ 85', () => {
    const csharpFile: FileAnalysis = {
      path: 'src/Program.cs', language: 'csharp',
      totalLines: 500, commentLines: 50, blankLines: 50,
      importCount: 10, typeAnnotationCount: 100, declarationCount: 120,
      hasStrictMode: false, totalProcedures: 30, documentedProcedures: 15,
    };
    const buildProps: FileAnalysis = {
      path: 'Directory.Build.props', language: 'xml',
      totalLines: 10, commentLines: 0, blankLines: 0,
      importCount: 0, typeAnnotationCount: 0, declarationCount: 0,
      hasStrictMode: true, totalProcedures: 0, documentedProcedures: 0,
    };
    const metrics = calculateCodebaseMetrics([csharpFile, buildProps], []);
    expect(metrics.typeStrictnessIndex).toBeGreaterThanOrEqual(85);
  });

  it('TypeScript with strict: true scores ≥ 70', () => {
    const tsFile: FileAnalysis = {
      path: 'src/app.ts', language: 'typescript',
      totalLines: 200, commentLines: 20, blankLines: 20,
      importCount: 5, typeAnnotationCount: 30, declarationCount: 40,
      hasStrictMode: false, totalProcedures: 15, documentedProcedures: 10,
    };
    const tsconfig: FileAnalysis = {
      path: 'tsconfig.json', language: 'json',
      totalLines: 10, commentLines: 0, blankLines: 0,
      importCount: 0, typeAnnotationCount: 0, declarationCount: 0,
      hasStrictMode: true, totalProcedures: 0, documentedProcedures: 0,
    };
    const metrics = calculateCodebaseMetrics([tsFile, tsconfig], []);
    expect(metrics.typeStrictnessIndex).toBeGreaterThanOrEqual(70);
  });

  it('Python with 72% type hints scores ~58-65', () => {
    const pythonFile: FileAnalysis = {
      path: 'src/pipeline.py', language: 'python',
      totalLines: 1000, commentLines: 100, blankLines: 100,
      importCount: 20, typeAnnotationCount: 72, declarationCount: 100,
      hasStrictMode: false, totalProcedures: 40, documentedProcedures: 20,
    };
    const metrics = calculateCodebaseMetrics([pythonFile], []);
    expect(metrics.typeStrictnessIndex).toBeGreaterThanOrEqual(58);
    expect(metrics.typeStrictnessIndex).toBeLessThanOrEqual(65);
  });

  it('mixed C#/Python repo weights by code volume, favoring C#', () => {
    const csharpFile: FileAnalysis = {
      path: 'src/Api/Controller.cs', language: 'csharp',
      totalLines: 800, commentLines: 80, blankLines: 80,
      importCount: 15, typeAnnotationCount: 150, declarationCount: 180,
      hasStrictMode: false, totalProcedures: 40, documentedProcedures: 20,
    };
    const pythonFile: FileAnalysis = {
      path: 'scripts/etl.py', language: 'python',
      totalLines: 200, commentLines: 20, blankLines: 20,
      importCount: 8, typeAnnotationCount: 20, declarationCount: 50,
      hasStrictMode: false, totalProcedures: 10, documentedProcedures: 5,
    };
    const csharpOnly = calculateCodebaseMetrics([csharpFile], []);
    const pythonOnly = calculateCodebaseMetrics([pythonFile], []);
    const mixed = calculateCodebaseMetrics([csharpFile, pythonFile], []);

    // Mixed score should be between the two, closer to C# (more lines)
    expect(mixed.typeStrictnessIndex).toBeGreaterThan(pythonOnly.typeStrictnessIndex);
    expect(mixed.typeStrictnessIndex).toBeLessThan(csharpOnly.typeStrictnessIndex);
    // C# has 800 lines vs Python 200 lines, so mixed should be closer to C#
    const midpoint = (csharpOnly.typeStrictnessIndex + pythonOnly.typeStrictnessIndex) / 2;
    expect(mixed.typeStrictnessIndex).toBeGreaterThan(midpoint);
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
