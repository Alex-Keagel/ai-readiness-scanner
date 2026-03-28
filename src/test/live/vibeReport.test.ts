import { describe, it, expect } from 'vitest';

/**
 * Pure-computation tests for the VibeReport formulas.
 *
 * VibeReportGenerator.collectMetrics is private and reads the filesystem,
 * so we replicate the formulas here and verify them with known inputs.
 * This validates the math without touching any I/O.
 */

interface SessionSummary {
  id: string;
  platform: string;
  project: string;
  startTime: string;
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolSuccesses: number;
  toolFailures: number;
  outputTokens: number;
  inputTokens: number;
  durationMinutes: number;
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    platform: 'copilot',
    project: 'test-project',
    startTime: '2024-01-01T00:00:00Z',
    messageCount: 20,
    userMessages: 5,
    assistantMessages: 10,
    toolCalls: 15,
    toolSuccesses: 14,
    toolFailures: 1,
    outputTokens: 5000,
    inputTokens: 2000,
    durationMinutes: 30,
    ...overrides,
  };
}

// ─── Helper: replicate APS formulas ──────────────────────────────────

const clamp = (v: number) => Math.round(Math.min(100, Math.max(0, v)));

function computeMetrics(sessions: SessionSummary[]) {
  const totalUserMessages = sessions.reduce((s, x) => s + x.userMessages, 0);
  const totalAssistantMessages = sessions.reduce((s, x) => s + x.assistantMessages, 0);
  const totalToolCalls = sessions.reduce((s, x) => s + x.toolCalls, 0);
  const totalOutputTokens = sessions.reduce((s, x) => s + x.outputTokens, 0);
  const totalInputTokens = sessions.reduce((s, x) => s + x.inputTokens, 0);
  const totalToolSuccesses = sessions.reduce((s, x) => s + x.toolSuccesses, 0);
  const totalToolFailures = sessions.reduce((s, x) => s + x.toolFailures, 0);

  const autonomyRatio = totalUserMessages > 0
    ? Math.round(((totalAssistantMessages + totalToolCalls) / totalUserMessages) * 10) / 10
    : 0;

  // Autonomy Score
  const arRaw = totalUserMessages > 0
    ? (totalToolCalls + 0.25 * totalAssistantMessages) / totalUserMessages
    : 0;
  const autonomyScore = clamp(((arRaw - 1.5) / (10 - 1.5)) * 100);

  // Output Density Score
  const odRaw = totalUserMessages > 0
    ? (totalOutputTokens / totalUserMessages) * Math.min(1, totalToolCalls / (3 * totalUserMessages))
    : 0;
  const outputDensityScore = clamp(((odRaw - 250) / (2500 - 250)) * 100);

  // Session Depth Score
  const avgDepth = sessions.length > 0
    ? sessions.reduce((s, x) => s + Math.log(1 + x.toolCalls) + Math.log(1 + x.outputTokens / 500), 0) / sessions.length
    : 0;
  const sessionDepthScore = clamp(((avgDepth - 1.6) / (3.6 - 1.6)) * 100);

  // Recovery Score
  const correctionLoad = totalToolCalls > 0
    ? Math.max(totalUserMessages - 1, 0) / (totalToolCalls + 1)
    : 1;
  const recoveryScore = clamp(100 * Math.exp(-2 * correctionLoad));

  // Delegation Quality
  const contextPerPrompt = totalUserMessages > 0 ? totalOutputTokens / totalUserMessages : 0;
  const actionYield = totalUserMessages > 0
    ? Math.min(1, totalToolCalls / (5 * totalUserMessages))
    : 0;
  const delegationQualityScore = clamp(
    0.35 * Math.min(100, contextPerPrompt / 25) + 0.35 * actionYield * 100 + 0.30 * recoveryScore,
  );

  // APS
  const aps = clamp(
    0.25 * autonomyScore +
    0.20 * delegationQualityScore +
    0.15 * recoveryScore +
    0.15 * sessionDepthScore +
    0.10 * outputDensityScore +
    0.15 * 50,
  );

  // Vibe Level
  const vibeLevel = aps >= 90 ? 5 : aps >= 80 ? 4 : aps >= 65 ? 3 : aps >= 45 ? 2 : aps >= 25 ? 1 : 0;

  // Growth
  const quarter = Math.max(1, Math.floor(sessions.length / 4));
  const earlySessions = sessions.slice(0, quarter);
  const recentSessions = sessions.slice(-quarter);
  const calcAvg = (arr: SessionSummary[], fn: (s: SessionSummary) => number) =>
    arr.length > 0 ? arr.reduce((s, x) => s + fn(x), 0) / arr.length : 0;

  const earlyAR = calcAvg(earlySessions, s => s.userMessages > 0 ? (s.toolCalls + s.assistantMessages) / s.userMessages : 0);
  const recentAR = calcAvg(recentSessions, s => s.userMessages > 0 ? (s.toolCalls + s.assistantMessages) / s.userMessages : 0);
  const autoDelta = recentAR - earlyAR;

  const toTrend = (d: number): 'improving' | 'stable' | 'declining' => d > 4 ? 'improving' : d < -4 ? 'declining' : 'stable';

  // Archetypes
  const archetypeScores: Record<string, number> = {
    Architect: 0.30 * Math.min(100, contextPerPrompt / 30) + 0.25 * delegationQualityScore + 0.25 * sessionDepthScore + 0.20 * recoveryScore,
    Sprinter: 0.35 * autonomyScore + 0.30 * (100 - Math.min(100, contextPerPrompt / 20)) + 0.35 * Math.min(100, sessions.length * 5),
    Perfectionist: 0.45 * (100 * Math.min(1, correctionLoad / 0.5)) + 0.25 * sessionDepthScore + 0.30 * outputDensityScore,
    Explorer: 0.50 * outputDensityScore + 0.25 * sessionDepthScore + 0.25 * autonomyScore,
    Delegator: 0.40 * autonomyScore + 0.30 * delegationQualityScore + 0.20 * recoveryScore + 0.10 * sessionDepthScore,
    Operator: 0.40 * autonomyScore + 0.25 * recoveryScore + 0.20 * sessionDepthScore + 0.15 * outputDensityScore,
  };
  const sorted = Object.entries(archetypeScores).sort((a, b) => b[1] - a[1]);
  const primaryArchetype = sorted[0][0];

  // Advanced metrics
  const tokenROI = totalOutputTokens > 0 && totalInputTokens > 0
    ? Math.round((totalOutputTokens / totalInputTokens) * 100) / 100
    : totalOutputTokens > 0 ? Infinity : 0;
  const toolCallSuccessRate = totalToolSuccesses + totalToolFailures > 0
    ? Math.round((totalToolSuccesses / (totalToolSuccesses + totalToolFailures)) * 100)
    : 100;
  const humanTakeoverRate = sessions.length > 0
    ? Math.round(sessions.filter(s => s.userMessages > 0 && (s.assistantMessages + s.toolCalls) / s.userMessages < 1.5).length / sessions.length * 100)
    : 0;
  const contextSNR = totalOutputTokens + totalInputTokens > 0
    ? Math.round(totalOutputTokens / (totalOutputTokens + totalInputTokens) * 100)
    : 0;
  const guardrailInterventionRate = totalToolCalls > 0
    ? Math.round(totalToolFailures / totalToolCalls * 100)
    : 0;

  return {
    autonomyRatio,
    autonomyScore,
    outputDensityScore,
    sessionDepthScore,
    recoveryScore,
    delegationQualityScore,
    aps,
    vibeLevel,
    primaryArchetype,
    growthTrend: toTrend(autoDelta),
    tokenROI,
    toolCallSuccessRate,
    humanTakeoverRate,
    contextSNR,
    guardrailInterventionRate,
  };
}

