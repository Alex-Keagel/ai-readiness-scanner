import { describe, it, expect } from 'vitest';
import { NarrativeGenerator, validateNarrativeAgainstSignals } from '../../report/narrativeGenerator';

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

  it('IQ Sync narrative does not contradict detected root instruction file', async () => {
    // Mock LLM returns a narrative that falsely claims the root instruction file is absent
    const contradictingClient = {
      analyze: async () => '[]',
      analyzeFast: async (prompt: string) => {
        if (prompt.includes('GROUND TRUTH') || prompt.includes('platform readiness')) {
          return JSON.stringify([
            { dimension: 'Business Logic Alignment', narrative: 'Despite the absence of a root copilot-instructions.md, the project shows good alignment.' },
            { dimension: 'Type & Environment Strictness', narrative: 'Strong types.' },
            { dimension: 'Semantic Density', narrative: 'Good density.' },
            { dimension: 'Instruction/Reality Sync', narrative: 'The absence of a root .github/copilot-instructions.md significantly weakens agent guidance for this project.' },
            { dimension: 'Context Efficiency', narrative: 'Moderate coverage.' },
          ]);
        }
        if (prompt.includes('tooling ecosystem')) {
          return JSON.stringify({ status: 'OK', items: [
            { name: 'Skill Portability', severity: 'good', narrative: 'Fine.' },
            { name: 'Tooling Execution Risk', severity: 'good', narrative: 'Fine.' },
            { name: 'Context Collision', severity: 'good', narrative: 'Fine.' },
          ]});
        }
        if (prompt.includes('Friction Map')) {
          return JSON.stringify([{ title: 'Step 1', narrative: 'Do something.', actions: [] }]);
        }
        return '[]';
      },
    } as any;

    // Report where copilot_instructions IS detected (file exists with real content)
    const report = makeReport({
      levels: [
        { level: 1, name: 'Prompt-Only', rawScore: 80, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
        { level: 2, name: 'Instruction-Guided', rawScore: 65, qualified: true, signals: [
          { signalId: 'copilot_instructions', level: 2, detected: true, score: 70, finding: 'Found .github/copilot-instructions.md (3116 bytes)', files: ['.github/copilot-instructions.md'], confidence: 'high' },
        ], signalsDetected: 1, signalsTotal: 1 },
      ],
    });

    const contradictGen = new NarrativeGenerator(contradictingClient);
    const result = await contradictGen.generate(report);

    const iqSync = result.platformReadiness.find(m => m.dimension === 'Instruction/Reality Sync');
    expect(iqSync).toBeDefined();

    // The narrative must NOT claim the file is absent — it EXISTS
    expect(iqSync!.narrative).not.toMatch(/absence/i);
    expect(iqSync!.narrative).not.toMatch(/\bmissing\b.*root/i);
    expect(iqSync!.narrative).not.toMatch(/\babsent\b/i);

    // It SHOULD acknowledge the file exists
    expect(iqSync!.narrative).toMatch(/present|exists|found|detected/i);

    // And contradictions in OTHER metrics should also be patched
    const bla = result.platformReadiness.find(m => m.dimension === 'Business Logic Alignment');
    expect(bla).toBeDefined();
    expect(bla!.narrative).not.toMatch(/absence|absent|missing/i);
  });

  it('IQ Sync narrative handles various absence claim patterns', () => {
    const patterns = [
      'The primary instruction file is missing, leaving agents without guidance.',
      'Without a root instruction file, the agent has limited context.',
      'copilot-instructions.md is not present in the repository.',
      'No main instruction file has been set up for this project.',
      'The absence of copilot-instructions.md weakens agent guidance.',
    ];

    for (const badNarrative of patterns) {
      const result = (gen as any).validateIQSyncNarrative(
        [{ dimension: 'Instruction/Reality Sync', narrative: badNarrative }],
        true,  // rootInstructionDetected = file EXISTS
        ['.github/copilot-instructions.md'],
        45,    // iqSyncScore
      );

      expect(result[0].narrative, `Pattern not caught: "${badNarrative}"`)
        .toMatch(/present|exists/i);
      expect(result[0].narrative, `Still claims absence: "${badNarrative}"`)
        .not.toMatch(/absence|absent|missing/i);
    }
  });

  it('catches LLM paraphrase variants of absence claims', () => {
    const expandedPatterns = [
      'The lack of a root copilot-instructions.md limits guidance',
      'Despite lacking a comprehensive copilot-instructions.md',
      'The absence of a comprehensive copilot-instructions.md limits agent guidance',
      'The absence of a well-defined copilot-instructions.md',
      'copilot-instructions.md has not been configured for this project',
      'Currently no copilot-instructions.md is available',
      'The project does not include a copilot-instructions.md',
      'there is no copilot-instructions.md in the repository',
      'A copilot-instructions.md file is not present',
      'copilot-instructions.md was not found in the project',
      'the repository has no dedicated copilot-instructions.md',
    ];

    for (const badNarrative of expandedPatterns) {
      const caught = (gen as any).containsRootAbsenceClaim(badNarrative);
      expect(caught, `Regex failed to catch: "${badNarrative}"`).toBe(true);
    }
  });

  it('catches 15+ LLM phrasings of root instruction absence', () => {
    const phrasings = [
      // Original set
      'Despite the absence of a root copilot-instructions.md, the project is well structured.',
      'The lack of a root copilot-instructions.md weakens guidance significantly.',
      'Lacking a root copilot-instructions.md, agents receive no project-level context.',
      'The project does not include a copilot-instructions.md file.',
      'copilot-instructions.md was not found in the repository.',
      'Without a dedicated root instruction file, the agent has limited context.',
      'No root-level copilot-instructions.md was detected for this project.',
      // New variants
      'The root instruction file is missing from the project.',
      'copilot-instructions.md is not available in this workspace.',
      'copilot-instructions.md is absent from the project root.',
      'A root copilot-instructions.md has not been set up yet.',
      'The repository doesn\'t have a copilot-instructions.md.',
      'copilot-instructions.md has not been created for this project.',
      'There is currently no root instruction file configured.',
      'The project lacks a root instructions.md file.',
      'copilot-instructions.md is not detected anywhere in the repository.',
      'The primary instruction file is not present in this project.',
      'No copilot-instructions.md was established for agent guidance.',
    ];

    for (const phrasing of phrasings) {
      const caught = (gen as any).containsRootAbsenceClaim(phrasing);
      expect(caught, `Failed to catch: "${phrasing}"`).toBe(true);
    }
    // Sanity: we tested more than 15 phrasings
    expect(phrasings.length).toBeGreaterThanOrEqual(15);
  });

  it('does NOT flag valid narratives about scoped instruction gaps', () => {
    const validNarratives = [
      'Root instruction file provides basic guidance but scoped instructions are missing for individual components.',
      'The copilot-instructions.md is present and well-structured, but component-level instructions are absent.',
      'While the root instruction exists, specific directories lack dedicated guidance files.',
      'Instruction coverage is strong at the root level but missing at the component level.',
      'The project has a solid copilot-instructions.md; consider adding scoped context for submodules.',
    ];

    for (const validNarrative of validNarratives) {
      const caught = (gen as any).containsRootAbsenceClaim(validNarrative);
      expect(caught, `False positive for: "${validNarrative}"`).toBe(false);
    }
  });

  it('cached report with stale contradiction gets repaired via sanitizeNarrativeSections', () => {
    const report = makeReport({
      narrativeSections: {
        platformReadiness: [
          { dimension: 'Instruction/Reality Sync', narrative: 'The absence of copilot-instructions.md weakens agent guidance.', score: 45, label: 'warning' },
          { dimension: 'Business Logic Alignment', narrative: 'Good alignment.', score: 60, label: 'strong' },
        ],
        toolingHealth: { status: 'OK', items: [] },
        frictionMap: [],
      },
    });

    const changed = gen.sanitizeNarrativeSections(report);
    expect(changed).toBe(true);

    const iqSync = report.narrativeSections!.platformReadiness.find(
      (m: any) => m.dimension === 'Instruction/Reality Sync',
    );
    expect(iqSync).toBeDefined();
    expect(iqSync!.narrative).toMatch(/present|exists/i);
    expect(iqSync!.narrative).not.toMatch(/absence|absent|missing/i);
  });

  it('cached report with valid narrative is NOT modified by sanitizeNarrativeSections', () => {
    const report = makeReport({
      narrativeSections: {
        platformReadiness: [
          {
            dimension: 'Instruction/Reality Sync',
            narrative: 'Root instruction file (.github/copilot-instructions.md) exists but would benefit from enrichment.',
            score: 45, label: 'warning',
          },
        ],
        toolingHealth: { status: 'OK', items: [] },
        frictionMap: [],
      },
    });

    const changed = gen.sanitizeNarrativeSections(report);
    expect(changed).toBe(false);
  });

  it('IQ Sync narrative allows valid absence claims for scoped instructions', () => {
    // Narrative about SCOPED instructions being absent (while root exists) should NOT be patched
    const validNarrative = 'Root instruction file provides basic guidance but scoped instructions are missing for individual components.';
    const result = (gen as any).validateIQSyncNarrative(
      [{ dimension: 'Instruction/Reality Sync', narrative: validNarrative }],
      true,
      ['.github/copilot-instructions.md'],
      45,
    );

    expect(result[0].narrative).toBe(validNarrative);
  });
});

describe('validateNarrativeAgainstSignals', () => {
  it('corrects a contradicting narrative when signal is detected', () => {
    const narrative = 'The absence of copilot-instructions.md weakens agent guidance.';
    const signals = [
      { signalId: 'copilot_instructions', detected: true, files: ['.github/copilot-instructions.md'], level: 2, score: 70, finding: 'Found', confidence: 'high' as const },
    ];
    const result = validateNarrativeAgainstSignals(narrative, signals);
    expect(result).not.toMatch(/absence/i);
    expect(result).toMatch(/present|detected/i);
  });

  it('leaves valid narrative unchanged', () => {
    const narrative = 'Root instruction file is present and well-integrated.';
    const signals = [
      { signalId: 'copilot_instructions', detected: true, files: ['.github/copilot-instructions.md'], level: 2, score: 70, finding: 'Found', confidence: 'high' as const },
    ];
    const result = validateNarrativeAgainstSignals(narrative, signals);
    expect(result).toBe(narrative);
  });

  it('handles empty signals array', () => {
    const narrative = 'Some narrative text.';
    const result = validateNarrativeAgainstSignals(narrative, []);
    expect(result).toBe(narrative);
  });
});
