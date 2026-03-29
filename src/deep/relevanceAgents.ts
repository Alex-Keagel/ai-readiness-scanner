import * as vscode from 'vscode';
import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';
import { CoverageGap, ModuleProfile } from './types';

// ─── Static exclusion patterns ──────────────────────────────────

const EXCLUDED_PATH_PATTERNS = [
  /[/\\]\.venv[/\\]/i,
  /[/\\]venv[/\\]/i,
  /[/\\]\.idea[/\\]/i,
  /[/\\]\.vs[/\\]/i,
  /[/\\]\.settings[/\\]/i,
  /[/\\]\.eclipse[/\\]/i,
  /[/\\]\.history[/\\]/i,
  /[/\\]node_modules[/\\]/i,
  /[/\\]__pycache__[/\\]/i,
  /[/\\]\.git[/\\]/i,
  /[/\\]\.tox[/\\]/i,
  /[/\\]\.mypy_cache[/\\]/i,
  /[/\\]\.pytest_cache[/\\]/i,
  /[/\\]\.ruff_cache[/\\]/i,
  /[/\\]dist[/\\]/i,
  /[/\\]build[/\\]/i,
  /[/\\]coverage[/\\]/i,
  /[/\\]\.next[/\\]/i,
  /[/\\]\.nuxt[/\\]/i,
  /\.egg-info[/\\]/i,
];

// ─── Agent 1: Exclusion Classifier ──────────────────────────────

export class ExclusionClassifierAgent {
  constructor(private copilotClient?: CopilotClient) {}

  /** Classify directories as exclude/include/low-priority using static patterns + LLM */
  async classify(
    directories: string[],
    workspaceName: string
  ): Promise<Map<string, 'exclude' | 'include' | 'low-priority'>> {
    const result = new Map<string, 'exclude' | 'include' | 'low-priority'>();

    // Phase 1: Static pattern matching
    for (const dir of directories) {
      if (EXCLUDED_PATH_PATTERNS.some(p => p.test(`/${dir}/`))) {
        result.set(dir, 'exclude');
      }
    }

    // Phase 2: LLM classification for remaining ambiguous directories
    const unclassified = directories.filter(d => !result.has(d));
    if (unclassified.length === 0 || !this.copilotClient?.isAvailable()) {
      for (const d of unclassified) result.set(d, 'include');
      return result;
    }

    try {
      const prompt = `You are a senior DevOps engineer classifying directories in "${workspaceName}".

For each directory, classify as:
- "exclude": third-party deps, vendored code, IDE artifacts, build output, generated code, cache dirs
- "low-priority": test utilities, fixtures, sample data, legacy/deprecated code, migration scripts
- "include": production source code, configuration, documentation, CI/CD, infrastructure

DIRECTORIES:
${unclassified.map(d => `- ${d}`).join('\n')}

Respond ONLY as JSON:
[{"dir": "path", "classification": "exclude|include|low-priority", "reason": "brief reason"}]`;

      const response = await this.copilotClient.analyzeFast(prompt);
      const match = response.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]) as { dir: string; classification: string; reason: string }[];
        for (const p of parsed) {
          const cls = p.classification as 'exclude' | 'include' | 'low-priority';
          if (['exclude', 'include', 'low-priority'].includes(cls)) {
            result.set(p.dir, cls);
          }
        }
      }
    } catch (err) {
      logger.debug('ExclusionClassifier: LLM classification failed', err);
    }

    // Default remaining to include
    for (const d of unclassified) {
      if (!result.has(d)) result.set(d, 'include');
    }

    return result;
  }

  /** Quick check if a path should be statically excluded */
  static isExcluded(path: string): boolean {
    return EXCLUDED_PATH_PATTERNS.some(p => p.test(`/${path}/`));
  }
}

// ─── Agent 2: Test Classification ───────────────────────────────

export class TestClassificationAgent {
  constructor(private copilotClient?: CopilotClient) {}

