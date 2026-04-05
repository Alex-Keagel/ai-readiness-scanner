import { describe, it, expect } from 'vitest';
import { DependencyScanner } from '../../graph/dependencyScanner';
import { GraphBuilder } from '../../graph/graphBuilder';
import { GraphEdge } from '../../graph/types';

describe('DependencyScanner', () => {
  describe('sanitizePath', () => {
    it('preserves paths with hyphens', () => {
      expect(DependencyScanner.sanitizePath('risk-register/.github/skills'))
        .toBe('risk-register/.github/skills');
    });

    it('normalizes double slashes', () => {
      expect(DependencyScanner.sanitizePath('risk/register//github/skills'))
        .toBe('risk/register/github/skills');
    });

    it('normalizes triple+ slashes', () => {
      expect(DependencyScanner.sanitizePath('a///b////c'))
        .toBe('a/b/c');
    });

    it('trims leading/trailing slashes', () => {
      expect(DependencyScanner.sanitizePath('/some/path/'))
        .toBe('some/path');
    });

    it('preserves dots in paths', () => {
      expect(DependencyScanner.sanitizePath('.github/agents'))
        .toBe('.github/agents');
    });

    it('handles already-clean paths', () => {
      expect(DependencyScanner.sanitizePath('src/components/auth'))
        .toBe('src/components/auth');
    });
  });
});

describe('GraphBuilder addDependencyEdges', () => {
  it('stores original path as label on DEPENDS_ON edges', () => {
    const builder = new GraphBuilder();
    const edges: GraphEdge[] = [];
    const deps = new Map<string, string[]>();
    deps.set('risk-register/.github/skills', ['ai-readiness-scanner/docs']);

    (builder as any).addDependencyEdges(edges, deps);

    expect(edges).toHaveLength(1);
    expect(edges[0].relation).toBe('DEPENDS_ON');
    expect(edges[0].label).toBe('ai-readiness-scanner/docs');
  });

  it('preserves hyphens and dots in dependency labels', () => {
    const builder = new GraphBuilder();
    const edges: GraphEdge[] = [];
    const deps = new Map<string, string[]>();
    deps.set('my-app/src', ['my-lib/.github/agents']);

    (builder as any).addDependencyEdges(edges, deps);

    expect(edges[0].label).toBe('my-lib/.github/agents');
    expect(edges[0].label).not.toMatch(/\/\//);
  });

  it('does not produce malformed paths from hyphenated directories', () => {
    const builder = new GraphBuilder();
    const edges: GraphEdge[] = [];
    const deps = new Map<string, string[]>();
    deps.set('risk-register', ['ai-readiness-scanner-vs-code-extension/docs']);

    (builder as any).addDependencyEdges(edges, deps);

    expect(edges).toHaveLength(1);
    expect(edges[0].label).toBe('ai-readiness-scanner-vs-code-extension/docs');
    expect(edges[0].label).not.toBe('ai/readiness/scanner/vs/code/extension/docs');
  });

  it('uses consistent nodeId for source and target', () => {
    const builder = new GraphBuilder();
    const edges: GraphEdge[] = [];
    const deps = new Map<string, string[]>();
    deps.set('risk-register/.github/skills', ['risk-register/.github/agents']);

    (builder as any).addDependencyEdges(edges, deps);

    expect(edges[0].source).toBe('comp-risk_register__github_skills');
    expect(edges[0].target).toBe('comp-risk_register__github_agents');
  });

  it('handles multiple dependencies from one component', () => {
    const builder = new GraphBuilder();
    const edges: GraphEdge[] = [];
    const deps = new Map<string, string[]>();
    deps.set('app-core', ['lib-utils', 'lib-auth/.github/config']);

    (builder as any).addDependencyEdges(edges, deps);

    expect(edges).toHaveLength(2);
    expect(edges[0].label).toBe('lib-utils');
    expect(edges[1].label).toBe('lib-auth/.github/config');
  });
});
