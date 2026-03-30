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
    (lang === 'javascript' && /['"]use strict['"]/.test(content));

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

function computeSemanticDensity(files: FileAnalysis[]): number {
  if (files.length === 0) { return 0; }

  let totalProcedures = 0;
  let documentedProcedures = 0;

  for (const f of files) {
    totalProcedures += f.totalProcedures;
    documentedProcedures += f.documentedProcedures;
  }

  if (totalProcedures === 0) { return 0; }
  // Ratio of procedures with docstrings/comments: 100% = every function/class is documented
  const ratio = documentedProcedures / totalProcedures;
  return clamp(Math.round(ratio * 100), 0, 100);
}

function computeTypeStrictness(files: FileAnalysis[]): number {
  if (files.length === 0) { return 0; }

  // Language-aware type scoring:
  // - Statically typed languages (C#, Java, Go, Rust, TypeScript) get inherent type safety credit
  // - Python with type hints gets partial credit
  // - Config/data languages (JSON, YAML, KQL, Markdown, etc.) are excluded
  const LANG_BASE_SCORES: Record<string, number> = {
    csharp: 85, java: 85, go: 80, rust: 90, typescript: 75,
    kotlin: 80, scala: 80, swift: 80,
    python: 45, // supports optional typing; productive for AI agents even without hints
    javascript: 10, ruby: 10, php: 15,
  };
  const CONFIG_LANGUAGES = new Set([
    'json', 'yaml', 'yml', 'xml', 'toml', 'ini', 'kql', 'kusto',
    'markdown', 'md', 'txt', 'csv', 'sql', 'bicep', 'hcl', 'terraform',
    'dockerfile', 'makefile', 'shell', 'bash', 'powershell', 'bat',
  ]);

  // Separate code files from config files
  const codeFiles = files.filter(f => {
    const lang = f.language.toLowerCase();
    // Exclude config/data languages
    if (CONFIG_LANGUAGES.has(lang)) return false;
    // Exclude unknown-language files with zero code signals
    if (!LANG_BASE_SCORES[lang] && f.declarationCount === 0 && f.typeAnnotationCount === 0) return false;
    return true;
  });
  if (codeFiles.length === 0) {
    // All config/data files — type strictness is not applicable, return neutral
    return 50;
  }

  // Languages where typing is mandatory — ratio is less meaningful
  const MANDATORY_TYPED = new Set(['csharp', 'java', 'go', 'rust', 'kotlin', 'scala', 'swift']);

  let totalScore = 0;
  let totalWeight = 0;

  for (const f of codeFiles) {
    const lang = f.language.toLowerCase();
    const baseScore = LANG_BASE_SCORES[lang] ?? 20;
    const weight = Math.max(1, Math.log2(f.totalLines + 1));

    if (MANDATORY_TYPED.has(lang)) {
      // Statically typed: base score is the floor, annotations only add a small bonus
      const ratio = f.declarationCount > 0 ? Math.min(1, f.typeAnnotationCount / f.declarationCount) : 0.5;
      const fileScore = baseScore + ratio * (100 - baseScore) * 0.5; // e.g. C#: 85 + ratio * 7.5
      totalScore += fileScore * weight;
    } else if (f.declarationCount > 0 && f.typeAnnotationCount > 0) {
      // Optional typing (Python, JS): base is floor, annotations add bonus
      const ratio = Math.min(1, f.typeAnnotationCount / f.declarationCount);
      const fileScore = baseScore + ratio * (100 - baseScore); // e.g. Python(45) + 15%*55 = 53
      totalScore += fileScore * weight;
    } else {
      totalScore += baseScore * weight;
    }
    totalWeight += weight;

    if (f.hasStrictMode) {
      totalScore += 10 * weight;
    }
  }

  return totalWeight > 0 ? clamp(totalScore / totalWeight, 0, 100) : 0;
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
