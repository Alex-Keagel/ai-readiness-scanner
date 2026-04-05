import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../../graph/graphBuilder';
import type { LevelScore, MaturityLevel, ProjectContext, ReadinessReport, SignalResult } from '../../scoring/types';

function makeSignal(overrides: Partial<SignalResult> = {}): SignalResult {
  return {
    signalId: 'copilot_agents',
    level: 3 as MaturityLevel,
    detected: true,
    score: 82,
    finding: 'Found agent definitions.',
    files: ['.github/agents/root.agent.md'],
    confidence: 'high',
    ...overrides,
  };
}

function makeLevel(level: MaturityLevel, signals: SignalResult[]): LevelScore {
  return {
    level,
    name: `Level ${level}`,
    rawScore: 70,
    qualified: true,
    signals,
    signalsDetected: signals.filter(signal => signal.detected).length,
    signalsTotal: signals.length,
  };
}

function makeReport(signal: SignalResult, projectType: ProjectContext['projectType'] = 'monorepo'): ReadinessReport {
  return {
    projectName: 'appsec',
    scannedAt: new Date().toISOString(),
    primaryLevel: 2 as MaturityLevel,
    levelName: 'Level 2',
    depth: 60,
    overallScore: 45,
    levels: [
      makeLevel(1 as MaturityLevel, []),
      makeLevel(2 as MaturityLevel, []),
      makeLevel(3 as MaturityLevel, [signal]),
      makeLevel(4 as MaturityLevel, []),
      makeLevel(5 as MaturityLevel, []),
      makeLevel(6 as MaturityLevel, []),
    ],
    componentScores: [],
    languageScores: [],
    projectContext: {
      languages: ['TypeScript'],
      frameworks: [],
      projectType,
      packageManager: 'pnpm',
      directoryTree: '.',
      components: [],
    },
    selectedTool: 'copilot',
    modelUsed: 'test',
    scanMode: 'full',
  };
}

describe('GraphBuilder monorepo signal descriptions', () => {
  it('labels root-level monorepo signals as detected at root level', () => {
    const graph = new GraphBuilder().buildGraph(makeReport(
      makeSignal({ files: ['.github/agents/root.agent.md'] })
    ));

    const signalNode = graph.nodes.find(node => node.id === 'signal-copilot_agents');
    expect(signalNode?.description).toContain('Detected at root level');
  });

  it('labels nested monorepo signals as detected at sub-project level only', () => {
    const graph = new GraphBuilder().buildGraph(makeReport(
      makeSignal({ files: ['packages/api/.github/agents/api.agent.md'] })
    ));

    const signalNode = graph.nodes.find(node => node.id === 'signal-copilot_agents');
    expect(signalNode?.description).toContain('Detected at sub-project level only');
  });
});