  /** Classify ambiguous files as test/test-utility/production */
  async classify(
    modules: ModuleProfile[]
  ): Promise<Map<string, 'test' | 'test-utility' | 'production'>> {
    const result = new Map<string, 'test' | 'test-utility' | 'production'>();

    // Phase 1: Static pattern matching
    for (const mod of modules) {
      const path = mod.path;
      const fileName = path.split('/').pop() || '';

      const isInTestDir = path.includes('/tests/') || path.includes('/test/') ||
        path.startsWith('tests/') || path.startsWith('test/') ||
        path.includes('__tests__/');

      // Definite test files
      if (
        path.includes('.test.') || path.includes('.spec.') ||
        isInTestDir ||
        fileName.startsWith('test_') ||
        fileName === 'conftest.py' ||
        fileName.endsWith('.test.ts') || fileName.endsWith('.spec.ts') ||
        fileName.endsWith('_test.go') || fileName.endsWith('_test.py')
      ) {
        // Check if it's a test utility rather than a test case
        const dirName = path.split('/').slice(-2, -1)[0] || '';
        if (
          isInTestDir &&
          !fileName.startsWith('test_') && !fileName.includes('.test.') && !fileName.includes('.spec.') &&
          !fileName.endsWith('_test.go') && !fileName.endsWith('_test.py') &&
          (fileName.includes('util') || fileName.includes('helper') ||
           fileName.includes('fixture') || fileName.includes('mock') ||
           fileName.includes('factory') || fileName === '__init__.py' ||
           fileName.includes('data_generation') || fileName.includes('conftest') ||
           dirName === 'utils' || dirName === 'helpers' || dirName === 'fixtures' ||
           dirName === 'mocks' || dirName === 'factories' || dirName === 'test_utils' ||
           dirName === 'testdata' || dirName === 'testutil')
        ) {
          result.set(path, 'test-utility');
        } else {
          result.set(path, 'test');
        }
        continue;
      }

      result.set(path, 'production');
    }

    // Phase 2: LLM for ambiguous cases
    const ambiguous = modules.filter(m => {
      const cls = result.get(m.path);
      return cls === 'production' && (
        m.path.includes('test') || m.path.includes('mock') ||
        m.path.includes('fixture') || m.path.includes('stub')
      );
    });

    if (ambiguous.length > 0 && this.copilotClient?.isAvailable()) {
      try {
        const batch = ambiguous.slice(0, 20).map(m => m.path).join('\n');
        const prompt = `Classify these files as "test", "test-utility", or "production":

${batch}

Respond ONLY as JSON: [{"path": "...", "classification": "test|test-utility|production"}]`;

        const response = await this.copilotClient.analyzeFast(prompt);
        const match = response.match(/\[[\s\S]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]) as { path: string; classification: string }[];
          for (const p of parsed) {
            if (['test', 'test-utility', 'production'].includes(p.classification)) {
              result.set(p.path, p.classification as any);
            }
          }
        }
      } catch { /* use static classification */ }
    }

    return result;
  }
}

// ─── Agent 3: Gap Relevance ─────────────────────────────────────

export class GapRelevanceAgent {
  constructor(private copilotClient?: CopilotClient) {}

  /** Filter coverage gaps by relevance — remove implementation details agents don't need */
  async filterGaps(gaps: CoverageGap[]): Promise<CoverageGap[]> {
    if (gaps.length === 0) return gaps;

    // Phase 1: Static filtering
    const filtered = gaps.filter(gap => {
      // Exclude gaps for excluded paths
      if (ExclusionClassifierAgent.isExcluded(gap.module)) return false;

      // Exclude gaps for test files
      const fileName = gap.module.split('/').pop() || '';
      if (fileName.startsWith('test_') || fileName === 'conftest.py') return false;
      if (gap.module.includes('/tests/') && gap.type === 'uncovered-module') return false;

      // Exclude __init__.py barrel files (low value for agent instructions)
      if (fileName === '__init__.py' && gap.metrics.lines && gap.metrics.lines < 20) return false;

      return true;
    });

    // Phase 2: Collapse per-file gaps into per-directory gaps
    const collapsed = this.collapseGaps(filtered);

    // Phase 3: LLM relevance scoring for remaining gaps
    if (collapsed.length > 10 && this.copilotClient?.isAvailable()) {
      try {
        const gapSummary = collapsed.slice(0, 25).map(g =>
          `${g.module} (${g.type}, ${g.severity}): ${g.evidence.slice(0, 100)}`
        ).join('\n');

        const prompt = `You are an AI readiness strategist. Rate which of these coverage gaps actually matter for AI coding agents.

GAPS:
${gapSummary}

Remove gaps that are:
- Internal implementation details agents don't need to know
- Auto-generated or boilerplate code
- Configuration files agents should never modify
- Barrel/index files with no logic

Return ONLY the indices (0-based) of gaps to KEEP:
{"keep": [0, 2, 5, ...], "remove_reasons": {"1": "reason", "3": "reason"}}`;

        const response = await this.copilotClient.analyzeFast(prompt);
        const match = response.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as { keep: number[] };
          if (Array.isArray(parsed.keep) && parsed.keep.length > 0) {
            const keepSet = new Set(parsed.keep);
            return collapsed.filter((_, i) => i >= 25 || keepSet.has(i));
          }
        }
      } catch { /* use static filtering only */ }
    }