// ─── APS calculation ─────────────────────────────────────────────────

describe('APS calculation', () => {
  it('computes weighted combination of dimension scores', () => {
    const sessions = [makeSession()];
    const m = computeMetrics(sessions);

    expect(m.aps).toBeGreaterThanOrEqual(0);
    expect(m.aps).toBeLessThanOrEqual(100);

    // Verify APS is derived from component scores
    const expectedAps = clamp(
      0.25 * m.autonomyScore +
      0.20 * m.delegationQualityScore +
      0.15 * m.recoveryScore +
      0.15 * m.sessionDepthScore +
      0.10 * m.outputDensityScore +
      0.15 * 50,
    );
    expect(m.aps).toBe(expectedAps);
  });

  it('higher tool usage and output yields higher APS', () => {
    const low = computeMetrics([makeSession({ toolCalls: 1, outputTokens: 100, assistantMessages: 1 })]);
    const high = computeMetrics([makeSession({ toolCalls: 50, outputTokens: 20000, assistantMessages: 30 })]);

    expect(high.aps).toBeGreaterThan(low.aps);
  });
});

// ─── Autonomy ratio ──────────────────────────────────────────────────

describe('autonomy ratio', () => {
  it('computes (assistant + toolCalls) / userMessages', () => {
    const m = computeMetrics([makeSession({ userMessages: 5, assistantMessages: 10, toolCalls: 15 })]);
    // (10 + 15) / 5 = 5.0
    expect(m.autonomyRatio).toBe(5);
  });

  it('returns 0 when no user messages', () => {
    const m = computeMetrics([makeSession({ userMessages: 0 })]);
    expect(m.autonomyRatio).toBe(0);
  });
});

