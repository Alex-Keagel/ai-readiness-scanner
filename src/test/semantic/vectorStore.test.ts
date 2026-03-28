import { describe, it, expect, beforeEach } from 'vitest';
import { VectorStore, VectorDocument, tokenize } from '../../semantic/vectorStore';

describe('tokenize', () => {
  it('splits camelCase', () => {
    expect(tokenize('getUserById')).toEqual(['get', 'user', 'by', 'id']);
  });

  it('splits snake_case', () => {
    expect(tokenize('get_user_by_id')).toEqual(['get', 'user', 'by', 'id']);
  });

  it('removes single-char tokens', () => {
    expect(tokenize('a b cd')).toEqual(['cd']);
  });

  it('removes stop words', () => {
    const tokens = tokenize('const myFunction = async function');
    expect(tokens).not.toContain('const');
    expect(tokens).not.toContain('async');
    expect(tokens).not.toContain('function');
    expect(tokens).toContain('my');
  });

  it('handles mixed input', () => {
    const tokens = tokenize('parseJSON_data fromAPI');
    expect(tokens).toContain('parse');
    expect(tokens).toContain('json');
    expect(tokens).toContain('data');
    expect(tokens).toContain('api');
  });
});

describe('VectorStore', () => {
  let store: VectorStore;

  const doc1: VectorDocument = {
    id: 'auth.ts#login',
    content: 'async function authenticateUser(email, password) { validate credentials check database return token }',
    metadata: { path: 'src/auth.ts', language: 'typescript', type: 'function', startLine: 1, endLine: 10 },
  };

  const doc2: VectorDocument = {
    id: 'db.ts#query',
    content: 'function queryDatabase(sql, params) { connect pool execute query return results rows }',
    metadata: { path: 'src/db.ts', language: 'typescript', type: 'function', startLine: 1, endLine: 8 },
  };

  const doc3: VectorDocument = {
    id: 'api.ts#handler',
    content: 'function handleRequest(request, response) { parse body validate input authenticate user send response }',
    metadata: { path: 'src/api.ts', language: 'typescript', type: 'function', startLine: 1, endLine: 15 },
  };

  beforeEach(() => {
    store = new VectorStore();
    store.upsert(doc1);
    store.upsert(doc2);
    store.upsert(doc3);
  });

  it('returns stats', () => {
    const stats = store.getStats();
    expect(stats.documentCount).toBe(3);
    expect(stats.vocabularySize).toBeGreaterThan(0);
    expect(stats.avgDocLength).toBeGreaterThan(0);
  });

  it('lists document IDs', () => {
    expect(store.getDocumentIds()).toEqual(['auth.ts#login', 'db.ts#query', 'api.ts#handler']);
  });

  it('searches by semantic relevance — authentication query', () => {
    const results = store.search('authenticate user credentials');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('auth.ts#login');
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].score).toBeLessThanOrEqual(1);
  });

  it('searches by semantic relevance — database query', () => {
    const results = store.search('database query execute sql');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('db.ts#query');
  });

  it('returns snippets in results', () => {
    const results = store.search('authenticate');
    expect(results[0].snippet.length).toBeGreaterThan(0);
    expect(results[0].snippet.length).toBeLessThanOrEqual(200);
  });

  it('returns metadata in results', () => {
    const results = store.search('authenticate');
    expect(results[0].metadata.path).toBe('src/auth.ts');
    expect(results[0].metadata.language).toBe('typescript');
    expect(results[0].metadata.type).toBe('function');
  });

  it('respects topK limit', () => {
    const results = store.search('function', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('returns empty for empty query', () => {
    expect(store.search('')).toEqual([]);
  });

  it('returns empty for stop-word-only query', () => {
    expect(store.search('const let var')).toEqual([]);
  });

  it('handles remove', () => {
    store.remove('auth.ts#login');
    expect(store.getStats().documentCount).toBe(2);
    const results = store.search('authenticate');
    expect(results.every(r => r.id !== 'auth.ts#login')).toBe(true);
  });

  it('handles upsert (update)', () => {
    store.upsert({ ...doc1, content: 'completely different content about logging and metrics' });
    expect(store.getStats().documentCount).toBe(3);
    const results = store.search('logging metrics');
    expect(results[0].id).toBe('auth.ts#login');
  });

  it('clears all documents', () => {
    store.clear();
    expect(store.getStats().documentCount).toBe(0);
    expect(store.search('anything')).toEqual([]);
  });

  describe('serialization', () => {
    it('round-trips through serialize/deserialize', () => {
      const serialized = store.serialize();
      const restored = VectorStore.deserialize(serialized);

      expect(restored.getStats().documentCount).toBe(3);

      const originalResults = store.search('authenticate user');
      const restoredResults = restored.search('authenticate user');

      expect(restoredResults.length).toBe(originalResults.length);
      expect(restoredResults[0].id).toBe(originalResults[0].id);
      expect(restoredResults[0].score).toBeCloseTo(originalResults[0].score, 5);
    });

    it('serialized data is valid JSON', () => {
      const serialized = store.serialize();
      expect(() => JSON.parse(serialized)).not.toThrow();
    });
  });
});
