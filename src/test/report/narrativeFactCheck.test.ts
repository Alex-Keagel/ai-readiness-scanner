import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { NarrativeGenerator } from '../../report/narrativeGenerator';

const DP_EXPORT = '/Users/alexkeagel/Dev/AzNet-ApplicationSecurity-DataPipelines/ai-readiness-graph-AzNet-ApplicationSecurity-DataPipelines.json';
const ZTS_EXPORT = '/Users/alexkeagel/Dev/ZTS/ai-readiness-graph-ZTS.json';
const APPSEC_EXPORT = '/Users/alexkeagel/Dev/AzNet-Application-Security/ai-readiness-graph-AzNet-Application-Security.json';

function loadGraphExport(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectNarratives(value: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'narrative' && typeof v === 'string') out.push(v);
      walk(v);
    }
  };
  walk(value);
  return out;
}

describe('narrative fact check harness (real repo exports)', () => {
  const gen = new NarrativeGenerator({ analyze: async () => '[]', analyzeFast: async () => '[]' } as any);

  it('DP: getRootInstructionFact falls back to knowledgeGraph when report levels are missing signals', () => {
    const dp = loadGraphExport(DP_EXPORT);

    const fact = (gen as any).getRootInstructionFact(
      {
        projectName: dp.projectName,
        levels: [],
        knowledgeGraph: dp.knowledgeGraph,
        structureComparison: { expected: [] },
      },
      'copilot',
      [],
    );

    expect(fact.present).toBe(true);
    expect(fact.files).toContain('.github/copilot-instructions.md');
  });

  it('containsRootAbsenceClaim scans all exported narratives and catches root-absence claims for DP/ZTS/AppSec', () => {
    const exports = [
      { name: 'DP', data: loadGraphExport(DP_EXPORT) },
      { name: 'ZTS', data: loadGraphExport(ZTS_EXPORT) },
      { name: 'AppSec', data: loadGraphExport(APPSEC_EXPORT) },
    ];

    for (const item of exports) {
      const narratives = collectNarratives(item.data);
      expect(narratives.length).toBeGreaterThan(0);

      // Exercise detector with all real narrative texts.
      const results = narratives.map(text => ({ text, caught: (gen as any).containsRootAbsenceClaim(text) }));

      const rootAbsenceNarrative = results.find(r =>
        /copilot-instructions\.md/i.test(r.text)
        && /(absence|absent|missing|without|lacks?|no\s+root|no\s+main|no\s+primary)/i.test(r.text),
      );

      expect(rootAbsenceNarrative, `${item.name}: expected at least one real root-absence narrative`).toBeDefined();
      expect(rootAbsenceNarrative!.caught, `${item.name}: detector missed real root-absence narrative`).toBe(true);
    }
  });
});
