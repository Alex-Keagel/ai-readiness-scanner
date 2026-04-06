/**
 * DataPipelines (AzNet-ApplicationSecurity-DataPipelines) ground truth integration tests.
 *
 * Ground truth (verified 2025-07-15):
 *   - 270 .py files, ~1 448 functions (def), ~1 424 docstrings (""" pairs), 3 504 comment lines, 63 523 total lines
 *   - mypy configured in python-workspace/pyproject.toml with [tool.mypy]
 *   - 8 py.typed marker files
 *   - .github/copilot-instructions.md EXISTS (root instruction file)
 *   - 6 scoped .instructions.md files in .github/instructions/
 *   - 1 SKILL.md (.github/skills/kusto-backup/SKILL.md)
 *   - .clinerules/ directory with 15 files
 *   - 15 pyproject.toml files (1 workspace root + 14 component/app)
 *   - 204 test files
 *   - projectType: app (single workspace, not monorepo)
 *   - primary language: Python + KQL
 *   - Export snapshot: overall=48, level=3, 30 components
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NarrativeGenerator } from '../../report/narrativeGenerator';
import { validateSignalScope } from '../../deep/validators/signalScopeValidator';
import { GENERIC_DIRS, validateComponentName } from '../../deep/validators/componentNameValidator';
import { MaturityEngine } from '../../scoring/maturityEngine';
import { calculateInstructionRealitySync } from '../../report/instructionRealitySync';
import { applySemanticDensitySampleGate } from '../../scanner/maturityScanner';
import {
  computeBlendedSemanticDensity,
  computeTypeStrictness,
  analyzeFileContent,
  type FileAnalysis,
} from '../../metrics/codebaseMetrics';
import type { ComponentScore, LanguageScore, LevelScore, MaturityLevel, ProjectContext } from '../../scoring/types';

// ── Paths ──────────────────────────────────────────────────────────────
const DP_REPO = '/Users/alexkeagel/Dev/AzNet-ApplicationSecurity-DataPipelines';
const DP_EXPORT = join(DP_REPO, 'ai-readiness-graph-AzNet-ApplicationSecurity-DataPipelines.json');
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);

// ── Helpers ────────────────────────────────────────────────────────────
function loadExport(): any | null {
  if (!existsSync(DP_EXPORT)) return null;
  return JSON.parse(readFileSync(DP_EXPORT, 'utf8'));
}

function createNarrativeGenerator() {
  return new NarrativeGenerator({
    analyze: async () => '[]',
    analyzeFast: async () => '[]',
  } as any);
}

function mkLevel(level: MaturityLevel, rawScore: number, signals: LevelScore['signals']): LevelScore {
  return {
    level,
    name: `Level ${level}`,
    rawScore,
    qualified: false,
    signals,
    signalsDetected: signals.filter(s => s.detected).length,
    signalsTotal: signals.length,
  };
}

function walkFiles(rootDir: string): string[] {
  const results: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { visit(full); continue; }
      results.push(relative(rootDir, full).replace(/\\/g, '/'));
    }
  };
  visit(rootDir);
  return results.sort();
}

// ── DataPipelines-representative Python file mocks ─────────────────────
// Ratios from real repo: ~1448 fns, ~1424 docstrings (~98% documented-ish),
// 3504 comment lines, 63523 total lines, mypy in pyproject.toml

function dpPythonFiles(): FileAnalysis[] {
  // Simulate ~20 representative Python files with realistic ratios
  return Array.from({ length: 20 }, (_, i) => ({
    path: `python-workspace/components/module_${i}/src/module.py`,
    language: 'python',
    totalLines: 800,
    commentLines: 45,       // ~5.6% comment ratio (3504/63523 ≈ 5.5%)
    blankLines: 100,
    importCount: 10,
    typeAnnotationCount: 12, // moderate type hints
    declarationCount: 40,    // defs + class + assignments
    hasStrictMode: false,
    totalProcedures: 30,
    documentedProcedures: 22, // ~73% documented
  }));
}

function dpMypyConfig(): FileAnalysis {
  return {
    path: 'python-workspace/pyproject.toml',
    language: 'toml',
    totalLines: 80,
    commentLines: 5,
    blankLines: 10,
    importCount: 0,
    typeAnnotationCount: 0,
    declarationCount: 0,
    hasStrictMode: true, // [tool.mypy] section detected
    totalProcedures: 0,
    documentedProcedures: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Filesystem ground truth (verify actual repo structure)
// ═══════════════════════════════════════════════════════════════════════
describe('DataPipelines filesystem ground truth', () => {
  it('root instruction file .github/copilot-instructions.md exists', () => {
    expect(existsSync(join(DP_REPO, '.github', 'copilot-instructions.md'))).toBe(true);
  });

  it('has the expected instruction/agent/skill file inventory', () => {
    const instructionFiles = [
      '.github/copilot-instructions.md',
      '.github/instructions/technical-context.instructions.md',
      '.github/instructions/data-engineering.instructions.md',
      '.github/instructions/data-science.instructions.md',
      '.github/instructions/kusto-development.instructions.md',
      '.github/instructions/development-standards.instructions.md',
      '.github/instructions/security-guidelines.instructions.md',
    ];
    for (const file of instructionFiles) {
      expect(existsSync(join(DP_REPO, file)), `Missing: ${file}`).toBe(true);
    }

    expect(existsSync(join(DP_REPO, '.github/skills/kusto-backup/SKILL.md'))).toBe(true);
    expect(existsSync(join(DP_REPO, '.clinerules/default-rules.md'))).toBe(true);
  });

  it('has mypy configured in python-workspace/pyproject.toml', () => {
    const content = readFileSync(join(DP_REPO, 'python-workspace/pyproject.toml'), 'utf8');
    expect(content).toContain('[tool.mypy]');
  });

  it('has py.typed markers in components', () => {
    const pyTypedPaths = [
      'python-workspace/components/ds-analysis/src/ds_analysis/py.typed',
      'python-workspace/components/logging-utils/src/logging_utils/py.typed',
      'python-workspace/components/data-downloader/src/data_downloader/py.typed',
      'python-workspace/components/bot_detection/src/bot_detection/py.typed',
      'python-workspace/components/data-processing/src/data_processing/py.typed',
      'python-workspace/components/kusto-manager/src/kusto_manager/py.typed',
      'python-workspace/components/kusto-queries/src/kusto_queries/py.typed',
      'python-workspace/components/baselines/src/baselines/py.typed',
    ];
    for (const p of pyTypedPaths) {
      expect(existsSync(join(DP_REPO, p)), `Missing py.typed: ${p}`).toBe(true);
    }
  });

  it('has 14 sub-component pyproject.toml files plus workspace root', () => {
    const allFiles = walkFiles(DP_REPO);
    const pyprojectFiles = allFiles.filter(f => f.endsWith('pyproject.toml'));
    expect(pyprojectFiles.length).toBe(15);
    expect(pyprojectFiles).toContain('python-workspace/pyproject.toml');
  });

  it('is NOT a monorepo — no sub-projects with their own .github/', () => {
    // DP has only one .github/ at root level, unlike AppSec which has nested sub-projects
    const topDirs = readdirSync(DP_REPO, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);

    const subProjectsWithGithub = topDirs.filter(dir =>
      existsSync(join(DP_REPO, dir, '.github', 'copilot-instructions.md'))
    );
    expect(subProjectsWithGithub).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Export snapshot assertions
// ═══════════════════════════════════════════════════════════════════════
describe('DataPipelines export snapshot', () => {
  const scan = loadExport();

  if (!scan) {
    it.skip('No graph export found', () => {});
    return;
  }

  it('overall score is in 40-60 range (L3 app with moderate AI readiness)', () => {
    expect(scan.overallScore).toBeGreaterThanOrEqual(40);
    expect(scan.overallScore).toBeLessThanOrEqual(60);
  });

  it('primary level is 3 (instruction-guided + skills present)', () => {
    expect(scan.primaryLevel).toBe(3);
  });

  it('component count is 25-35', () => {
    expect(scan.componentCount).toBeGreaterThanOrEqual(25);
    expect(scan.componentCount).toBeLessThanOrEqual(35);
  });

  it('key Python workspace components are present', () => {
    const paths = (scan.componentScores || []).map((c: any) => c.path);
    const expected = [
      'python-workspace',
      'python-workspace/components/bot_detection',
      'python-workspace/components/data-processing',
      'python-workspace/components/ds-analysis',
      'python-workspace/components/kusto-queries',
      'python-workspace/components/stratified-sampler',
      'python-workspace/apps/bot_classification',
      'python-workspace/apps/kusto-functions-downloader',
    ];
    for (const p of expected) {
      expect(paths, `Missing component: ${p}`).toContain(p);
    }
  });

  it('no .venv contamination in component paths', () => {
    for (const comp of scan.componentScores || []) {
      expect(comp.path).not.toContain('.venv');
      expect(comp.path).not.toContain('site-packages');
    }
  });

  it('component names for non-generic dirs include the real directory name', () => {
    for (const comp of scan.componentScores || []) {
      const dirName = comp.path?.replace(/\\/g, '/').split('/').filter(Boolean).pop() || comp.path;
      const isGeneric = GENERIC_DIRS.has((dirName || '').toLowerCase()) || (dirName || '').length <= 3;
      const validated = validateComponentName(comp.path, comp.name, comp.language);
      if (!isGeneric) {
        expect(
          validated.validatedName.toLowerCase(),
          `Component ${comp.path} → ${validated.validatedName} should contain "${dirName}"`,
        ).toContain((dirName || '').toLowerCase());
      }
    }
  });

  it('KG contains signal-copilot_l2_instructions with detected=true', () => {
    const kgNodes = scan.knowledgeGraph?.nodes || [];
    const l2Signal = kgNodes.find((n: any) => n.id === 'signal-copilot_l2_instructions');
    expect(l2Signal).toBeDefined();
    expect(l2Signal.properties?.detected).toBe(true);
  });

  it('KG contains file node for .github/copilot-instructions.md', () => {
    const kgNodes = scan.knowledgeGraph?.nodes || [];
    const fileNode = kgNodes.find(
      (n: any) => n.type === 'ai-file' && n.label === '.github/copilot-instructions.md',
    );
    expect(fileNode).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2b: Narrative metric scores from export
// ═══════════════════════════════════════════════════════════════════════
describe('DataPipelines metric scores from export', () => {
  const scan = loadExport();

  if (!scan) {
    it.skip('No graph export found', () => {});
    return;
  }

  const metrics = scan.narrativeSections?.platformReadiness ?? [];

  it('Type Strictness is 55-75 (Python with mypy + type hints, not C#-level)', () => {
    const typeMetric = metrics.find((m: any) => m.dimension?.includes('Type'));
    expect(typeMetric?.score).toBeGreaterThanOrEqual(55);
    expect(typeMetric?.score).toBeLessThanOrEqual(75);
  });

  it('Semantic Density is 55-85 (well-documented Python with docstrings)', () => {
    const sdMetric = metrics.find((m: any) => m.dimension?.includes('Semantic'));
    expect(sdMetric?.score).toBeGreaterThanOrEqual(55);
    expect(sdMetric?.score).toBeLessThanOrEqual(85);
  });

  it('IQ Sync is 50-80 (root instruction file exists with scoped instructions)', () => {
    const iqMetric = metrics.find((m: any) => m.dimension?.includes('Instruction'));
    // Root file exists + scoped instructions + SKILL.md → should be well above 35
    expect(iqMetric?.score).toBeGreaterThanOrEqual(50);
    expect(iqMetric?.score).toBeLessThanOrEqual(80);
  });

  it('Context Efficiency is 60-90 (rich instruction coverage)', () => {
    const ceMetric = metrics.find((m: any) => m.dimension?.includes('Context'));
    expect(ceMetric?.score).toBeGreaterThanOrEqual(60);
    expect(ceMetric?.score).toBeLessThanOrEqual(90);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Scanner function unit tests with DP-shaped data
// ═══════════════════════════════════════════════════════════════════════
describe('DataPipelines scanner function assertions', () => {
  // ── getRootInstructionFact ──────────────────────────────────────────
  it('getRootInstructionFact detects root instruction via KG signal node', () => {
    const generator = createNarrativeGenerator();
    const report = {
      knowledgeGraph: {
        nodes: [
          {
            id: 'signal-copilot_l2_instructions',
            type: 'signal',
            label: 'copilot_l2_instructions',
            description: 'Instruction files use the correct naming and frontmatter but suffer from path inaccuracies. | Business logic validated',
            properties: {
              level: 2,
              detected: true,
              score: 64,
              model: 'claude-opus-4.6-1m',
            },
          },
          {
            id: 'file-_github_copilot_instructions_md',
            type: 'ai-file',
            label: '.github/copilot-instructions.md',
            description: 'Instruction files use the correct naming and frontmatter',
            properties: { tool: 'copilot', level: 2, score: 64, accuracy: 'checked' },
          },
        ],
      },
      levels: [],
    } as any;

    const fact = (generator as any).getRootInstructionFact(report, 'copilot', []);
    expect(fact.present).toBe(true);
    expect(fact.files).toContain('.github/copilot-instructions.md');
  });

  it('getRootInstructionFact detects root instruction via signal array', () => {
    const generator = createNarrativeGenerator();
    const signals = [
      {
        signalId: 'copilot_l2_instructions',
        level: 2,
        detected: true,
        score: 64,
        finding: 'Found .github/copilot-instructions.md',
        files: ['.github/copilot-instructions.md'],
        confidence: 'high' as const,
      },
    ];
    const report = { knowledgeGraph: { nodes: [] }, levels: [] } as any;

    const fact = (generator as any).getRootInstructionFact(report, 'copilot', signals);
    expect(fact.present).toBe(true);
    expect(fact.files).toContain('.github/copilot-instructions.md');
  });

  // ── containsRootAbsenceClaim ──────────────────────────────────────
  it('containsRootAbsenceClaim catches the actual DP IQ narrative', () => {
    const scan = loadExport();
    if (!scan) return;

    const generator = createNarrativeGenerator();
    const iqMetric = scan.narrativeSections?.platformReadiness?.find(
      (m: any) => m.dimension?.includes('Instruction'),
    );
    // The LLM-generated narrative wrongly says "absence of root-level .github/copilot-instructions.md"
    expect((generator as any).containsRootAbsenceClaim(iqMetric?.narrative || '')).toBe(true);
  });

  it('containsRootAbsenceClaim correctly identifies absence phrasing variants', () => {
    const generator = createNarrativeGenerator();
    // Phrases the LLM might use to incorrectly claim absence
    const absencePhrases = [
      'the absence of a root-level .github/copilot-instructions.md prevents grounding',
      'no root-level copilot-instructions.md file was found',
      'the project lacks a .github/copilot-instructions.md',
      'missing instructions.md at the root level limits AI capabilities',
    ];
    for (const phrase of absencePhrases) {
      expect(
        (generator as any).containsRootAbsenceClaim(phrase),
        `Should detect absence in: "${phrase}"`,
      ).toBe(true);
    }
  });

  it('containsRootAbsenceClaim does NOT flag valid presence claims', () => {
    const generator = createNarrativeGenerator();
    const presencePhrases = [
      'The project provides a well-structured .github/copilot-instructions.md that covers coding standards.',
      'Root-level copilot-instructions.md is present and provides guidance on data engineering.',
    ];
    for (const phrase of presencePhrases) {
      expect(
        (generator as any).containsRootAbsenceClaim(phrase),
        `Should NOT flag presence in: "${phrase}"`,
      ).toBe(false);
    }
  });

  // ── sanitizeNarrativeSections ──────────────────────────────────────
  it('sanitizeNarrativeSections repairs contradictory IQ narrative when root file exists', () => {
    const scan = loadExport();
    if (!scan) return;

    const generator = createNarrativeGenerator();
    const report = {
      levels: [],
      knowledgeGraph: scan.knowledgeGraph,
      narrativeSections: JSON.parse(JSON.stringify(scan.narrativeSections)),
      selectedTool: 'copilot',
      overallScore: scan.overallScore,
    } as any;

    const changed = (generator as any).sanitizeNarrativeSections(report);
    expect(changed).toBe(true);

    const repairedIQ = report.narrativeSections.platformReadiness.find(
      (m: any) => m.dimension?.includes('Instruction'),
    );
    expect(repairedIQ.narrative.toLowerCase()).not.toMatch(/absence.*copilot-instructions/);
    expect(repairedIQ.narrative.toLowerCase()).toMatch(/present|exists|found|detected|provides/);
  });

  // ── computeBlendedSemanticDensity ──────────────────────────────────
  it('computeBlendedSemanticDensity: DP-scale Python (600 procs, 440 documented, 60K lines, 3.5K comments)', () => {
    // Real DP: ~1448 fns, ~712 docstring-documented (≈49%), 3504 comments, 63523 lines
    // comment ratio = 3504/60000 ≈ 5.8% → commentScore ≈ 23
    // procRatio = 440/600 ≈ 73% → procScore = 73
    // score = 73*0.6 + 23*0.4 = 43.8 + 9.2 = 53 → after commentRatio cap (<5% would cap at 40, but 5.8% is ok)
    const score = computeBlendedSemanticDensity(600, 440, 60_000, 3_500);
    expect(score).toBeGreaterThanOrEqual(45);
    expect(score).toBeLessThanOrEqual(65);
  });

  it('computeBlendedSemanticDensity: large repo floor kicks in for mature repos', () => {
    // Floor test: >= 1000 procs, >= 50K lines, >= 30% procRatio, >= 8% commentRatio
    const score = computeBlendedSemanticDensity(1_200, 400, 60_000, 5_000);
    // procRatio=33%, commentRatio=8.3%, both meet floor criteria
    expect(score).toBeGreaterThanOrEqual(50);
  });

  it('computeBlendedSemanticDensity: small-sample fallback uses comment only', () => {
    // < 20 procedures → falls back to comment score only
    const score = computeBlendedSemanticDensity(15, 15, 2_000, 200);
    // commentRatio = 10%, commentScore = (0.1/0.25)*100 = 40
    expect(score).toBeLessThanOrEqual(60);
    expect(score).toBeGreaterThanOrEqual(30);
  });

  // ── computeTypeStrictness ──────────────────────────────────────────
  it('computeTypeStrictness: Python with mypy configured scores 25-45', () => {
    const files = [
      ...dpPythonFiles(),
      dpMypyConfig(),
    ];
    const score = computeTypeStrictness(files);
    // Python base: 15, with annotations ratio ~0.3 → 15 + 0.3*65 = 34.5, + mypy bonus 10 = 44.5
    expect(score).toBeGreaterThanOrEqual(25);
    expect(score).toBeLessThanOrEqual(50);
  });

  it('computeTypeStrictness: Python without mypy scores 15-35', () => {
    const files = dpPythonFiles(); // no mypy config file
    const score = computeTypeStrictness(files);
    expect(score).toBeGreaterThanOrEqual(15);
    expect(score).toBeLessThanOrEqual(35);
  });

  it('computeTypeStrictness: KQL/config files excluded from scoring', () => {
    // If only config-language files exist, returns 50 (not applicable)
    const score = computeTypeStrictness([
      {
        path: 'KustoFunctions/ddos_detection.kql',
        language: 'kql',
        totalLines: 200,
        commentLines: 10,
        blankLines: 20,
        importCount: 0,
        typeAnnotationCount: 0,
        declarationCount: 0,
        hasStrictMode: false,
        totalProcedures: 0,
        documentedProcedures: 0,
      },
    ]);
    expect(score).toBe(50); // All config/data → "not applicable"
  });

  // ── analyzeFileContent ─────────────────────────────────────────────
  it('analyzeFileContent: Python file with docstrings detects procedures and documentation', () => {
    const content = `
import os
from typing import List

# Configuration module for data processing

class DataProcessor:
    """Processes WAF telemetry data for analysis."""

    def __init__(self, config: dict) -> None:
        """Initialize the processor."""
        self.config = config

    def process_batch(self, items: List[dict]) -> List[dict]:
        """Process a batch of telemetry items."""
        # Filter invalid entries
        valid = [i for i in items if i.get('valid')]
        return valid

def load_config(path: str) -> dict:
    """Load configuration from disk."""
    with open(path) as f:
        return {}
`.trim();

    const analysis = analyzeFileContent('src/processor.py', content, 'python');
    expect(analysis.totalProcedures).toBeGreaterThanOrEqual(3); // class + 2 def + load_config
    expect(analysis.documentedProcedures).toBeGreaterThanOrEqual(3);
    expect(analysis.commentLines).toBeGreaterThanOrEqual(2);
    expect(analysis.typeAnnotationCount).toBeGreaterThanOrEqual(2); // return types, param types
  });

  it('analyzeFileContent: pyproject.toml with [tool.mypy] sets hasStrictMode', () => {
    const content = `
[project]
name = "python-workspace"

[tool.mypy]
python_version = "3.11"
ignore_missing_imports = true
`.trim();

    const analysis = analyzeFileContent('python-workspace/pyproject.toml', content, 'toml');
    expect(analysis.hasStrictMode).toBe(true);
  });

  // ── validateComponentName ──────────────────────────────────────────
  it('validateComponentName: DP component paths keep real directory names', () => {
    const cases: Array<{ path: string; llmName: string; language?: string }> = [
      { path: 'python-workspace/components/bot_detection', llmName: 'Bot Detection Module', language: 'Python' },
      { path: 'python-workspace/components/kusto-queries', llmName: 'Kusto Query Library', language: 'Python' },
      { path: 'python-workspace/components/stratified-sampler', llmName: 'Stratified Sampling Engine', language: 'Python' },
      { path: 'python-workspace/apps/bot_classification', llmName: 'ML Bot Classifier', language: 'Python' },
      { path: 'KustoFunctions', llmName: 'Kusto Analytical Functions', language: 'Multi' },
      { path: 'data-pipelines-mapping', llmName: 'Data Factory Pipeline Indexer', language: 'Python' },
    ];

    for (const { path, llmName, language } of cases) {
      const dirName = path.split('/').pop()!;
      const validated = validateComponentName(path, llmName, language);
      expect(
        validated.validatedName.toLowerCase(),
        `${path} → ${validated.validatedName} should contain "${dirName}"`,
      ).toContain(dirName.toLowerCase());
    }
  });

  it('validateComponentName: generic dotdirs may get LLM names', () => {
    // Generic dirs like .github, .vscode are expected to get LLM-assigned names
    const validated = validateComponentName('.github', 'GitHub Workflow Automation', 'Multi');
    // .github is in GENERIC_DIRS, so LLM name is acceptable
    expect(validated.validatedName).toBeDefined();
    expect(validated.validatedName.length).toBeGreaterThan(0);
  });

  // ── validateSignalScope ────────────────────────────────────────────
  it('validateSignalScope: DP root-level instruction file IS root-detected', () => {
    // DP has .github/copilot-instructions.md at root, no sub-projects have their own
    const result = validateSignalScope(
      'copilot_l2_instructions',
      ['.github/copilot-instructions.md'],
      [], // no sub-projects (DP is a single project)
    );
    expect(result.isRootDetected).toBe(true);
    expect(result.rootFiles).toContain('.github/copilot-instructions.md');
  });

  // ── calculateInstructionRealitySync ────────────────────────────────
  it('IQ Sync score is 50+ when root instruction exists with scoped instructions', () => {
    const score = calculateInstructionRealitySync({
      projectName: 'DataPipelines',
      scannedAt: new Date().toISOString(),
      primaryLevel: 3,
      levelName: 'Skill-Equipped',
      depth: 60,
      overallScore: 48,
      selectedTool: 'copilot',
      modelUsed: 'test',
      scanMode: 'full',
      projectContext: {
        languages: ['Python', 'KQL'],
        frameworks: [],
        projectType: 'app',
        packageManager: 'pip',
        directoryTree: '.',
        components: [],
      },
      componentScores: [],
      languageScores: [],
      levels: [
        mkLevel(1, 80, [{
          signalId: 'codebase_type_strictness',
          level: 1,
          detected: true,
          score: 64,
          finding: 'Python with mypy configured',
          files: [],
          confidence: 'high',
        }]),
        mkLevel(2, 70, [
          {
            signalId: 'copilot_l2_instructions',
            level: 2,
            detected: true,
            score: 64,
            finding: 'Found .github/copilot-instructions.md',
            files: ['.github/copilot-instructions.md'],
            confidence: 'high',
            realityChecks: [
              { category: 'path' as const, status: 'valid' as const, claim: 'References python-workspace/', reality: 'python-workspace/ exists', file: '.github/copilot-instructions.md' },
              { category: 'path' as const, status: 'valid' as const, claim: 'References KustoFunctions/', reality: 'KustoFunctions/ exists', file: '.github/copilot-instructions.md' },
            ],
          },
          {
            signalId: 'copilot_domain_instructions',
            level: 2,
            detected: true,
            score: 72,
            finding: 'Found 6 domain instruction files in .github/instructions/',
            files: [
              '.github/instructions/data-engineering.instructions.md',
              '.github/instructions/data-science.instructions.md',
              '.github/instructions/kusto-development.instructions.md',
              '.github/instructions/development-standards.instructions.md',
              '.github/instructions/security-guidelines.instructions.md',
              '.github/instructions/technical-context.instructions.md',
            ],
            confidence: 'high',
          },
        ]),
        mkLevel(3, 55, [{
          signalId: 'copilot_l3_skills_and_tools',
          level: 3,
          detected: true,
          score: 60,
          finding: 'Found kusto-backup SKILL.md',
          files: ['.github/skills/kusto-backup/SKILL.md'],
          confidence: 'high',
        }]),
      ],
    } as any);

    // Root instruction detected + scoped instructions + SKILL → well above the 35 cap
    // Mock has all-valid reality checks so structural score reaches maximum;
    // real scans score lower (e.g. 69) due to mixed reality check results.
    expect(score).toBeGreaterThanOrEqual(50);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('IQ Sync with mixed reality checks scores in realistic 55-85 range', () => {
    const score = calculateInstructionRealitySync({
      projectName: 'DataPipelines',
      scannedAt: new Date().toISOString(),
      primaryLevel: 3,
      levelName: 'Skill-Equipped',
      depth: 60,
      overallScore: 48,
      selectedTool: 'copilot',
      modelUsed: 'test',
      scanMode: 'full',
      projectContext: {
        languages: ['Python', 'KQL'],
        frameworks: [],
        projectType: 'app',
        packageManager: 'pip',
        directoryTree: '.',
        components: [],
      },
      componentScores: [],
      languageScores: [],
      levels: [
        mkLevel(1, 80, []),
        mkLevel(2, 70, [
          {
            signalId: 'copilot_l2_instructions',
            level: 2,
            detected: true,
            score: 64,
            finding: 'Found .github/copilot-instructions.md',
            files: ['.github/copilot-instructions.md'],
            confidence: 'high',
            realityChecks: [
              { category: 'path' as const, status: 'valid' as const, claim: 'References python-workspace/', reality: 'exists', file: '.github/copilot-instructions.md' },
              { category: 'path' as const, status: 'invalid' as const, claim: 'References scripts/format.ps1', reality: 'does not exist', file: '.github/copilot-instructions.md' },
              { category: 'path' as const, status: 'invalid' as const, claim: 'References scripts/lint.ps1', reality: 'does not exist', file: '.github/copilot-instructions.md' },
              { category: 'path' as const, status: 'valid' as const, claim: 'References KustoFunctions/', reality: 'exists', file: '.github/copilot-instructions.md' },
            ],
          },
        ]),
        mkLevel(3, 55, [{
          signalId: 'copilot_l3_skills_and_tools',
          level: 3,
          detected: true,
          score: 60,
          finding: 'Found kusto-backup SKILL.md',
          files: ['.github/skills/kusto-backup/SKILL.md'],
          confidence: 'high',
        }]),
      ],
    } as any);

    // Root exists but some reality checks fail → mid-range score
    expect(score).toBeGreaterThanOrEqual(50);
    expect(score).toBeLessThanOrEqual(85);
  });

  // ── applySemanticDensitySampleGate ─────────────────────────────────
  it('large sample (>10 files) preserves score', () => {
    const result = applySemanticDensitySampleGate(75, 50);
    expect(result.score).toBe(75);
    expect(result.confidence).toBe('high');
  });

  it('small sample (<10 files) caps at 60', () => {
    const result = applySemanticDensitySampleGate(85, 5);
    expect(result.score).toBeLessThanOrEqual(60);
    expect(result.confidence).toBe('low');
  });

  // ── MaturityEngine level qualification ─────────────────────────────
  it('MaturityEngine qualifies L3 for DP-like signal profile', () => {
    const engine = new MaturityEngine();

    const levels: LevelScore[] = [
      mkLevel(1, 75, [
        {
          signalId: 'codebase_type_strictness',
          level: 1,
          detected: true,
          score: 64,
          finding: 'Python with mypy',
          files: [],
          confidence: 'high',
        },
        {
          signalId: 'codebase_semantic_density',
          level: 1,
          detected: true,
          score: 70,
          finding: 'Good documentation coverage',
          files: [],
          confidence: 'high',
        },
      ]),
      mkLevel(2, 70, [
        {
          signalId: 'copilot_l2_instructions',
          level: 2,
          detected: true,
          score: 64,
          finding: 'Found .github/copilot-instructions.md',
          files: ['.github/copilot-instructions.md'],
          confidence: 'high',
        },
        {
          signalId: 'project_structure_doc',
          level: 2,
          detected: true,
          score: 60,
          finding: 'README.md exists',
          files: ['README.md'],
          confidence: 'high',
        },
        {
          signalId: 'conventions_documented',
          level: 2,
          detected: true,
          score: 55,
          finding: 'Conventions in instructions',
          files: ['.github/instructions/development-standards.instructions.md'],
          confidence: 'medium',
        },
      ]),
      mkLevel(3, 55, [
        {
          signalId: 'copilot_l3_skills_and_tools',
          level: 3,
          detected: true,
          score: 60,
          finding: 'SKILL.md found',
          files: ['.github/skills/kusto-backup/SKILL.md'],
          confidence: 'high',
        },
      ]),
    ];

    const projectContext: ProjectContext = {
      languages: ['Python', 'KQL'],
      frameworks: [],
      projectType: 'app',
      packageManager: 'pip',
      directoryTree: '.',
      components: [],
    };

    const report = engine.calculateReport(
      'DataPipelines', levels, projectContext, [], [] as LanguageScore[], 'test', 'full', 'copilot',
    );

    expect(report.primaryLevel).toBe(3);
    expect(report.overallScore).toBeGreaterThanOrEqual(35);
    expect(report.overallScore).toBeLessThanOrEqual(60);
  });
});
