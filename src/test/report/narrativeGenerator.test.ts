import { describe, it, expect } from 'vitest';
import { NarrativeGenerator } from '../../report/narrativeGenerator';

const mockClient = {
  analyze: async (prompt: string) => {
    if (prompt.includes('platform readiness')) {
      return JSON.stringify([
        { dimension: 'Business Logic Alignment', narrative: 'Good alignment.' },
        { dimension: 'Type & Environment Strictness', narrative: 'Strong types.' },
      ]);
    }
    if (prompt.includes('tooling ecosystem')) {
      return JSON.stringify({
        status: 'Capable, but Fragmented',
        items: [
          { name: 'Skill Portability', severity: 'warning', narrative: '1 skill defined.' },
          { name: 'Tooling Execution Risk', severity: 'critical', narrative: 'Missing script.' },
          { name: 'Context Collision', severity: 'good', narrative: 'No collision.' },
        ],
      });
    }
    if (prompt.includes('Friction Map')) {
      return JSON.stringify([
        { title: 'Fix Ghost Map', narrative: 'References missing files.', actions: [{ action: 'Remove bad ref', impact: 'Eliminates hallucinations' }] },
      ]);
    }
    return '[]';
  },
  analyzeFast: async (prompt) => { if (prompt.includes("platform readiness")) return JSON.stringify([{dimension:"Business Logic Alignment",narrative:"Good alignment."},{dimension:"Type \analyzeFast: async () => '{}' Environment Strictness",narrative:"Strong types."}]); if (prompt.includes("tooling ecosystem")) return JSON.stringify({status:"Capable",items:[{name:"Skill Portability",severity:"warning",narrative:"1 skill."},{name:"Tooling Execution Risk",severity:"critical",narrative:"Missing script."},{name:"Context Collision",severity:"good",narrative:"No collision."}]}); if (prompt.includes("Friction Map")) return JSON.stringify([{title:"Fix Ghost Map",narrative:"References missing files.",actions:[{action:"Remove bad ref",impact:"Eliminates hallucinations"}]}]); return "[]"; },
} as any;

