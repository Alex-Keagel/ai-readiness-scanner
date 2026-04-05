import { AITool, ReadinessReport, SignalResult } from '../scoring/types';

type InstructionQualityLike = {
  overall?: number;
  accuracy?: number;
  coverage?: number;
};

type ReportWithDeepAnalysis = ReadinessReport & {
  deepAnalysis?: {
    instructionQuality?: InstructionQualityLike;
    coveragePercent?: number;
  };
};

type SyncProfile = {
  rootSignalIds: string[];
  scopedSignalIds: string[];
  l3SignalIds: string[];
  rootFiles: string[];
  scopedFilePrefixes: string[];
  l3FilePrefixes: string[];
};

const SYNC_PROFILES: Record<AITool, SyncProfile> = {
  copilot: {
    rootSignalIds: ['copilot_instructions', 'copilot_l2_instructions'],
    scopedSignalIds: ['copilot_domain_instructions'],
    l3SignalIds: ['copilot_agents', 'copilot_skills', 'copilot_l3_skills_and_tools', 'mcp_config'],
    rootFiles: ['.github/copilot-instructions.md'],
    scopedFilePrefixes: ['.github/instructions/'],
    l3FilePrefixes: ['.github/agents/', '.github/skills/', '.vscode/mcp.json', '.mcp.json'],
  },
  cline: {
    rootSignalIds: ['cline_rules', 'cline_l2_instructions'],
    scopedSignalIds: ['cline_domains'],
    l3SignalIds: ['safe_commands', 'tool_definitions', 'memory_bank', 'mcp_config', 'cline_l3_skills_and_tools'],
    rootFiles: ['.clinerules/default-rules.md'],
    scopedFilePrefixes: ['.clinerules/core/', '.clinerules/domains/'],
    l3FilePrefixes: ['.clinerules/tools/', '.clinerules/workflows/', '.clinerules/mcp-config/', 'memory-bank/'],
  },
  cursor: {
    rootSignalIds: ['cursor_rules', 'cursor_l2_instructions'],
    scopedSignalIds: [],
    l3SignalIds: ['mcp_config', 'cursor_l3_skills_and_tools'],
    rootFiles: ['.cursorrules'],
    scopedFilePrefixes: ['.cursor/rules/'],
    l3FilePrefixes: ['.cursor/mcp.json', '.vscode/mcp.json'],
  },
  claude: {
    rootSignalIds: ['claude_instructions', 'claude_l2_instructions'],
    scopedSignalIds: [],
    l3SignalIds: ['claude_l3_skills_and_tools'],
    rootFiles: ['CLAUDE.md', '.claude/CLAUDE.md'],
    scopedFilePrefixes: ['.claude/rules/'],
    l3FilePrefixes: [],
  },
  roo: {
    rootSignalIds: ['roo_modes', 'roo_l2_instructions'],
    scopedSignalIds: [],
    l3SignalIds: ['tool_definitions', 'agent_personas', 'roo_l3_skills_and_tools'],
    rootFiles: ['.roorules', '.roomodes'],
    scopedFilePrefixes: ['.roo/rules/'],
    l3FilePrefixes: ['.roo/rules-code/', '.roo/rules-architect/', '.roo/rules-debug/'],
  },
  windsurf: {
    rootSignalIds: ['windsurf_rules', 'windsurf_l2_instructions', 'agents_md'],
    scopedSignalIds: [],
    l3SignalIds: ['tool_definitions', 'windsurf_l3_skills_and_tools'],
    rootFiles: ['AGENTS.md'],
    scopedFilePrefixes: ['.windsurf/rules/'],
    l3FilePrefixes: ['.windsurf/skills/', '.windsurf/workflows/'],
  },
  aider: {
    rootSignalIds: ['aider_config', 'aider_l2_instructions'],
    scopedSignalIds: [],
    l3SignalIds: [],
    rootFiles: ['.aider.conf.yml'],
    scopedFilePrefixes: [],
    l3FilePrefixes: [],
  },
};

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function matchesSignal(signal: SignalResult, signalIds: string[], files: string[], prefixes: string[]): boolean {
  if (signalIds.includes(signal.signalId)) return true;
  return (signal.files || []).some(file =>
    files.includes(file) || prefixes.some(prefix => file.startsWith(prefix))
  );
}

