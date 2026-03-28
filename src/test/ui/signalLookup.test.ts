import { describe, it, expect } from 'vitest';

/**
 * Tests for the signal lookup chain used by generate/preview handlers.
 * Ensures insight-based (insight_*) and component-based (comp_*) signal IDs
 * are correctly resolved — preventing the "Signal not found" bug.
 */

// Simulate the lookup logic from extension.ts generate/preview handlers
function resolveSignalId(
  signalId: string,
  report: {
    levels: { signals: { signalId: string; level: number; finding: string; detected: boolean; confidence: string }[] }[];
    insights?: { title: string; recommendation: string; severity: string; category: string; affectedComponent?: string }[];
    componentScores?: { name: string; path: string; overallScore: number; primaryLevel: number; children?: string[] }[];
  }
): { type: 'signal' | 'insight' | 'component' | 'not-found'; recommendation?: string; filePath?: string } {
  // 1. Try real signals
  const signal = report.levels
    .flatMap(ls => ls.signals)
    .find(s => s.signalId === signalId);
  if (signal) {
    return { type: 'signal' };
  }

  // 2. Try insights
  const insight = report.insights?.find(i => {
    const iId = `insight_${i.category}_${(i.title || '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}`;
    return iId === signalId;
  });
  if (insight) {
    return { type: 'insight', recommendation: insight.recommendation };
  }

  // 3. Try component-based
  const compMatch = signalId.match(/^comp_(readme|docs)_(.+)$/);
  const component = compMatch
    ? report.componentScores?.find(c => c.path.replace(/[^a-zA-Z0-9]/g, '_') === compMatch[2])
    : undefined;
  if (component && compMatch) {
    const rec = compMatch[1] === 'readme'
      ? `Create \`${component.path}/README.md\` describing what ${component.name} does.`
      : `Add documentation to \`${component.path}/\` explaining the architecture of ${component.name}.`;
    return { type: 'component', recommendation: rec, filePath: `${component.path}/${compMatch[1] === 'readme' ? 'README.md' : ''}` };
  }

  return { type: 'not-found' };
}

// Simulate buildRecommendations ID generation for insights
function insightToSignalId(category: string, title: string): string {
  return `insight_${category}_${title.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}`;
}