    return collapsed;
  }

  /** Collapse 3+ per-file gaps in the same directory into a single directory gap */
  private collapseGaps(gaps: CoverageGap[]): CoverageGap[] {
    // Group file-level gaps by parent directory
    const dirGroups = new Map<string, CoverageGap[]>();
    const nonFileGaps: CoverageGap[] = [];

    for (const gap of gaps) {
      if (gap.type !== 'uncovered-module' || gap.module.endsWith('/')) {
        nonFileGaps.push(gap);
        continue;
      }
      const dir = gap.module.split('/').slice(0, -1).join('/');
      if (!dir) {
        nonFileGaps.push(gap);
        continue;
      }
      const group = dirGroups.get(dir) || [];
      group.push(gap);
      dirGroups.set(dir, group);
    }

    const result = [...nonFileGaps];
    for (const [dir, fileGaps] of dirGroups) {
      if (fileGaps.length >= 3) {
        // Collapse into directory-level gap
        const totalLines = fileGaps.reduce((s, g) => s + (g.metrics.lines || 0), 0);
        const totalExports = fileGaps.reduce((s, g) => s + (g.metrics.exports || 0), 0);
        const worstSeverity = fileGaps.some(g => g.severity === 'critical') ? 'critical' :
          fileGaps.some(g => g.severity === 'important') ? 'important' : 'suggestion';

        result.push({
          type: 'uncovered-module',
          severity: worstSeverity as CoverageGap['severity'],
          module: dir + '/',
          evidence: `Directory ${dir}/ has ${fileGaps.length} modules (${totalLines} lines, ${totalExports} exports) with no instruction coverage. Files: ${fileGaps.map(g => g.module.split('/').pop()).join(', ')}`,
          metrics: { lines: totalLines, exports: totalExports },
        });
      } else {
        result.push(...fileGaps);
      }
    }

    return result;
  }
}

// ─── Agent 4: Recommendation Validator ──────────────────────────

export class RecommendationValidatorAgent {
  constructor(private copilotClient?: CopilotClient) {}

  /** Cross-check other agents' decisions for false negatives */
  async validate(
    excluded: Map<string, 'exclude' | 'include' | 'low-priority'>,
    testClassifications: Map<string, 'test' | 'test-utility' | 'production'>,
    filteredGaps: CoverageGap[],
    originalGapCount: number
  ): Promise<{ adjustments: string[]; warnings: string[] }> {
    const adjustments: string[] = [];
    const warnings: string[] = [];

    // Deterministic checks
    const excludedCount = [...excluded.values()].filter(v => v === 'exclude').length;
    const excludeRate = excluded.size > 0 ? excludedCount / excluded.size : 0;

    if (excludeRate > 0.6) {
      warnings.push(`Exclusion rate is ${Math.round(excludeRate * 100)}% — verify the classifier isn't being too aggressive`);
    }

    const filterRate = originalGapCount > 0 ? 1 - (filteredGaps.length / originalGapCount) : 0;
    if (filterRate > 0.8) {
      warnings.push(`Gap filter removed ${Math.round(filterRate * 100)}% of gaps — some may have been valid`);
    }

    // LLM consistency check
    if (this.copilotClient?.isAvailable() && (warnings.length > 0 || excludedCount > 5)) {
      try {
        const excludedDirs = [...excluded.entries()]
          .filter(([, v]) => v === 'exclude')
          .map(([k]) => k)
          .slice(0, 15);

        const prompt = `Quick validation: these directories were classified as "exclude" (not project code). Flag any that look like they SHOULD be included:

${excludedDirs.join('\n')}

Respond ONLY as JSON: {"false_negatives": ["dir1", "dir2"], "all_correct": true|false}`;

        const response = await this.copilotClient.analyzeFast(prompt);
        const match = response.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as { false_negatives: string[]; all_correct: boolean };
          if (parsed.false_negatives?.length > 0) {
            for (const fn of parsed.false_negatives) {
              adjustments.push(`Re-include "${fn}" — validator flagged it as a false negative`);
              excluded.set(fn, 'include');
            }
          }
        }
      } catch { /* validator failed — use unadjusted results */ }
    }

    logger.info(`RecommendationValidator: ${adjustments.length} adjustments, ${warnings.length} warnings`);
    return { adjustments, warnings };
  }
}
