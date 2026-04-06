import * as vscode from 'vscode';
import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';
import { SemanticCache } from './cache';
import { SearchResult,VectorStore } from './vectorStore';

export interface CodeChunk {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  type: 'function' | 'class' | 'module' | 'interface' | 'config' | 'unknown';
  name: string;
  signature?: string;
  parentName?: string;
}

// Regex patterns for extracting semantic boundaries per language
const CHUNK_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
    /^(?:export\s+)?class\s+(\w+)/gm,
    /^(?:export\s+)?interface\s+(\w+)/gm,
    /^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/gm,
  ],
  python: [
    /^(?:async\s+)?def\s+(\w+)\s*\(/gm,
    /^class\s+(\w+)/gm,
  ],
  csharp: [
    /(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?(?:\w+\s+)+(\w+)\s*\(/gm,
    /(?:public|private|protected|internal)\s+(?:static\s+)?(?:abstract\s+)?class\s+(\w+)/gm,
    /(?:public|private|protected|internal)\s+interface\s+(\w+)/gm,
  ],
  go: [
    /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/gm,
    /^type\s+(\w+)\s+struct/gm,
    /^type\s+(\w+)\s+interface/gm,
  ],
  rust: [
    /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm,
    /^(?:pub\s+)?struct\s+(\w+)/gm,
    /^(?:pub\s+)?trait\s+(\w+)/gm,
    /^(?:pub\s+)?impl(?:<[^>]*>)?\s+(\w+)/gm,
  ],
  java: [
    /(?:public|private|protected)\s+(?:static\s+)?(?:\w+\s+)+(\w+)\s*\(/gm,
    /(?:public|private|protected)\s+(?:abstract\s+)?class\s+(\w+)/gm,
    /(?:public|private|protected)\s+interface\s+(\w+)/gm,
  ],
};

// Map file extensions to language keys
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'typescript', jsx: 'typescript',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'java',
  cs: 'csharp', cpp: 'csharp', c: 'csharp', h: 'csharp',
};

const EXCLUDE_GLOB = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/vendor/**,**/__pycache__/**,**/.venv/**,**/target/**,**/coverage/**}';

interface FileData {
  uri: vscode.Uri;
  path: string;
  content: string;
  lang: string;
  ext: string;
  chunks: CodeChunk[];
  dependencies: string[];
  exports: string[];
  lines: number;
}

export class WorkspaceIndexer {
  private vectorStore: VectorStore;

  constructor(
    private cache: SemanticCache,
    private copilotClient?: CopilotClient
  ) {
    // Attempt to restore persisted vector store
    const saved = cache.getVectorStoreData();
    if (saved) {
      try {
        this.vectorStore = VectorStore.deserialize(saved);
      } catch (err) {
        logger.warn('Failed to deserialize vector store, creating new', { error: err instanceof Error ? err.message : String(err) });
        this.vectorStore = new VectorStore();
      }
    } else {
      this.vectorStore = new VectorStore();
    }
  }

  /**
   * Index the entire workspace — only processes files not already cached.
   * Returns count of newly indexed files.
   */
  async indexWorkspace(
    workspaceUri: vscode.Uri,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    token?: vscode.CancellationToken
  ): Promise<{ indexed: number; cached: number; total: number }> {
    const sourceExts = Object.keys(EXT_TO_LANG);
    const glob = `**/*.{${sourceExts.join(',')}}`;

    // No hard cap — discover ALL source files
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceUri, glob), EXCLUDE_GLOB, 10000
    );
    logger.info(`Workspace has ${files.length} source files`);

    let indexed = 0;
    let cached = 0;

    // ── Tier 1: Fast structural scan (ALL files, no LLM) ──
    // Read every file, extract chunks + imports/exports, store in cache.
    // This is fast (~50ms/file) and gives us the structural graph.
    const allFileData: FileData[] = [];

    for (let i = 0; i < files.length; i++) {
      if (token?.isCancellationRequested) break;
      const uri = files[i];
      const relPath = vscode.workspace.asRelativePath(uri);

      if (progress && i % 50 === 0) {
        progress.report({ message: `📂 Scanning structure ${i + 1}/${files.length}...`, increment: (50 / files.length) * 30 });
      }

      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString('utf-8');

        // Skip binary/huge files
        if (content.length > 500_000 || content.includes('\0')) continue;

        if (!this.cache.needsReindex(relPath, content)) {
          const existing = this.cache.get(relPath, content);
          // Only skip if LLM-enriched (summary contains keywords in brackets)
          if (existing?.summary?.includes('[')) {
            cached++;
            continue;
          }
        }

        const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
        const lang = EXT_TO_LANG[ext];
        const chunks = this.extractChunks(relPath, content, lang);
        const dependencies = this.extractImports(content, lang);
        const exports = this.extractExports(content, lang);
        const lines = content.split('\n').length;

        allFileData.push({ uri, path: relPath, content, lang: lang || ext, ext, chunks, dependencies, exports, lines });
      } catch (err) {
        logger.warn(`Skipping unreadable file: ${relPath}`, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    logger.info(`Structural scan: ${allFileData.length} files to index, ${cached} cached`);

    // ── Collect git stats (one command, graceful if not a git repo) ──
    const gitTimer = logger.time('Git stats collection');
    const gitStats = await this.collectGitStats(workspaceUri);
    gitTimer?.end?.();
    logger.info(`Git stats: ${gitStats.size} files with history`);

    // ── Build fan-in map (how many files import each file) ──
    const rawFanIn = new Map<string, number>();
    for (const f of allFileData) {
      for (const dep of f.dependencies) {
        // Normalize import path to match file paths
        const normalized = dep.replace(/^[.\/]+/, '').replace(/\.(ts|js|py|go|rs|cs|java)$/, '');
        // Find matching files
        for (const target of allFileData) {
          const targetNorm = target.path.replace(/\.(ts|tsx|js|jsx|py|go|rs|cs|java)$/, '');
          if (targetNorm.endsWith(normalized) || targetNorm === normalized) {
            rawFanIn.set(target.path, (rawFanIn.get(target.path) || 0) + 1);
          }
        }
      }
    }

    // ── Weighted fan-in: importers with high fan-in themselves count more ──
    const fanInMap = new Map<string, number>();
    for (const f of allFileData) {
      for (const dep of f.dependencies) {
        const normalized = dep.replace(/^[.\/]+/, '').replace(/\.(ts|js|py|go|rs|cs|java)$/, '');
        for (const target of allFileData) {
          const targetNorm = target.path.replace(/\.(ts|tsx|js|jsx|py|go|rs|cs|java)$/, '');
          if (targetNorm.endsWith(normalized) || targetNorm === normalized) {
            const importerFanIn = rawFanIn.get(f.path) || 0;
            const weight = 1 + 0.1 * Math.log(importerFanIn + 1);
            fanInMap.set(target.path, (fanInMap.get(target.path) || 0) + weight);
          }
        }
      }
    }

    // ── Tier 2: Rank files by importance (with fan-in + git stats + semantic density) ──
    const ranked = allFileData.map(f => ({
      ...f,
      importance: this.calculateImportance(f, fanInMap.get(f.path) || 0, gitStats.get(f.path)),
    })).sort((a, b) => b.importance - a.importance);

    // Read enrichment percentage from settings (default 70%)
    const enrichPct = vscode.workspace.getConfiguration('ai-readiness').get<number>('enrichmentDepth') ?? 70;
    const LLM_ENRICHMENT_LIMIT = Math.min(
      ranked.length,
      Math.max(1, Math.round(ranked.length * enrichPct / 100))
    );
    const llmFiles = ranked.slice(0, LLM_ENRICHMENT_LIMIT);
    const heuristicFiles = ranked.slice(LLM_ENRICHMENT_LIMIT);

    logger.info(`Importance ranking: ${llmFiles.length} files for LLM enrichment (fast model: ${this.copilotClient?.getFastModelName() || 'heuristic'}), ${heuristicFiles.length} for heuristic`);
    if (llmFiles.length > 0) {
      logger.debug(`Top 10 by importance: ${llmFiles.slice(0, 10).map(f => `${f.path}(${(f as any).importance})`).join(', ')}`);
    }

    // ── Tier 3: LLM enrichment for important files (parallel batches) ──
    const BATCH_SIZE = vscode.workspace.getConfiguration('ai-readiness').get<number>('enrichmentBatchSize') ?? 10;
    const CONCURRENCY = vscode.workspace.getConfiguration('ai-readiness').get<number>('enrichmentConcurrency') ?? 5;
    const batches: FileData[][] = [];
    for (let i = 0; i < llmFiles.length; i += BATCH_SIZE) {
      batches.push(llmFiles.slice(i, i + BATCH_SIZE));
    }

    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      if (token?.isCancellationRequested) break;
      const concurrentBatches = batches.slice(i, i + CONCURRENCY);
      const batchStart = i * BATCH_SIZE + 1;
      const batchEnd = Math.min((i + CONCURRENCY) * BATCH_SIZE, llmFiles.length);
      progress?.report({ message: `🧠 Enriching files ${batchStart}-${batchEnd} of ${llmFiles.length} (${CONCURRENCY} parallel)...`, increment: (CONCURRENCY * BATCH_SIZE / ranked.length) * 40 });

      const results = await Promise.all(
        concurrentBatches.map(batch => this.batchGenerateSummaries(batch, token))
      );

      for (let b = 0; b < concurrentBatches.length; b++) {
        const batch = concurrentBatches[b];
        const summaries = results[b];
        for (let j = 0; j < batch.length; j++) {
          this.indexFile(batch[j], summaries[j] || this.heuristicSummary(batch[j].path, batch[j].content, batch[j].chunks));
          indexed++;
        }
      }
    }

    // ── Tier 4: Heuristic index for remaining files (fast, no LLM) ──
    for (const file of heuristicFiles) {
      if (token?.isCancellationRequested) break;
      this.indexFile(file, this.heuristicSummary(file.path, file.content, file.chunks));
      indexed++;
    }

    progress?.report({ message: `✅ Indexed ${indexed} files (${llmFiles.length} LLM-enriched)`, increment: 10 });

    // Persist vector store
    this.cache.setVectorStoreData(this.vectorStore.serialize());
    logger.info(`Indexing complete: ${indexed} indexed, ${cached} cached, ${files.length} total`);

    return { indexed, cached, total: files.length };
  }

  /** Score file importance: higher = more important = gets LLM enrichment */
  private calculateImportance(
    f: FileData,
    fanIn: number = 0,
    gitStats?: { commits: number; authors: number }
  ): number {
    let score = 0;
    const pathLower = f.path.toLowerCase();
    const nameLower = (f.path.split('/').pop() || '').toLowerCase();

    // ── Structural (35% weight) — fan-in is the #1 predictor ──
    // Logarithmic scale: 1 importer = 10pts, 5 = 25pts, 20 = 40pts, 50+ = 55pts
    if (fanIn > 0) {
      score += Math.round(10 * Math.log2(fanIn + 1));
    }
    // Fan-out (files this imports) — orchestrators are important
    score += Math.min(15, f.dependencies.length * 2);

    // ── Role (25% weight) — what kind of file is it? ──
    // AI config files (critical for readiness)
    if (pathLower.includes('.github/') || pathLower.includes('.clinerules') || pathLower.includes('claude')) score += 40;
    if (pathLower.includes('memory-bank/')) score += 35;
    // Entry points
    if (/^(index|main|app|server|extension|program|startup)\./i.test(nameLower)) score += 30;
    // Type definitions (define the codebase vocabulary)
    if (/^(types|models|schema|interfaces|contracts)\./i.test(nameLower) || nameLower.endsWith('.d.ts')) score += 25;
    // Docs
    if (/^(readme|contributing|architecture|changelog)/i.test(nameLower)) score += 20;
    // Config
    if (/\.(md|yaml|yml|json)$/i.test(nameLower) && pathLower.includes('config')) score += 15;

    // ── Git velocity — frequently changed files are important ──
    if (gitStats) {
      score += Math.min(20, Math.round(5 * Math.log2(gitStats.commits + 1)));
      // Multi-author files = shared responsibility = important
      if (gitStats.authors >= 3) score += 10;
      else if (gitStats.authors >= 2) score += 5;
    }

    // ── Semantic density — high-value code patterns ──
    // Security patterns (auth, crypto, validation)
    const securityPatterns = /\b(auth|jwt|oauth|session|token|password|secret|crypto|bcrypt|encrypt|decrypt|hash|validate|sanitize|csrf)\b/gi;
    const securityHits = (f.content.match(securityPatterns) || []).length;
    if (securityHits > 3) score += 20;
    else if (securityHits > 0) score += 10;

    // Integration patterns (external APIs, databases, message queues)
    const integrationPatterns = /\b(fetch|axios|HttpClient|prisma|sequelize|mongoose|knex|kafka|rabbitmq|redis|sql|query|connection|endpoint)\b/gi;
    const integrationHits = (f.content.match(integrationPatterns) || []).length;
    if (integrationHits > 3) score += 15;
    else if (integrationHits > 0) score += 8;

    // Error handling density (complex logic worth understanding)
    const errorPatterns = /\b(try|catch|throw|Error|Exception|reject|fail)\b/g;
    const errorDensity = (f.content.match(errorPatterns) || []).length / Math.max(1, f.lines);
    if (errorDensity > 0.05) score += 10;

    // ── Complexity (15% weight) — surface area of the file ──
    score += Math.min(15, f.exports.length * 3);
    const classCount = f.chunks.filter(c => c.type === 'class' || c.type === 'interface').length;
    score += Math.min(10, classCount * 3);
    if (f.lines > 200) score += 5;
    if (f.lines > 500) score += 5;

    // ── Position (10% weight) — root files more important ──
    const depth = f.path.split('/').length;
    score += Math.max(0, 8 - depth * 2);

    // ── Penalties ──
    if (pathLower.includes('test') || pathLower.includes('spec') || pathLower.includes('__test')) score -= 20;
    if (pathLower.includes('mock') || pathLower.includes('fixture') || pathLower.includes('stub')) score -= 15;
    if (nameLower.endsWith('.min.js') || nameLower.endsWith('.bundle.js')) score -= 30;

    return score;
  }

  /** Collect git change frequency and contributor count for all files (single command) */
  private async collectGitStats(workspaceUri: vscode.Uri): Promise<Map<string, { commits: number; authors: number }>> {
    interface GitFileStats { commits: number; authors: number; authorSet: Set<string> }
    const stats = new Map<string, GitFileStats>();
    try {
      const fs = await import('fs');
      const cwd = workspaceUri.fsPath;
      // Verify cwd is a directory
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        logger.debug(`Git stats skipped — workspace path is not a directory: ${cwd}`);
        return stats;
      }

      const cp = await import('child_process');
      const { promisify } = await import('util');
      const execFile = promisify(cp.execFile);

      const { stdout } = await execFile('git', [
        'log', '--format=\x1e%aN', '--name-only', '--diff-filter=ACMR',
        '--no-merges', '--since=12.months', '--'
      ], { cwd: workspaceUri.fsPath, maxBuffer: 64 * 1024 * 1024 });

      const records = stdout.split('\x1e').filter(Boolean);
      for (const rec of records) {
        const lines = rec.trim().split('\n');
        const author = lines[0];
        for (const file of lines.slice(1)) {
          const f = file.trim();
          if (!f) continue;
          let existing = stats.get(f);
          if (!existing) {
            existing = { commits: 0, authors: 0, authorSet: new Set() };
            stats.set(f, existing);
          }
          existing.commits++;
          existing.authorSet.add(author);
          existing.authors = existing.authorSet.size;
        }
      }
    } catch {
      // Git not available or not a git repo — graceful degradation
    }
    // Return without the authorSet internals
    const result = new Map<string, { commits: number; authors: number }>();
    for (const [path, s] of stats) {
      result.set(path, { commits: s.commits, authors: s.authors });
    }
    return result;
  }

  /** Store a file in cache + vector store */
  private indexFile(file: FileData, summary: string): void {
    try {
      this.cache.set(file.path, file.content, {
        language: file.lang,
        summary,
        purpose: file.chunks.length > 0
          ? `${file.chunks.length} ${file.chunks[0]?.type}(s): ${file.chunks.slice(0, 5).map(c => c.name).join(', ')}`
          : 'Module',
        dependencies: file.dependencies,
        exports: file.exports,
        complexity: file.lines > 500 ? 'high' : file.lines > 100 ? 'medium' : 'low',
      });

      if (file.chunks.length > 0) {
        for (const chunk of file.chunks) {
          this.vectorStore.upsert({
            id: `${file.path}#${chunk.name}@${chunk.startLine}`,
            content: `${chunk.content}\n${summary}`,
            metadata: {
              path: chunk.path,
              language: file.lang,
              type: chunk.type === 'interface' || chunk.type === 'config' || chunk.type === 'unknown'
                ? 'chunk' : chunk.type as 'function' | 'class' | 'module',
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              summary: `${chunk.type} ${chunk.name}`,
            },
          });
        }
      } else {
        this.vectorStore.upsert({
          id: file.path,
          content: `${file.content.slice(0, 5000)}\n${summary}`,
          metadata: { path: file.path, language: file.lang, type: 'file', summary },
        });
      }
    } catch (err) {
      logger.warn(`Failed to index ${file.path}`, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Extract semantic chunks from a file */
  extractChunks(path: string, content: string, lang?: string): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const lines = content.split('\n');
    const patterns = lang ? CHUNK_PATTERNS[lang] : undefined;

    if (!patterns) {
      // For unknown languages, treat entire file as one chunk
      return [{
        path, startLine: 0, endLine: lines.length - 1,
        content: content.slice(0, 500), type: 'module',
        name: path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'unknown',
      }];
    }

    for (const pattern of patterns) {
      // Reset regex
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(content)) !== null) {
        const startIdx = match.index;
        const startLine = content.slice(0, startIdx).split('\n').length - 1;
        const name = match[1] ?? 'anonymous';

        // Find the end of this block (next function/class or end of file)
        const nextPattern = new RegExp(pattern.source, pattern.flags);
        nextPattern.lastIndex = regex.lastIndex;
        const nextMatch = nextPattern.exec(content);
        const endIdx = nextMatch ? nextMatch.index - 1 : content.length;
        const endLine = content.slice(0, endIdx).split('\n').length - 1;

        const chunkContent = content.slice(startIdx, Math.min(endIdx, startIdx + 2000));
        const signature = match[0];

        chunks.push({
          path, startLine, endLine,
          content: chunkContent,
          type: signature.includes('class') ? 'class' :
                signature.includes('interface') ? 'interface' :
                signature.includes('struct') || signature.includes('type') ? 'class' :
                'function',
          name, signature, parentName: undefined,
        });
      }
    }

    return chunks;
  }


  /** Generate summaries for a batch of files in a single LLM call */
  private async batchGenerateSummaries(
    files: { path: string; content: string; lang: string; chunks: CodeChunk[] }[],
    token?: vscode.CancellationToken
  ): Promise<string[]> {
    if (!this.copilotClient?.isAvailable()) {
      return files.map(f => this.heuristicSummary(f.path, f.content, f.chunks));
    }

    try {
      const fileBlocks = files.map((f, i) =>
        `[FILE ${i}] ${f.path}\n\`\`\`\n${f.content.slice(0, 2000)}\n\`\`\``
      ).join('\n\n');

      const prompt = `Analyze these ${files.length} source files. For EACH file, provide:
SUMMARY: <1 sentence>
KEYWORDS: <5-10 semantic tags>

${fileBlocks}

Respond as JSON array: [{"summary":"...","keywords":"k1, k2, k3"}, ...]`;

      const response = await this.copilotClient.analyzeFast(prompt, token);

      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.map((item: any) => {
          const s = item.summary || '';
          const k = item.keywords || '';
          return k ? `${s} [${k}]` : s;
        });
      }
    } catch (err) {
      logger.warn('Batch LLM summary failed, using heuristic', { error: err instanceof Error ? err.message : String(err) });
    }

    return files.map(f => this.heuristicSummary(f.path, f.content, f.chunks));
  }

  /** Fast heuristic summary when LLM is unavailable */
  private heuristicSummary(path: string, content: string, chunks: CodeChunk[]): string {
    const lines = content.split('\n');
    const firstComment = lines.slice(0, 10).find(l =>
      l.trim().startsWith('//') || l.trim().startsWith('#') || l.trim().startsWith('"""') || l.trim().startsWith('/*')
    );
    if (firstComment) return firstComment.replace(/^[\s/*#"]+/, '').replace(/[\s/*"]+$/, '').slice(0, 200);
    if (chunks.length > 0) return `${chunks.length} ${chunks[0].type}(s): ${chunks.slice(0, 3).map(c => c.name).join(', ')}`;
    return `${path.split('/').pop()} (${lines.length} lines)`;
  }

  /** Extract import/dependency paths from source code */
  private extractImports(content: string, lang?: string): string[] {
    const imports: string[] = [];
    const patterns: RegExp[] = [];

    switch (lang) {
      case 'typescript':
        patterns.push(/(?:import|from)\s+['"]([^'"]+)['"]/g);
        patterns.push(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
        break;
      case 'python':
        patterns.push(/^(?:from|import)\s+([\w.]+)/gm);
        break;
      case 'go':
        patterns.push(/"([^"]+)"/g); // inside import block
        break;
      case 'csharp':
        patterns.push(/using\s+([\w.]+)\s*;/g);
        break;
      case 'rust':
        patterns.push(/use\s+([\w:]+)/g);
        break;
      case 'java':
        patterns.push(/import\s+([\w.]+)\s*;/g);
        break;
    }

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        imports.push(match[1]);
      }
    }

    return [...new Set(imports)];
  }

  /** Extract exported symbols */
  private extractExports(content: string, lang?: string): string[] {
    const exports: string[] = [];

    if (lang === 'typescript') {
      const re = /export\s+(?:default\s+)?(?:function|class|const|let|interface|type|enum)\s+(\w+)/g;
      let match;
      while ((match = re.exec(content)) !== null) exports.push(match[1]);
    } else if (lang === 'python') {
      const re = /^(?:def|class)\s+(\w+)/gm;
      let match;
      while ((match = re.exec(content)) !== null) {
        if (!match[1].startsWith('_')) exports.push(match[1]);
      }
    }

    return exports;
  }

  /** Get index stats */
  getStats(): { total: number; languages: Record<string, number>; lastUpdate: string | null } {
    return this.cache.getStats();
  }

  /** Expose the underlying semantic cache for enrichment */
  getSemanticCache(): SemanticCache {
    return this.cache;
  }

  /** Semantic search via TF-IDF cosine similarity */
  semanticSearch(query: string, topK = 10): SearchResult[] {
    return this.vectorStore.search(query, topK);
  }

  /** Expose the vector store (e.g. for MCP) */
  getVectorStore(): VectorStore {
    return this.vectorStore;
  }

  /** Remove all vector-store entries whose ID starts with the given path prefix */
  removeFileFromVectorStore(path: string): void {
    for (const id of this.vectorStore.getDocumentIds()) {
      if (id === path || id.startsWith(path + '#')) {
        this.vectorStore.remove(id);
      }
    }
  }

  // ─── Unified Module Analysis (shared with codebaseProfiler) ────

  /**
   * Analyze a single module file — produces a ModuleProfile-compatible result.
   * This is the single source of truth for module metadata.
   */
  analyzeModule(path: string, content: string): {
    path: string; language: string; lines: number;
    exports: string[]; exportCount: number; importCount: number;
    fanIn: number; hasTests: boolean; hasDocstring: boolean;
    complexity: 'low' | 'medium' | 'high';
    role: 'entry-point' | 'core-logic' | 'utility' | 'ui' | 'config' | 'test' | 'type-def' | 'generated' | 'unknown';
  } {
    const lines = content.split('\n');
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const fileName = path.split('/').pop() || '';
    const langMap: Record<string, string> = {
      ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
      py: 'Python', cs: 'C#', java: 'Java', go: 'Go', rs: 'Rust', rb: 'Ruby', kt: 'Kotlin',
    };

    // Exports
    const exportNames = this.extractExports(content, this.detectLang(ext));
    const importCount = (content.match(/^import\s+/gm) || []).length +
      (content.match(/^from\s+/gm) || []).length +
      (content.match(/require\s*\(/g) || []).length;

    // Role detection (comprehensive — covers all languages)
    let role: 'entry-point' | 'core-logic' | 'utility' | 'ui' | 'config' | 'test' | 'type-def' | 'generated' | 'unknown' = 'unknown';
    if (path.includes('.test.') || path.includes('.spec.') || path.includes('__tests__')) role = 'test';
    else if (path.includes('/tests/') || path.includes('/test/') || fileName.startsWith('test_') || fileName === 'conftest.py') role = 'test';
    else if (fileName.endsWith('Tests.cs') || fileName.endsWith('Test.cs') || path.includes('.Tests/') || path.includes('Integration.Tests/')) role = 'test';
    else if (/\b(backup|generated|exported|auto[-_]gen|stubs?)\b/i.test(path) || (path.includes('KustoFunctions') && /\.kql$/i.test(path))) role = 'generated';
    else if (path.includes('types') && !path.includes('test')) role = 'type-def';
    else if (/extension\.(ts|js)$/.test(path) || /main\.(ts|js|py|go)$/.test(path) || /index\.(ts|js)$/.test(path) || /app\.(ts|js|py)$/.test(path)) role = 'entry-point';
    else if (path.includes('/ui/') || path.includes('/views/') || path.includes('/components/')) role = 'ui';
    else if (path.includes('/utils') || path.includes('/helpers') || path.includes('/lib/')) role = 'utility';
    else if (path.includes('/config') || path.endsWith('.config.ts') || path.endsWith('.config.js')) role = 'config';
    else if (exportNames.length > 0 && lines.length > 30) role = 'core-logic';

    const hasDocstring = /\/\*\*[\s\S]*?\*\//.test(content) || /^"""/m.test(content) || /^'''/m.test(content);
    const complexity: 'low' | 'medium' | 'high' = lines.length > 500 ? 'high' : lines.length > 150 ? 'medium' : 'low';
    const hasTests = role === 'test' || content.includes('describe(') || content.includes('it(') || content.includes('test(') || content.includes('def test_');

    return {
      path,
      language: langMap[ext] || ext,
      lines: lines.length,
      exports: exportNames,
      exportCount: exportNames.length,
      importCount,
      fanIn: 0,
      hasTests,
      hasDocstring,
      complexity,
      role,
    };
  }

  /**
   * Separate project imports from package imports.
   * Project imports (relative) are used for fan-in; packages are metadata.
   */
  separateImports(content: string, filePath: string): { project: string[]; packages: string[] } {
    const project: string[] = [];
    const packages: string[] = [];
    const patterns = [
      /import\s+.*?from\s+['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /^from\s+([\w.]+)\s+import/gm,
    ];
    for (const pat of patterns) {
      pat.lastIndex = 0;
      let m;
      while ((m = pat.exec(content)) !== null) {
        const imp = m[1];
        if (imp.startsWith('.')) {
          const dir = filePath.split('/').slice(0, -1).join('/');
          const resolved = imp.replace(/^\.\//, dir + '/').replace(/^\.\.\//, dir + '/../');
          project.push(resolved);
        } else {
          const pkgName = imp.startsWith('@') ? imp.split('/').slice(0, 2).join('/') : imp.split('/')[0];
          packages.push(pkgName);
        }
      }
    }
    return { project, packages: [...new Set(packages)] };
  }

  private detectLang(ext: string): string | undefined {
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'typescript', jsx: 'typescript',
      py: 'python', go: 'go', rs: 'rust', cs: 'csharp', java: 'java',
    };
    return map[ext];
  }

  // ─── Dead Code Detection ────────────────────────────────────────

  /**
   * Detect exported symbols that are never imported by any other module.
   * Returns modules/exports that appear dead (exported but unused).
   */
  detectDeadExports(
    modules: { path: string; exports: string[]; lines: number; role: string }[],
    importGraph: Map<string, string[]>
  ): { path: string; exportName: string; lines: number; role: string }[] {
    // Build set of all imported symbols across all modules
    const allImportedPaths = new Set<string>();
    for (const [, targets] of importGraph) {
      for (const t of targets) {
        allImportedPaths.add(t);
      }
    }

    // Also build a set of import path fragments (for relative imports like '../utils')
    const importedFragments = new Set<string>();
    for (const p of allImportedPaths) {
      // Extract the module name from the import path
      const parts = p.split('/');
      importedFragments.add(parts[parts.length - 1]);
      if (parts.length >= 2) {
        importedFragments.add(parts.slice(-2).join('/'));
      }
    }

    const deadExports: { path: string; exportName: string; lines: number; role: string }[] = [];

    for (const mod of modules) {
      if (mod.role === 'test' || mod.role === 'generated' || mod.role === 'config') continue;
      if (mod.exports.length === 0) continue;

      // Check if this module is imported by anyone
      const modName = mod.path.replace(/\.\w+$/, ''); // strip extension
      const modParts = modName.split('/');
      const isImported = allImportedPaths.has(mod.path) ||
        allImportedPaths.has(modName) ||
        importedFragments.has(modParts[modParts.length - 1]) ||
        (modParts.length >= 2 && importedFragments.has(modParts.slice(-2).join('/')));

      if (!isImported && mod.lines > 50) {
        // Module exports things but nobody imports it
        for (const exp of mod.exports.slice(0, 5)) {
          deadExports.push({
            path: mod.path,
            exportName: exp,
            lines: mod.lines,
            role: mod.role,
          });
        }
      }
    }

    return deadExports.sort((a, b) => b.lines - a.lines);
  }
}
