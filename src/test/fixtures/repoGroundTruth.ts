/**
 * Ground truth test fixtures for real repositories.
 *
 * These values were captured directly from the filesystem on 2025-04-06
 * and should be kept in sync as the repos evolve.
 */

// ── Interface ────────────────────────────────────────────────────
export interface RepoGroundTruth {
  name: string;

  // Filesystem facts
  hasRootCopilotInstructions: boolean;
  rootCopilotInstructionsBytes?: number;
  hasRootGithubDir: boolean;
  instructionFileCount: number;
  agentFileCount: number;
  skillFileCount: number;
  projectType: 'monorepo' | 'app' | 'library' | 'service' | 'unknown';
  primaryLanguage: string;
  languages: string[];
  subProjectPaths: string[];

  // Expected score ranges
  expectedLevel: { min: number; max: number };
  expectedTypeStrictness: { min: number; max: number };
  expectedSemanticDensity: { min: number; max: number };
  expectedIQSync: { min: number; max: number };

  // Narrative assertions
  narrativeShouldNotContain: string[];
  narrativeShouldContain: string[];

  // Component assertions
  expectedComponentCountRange: { min: number; max: number };
  knownComponents: { path: string; expectedMinLevel: number }[];
}

// ── DataPipelines ────────────────────────────────────────────────
// Python-heavy data-engineering repo.
// Has root copilot-instructions (3116 B), 6 instruction files, 1 skill,
// 0 agents.  270 .py files, ~0 with type hints in a quick sample.
export const DATA_PIPELINES: RepoGroundTruth = {
  name: 'AzNet-ApplicationSecurity-DataPipelines',

  hasRootCopilotInstructions: true,
  rootCopilotInstructionsBytes: 3116,
  hasRootGithubDir: true,
  instructionFileCount: 6,
  agentFileCount: 0,
  skillFileCount: 1,
  projectType: 'monorepo',
  primaryLanguage: 'python',
  languages: ['python', 'kql', 'json', 'markdown'],
  subProjectPaths: [
    'KustoFunctions',
    'azure-attack-paths-demo',
    'ci',
    'dashboards',
    'data-pipelines-mapping',
    'detection',
    'python-workspace',
    'scripts',
    'vscode',
  ],

  expectedLevel: { min: 2, max: 3 },
  expectedTypeStrictness: { min: 10, max: 40 },
  expectedSemanticDensity: { min: 20, max: 75 },
  expectedIQSync: { min: 30, max: 75 },

  narrativeShouldNotContain: [
    'absence of root copilot-instructions',
    'missing copilot-instructions',
    'no copilot-instructions',
    'lacks a root copilot-instructions',
  ],
  narrativeShouldContain: [],

  expectedComponentCountRange: { min: 3, max: 12 },
  knownComponents: [
    { path: 'python-workspace', expectedMinLevel: 1 },
    { path: 'KustoFunctions', expectedMinLevel: 1 },
    { path: 'scripts', expectedMinLevel: 1 },
  ],
};

// ── ZTS ──────────────────────────────────────────────────────────
// Large C# service repo.  82 csproj files, Directory.Build.props with
// Nullable=enable, Features=strict, TreatWarningsAsErrors=true.
// NO root copilot-instructions.  1 agent, 7 skill dirs (19 .md files).
export const ZTS: RepoGroundTruth = {
  name: 'ZTS',

  hasRootCopilotInstructions: false,
  hasRootGithubDir: true,
  instructionFileCount: 0,
  agentFileCount: 1,
  skillFileCount: 7,
  projectType: 'service',
  primaryLanguage: 'csharp',
  languages: ['csharp', 'python', 'bicep', 'powershell', 'json'],
  subProjectPaths: [
    'apispec',
    'deploy',
    'docs',
    'infrastructure',
    'misc',
    'scripts',
    'src',
  ],

  expectedLevel: { min: 1, max: 3 },
  expectedTypeStrictness: { min: 80, max: 95 },
  expectedSemanticDensity: { min: 30, max: 75 },
  expectedIQSync: { min: 0, max: 35 },

  narrativeShouldNotContain: [],
  narrativeShouldContain: [],

  expectedComponentCountRange: { min: 3, max: 20 },
  knownComponents: [
    { path: 'src', expectedMinLevel: 1 },
    { path: 'deploy', expectedMinLevel: 1 },
  ],
};

// ── AppSec ───────────────────────────────────────────────────────
// Monorepo of loosely-related sub-projects.  No root .github dir at all.
// Two sub-projects have their own copilot-instructions:
//   risk-register/.github/copilot-instructions.md
//   ai-readiness-scanner-vs-code-extension/.github/copilot-instructions.md
export const APP_SEC: RepoGroundTruth = {
  name: 'AzNet-Application-Security',

  hasRootCopilotInstructions: false,
  hasRootGithubDir: false,
  instructionFileCount: 0,
  agentFileCount: 0,
  skillFileCount: 0,
  projectType: 'monorepo',
  primaryLanguage: 'typescript',
  languages: ['typescript', 'markdown', 'bicep', 'yaml', 'python', 'shell', 'go'],
  subProjectPaths: [
    'CRStoXMLConverter',
    'agc-setup',
    'ai-readiness-scanner-vs-code-extension',
    'appgw-quick-test',
    'benchmark-automation',
    'cline-compliance',
    'lrt',
    'risk-register',
    'slices',
    'waf-evaluation',
  ],

  expectedLevel: { min: 1, max: 2 },
  expectedTypeStrictness: { min: 30, max: 70 },
  expectedSemanticDensity: { min: 15, max: 60 },
  expectedIQSync: { min: 0, max: 35 },

  narrativeShouldNotContain: [],
  narrativeShouldContain: [],

  expectedComponentCountRange: { min: 4, max: 15 },
  knownComponents: [
    { path: 'risk-register', expectedMinLevel: 2 },
    { path: 'ai-readiness-scanner-vs-code-extension', expectedMinLevel: 2 },
    { path: 'waf-evaluation', expectedMinLevel: 1 },
  ],
};

// ── All repos for iteration ──────────────────────────────────────
export const ALL_REPOS: RepoGroundTruth[] = [DATA_PIPELINES, ZTS, APP_SEC];