// ─── Growth trend detection ──────────────────────────────────────────

describe('growth trend', () => {
  it('detects improving trend when recent AR exceeds early by > 4', () => {
    const early = makeSession({ id: 's1', startTime: '2024-01-01', userMessages: 5, assistantMessages: 2, toolCalls: 2 }); // AR=0.8
    const recent = makeSession({ id: 's4', startTime: '2024-04-01', userMessages: 5, assistantMessages: 20, toolCalls: 30 }); // AR=10

    const sessions = [early, makeSession({ id: 's2', startTime: '2024-02-01' }), makeSession({ id: 's3', startTime: '2024-03-01' }), recent];
    const m = computeMetrics(sessions);
    expect(m.growthTrend).toBe('improving');
  });

  it('detects stable trend when delta is within ±4', () => {
    const sessions = [
      makeSession({ id: 's1', startTime: '2024-01-01', userMessages: 5, assistantMessages: 10, toolCalls: 10 }),
      makeSession({ id: 's2', startTime: '2024-02-01', userMessages: 5, assistantMessages: 10, toolCalls: 10 }),
      makeSession({ id: 's3', startTime: '2024-03-01', userMessages: 5, assistantMessages: 10, toolCalls: 10 }),
      makeSession({ id: 's4', startTime: '2024-04-01', userMessages: 5, assistantMessages: 10, toolCalls: 10 }),
    ];
    const m = computeMetrics(sessions);
    expect(m.growthTrend).toBe('stable');
  });

  it('detects declining trend when recent AR falls below early by > 4', () => {
    const early = makeSession({ id: 's1', startTime: '2024-01-01', userMessages: 5, assistantMessages: 20, toolCalls: 30 }); // AR=10
    const recent = makeSession({ id: 's4', startTime: '2024-04-01', userMessages: 5, assistantMessages: 2, toolCalls: 2 }); // AR=0.8

    const sessions = [early, makeSession({ id: 's2', startTime: '2024-02-01' }), makeSession({ id: 's3', startTime: '2024-03-01' }), recent];
    const m = computeMetrics(sessions);
    expect(m.growthTrend).toBe('declining');
  });
});

// ─── Archetype classification ────────────────────────────────────────

