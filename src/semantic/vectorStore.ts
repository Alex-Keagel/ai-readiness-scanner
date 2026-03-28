/**
 * Lightweight TF-IDF vector search engine for code semantic search.
 * Pure TypeScript — zero native dependencies.
 */

export interface VectorDocument {
  id: string;
  content: string;
  metadata: {
    path: string;
    language: string;
    type: 'function' | 'class' | 'module' | 'file' | 'chunk';
    startLine?: number;
    endLine?: number;
    summary?: string;
  };
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: VectorDocument['metadata'];
  snippet: string;
}

const STOP_WORDS = new Set([
  'const', 'let', 'var', 'function', 'class', 'import', 'export',
  'return', 'if', 'else', 'for', 'while', 'new', 'this',
  'true', 'false', 'null', 'undefined', 'void', 'async', 'await',
  'try', 'catch', 'throw', 'from', 'the', 'and', 'or', 'not',
  'is', 'in', 'of', 'to', 'a', 'an',
]);

const MAX_VOCABULARY = 50_000;
const MAX_DOCUMENTS = 5_000;

/** Split camelCase and snake_case, lowercase, remove single-char tokens and stop words */
export function tokenize(text: string): string[] {
  // Split camelCase boundaries: insert space before uppercase letters that follow lowercase
  const expanded = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  // Split on non-alphanumeric (covers snake_case, punctuation, whitespace)
  const raw = expanded.toLowerCase().split(/[^a-z0-9]+/);

  return raw.filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

export class VectorStore {
  private documents: Map<string, VectorDocument> = new Map();
  private tfidfVectors: Map<string, Map<string, number>> = new Map();
  private idfCache: Map<string, number> = new Map();
  private vocabulary: Set<string> = new Set();

  // Per-doc term frequencies (raw counts) — kept to avoid re-tokenizing on IDF refresh
  private termFreqs: Map<string, Map<string, number>> = new Map();
  private docTokenCounts: Map<string, number> = new Map();
  // Per-term: set of doc IDs containing that term
  private termDocSets: Map<string, Set<string>> = new Map();

  private dirty = false;

  upsert(doc: VectorDocument): void {
    if (this.documents.size >= MAX_DOCUMENTS && !this.documents.has(doc.id)) {
      return; // cap reached
    }

    // If updating, remove old term references first
    if (this.documents.has(doc.id)) {
      this.removeTermRefs(doc.id);
    }

    this.documents.set(doc.id, doc);

    const tokens = tokenize(doc.content);
    const counts = new Map<string, number>();
    for (const t of tokens) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }

    this.termFreqs.set(doc.id, counts);
    this.docTokenCounts.set(doc.id, tokens.length);

    for (const term of counts.keys()) {
      this.vocabulary.add(term);
      let docSet = this.termDocSets.get(term);
      if (!docSet) {
        docSet = new Set();
        this.termDocSets.set(term, docSet);
      }
      docSet.add(doc.id);
    }

    this.pruneVocabulary();
    this.dirty = true;
  }

  remove(id: string): void {
    if (!this.documents.has(id)) return;
    this.removeTermRefs(id);
    this.documents.delete(id);
    this.termFreqs.delete(id);
    this.docTokenCounts.delete(id);
    this.tfidfVectors.delete(id);
    this.dirty = true;
  }

  search(query: string, topK = 10): SearchResult[] {
    this.rebuildIfNeeded();

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    // Build query TF-IDF vector (sparse)
    const queryCounts = new Map<string, number>();
    for (const t of queryTokens) {
      queryCounts.set(t, (queryCounts.get(t) ?? 0) + 1);
    }

    const queryVec = new Map<string, number>();
    for (const [term, count] of queryCounts) {
      const idf = this.idfCache.get(term);
      if (idf === undefined) continue; // term not in corpus
      const tf = 1 + Math.log(count);
      queryVec.set(term, tf * idf);
    }

    if (queryVec.size === 0) return [];

    const queryMag = magnitude(queryVec);
    if (queryMag === 0) return [];

    // Score each document using sparse cosine similarity
    const scores: { id: string; score: number }[] = [];

    for (const [docId, docVec] of this.tfidfVectors) {
      let dot = 0;
      // iterate over the smaller vector for efficiency
      for (const [term, qVal] of queryVec) {
        const dVal = docVec.get(term);
        if (dVal !== undefined) {
          dot += qVal * dVal;
        }
      }
      if (dot === 0) continue;

      const docMag = magnitude(docVec);
      if (docMag === 0) continue;

      const score = dot / (queryMag * docMag);
      scores.push({ id: docId, score });
    }

    scores.sort((a, b) => b.score - a.score);

    return scores.slice(0, topK).map(({ id, score }) => {
      const doc = this.documents.get(id)!;
      return {
        id,
        score,
        metadata: doc.metadata,
        snippet: doc.content.slice(0, 200),
      };
    });
  }

  getDocumentIds(): string[] {
    return [...this.documents.keys()];
  }

  getStats(): { documentCount: number; vocabularySize: number; avgDocLength: number } {
    let totalTokens = 0;
    for (const count of this.docTokenCounts.values()) {
      totalTokens += count;
    }
    return {
      documentCount: this.documents.size,
      vocabularySize: this.vocabulary.size,
      avgDocLength: this.documents.size > 0 ? totalTokens / this.documents.size : 0,
    };
  }

  clear(): void {
    this.documents.clear();
    this.tfidfVectors.clear();
    this.idfCache.clear();
    this.vocabulary.clear();
    this.termFreqs.clear();
    this.docTokenCounts.clear();
    this.termDocSets.clear();
    this.dirty = false;
  }

  serialize(): string {
    const docs: Record<string, VectorDocument> = {};
    for (const [k, v] of this.documents) {
      docs[k] = v;
    }
    return JSON.stringify({ documents: docs });
  }

  static deserialize(data: string): VectorStore {
    const parsed = JSON.parse(data) as { documents: Record<string, VectorDocument> };
    const store = new VectorStore();
    for (const doc of Object.values(parsed.documents)) {
      store.upsert(doc);
    }
    return store;
  }

  // --- private helpers ---

  private removeTermRefs(id: string): void {
    const counts = this.termFreqs.get(id);
    if (!counts) return;
    for (const term of counts.keys()) {
      const docSet = this.termDocSets.get(term);
      if (docSet) {
        docSet.delete(id);
        if (docSet.size === 0) {
          this.termDocSets.delete(term);
          this.vocabulary.delete(term);
        }
      }
    }
  }

  private pruneVocabulary(): void {
    if (this.vocabulary.size <= MAX_VOCABULARY) return;
    // Remove rarest terms
    const termCounts = [...this.termDocSets.entries()]
      .map(([term, set]) => ({ term, count: set.size }))
      .sort((a, b) => a.count - b.count);

    const toRemove = termCounts.slice(0, this.vocabulary.size - MAX_VOCABULARY);
    for (const { term } of toRemove) {
      this.vocabulary.delete(term);
      this.termDocSets.delete(term);
      // Remove from per-doc term freqs
      for (const counts of this.termFreqs.values()) {
        counts.delete(term);
      }
    }
  }

  private rebuildIfNeeded(): void {
    if (!this.dirty) return;
    this.dirty = false;

    const totalDocs = this.documents.size;
    if (totalDocs === 0) {
      this.idfCache.clear();
      this.tfidfVectors.clear();
      return;
    }

    // Recompute IDF for every term in vocabulary
    this.idfCache.clear();
    for (const [term, docSet] of this.termDocSets) {
      this.idfCache.set(term, Math.log(totalDocs / docSet.size));
    }

    // Recompute TF-IDF vectors
    this.tfidfVectors.clear();
    for (const [docId, counts] of this.termFreqs) {
      const vec = new Map<string, number>();
      for (const [term, count] of counts) {
        const idf = this.idfCache.get(term);
        if (idf === undefined || idf === 0) continue;
        const tf = 1 + Math.log(count);
        vec.set(term, tf * idf);
      }
      this.tfidfVectors.set(docId, vec);
    }
  }
}

function magnitude(vec: Map<string, number>): number {
  let sum = 0;
  for (const v of vec.values()) {
    sum += v * v;
  }
  return Math.sqrt(sum);
}