// Simulate buildRecommendations ID generation for components
function componentToSignalId(type: 'readme' | 'docs', path: string): string {
  return `comp_${type}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

const mockReport = {
  levels: [
    {
      signals: [
        { signalId: 'copilot_instructions', level: 2, finding: 'Found', detected: true, confidence: 'high' },
        { signalId: 'copilot_agents', level: 3, finding: 'Missing', detected: false, confidence: 'high' },
      ],
    },
  ],
  insights: [
    { title: 'Component "Zero Trust Segmentation Services" lagging behind', recommendation: 'Add README and Documentation to src/', severity: 'important', category: 'improvement', affectedComponent: 'src' },
    { title: 'Suggested: adf_pipeline_validation', recommendation: 'Create skill for ADF pipeline validation', severity: 'important', category: 'missing-skill', affectedComponent: 'infrastructure' },
    { title: 'Create a comprehensive copilot-instructions.md', recommendation: 'Create .github/copilot-instructions.md with project conventions', severity: 'suggestion', category: 'improvement' },
  ],
  componentScores: [
    { name: 'Zero Trust Services', path: 'src', overallScore: 33, primaryLevel: 1, children: ['src/api'] },
    { name: 'Release Pipeline', path: '.release', overallScore: 25, primaryLevel: 1 },
    { name: 'API Specs', path: 'apispec', overallScore: 33, primaryLevel: 1 },
  ],
};

describe('Signal lookup chain', () => {
  it('resolves real signal IDs from report.levels', () => {
    const result = resolveSignalId('copilot_instructions', mockReport);
    expect(result.type).toBe('signal');
  });

  it('resolves real missing signal IDs', () => {
    const result = resolveSignalId('copilot_agents', mockReport);
    expect(result.type).toBe('signal');
  });

  it('resolves insight-based IDs', () => {
    const id = insightToSignalId('improvement', 'Component "Zero Trust Segmentation Services" lagging behind');
    const result = resolveSignalId(id, mockReport);
    expect(result.type).toBe('insight');
    expect(result.recommendation).toContain('README');
  });

  it('resolves insight IDs with special chars in title', () => {
    const id = insightToSignalId('missing-skill', 'Suggested: adf_pipeline_validation');
    const result = resolveSignalId(id, mockReport);
    expect(result.type).toBe('insight');
    expect(result.recommendation).toContain('ADF');
  });

  it('resolves component readme IDs', () => {
    const id = componentToSignalId('readme', 'src');
    const result = resolveSignalId(id, mockReport);
    expect(result.type).toBe('component');
    expect(result.recommendation).toContain('README.md');
    expect(result.filePath).toBe('src/README.md');
  });

  it('resolves component docs IDs', () => {
    const id = componentToSignalId('docs', '.release');
    const result = resolveSignalId(id, mockReport);
    expect(result.type).toBe('component');
    expect(result.recommendation).toContain('architecture');
  });

  it('resolves component with dotted path', () => {
    const id = componentToSignalId('readme', '.release');
    const result = resolveSignalId(id, mockReport);
    expect(result.type).toBe('component');
    expect(result.recommendation).toContain('Release Pipeline');
  });

  it('returns not-found for unknown IDs', () => {
    const result = resolveSignalId('totally_unknown_signal', mockReport);
    expect(result.type).toBe('not-found');
  });

  it('returns not-found for malformed comp IDs', () => {
    const result = resolveSignalId('comp_readme_nonexistent_path', mockReport);
    expect(result.type).toBe('not-found');
  });

  it('returns not-found for malformed insight IDs', () => {
    const result = resolveSignalId('insight_unknown_category_unknown_title', mockReport);
    expect(result.type).toBe('not-found');
  });
});

describe('Insight ID generation roundtrip', () => {
  it('generates consistent IDs from title', () => {
    const title = 'Component "Zero Trust Segmentation Services" lagging behind';
    const id1 = insightToSignalId('improvement', title);
    const id2 = insightToSignalId('improvement', title);
    expect(id1).toBe(id2);
  });

  it('truncates long titles to 40 chars', () => {
    const longTitle = 'A'.repeat(100);
    const id = insightToSignalId('cat', longTitle);
    // insight_ (8) + cat_ (4) + 40 = 52 max
    expect(id.length).toBeLessThanOrEqual(52);
  });

  it('handles empty title', () => {
    const id = insightToSignalId('improvement', '');
    expect(id).toBe('insight_improvement_');
  });

  it('replaces special characters in title with underscores', () => {
    const id = insightToSignalId('missing-skill', 'Suggested: add-dotnet-service');
    expect(id).not.toContain(':');
    // Note: category retains hyphens (matches production code)
    expect(id).toContain('Suggested');
    expect(id).toContain('missing-skill');
  });
});

describe('Component ID generation roundtrip', () => {
  it('generates consistent IDs', () => {
    const id1 = componentToSignalId('readme', 'src/api');
    const id2 = componentToSignalId('readme', 'src/api');
    expect(id1).toBe(id2);
  });

  it('replaces path separators', () => {
    const id = componentToSignalId('readme', 'src/python/common');
    expect(id).not.toContain('/');
    expect(id).toContain('src_python_common');
  });

  it('handles dotted paths', () => {
    const id = componentToSignalId('docs', '.release-fpa');
    expect(id).toBe('comp_docs__release_fpa');
  });

  it('resolves back via lookup', () => {
    const path = 'apispec';
    const id = componentToSignalId('readme', path);
    const result = resolveSignalId(id, mockReport);
    expect(result.type).toBe('component');
    expect(result.recommendation).toContain('API Specs');
  });
});

describe('buildRecommendations integration', () => {
  // Simulate the deduplication logic from buildRecommendations
  function buildIds(report: typeof mockReport): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();

    // Signal-based
    for (const s of report.levels.flatMap(l => l.signals).filter(s => !s.detected || (s as any).score < 40)) {
      if (!seen.has(s.signalId)) { seen.add(s.signalId); ids.push(s.signalId); }
    }

    // Insight-based
    for (const i of report.insights || []) {
      const id = insightToSignalId(i.category, i.title);
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }

    // Component-based
    for (const c of (report.componentScores || []).filter(c => c.overallScore < 50)) {
      const id = componentToSignalId('readme', c.path);
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }

    return ids;
  }

  it('includes all three recommendation types', () => {
    const ids = buildIds(mockReport);
    expect(ids.some(id => id === 'copilot_agents')).toBe(true); // signal
    expect(ids.some(id => id.startsWith('insight_'))).toBe(true); // insight
    expect(ids.some(id => id.startsWith('comp_'))).toBe(true); // component
  });

  it('all generated IDs are resolvable', () => {
    const ids = buildIds(mockReport);
    for (const id of ids) {
      const result = resolveSignalId(id, mockReport);
      expect(result.type).not.toBe('not-found');
    }
  });

  it('no duplicate IDs', () => {
    const ids = buildIds(mockReport);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