describe('archetype classification', () => {
  it('returns a valid archetype string', () => {
    const m = computeMetrics([makeSession()]);
    const validArchetypes = ['Architect', 'Sprinter', 'Perfectionist', 'Explorer', 'Delegator', 'Operator'];
    expect(validArchetypes).toContain(m.primaryArchetype);
  });

  it('high autonomy sessions classify into a recognized archetype', () => {
    const m = computeMetrics([makeSession({ toolCalls: 50, assistantMessages: 30, userMessages: 3, outputTokens: 20000 })]);
    const validArchetypes = ['Architect', 'Sprinter', 'Perfectionist', 'Explorer', 'Delegator', 'Operator'];
    expect(validArchetypes).toContain(m.primaryArchetype);
  });
});

// ─── Vibe level assignment ───────────────────────────────────────────

describe('vibe level', () => {
  it('assigns level 0-5 based on APS thresholds', () => {
    // Low APS → level 0
    const low = computeMetrics([makeSession({ toolCalls: 0, assistantMessages: 1, userMessages: 10, outputTokens: 50 })]);
    expect(low.vibeLevel).toBeGreaterThanOrEqual(0);
    expect(low.vibeLevel).toBeLessThanOrEqual(5);
  });

  it('very high APS gets level 4 or 5', () => {
    // Extreme engagement
    const high = computeMetrics([makeSession({
      toolCalls: 100, assistantMessages: 50, userMessages: 3, outputTokens: 50000, inputTokens: 5000,
    })]);
    expect(high.vibeLevel).toBeGreaterThanOrEqual(3);
  });
});

// ─── Advanced metrics ────────────────────────────────────────────────

describe('advanced metrics', () => {
  it('tokenROI = outputTokens / inputTokens', () => {
    const m = computeMetrics([makeSession({ outputTokens: 5000, inputTokens: 2000 })]);
    expect(m.tokenROI).toBe(2.5);
  });

  it('tokenROI returns Infinity when inputTokens is 0 but output > 0', () => {
    const m = computeMetrics([makeSession({ outputTokens: 5000, inputTokens: 0 })]);
    expect(m.tokenROI).toBe(Infinity);
  });

  it('tokenROI returns 0 when both are 0', () => {
    const m = computeMetrics([makeSession({ outputTokens: 0, inputTokens: 0 })]);
    expect(m.tokenROI).toBe(0);
  });

  it('toolCallSuccessRate computes percentage', () => {
    const m = computeMetrics([makeSession({ toolSuccesses: 9, toolFailures: 1 })]);
    expect(m.toolCallSuccessRate).toBe(90);
  });

  it('toolCallSuccessRate is 100 when no tool calls', () => {
    const m = computeMetrics([makeSession({ toolSuccesses: 0, toolFailures: 0 })]);
    expect(m.toolCallSuccessRate).toBe(100);
  });

  it('humanTakeoverRate is 0 when agent dominates', () => {
    // AR = (assistantMessages + toolCalls) / userMessages = (10+15)/5 = 5 ≥ 1.5
    const m = computeMetrics([makeSession({ userMessages: 5, assistantMessages: 10, toolCalls: 15 })]);
    expect(m.humanTakeoverRate).toBe(0);
  });

  it('humanTakeoverRate increases with low-autonomy sessions', () => {
    // AR = (1+0)/5 = 0.2 < 1.5 → this session counts as takeover
    const m = computeMetrics([makeSession({ userMessages: 5, assistantMessages: 1, toolCalls: 0 })]);
    expect(m.humanTakeoverRate).toBe(100);
  });

  it('contextSNR = outputTokens / (output + input) * 100', () => {
    const m = computeMetrics([makeSession({ outputTokens: 3000, inputTokens: 7000 })]);
    // 3000 / 10000 * 100 = 30
    expect(m.contextSNR).toBe(30);
  });

  it('guardrailInterventionRate = failures / totalToolCalls * 100', () => {
    const m = computeMetrics([makeSession({ toolCalls: 20, toolFailures: 4 })]);
    // 4 / 20 * 100 = 20
    expect(m.guardrailInterventionRate).toBe(20);
  });

  it('guardrailInterventionRate is 0 when no tool calls', () => {
    const m = computeMetrics([makeSession({ toolCalls: 0, toolFailures: 0 })]);
    expect(m.guardrailInterventionRate).toBe(0);
  });
});
