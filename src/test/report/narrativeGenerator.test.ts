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

  it('IQ Sync narrative honors synthetic root instruction aliases', async () => {
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
          return JSON.stringify({ status: 'OK', items: [] });
        }
        if (prompt.includes('Friction Map')) {
          return JSON.stringify([{ title: 'Step 1', narrative: 'Do something.', actions: [] }]);
        }
        return '[]';
      },
    } as any;

    const report = makeReport({
      levels: [
        { level: 1, name: 'Prompt-Only', rawScore: 80, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
        { level: 2, name: 'Instruction-Guided', rawScore: 65, qualified: true, signals: [
          { signalId: 'copilot_l2_instructions', level: 2, detected: true, score: 70, finding: 'Found .github/copilot-instructions.md', files: ['.github/copilot-instructions.md'], confidence: 'high' },
        ], signalsDetected: 1, signalsTotal: 1 },
      ],
      structureComparison: undefined,
    });

    const result = await new NarrativeGenerator(contradictingClient).generate(report);
    const iqSync = result.platformReadiness.find(m => m.dimension === 'Instruction/Reality Sync');

    expect(iqSync).toBeDefined();
    expect(iqSync!.narrative).toMatch(/present|exists|found|detected/i);
    expect(iqSync!.narrative).not.toMatch(/absence|absent|missing/i);
    expect(iqSync!.narrative)
      .toContain('The root .github/copilot-instructions.md provides foundational context for GitHub Copilot.');
  });

  it('IQ Sync narrative uses knowledgeGraph root instruction signals when level signals are missing', async () => {
    const contradictingClient = {
      analyze: async () => '[]',
      analyzeFast: async (prompt: string) => {
        if (prompt.includes('GROUND TRUTH') || prompt.includes('platform readiness')) {
          return JSON.stringify([
            { dimension: 'Business Logic Alignment', narrative: 'Despite the absence of a root copilot-instructions.md, alignment is decent.' },
            { dimension: 'Type & Environment Strictness', narrative: 'Strong types.' },
            { dimension: 'Semantic Density', narrative: 'Good density.' },
            { dimension: 'Instruction/Reality Sync', narrative: 'No root instruction file is present in this repository.' },
            { dimension: 'Context Efficiency', narrative: 'Moderate coverage.' },
          ]);
        }
        if (prompt.includes('tooling ecosystem')) {
          return JSON.stringify({ status: 'OK', items: [] });
        }
        if (prompt.includes('Friction Map')) {
          return JSON.stringify([{ title: 'Step 1', narrative: 'Do something.', actions: [] }]);
        }
        return '[]';
      },
    } as any;

    const report = makeReport({
      levels: [
        { level: 1, name: 'Prompt-Only', rawScore: 80, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
        { level: 2, name: 'Instruction-Guided', rawScore: 65, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
      ],
      structureComparison: undefined,
      knowledgeGraph: {
        nodes: [
          {
            id: 'signal-copilot_l2_instructions',
            type: 'signal',
            label: 'copilot_l2_instructions',
            description: 'Found .github/copilot-instructions.md',
            properties: { detected: true, score: 64 },
          },
          {
            id: 'file-_github_copilot_instructions_md',
            type: 'ai-file',
            label: '.github/copilot-instructions.md',
            properties: { tool: 'copilot', level: 2 },
          },
        ],
        edges: [],
        rootId: 'repo',
        metadata: {
          projectName: 'test-project',
          scannedAt: new Date().toISOString(),
          selectedTool: 'copilot',
          nodeCount: 2,
          edgeCount: 0,
        },
      },
    });

    const result = await new NarrativeGenerator(contradictingClient).generate(report);
    const iqSync = result.platformReadiness.find(m => m.dimension === 'Instruction/Reality Sync');

    expect(iqSync).toBeDefined();
    expect(iqSync!.narrative).toMatch(/present|exists|found|detected/i);
    expect(iqSync!.narrative).not.toMatch(/absence|absent|missing/i);
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
        .toContain('The root .github/copilot-instructions.md provides foundational context for GitHub Copilot.');
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
    expect(iqSync!.narrative)
      .toContain('The root .github/copilot-instructions.md provides foundational context for GitHub Copilot.');
    expect(iqSync!.narrative).not.toMatch(/absence|absent|missing/i);
  });

  it('cached report IQ Sync narrative is normalized to deterministic template', () => {
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
    expect(changed).toBe(true);
    expect(report.narrativeSections!.platformReadiness[0].narrative)
      .toContain('The root .github/copilot-instructions.md provides foundational context for GitHub Copilot.');
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

describe('DataPipelines IQ Sync contradiction (regression)', () => {
  const gen = new NarrativeGenerator(null as any);

  // The EXACT phrases that have appeared in production for DataPipelines
  // despite .github/copilot-instructions.md existing (3116 bytes)
  const DATAPIPELINES_PHRASE = 'Existing README and convention documentation provide a strong surrogate knowledge base, but the absence of a root `.github/copilot-instructions.md` prevents a perfect alignment score.';

  // V2 variant that appeared in the exported graph JSON (Apr 2026)
  const DATAPIPELINES_PHRASE_V2 = 'While documentation like CLAUDE.md provides a strong baseline for coding conventions, the absence of a root-level .github/copilot-instructions.md prevents the agent from grounding these rules in the actual file system.';

  it('containsRootAbsenceClaim catches the exact DataPipelines phrase', () => {
    const caught = (gen as any).containsRootAbsenceClaim(DATAPIPELINES_PHRASE);
    expect(caught, `Failed to catch DataPipelines phrase`).toBe(true);
  });

  it('containsRootAbsenceClaim catches the V2 DataPipelines phrase from exported graph', () => {
    const caught = (gen as any).containsRootAbsenceClaim(DATAPIPELINES_PHRASE_V2);
    expect(caught, `Failed to catch DataPipelines V2 phrase`).toBe(true);
  });

  it('sanitizeNarrativeSections repairs the DataPipelines phrase in cached reports', () => {
    const report = makeReport({
      narrativeSections: {
        platformReadiness: [
          { dimension: 'Instruction/Reality Sync', narrative: DATAPIPELINES_PHRASE, score: 45, label: 'warning' },
          { dimension: 'Business Logic Alignment', narrative: DATAPIPELINES_PHRASE, score: 55, label: 'strong' },
          { dimension: 'Type & Environment Strictness', narrative: 'Strong types.', score: 60, label: 'strong' },
          { dimension: 'Semantic Density', narrative: 'Good density.', score: 50, label: 'warning' },
          { dimension: 'Context Efficiency', narrative: 'Moderate coverage.', score: 60, label: 'strong' },
        ],
        toolingHealth: { status: 'OK', items: [] },
        frictionMap: [
          { title: 'Step 1', narrative: DATAPIPELINES_PHRASE, actions: [{ action: 'Create .github/copilot-instructions.md', impact: 'Better guidance' }] },
        ],
      },
    });

    const changed = gen.sanitizeNarrativeSections(report);
    expect(changed).toBe(true);

    // Check ALL sections were repaired
    for (const metric of report.narrativeSections!.platformReadiness) {
      expect(metric.narrative, `${metric.dimension} still claims absence`)
        .not.toMatch(/\babsence\b.*copilot-instructions/i);
      expect(metric.narrative, `${metric.dimension} still says missing`)
        .not.toMatch(/\bmissing\b.*copilot-instructions/i);
    }

    // Friction map narrative should also be repaired
    for (const step of report.narrativeSections!.frictionMap) {
      expect(step.narrative, `Friction step still claims absence`)
        .not.toMatch(/\babsence\b.*copilot-instructions/i);
    }
  });

  it('sanitizeNarrativeSections repairs the V2 DataPipelines phrase (exported graph variant)', () => {
    const report = makeReport({
      narrativeSections: {
        platformReadiness: [
          { dimension: 'Instruction/Reality Sync', narrative: DATAPIPELINES_PHRASE_V2, score: 69, label: 'strong' },
          { dimension: 'Business Logic Alignment', narrative: 'Good alignment.', score: 74, label: 'strong' },
          { dimension: 'Type & Environment Strictness', narrative: 'Strong types.', score: 64, label: 'strong' },
          { dimension: 'Semantic Density', narrative: 'Good density.', score: 81, label: 'excellent' },
          { dimension: 'Context Efficiency', narrative: 'Moderate coverage.', score: 80, label: 'excellent' },
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
    // IQ Sync must be replaced with deterministic narrative confirming file exists
    expect(iqSync!.narrative).toContain('provides foundational context');
    expect(iqSync!.narrative).not.toMatch(/\babsence\b/i);
    expect(iqSync!.narrative).not.toMatch(/\bmissing\b/i);
  });

  it('generate() never produces absence claims when signal is detected=true', async () => {
    // LLM returns the exact DataPipelines contradicting phrase for EVERY dimension
    const stubbornLLM = {
      analyze: async () => '[]',
      analyzeFast: async (prompt: string) => {
        if (prompt.includes('platform readiness') || prompt.includes('GROUND TRUTH')) {
          return JSON.stringify([
            { dimension: 'Business Logic Alignment', narrative: DATAPIPELINES_PHRASE },
            { dimension: 'Type & Environment Strictness', narrative: 'Strong types.' },
            { dimension: 'Semantic Density', narrative: 'Good density.' },
            { dimension: 'Instruction/Reality Sync', narrative: DATAPIPELINES_PHRASE },
            { dimension: 'Context Efficiency', narrative: DATAPIPELINES_PHRASE },
          ]);
        }
        if (prompt.includes('tooling ecosystem')) {
          return JSON.stringify({ status: DATAPIPELINES_PHRASE, items: [
            { name: 'Skill Portability', severity: 'warning', narrative: DATAPIPELINES_PHRASE },
            { name: 'Tooling Execution Risk', severity: 'good', narrative: 'Fine.' },
            { name: 'Context Collision', severity: 'good', narrative: 'Fine.' },
          ]});
        }
        if (prompt.includes('Friction Map')) {
          return JSON.stringify([{ title: 'Fix Root', narrative: DATAPIPELINES_PHRASE, actions: [{ action: 'Create copilot-instructions.md', impact: DATAPIPELINES_PHRASE }] }]);
        }
        return '[]';
      },
    } as any;

    const report = makeReport({
      levels: [
        { level: 1, name: 'Prompt-Only', rawScore: 80, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
        { level: 2, name: 'Instruction-Guided', rawScore: 65, qualified: true, signals: [
          { signalId: 'copilot_instructions', level: 2, detected: true, score: 70, finding: 'Found .github/copilot-instructions.md (3116 bytes)', files: ['.github/copilot-instructions.md'], confidence: 'high' },
        ], signalsDetected: 1, signalsTotal: 1 },
      ],
    });

    const narrativeGen = new NarrativeGenerator(stubbornLLM);
    const result = await narrativeGen.generate(report);

    // Every single narrative output must NOT contain absence claims about copilot-instructions
    for (const metric of result.platformReadiness) {
      expect(metric.narrative, `platformReadiness[${metric.dimension}] claims absence`)
        .not.toMatch(/\babsence\b/i);
      expect(metric.narrative, `platformReadiness[${metric.dimension}] says missing`)
        .not.toMatch(/\bmissing\b.*copilot-instructions/i);
    }

    // IQ Sync specifically must confirm file exists
    const iqSync = result.platformReadiness.find(m => m.dimension === 'Instruction/Reality Sync');
    expect(iqSync).toBeDefined();
    expect(iqSync!.narrative).toMatch(/present|exists|found|detected/i);
    expect(iqSync!.narrative)
      .toContain('The root .github/copilot-instructions.md provides foundational context for GitHub Copilot.');

    // Tooling health
    expect(result.toolingHealth.status).not.toMatch(/\babsence\b/i);
    for (const item of result.toolingHealth.items) {
      expect(item.narrative, `toolingHealth[${item.name}] claims absence`)
        .not.toMatch(/\babsence\b.*copilot-instructions/i);
    }

    // Friction map
    for (const step of result.frictionMap) {
      expect(step.narrative, `frictionMap[${step.title}] claims absence`)
        .not.toMatch(/\babsence\b.*copilot-instructions/i);
    }
  });

  it('catches consequence-pattern absence claims', () => {
    const consequencePatterns = [
      'The absence of copilot-instructions.md prevents a perfect alignment score.',
      'Missing copilot-instructions.md limits agent effectiveness.',
      'Without a root .github/copilot-instructions.md, alignment suffers.',
      'Lacking copilot-instructions.md hinders the agent guidance pipeline.',
      'The absence of a root instruction file reduces overall readiness.',
    ];

    for (const phrase of consequencePatterns) {
      const caught = (gen as any).containsRootAbsenceClaim(phrase);
      expect(caught, `Consequence pattern not caught: "${phrase}"`).toBe(true);
    }
  });

  it('prompt includes FACT line with finding details when root file exists', async () => {
    let capturedPrompt = '';
    const capturingClient = {
      analyze: async () => '[]',
      analyzeFast: async (prompt: string) => {
        if (prompt.includes('platform readiness') || prompt.includes('GROUND TRUTH')) {
          capturedPrompt = prompt;
          return JSON.stringify([
            { dimension: 'Business Logic Alignment', narrative: 'Good.' },
          ]);
        }
        if (prompt.includes('tooling ecosystem')) return JSON.stringify({ status: 'OK', items: [] });
        if (prompt.includes('Friction Map')) return JSON.stringify([]);
        return '[]';
      },
    } as any;

    const report = makeReport({
      levels: [
        { level: 1, name: 'Prompt-Only', rawScore: 80, qualified: true, signals: [], signalsDetected: 0, signalsTotal: 0 },
        { level: 2, name: 'Instruction-Guided', rawScore: 65, qualified: true, signals: [
          { signalId: 'copilot_instructions', level: 2, detected: true, score: 70, finding: 'Found .github/copilot-instructions.md (3116 bytes)', files: ['.github/copilot-instructions.md'], confidence: 'high' },
        ], signalsDetected: 1, signalsTotal: 1 },
      ],
    });

    await new NarrativeGenerator(capturingClient).generate(report);

    // The prompt must contain an explicit FACT line
    expect(capturedPrompt).toContain('FACT:');
    expect(capturedPrompt).toContain('EXISTS');
    expect(capturedPrompt).toContain('3116 bytes');
    // Must include MANDATORY RULES about never using "absence"
    expect(capturedPrompt).toMatch(/NEVER.*absence/i);
  });
});
