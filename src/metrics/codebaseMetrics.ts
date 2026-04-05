/**
 * RAG Food metrics — evaluate how easily AI agents can ingest/understand the code.
 */

export interface FileAnalysis {
  path: string;
  language: string;
  totalLines: number;
  commentLines: number;
  blankLines: number;
  importCount: number;
  typeAnnotationCount: number;
  declarationCount: number;
  hasStrictMode: boolean;
  totalProcedures: number;       // functions + classes + methods
  documentedProcedures: number;  // procedures with a docstring/comment above
}

export interface CodebaseReadinessMetrics {
  semanticDensity: number;
  typeStrictnessIndex: number;
  contextFragmentation: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const COMMENT_PATTERNS: Record<string, { line: RegExp; blockStart: RegExp; blockEnd: RegExp }> = {
  typescript: { line: /^\s*\/\//, blockStart: /\/\*/, blockEnd: /\*\// },
  javascript: { line: /^\s*\/\//, blockStart: /\/\*/, blockEnd: /\*\// },
  python: { line: /^\s*#/, blockStart: /^\s*"""/, blockEnd: /"""/ },
  java: { line: /^\s*\/\//, blockStart: /\/\*/, blockEnd: /\*\// },
  csharp: { line: /^\s*\/\//, blockStart: /\/\*/, blockEnd: /\*\// },
  go: { line: /^\s*\/\//, blockStart: /\/\*/, blockEnd: /\*\// },
  rust: { line: /^\s*\/\//, blockStart: /\/\*/, blockEnd: /\*\// },
  ruby: { line: /^\s*#/, blockStart: /^=begin/, blockEnd: /^=end/ },
};

const IMPORT_PATTERNS: Record<string, RegExp> = {
  typescript: /^\s*import\s/,
  javascript: /^\s*(import\s|const\s+\w+\s*=\s*require\()/,
  python: /^\s*(import\s|from\s+\S+\s+import\s)/,
  java: /^\s*import\s/,
  csharp: /^\s*using\s/,
  go: /^\s*import\s/,
  rust: /^\s*(use\s|extern\s+crate\s)/,
  ruby: /^\s*require\s/,
};

const TYPE_ANNOTATION_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /:\s*(string|number|boolean|any|void|never|unknown|null|undefined)\b/,
    /:\s*[A-Z]\w+/,
    /<[A-Z]\w+/,
    /\binterface\s+/,
    /\btype\s+\w+\s*=/,
  ],
  javascript: [],
  python: [
    /:\s*(str|int|float|bool|None|List|Dict|Tuple|Set|Optional)\b/,
    /->\s*(str|int|float|bool|None|List|Dict|Tuple|Set|Optional)\b/,
    /->\s*[A-Z]\w+/,
    /:\s*[A-Z]\w+/,
  ],
  java: [
    /\b(int|long|double|float|boolean|char|byte|short|void|String)\s+\w+/,
    /\b[A-Z]\w*\s+\w+\s*[=;({\[]/, // Class typed declarations
    /<[A-Z]\w+/,
  ],
  csharp: [
    /\b(int|long|double|float|bool|char|byte|string|void|decimal|var|dynamic|object)\s+\w+/,
    /\b[A-Z]\w*\s+\w+\s*[=;({\[]/, // Class/interface typed declarations: ILogger logger, HttpClient client
    /<[A-Z]\w+/,                     // Generics: Task<string>, List<int>
    /\basync\s+Task/,                // async Task methods
  ],
  go: [
    /\b(int|int8|int16|int32|int64|uint|float32|float64|string|bool|byte|rune|error)\b/,
  ],
  rust: [
    /:\s*(i8|i16|i32|i64|u8|u16|u32|u64|f32|f64|bool|char|String|&str)\b/,
    /->\s*/,
  ],
  ruby: [],
};

const DECLARATION_PATTERNS: Record<string, RegExp[]> = {
  typescript: [/\b(const|let|var|function|class|enum)\s+\w+/, /\binterface\s+/, /\btype\s+\w+\s*=/],
  javascript: [/\b(const|let|var|function|class)\s+\w+/],
  python: [/^\s*def\s+/, /^\s*class\s+/, /^\s*\w+\s*=/],
  java: [/\b(class|interface|enum)\s+\w+/, /\b(public|private|protected)\s+\S+\s+\w+/],
  csharp: [/\b(class|interface|enum|struct)\s+\w+/, /\b(public|private|protected|internal)\s+\S+\s+\w+/],
  go: [/\b(func|type|var|const)\s+\w+/],
  rust: [/\b(fn|struct|enum|trait|impl|type|const|let|static)\s+/],
  ruby: [/^\s*(def|class|module)\s+/, /^\s*\w+\s*=/],
};

const DESCRIPTIVE_IDENTIFIER = /[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*){2,}/g;

// Patterns that identify a function, class, or method declaration
const PROCEDURE_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^\s*(export\s+)?(async\s+)?function\s+\w+/,
    /^\s*(export\s+)?class\s+\w+/,
    /^\s*(public|private|protected|static|async)\s+\w+\s*\(/,
    /^\s*(?!if|else|for|while|switch|catch|return|throw|new|await|yield|typeof|delete|void)\w+\s*\([^)]*\)\s*[:{]/,
  ],
  javascript: [
    /^\s*(export\s+)?(async\s+)?function\s+\w+/,
    /^\s*(export\s+)?class\s+\w+/,
    /^\s*(?!if|else|for|while|switch|catch|return|throw|new|await|yield)\w+\s*\([^)]*\)\s*\{/,
  ],
  python: [/^\s*def\s+\w+/, /^\s*class\s+\w+/],
  java: [/^\s*(public|private|protected)\s+.*\w+\s*\(/, /^\s*(public|private|protected)?\s*(class|interface|enum)\s+\w+/],
  csharp: [/^\s*(public|private|protected|internal)\s+.*\w+\s*\(/, /^\s*(public|private|protected|internal)?\s*(class|interface|struct|enum)\s+\w+/],
  go: [/^\s*func\s+/, /^\s*type\s+\w+\s+struct/],
  rust: [/^\s*(pub\s+)?fn\s+/, /^\s*(pub\s+)?(struct|enum|trait|impl)\s+/],
  ruby: [/^\s*def\s+/, /^\s*class\s+/, /^\s*module\s+/],
};

// ─── File Analysis ────────────────────────────────────────────────────

export function analyzeFileContent(path: string, content: string, language: string): FileAnalysis {
  const lang = language.toLowerCase();
  const lines = content.split('\n');

  const commentPatterns = COMMENT_PATTERNS[lang] ?? COMMENT_PATTERNS.typescript;
  const importPattern = IMPORT_PATTERNS[lang] ?? IMPORT_PATTERNS.typescript;

  let commentLines = 0;
  let blankLines = 0;
  let importCount = 0;
  let typeAnnotationCount = 0;
  let declarationCount = 0;
  let totalProcedures = 0;
  let documentedProcedures = 0;
  let inBlock = false;
  let lastNonBlankWasComment = false; // tracks if the line(s) before a procedure were comments

  const procedurePatterns = PROCEDURE_PATTERNS[lang] ?? PROCEDURE_PATTERNS.typescript;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      blankLines++;
      // blank lines don't reset the comment flag (docstrings often have a blank between)
      continue;
    }

    if (inBlock) {
      commentLines++;
      if (commentPatterns.blockEnd.test(line)) { inBlock = false; lastNonBlankWasComment = true; }
      continue;
    }

    if (commentPatterns.blockStart.test(line) && !commentPatterns.blockEnd.test(line.replace(commentPatterns.blockStart, ''))) {
      commentLines++;
      inBlock = true;
      continue;
    }

    // Single-line block comment (e.g. /** ... */ or """ ... """)
    if (commentPatterns.blockStart.test(line) && commentPatterns.blockEnd.test(line.replace(commentPatterns.blockStart, ''))) {
      commentLines++;
      lastNonBlankWasComment = true;
      continue;
    }

    if (commentPatterns.line.test(line)) {
      commentLines++;
      lastNonBlankWasComment = true;
      continue;
    }

    // Check if this line is a procedure declaration
    const isProcedure = procedurePatterns.some(p => p.test(line));
    if (isProcedure) {
      totalProcedures++;
      let isDocumented = false;

      // Method 1: comment/docstring immediately before
      if (lastNonBlankWasComment) {
        isDocumented = true;
      }

      // Method 2: Python docstring after def/class
      if (!isDocumented && lang === 'python') {
        for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
          const nextLine = lines[j].trim();
          if (nextLine === '') continue;
          if (nextLine.startsWith('"""') || nextLine.startsWith("'''") || nextLine.startsWith('"') || nextLine.startsWith("'")) {
            isDocumented = true;
          }
          break;
        }
      }

      // Method 3: descriptive name (3+ word segments in camelCase/snake_case)
      if (!isDocumented) {
        const nameMatch = line.match(/(?:function|def|class|async)\s+(\w+)|(\w+)\s*[\(:]/);
        const name = nameMatch?.[1] || nameMatch?.[2] || '';
        const segments = name.replace(/([A-Z])/g, '_$1').split(/[_]+/).filter(s => s.length > 0);
        if (segments.length >= 3) {
          isDocumented = true;
        }
      }

      // Method 4: section header within 5 lines above (e.g., // ─── Helpers ───)
      if (!isDocumented) {
        for (let j = Math.max(0, i - 5); j < i; j++) {
          if (/^\s*\/\/\s*[─═━▬\-]{3,}/.test(lines[j]) || /^\s*#\s*[─═━▬\-]{3,}/.test(lines[j])) {
            isDocumented = true;
            break;
          }
        }
      }

      // Method 5: inline comments in body (≥2 comment lines in next 20 lines)
      if (!isDocumented) {
        let bodyComments = 0;
        for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
          const bodyLine = lines[j].trim();
          if (bodyLine === '') continue;
          if (bodyLine.startsWith('}') || bodyLine.startsWith('def ') || bodyLine.startsWith('class ')) break;
          if (commentPatterns.line.test(lines[j]) || commentPatterns.blockStart.test(lines[j])) {
            bodyComments++;
          }
        }
        if (bodyComments >= 2) {
          isDocumented = true;
        }
      }

      if (isDocumented) documentedProcedures++;
    }

    lastNonBlankWasComment = false;

    if (importPattern.test(line)) { importCount++; }

    const typePatterns = TYPE_ANNOTATION_PATTERNS[lang] ?? [];
    for (const tp of typePatterns) {
      if (tp.test(line)) { typeAnnotationCount++; break; }
    }

    const declPatterns = DECLARATION_PATTERNS[lang] ?? DECLARATION_PATTERNS.typescript;
    for (const dp of declPatterns) {
      if (dp.test(line)) { declarationCount++; break; }
    }
  }

  const hasStrictMode =
    (lang === 'typescript' && /\"strict\"\s*:\s*true/.test(content)) ||
    (lang === 'python' && /# mypy: strict/.test(content)) ||
    (lang === 'javascript' && /['"]use strict['"]/.test(content)) ||
    // Build-level enforcement signals (path-based, language-agnostic)
    (/tsconfig[^/]*\.json$/i.test(path) && /\"strict\"\s*:\s*true/.test(content)) ||
    (/directory\.build\.props$/i.test(path) && /<Nullable>\s*enable\s*<\/Nullable>/i.test(content)) ||
    (/\.csproj$/i.test(path) && /<Nullable>\s*enable\s*<\/Nullable>/i.test(content)) ||
    (/pyproject\.toml$/i.test(path) && /\[tool\.mypy\]/.test(content)) ||
    (/setup\.cfg$/i.test(path) && /\[mypy\]/.test(content));

  return {
    path,
    language: lang,
    totalLines: lines.length,
    commentLines,
    blankLines,
    importCount,
    typeAnnotationCount,
    declarationCount,
    hasStrictMode,
    totalProcedures,
    documentedProcedures,
  };
}

// ─── Metric Calculations ─────────────────────────────────────────────

/**
 * Blend procedure-documentation ratio with comment-to-code ratio for a robust
 * semantic density score.  Exported so the scanner can reuse the same logic
 * with LLM-corrected procedure counts.
 */
export function computeBlendedSemanticDensity(
  totalProcedures: number,
  documentedProcedures: number,
  totalCodeLines: number,
  totalCommentLines: number,
  totalFilesAnalyzed?: number,
): number {
  // Comment-to-code ratio score (0-100).
  // 25% comment-to-code ratio maps to the maximum score.
  const commentRatio = totalCodeLines > 0 ? totalCommentLines / totalCodeLines : 0;
  const commentScore = clamp(Math.round((commentRatio / 0.25) * 100), 0, 100);

  // Procedure documentation ratio score (0-100)
  const procRatio = totalProcedures > 0 ? documentedProcedures / totalProcedures : 0;
  const procScore = clamp(Math.round(procRatio * 100), 0, 100);

  let score: number;
  if (totalProcedures < 20) {
    // Too few procedures for a reliable ratio — fall back to comment density
    score = commentScore;
  } else {
    // Blend: 60% procedure ratio, 40% comment-line ratio
    score = Math.round(procScore * 0.6 + commentScore * 0.4);
  }

  // Cap: very low comment ratio (< 5%) signals poor documentation regardless
  if (commentRatio < 0.05) {
    score = Math.min(score, 40);
  }

  // Cap: if very few procedures detected relative to code lines, the sample is unrepresentative.
  // For a 10K+ line codebase with <50 procedures, the ratio is unreliable.
  if (totalCodeLines > 5000 && totalProcedures < 50) {
    score = Math.min(score, Math.max(commentScore, 50));
  }

  // Cap: extreme procedure ratio (>95% documented) in small samples is likely noise
  if (totalProcedures > 0 && totalProcedures < 100 && procRatio > 0.95) {
    score = Math.min(score, 80);
  }

  // Cap: LLM-corrected inputs with >80% proc ratio in large samples need deep
  // validation before scoring above 85 — very few real codebases achieve this.
  if (totalProcedures >= 50 && procRatio > 0.80) {
    score = Math.min(score, 85);
  }

  return clamp(score, 0, 100);
}

export function computeWeightedSemanticDensity(
  files: FileAnalysis[],
  correctionFactors?: {
    totalProceduresFactor?: number;
    documentedProceduresFactor?: number;
  },
): number {
  if (files.length === 0) { return 0; }

  const totalFactor = correctionFactors?.totalProceduresFactor ?? 1;
  const docFactor = correctionFactors?.documentedProceduresFactor ?? 1;
  let totalScore = 0;
  let totalWeight = 0;

  for (const f of files) {
    const codeLines = Math.max(0, f.totalLines - f.blankLines);
    const weight = Math.max(1, codeLines);
    const adjustedTotalProcedures = f.totalProcedures * totalFactor;
    const adjustedDocumentedProcedures = Math.min(
      adjustedTotalProcedures,
      f.documentedProcedures * docFactor,
    );

    const fileScore = computeBlendedSemanticDensity(
      adjustedTotalProcedures,
      adjustedDocumentedProcedures,
      codeLines,
      f.commentLines,
      1,
    );

    totalScore += fileScore * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;
}

function computeSemanticDensity(files: FileAnalysis[]): number {
  return computeWeightedSemanticDensity(files);
}

function computeTypeStrictness(files: FileAnalysis[]): number {
  if (files.length === 0) { return 0; }

  // Language base scores: inherent type safety of each language
  const LANG_BASE_SCORES: Record<string, number> = {
    csharp: 75, java: 75, kotlin: 75, go: 75, rust: 75, swift: 75, scala: 75,
    typescript: 50,
    python: 15,
    javascript: 10, ruby: 10, php: 15,
  };
  const CONFIG_LANGUAGES = new Set([
    'json', 'yaml', 'yml', 'xml', 'toml', 'ini', 'kql', 'kusto',
    'markdown', 'md', 'txt', 'csv', 'sql', 'bicep', 'hcl', 'terraform',
    'dockerfile', 'makefile', 'shell', 'bash', 'powershell', 'bat',
  ]);

  // ── Build-level enforcement signals (scan ALL files before filtering) ──
  let tsconfigStrict = false;
  let nullableEnabled = false;
  let mypyConfigured = false;

  for (const f of files) {
    if (!f.hasStrictMode) { continue; }
    const p = f.path.toLowerCase();
    if (f.language === 'typescript' || /tsconfig[^/]*\.json$/.test(p)) {
      tsconfigStrict = true;
    }
    if (p.endsWith('directory.build.props') || p.endsWith('.csproj')) {
      nullableEnabled = true;
    }
    if (p.endsWith('pyproject.toml') || p.endsWith('setup.cfg')) {
      mypyConfigured = true;
    }
  }

  // ── Filter to code files ──
  const codeFiles = files.filter(f => {
    const lang = f.language.toLowerCase();
    if (CONFIG_LANGUAGES.has(lang)) { return false; }
    if (!LANG_BASE_SCORES[lang] && f.declarationCount === 0 && f.typeAnnotationCount === 0) { return false; }
    return true;
  });
  if (codeFiles.length === 0) {
    return 50; // All config/data files — type strictness not applicable
  }

  const MANDATORY_TYPED = new Set(['csharp', 'java', 'go', 'rust', 'kotlin', 'scala', 'swift']);
  const OPTIONAL_TYPED_CEILING = 80;

  let totalScore = 0;
  let totalWeight = 0;

  for (const f of codeFiles) {
    const lang = f.language.toLowerCase();
    let baseScore = LANG_BASE_SCORES[lang] ?? 20;
    const weight = Math.max(1, Math.log2(f.totalLines + 1));

    // TypeScript strict: boost base from 50 → 70
    if (lang === 'typescript' && tsconfigStrict) {
      baseScore = 70;
    }

    let fileScore: number;

    if (MANDATORY_TYPED.has(lang)) {
      // Statically typed: base score is the floor, annotations add a small bonus
      const ratio = f.declarationCount > 0 ? Math.min(1, f.typeAnnotationCount / f.declarationCount) : 0.5;
      fileScore = baseScore + ratio * (100 - baseScore) * 0.5;
    } else if (f.declarationCount > 0 && f.typeAnnotationCount > 0) {
      // Optional typing: scale from base to ceiling based on annotation coverage
      const ratio = Math.min(1, f.typeAnnotationCount / f.declarationCount);
      fileScore = baseScore + ratio * (OPTIONAL_TYPED_CEILING - baseScore);
    } else {
      fileScore = baseScore;
    }

    // Build-level enforcement bonuses (+10, capped at 100)
    if (lang === 'csharp' && nullableEnabled) { fileScore += 10; }
    if (lang === 'python' && mypyConfigured) { fileScore += 10; }

    totalScore += fileScore * weight;
    totalWeight += weight;
  }

  const score = totalWeight > 0 ? totalScore / totalWeight : 0;
  return clamp(score, 0, 100);
}

function computeContextFragmentation(
  files: FileAnalysis[],
  _dependencyGraph: { source: string; targets: string[] }[],
): number {
  if (files.length === 0) { return 100; }

  const totalImports = files.reduce((sum, f) => sum + f.importCount, 0);
  const avgImports = totalImports / files.length;

  // Log scale: 0 imports = 100, 5 imports ≈ 60, 20+ imports = 0
  const score = 100 * (1 - Math.min(1, Math.log(avgImports + 1) / Math.log(20)));
  return clamp(score, 0, 100);
}

// ─── Public API ───────────────────────────────────────────────────────

export function calculateCodebaseMetrics(
  files: FileAnalysis[],
  dependencyGraph: { source: string; targets: string[] }[],
): CodebaseReadinessMetrics {
  return {
    semanticDensity: Math.round(computeSemanticDensity(files) * 100) / 100,
    typeStrictnessIndex: Math.round(computeTypeStrictness(files) * 100) / 100,
    contextFragmentation: Math.round(computeContextFragmentation(files, dependencyGraph) * 100) / 100,
  };
}