function scoreBucket(signals: SignalResult[], signalIds: string[], files: string[], prefixes: string[]): number {
  const bucketSignals = signals.filter(signal => matchesSignal(signal, signalIds, files, prefixes));
  if (bucketSignals.length > 0) {
    return clamp((bucketSignals.filter(signal => signal.detected).length / bucketSignals.length) * 100);
  }

  const hasMatchingFiles = signals.some(signal =>
    signal.detected && matchesSignal(signal, signalIds, files, prefixes)
  );
  return hasMatchingFiles ? 100 : 0;
}

export function calculateInstructionRealitySync(report: ReportWithDeepAnalysis): number {
  const tool = (report.selectedTool as AITool) || 'copilot';
  const profile = SYNC_PROFILES[tool] || SYNC_PROFILES.copilot;
  const allSignals = report.levels.flatMap(level => level.signals);

  const instructionSignals = allSignals.filter(signal =>
    matchesSignal(
      signal,
      [...profile.rootSignalIds, ...profile.scopedSignalIds, ...profile.l3SignalIds],
      [...profile.rootFiles],
      [...profile.scopedFilePrefixes, ...profile.l3FilePrefixes],
    ),
  );

  const rootInstructionScore = scoreBucket(instructionSignals, profile.rootSignalIds, profile.rootFiles, []);
  const scopedInstructionScore = scoreBucket(instructionSignals, profile.scopedSignalIds, [], profile.scopedFilePrefixes);
  const skillsAndToolsScore = scoreBucket(instructionSignals, profile.l3SignalIds, [], profile.l3FilePrefixes);

  const realityChecks = instructionSignals
    .flatMap(signal => signal.realityChecks || []);
  const pathAccuracyScore = realityChecks.length > 0
    ? clamp((realityChecks.filter(check => check.status === 'valid').length / realityChecks.length) * 100)
    : 0;

  const hasInstructionArtifacts = rootInstructionScore > 0 || scopedInstructionScore > 0 || skillsAndToolsScore > 0;

  if (!hasInstructionArtifacts) {
    // No AI instruction files — give minor credit for general documentation only
    const GENERAL_DOC_SIGNAL_IDS = ['project_structure_doc', 'conventions_documented'];
    const generalDocsDetected = allSignals.filter(
      s => GENERAL_DOC_SIGNAL_IDS.includes(s.signalId) && s.detected
    ).length;
    return Math.min(generalDocsDetected * 10, 20);
  }

  const hasRootInstruction = rootInstructionScore > 0;
  const depthScore = clamp(scopedInstructionScore * 0.5 + skillsAndToolsScore * 0.5);

  // Gated structural score: root instruction existence is a prerequisite for high scores.
  // With root: 30pt base + 40pt max path accuracy + 35pt max depth (capped at 100)
  // Without root: capped at 35 — skills/agents alone can't compensate for missing core file
  let structuralScore: number;
  if (hasRootInstruction) {
    structuralScore = clamp(30 + pathAccuracyScore * 0.40 + depthScore * 0.35);
  } else {
    structuralScore = Math.min(clamp(depthScore * 0.30 + pathAccuracyScore * 0.10), 35);
  }

  const instructionQuality = report.deepAnalysis?.instructionQuality;
  if (!instructionQuality) {
    return structuralScore;
  }

  const deepOverall = clamp(instructionQuality.overall ?? 0);
  const deepAccuracy = clamp(instructionQuality.accuracy ?? deepOverall);
  const deepCoverage = clamp(instructionQuality.coverage ?? report.deepAnalysis?.coveragePercent ?? 0);
  const deepScore = clamp(deepOverall * 0.7 + deepAccuracy * 0.15 + deepCoverage * 0.15);

  const blendedScore = clamp(structuralScore * 0.55 + deepScore * 0.45);
  return hasRootInstruction ? blendedScore : Math.min(blendedScore, 35);
}