function makeReport(overrides: Record<string, any> = {}) {
  return {
    projectName: 'test-project',
    scannedAt: new Date().toISOString(),
    primaryLevel: 2,
    levelName: 'Instruction-Guided',
    depth: 65,
    overallScore: 35,
    levels: [
      { level: 1, name: 'Prompt-Only', rawScore: 80, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
      { level: 2, name: 'Instruction-Guided', rawScore: 65, qualified: true, signals: [
        { signalId: 'copilot_instructions', level: 2, detected: true, score: 70, finding: 'Found', files: ['.github/copilot-instructions.md'], confidence: 'high' },
        { signalId: 'cursor_rules', level: 2, detected: false, score: 0, finding: 'Missing', files: [], confidence: 'high' },
      ], signalsDetected: 1, signalsTotal: 2 },
      { level: 3, name: 'Skill-Equipped', rawScore: 20, qualified: false, signals: [
        { signalId: 'copilot_agents', level: 3, detected: false, score: 0, finding: 'No agents', files: [], confidence: 'high' },
      ], signalsDetected: 0, signalsTotal: 1 },
    ],
    componentScores: [
      { name: 'API', path: 'src/api', language: 'TypeScript', type: 'service', primaryLevel: 2, depth: 50, overallScore: 40, levels: [], signals: [] },
    ],
    languageScores: [],
    projectContext: { languages: ['TypeScript'], frameworks: [], projectType: 'app', packageManager: 'npm', directoryTree: '', components: [] },
    selectedTool: 'copilot',
    modelUsed: 'test',
    scanMode: 'full',
    codebaseMetrics: { semanticDensity: 45, typeStrictnessIndex: 60, contextFragmentation: 35 },
    contextAudit: {
      mcpHealth: { score: 80, servers: [], totalTools: 0, estimatedTokenCost: 0 },
      skillQuality: { score: 50, skills: [] },
      contextEfficiency: { score: 70, totalTokens: 5000, budgetPct: 5, breakdown: [], redundancies: [] },
      toolSecurity: { score: 90, issues: [] },
      hookCoverage: { score: 40, hasPostTask: false, hasMemoryUpdate: false, hasSafeCommands: true, hasPreCommit: false },
      skillCoverage: { score: 50, coveredAreas: [], gaps: [] },
    },
    ...overrides,
  } as any;
}

describe('NarrativeGenerator', () => {
  const gen = new NarrativeGenerator(mockClient);

  it('generates all three sections', async () => {
    const result = await gen.generate(makeReport());
    expect(result.platformReadiness).toBeDefined();
    expect(result.toolingHealth).toBeDefined();
    expect(result.frictionMap).toBeDefined();
  });

  it('platformReadiness returns 5 metrics with required fields', async () => {
    const result = await gen.generate(makeReport());
    expect(result.platformReadiness).toHaveLength(5);
    for (const m of result.platformReadiness) {
      expect(m.dimension).toBeTruthy();
      expect(typeof m.score).toBe('number');
      expect(['excellent', 'strong', 'warning', 'critical']).toContain(m.label);
      expect(m.narrative).toBeTruthy();
    }
  });

  it('metric labels match score ranges', async () => {
    const result = await gen.generate(makeReport());
    for (const m of result.platformReadiness) {
      if (m.score >= 75) expect(m.label).toBe('excellent');
      else if (m.score >= 55) expect(m.label).toBe('strong');
      else if (m.score >= 35) expect(m.label).toBe('warning');
      else expect(m.label).toBe('critical');
    }
  });

  it('toolingHealth has status and items', async () => {
    const result = await gen.generate(makeReport());
    expect(result.toolingHealth.status).toBeTruthy();
    expect(result.toolingHealth.items.length).toBeGreaterThanOrEqual(1);
    for (const item of result.toolingHealth.items) {
      expect(['good', 'warning', 'critical']).toContain(item.severity);
      expect(item.name).toBeTruthy();
    }
  });

  it('frictionMap returns steps with actions', async () => {
    const result = await gen.generate(makeReport());
    expect(result.frictionMap.length).toBeGreaterThanOrEqual(1);
    expect(result.frictionMap[0].title).toBeTruthy();
    expect(result.frictionMap[0].narrative).toBeTruthy();
  });

  it('handles missing codebaseMetrics', async () => {
    const result = await gen.generate(makeReport({ codebaseMetrics: undefined }));
    expect(result.platformReadiness).toHaveLength(5);
  });

  it('handles missing contextAudit', async () => {
    const result = await gen.generate(makeReport({ contextAudit: undefined }));
    expect(result.toolingHealth.status).toBeTruthy();
  });

  it('handles LLM failure with fallbacks', async () => {
    const failGen = new NarrativeGenerator({ analyze: async () => { throw new Error('down'); }, analyzeFast: async (prompt) => { if (prompt.includes("platform readiness")) return JSON.stringify([{dimension:"Business Logic Alignment",narrative:"Good alignment."},{dimension:"Type \analyzeFast: async () => '{}' Environment Strictness",narrative:"Strong types."}]); if (prompt.includes("tooling ecosystem")) return JSON.stringify({status:"Capable",items:[{name:"Skill Portability",severity:"warning",narrative:"1 skill."},{name:"Tooling Execution Risk",severity:"critical",narrative:"Missing script."},{name:"Context Collision",severity:"good",narrative:"No collision."}]}); if (prompt.includes("Friction Map")) return JSON.stringify([{title:"Fix Ghost Map",narrative:"References missing files.",actions:[{action:"Remove bad ref",impact:"Eliminates hallucinations"}]}]); return "[]"; } } as any);
    const result = await failGen.generate(makeReport());
    expect(result.platformReadiness).toHaveLength(5);
    expect(result.toolingHealth.status).toBeTruthy();
    expect(result.frictionMap.length).toBeGreaterThanOrEqual(1);
  });

  it('handles malformed LLM JSON', async () => {
    const badGen = new NarrativeGenerator({ analyze: async () => 'not json!!!', analyzeFast: async (prompt) => { if (prompt.includes("platform readiness")) return JSON.stringify([{dimension:"Business Logic Alignment",narrative:"Good alignment."},{dimension:"Type \analyzeFast: async () => '{}' Environment Strictness",narrative:"Strong types."}]); if (prompt.includes("tooling ecosystem")) return JSON.stringify({status:"Capable",items:[{name:"Skill Portability",severity:"warning",narrative:"1 skill."},{name:"Tooling Execution Risk",severity:"critical",narrative:"Missing script."},{name:"Context Collision",severity:"good",narrative:"No collision."}]}); if (prompt.includes("Friction Map")) return JSON.stringify([{title:"Fix Ghost Map",narrative:"References missing files.",actions:[{action:"Remove bad ref",impact:"Eliminates hallucinations"}]}]); return "[]"; } } as any);
    const result = await badGen.generate(makeReport());
    expect(result.platformReadiness).toHaveLength(5);
  });

  it('caps friction steps at 5', async () => {
    const manyClient = {
      analyze: async (p: string) => {
        if (p.includes('Friction Map')) {
          return JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ title: `Step ${i}`, narrative: 'Fix', actions: [] })));
        }
        return '[]';
      },
      analyzeFast: async (prompt) => { if (prompt.includes("platform readiness")) return JSON.stringify([{dimension:"Business Logic Alignment",narrative:"Good alignment."},{dimension:"Type \analyzeFast: async () => '{}' Environment Strictness",narrative:"Strong types."}]); if (prompt.includes("tooling ecosystem")) return JSON.stringify({status:"Capable",items:[{name:"Skill Portability",severity:"warning",narrative:"1 skill."},{name:"Tooling Execution Risk",severity:"critical",narrative:"Missing script."},{name:"Context Collision",severity:"good",narrative:"No collision."}]}); if (prompt.includes("Friction Map")) return JSON.stringify([{title:"Fix Ghost Map",narrative:"References missing files.",actions:[{action:"Remove bad ref",impact:"Eliminates hallucinations"}]}]); return "[]"; },
    } as any;
    const result = await new NarrativeGenerator(manyClient).generate(makeReport());
    expect(result.frictionMap.length).toBeLessThanOrEqual(5);
  });

  it('handles empty levels for friction map', async () => {
    const result = await gen.generate(makeReport({ levels: [] }));
    expect(result.frictionMap.length).toBeGreaterThanOrEqual(1);
  });

  it('uses LLM narrative when available', async () => {
    const result = await gen.generate(makeReport());
    const bla = result.platformReadiness.find(m => m.dimension === 'Business Logic Alignment');
    expect(bla?.narrative).toBe('Good alignment.');
  });
});
