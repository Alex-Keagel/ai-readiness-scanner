import * as vscode from 'vscode';
import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';
import { InstructionProfile, CodebaseProfile, CoverageGap, DriftIssue, CrossRefResult, InstructionQuality } from './types';
import { GapRelevanceAgent } from './relevanceAgents';

export class CrossRefEngine {
  constructor(private copilotClient?: CopilotClient) {}

  async analyze(
    instructions: InstructionProfile,
    codebase: CodebaseProfile,
    workspaceUri: vscode.Uri
  ): Promise<CrossRefResult> {
    const timer = logger.time('CrossRefEngine');

    const rawGaps = this.findCoverageGaps(instructions, codebase);
    const driftIssues = await this.findDrift(instructions, codebase, workspaceUri);
    const instructionQuality = this.scoreQuality(instructions, codebase);

    // Filter gaps through relevance agent (static + LLM)
    const relevanceAgent = new GapRelevanceAgent(this.copilotClient);
    const coverageGaps = await relevanceAgent.filterGaps(rawGaps);
    logger.info(`CrossRefEngine: relevance filter ${rawGaps.length} → ${coverageGaps.length} gaps`);

    // Coverage: % of critical modules (core-logic + entry-point with >100 lines) mentioned
    const criticalModules = codebase.modules.filter(m =>
      (m.role === 'core-logic' || m.role === 'entry-point') && m.lines > 100
    );
    const mentionedPaths = instructions.coveredPaths;
    const coveredCount = criticalModules.filter(m =>
      mentionedPaths.has(m.path) ||
      [...mentionedPaths].some(p => m.path.includes(p) || p.includes(m.path.split('/').slice(0, -1).join('/')))
    ).length;
    const coveragePercent = criticalModules.length > 0 ? Math.round((coveredCount / criticalModules.length) * 100) : 100;

    logger.info(`CrossRefEngine: ${coverageGaps.length} gaps, ${driftIssues.length} drift issues, coverage ${coveragePercent}%, quality ${instructionQuality.overall}/100`);
    timer?.end?.();

    return { coverageGaps, driftIssues, instructionQuality, coveragePercent };
  }

  // ─── Coverage Gap Analysis (deterministic) ────────────────────────

  private findCoverageGaps(instructions: InstructionProfile, codebase: CodebaseProfile): CoverageGap[] {
    const gaps: CoverageGap[] = [];
    const mentionedPaths = instructions.coveredPaths;
    const mentionedWorkflows = new Set(instructions.coveredWorkflows.map(w => w.toLowerCase()));

    // 1. Critical modules not mentioned in any instruction file
    const criticalModules = codebase.modules.filter(m =>
      m.role !== 'test' && m.role !== 'type-def' && m.role !== 'config' &&
      (m.fanIn >= 2 || m.lines > 200 || m.role === 'entry-point')
    );

    for (const mod of criticalModules) {
      const dir = mod.path.split('/').slice(0, -1).join('/');
      const isMentioned = mentionedPaths.has(mod.path) ||
        mentionedPaths.has(dir) ||
        [...mentionedPaths].some(p => mod.path.includes(p) || p.includes(dir));

      if (!isMentioned) {
        const severity = mod.fanIn >= 5 || mod.role === 'entry-point' ? 'critical' :
          mod.fanIn >= 3 || mod.lines > 300 ? 'important' : 'suggestion';
        gaps.push({
          type: 'uncovered-module',
          severity,
          module: mod.path,
          evidence: `${mod.path} has ${mod.exportCount} exports, ${mod.fanIn} dependents, ${mod.lines} lines — but no instruction file mentions it. Agents will guess at its purpose.`,
          metrics: { fanIn: mod.fanIn, exports: mod.exportCount, lines: mod.lines, complexity: mod.complexity },
        });
      }
    }

    // 2. Directories with multiple modules but no coverage
    const dirModules = new Map<string, typeof criticalModules>();
    for (const mod of criticalModules) {
      const dir = mod.path.split('/').slice(0, -1).join('/');
      if (!dir) continue;
      const list = dirModules.get(dir) || [];
      list.push(mod);
      dirModules.set(dir, list);
    }

    for (const [dir, mods] of dirModules) {
      if (mods.length >= 3) {
        const anyMentioned = mods.some(m => [...mentionedPaths].some(p => m.path.includes(p)));
        if (!anyMentioned) {
          const totalExports = mods.reduce((s, m) => s + m.exportCount, 0);
          gaps.push({
            type: 'uncovered-module',
            severity: 'important',
            module: dir + '/',
            evidence: `Directory ${dir}/ has ${mods.length} modules with ${totalExports} total exports — no instruction covers this area.`,
            metrics: { exports: totalExports, lines: mods.reduce((s, m) => s + m.lines, 0) },
          });
        }
      }
    }

    // 3. Pipelines not covered by any workflow/skill
    for (const pipeline of codebase.pipelines) {
      const nameWords = pipeline.name.toLowerCase().split(/[_\-\s]+/);
      const hasCoverage = nameWords.some(w => mentionedWorkflows.has(w)) ||
        instructions.files.some(f => f.type === 'workflow' || f.type === 'skill');
      if (!hasCoverage) {
        gaps.push({
          type: 'uncovered-pipeline',
          severity: 'important',
          module: pipeline.entryPoint,
          evidence: `Pipeline "${pipeline.name}" (${pipeline.steps.length} steps: ${pipeline.steps.map(s => s.file).join(' → ')}) has no corresponding workflow or skill definition.`,
          metrics: {},
        });
      }
    }

    // 4. Hotspots without documentation
    for (const hotspot of codebase.hotspots) {
      const mod = codebase.modules.find(m => m.path === hotspot);
      if (mod && !mod.hasDocstring) {
        gaps.push({
          type: 'weak-description',
          severity: 'suggestion',
          module: hotspot,
          evidence: `${hotspot} is a hotspot (fan-in: ${mod.fanIn}, ${mod.lines} lines) but has no module-level docstring.`,
          metrics: { fanIn: mod.fanIn, lines: mod.lines },
        });
      }
    }

    // 5. Missing skills for key domains
    const skillFiles = instructions.files.filter(f => f.type === 'skill');
    const skillNames = new Set(skillFiles.map(f => f.path.split('/').slice(-2, -1)[0]));
    const coreWorkflows = ['build', 'test', 'deploy', 'lint', 'release'];
    for (const workflow of coreWorkflows) {
      if (!skillNames.has(workflow) && !mentionedWorkflows.has(workflow)) {
        gaps.push({
          type: 'missing-skill',
          severity: 'suggestion',
          module: workflow,
          evidence: `No skill defined for "${workflow}" — agents can't execute ${workflow} operations autonomously.`,
          metrics: {},
        });
      }
    }

    return gaps.sort((a, b) => {
      const sevOrder = { critical: 0, important: 1, suggestion: 2 };
      return sevOrder[a.severity] - sevOrder[b.severity];
    });
  }

  // ─── Drift Detection (deterministic + LLM) ────────────────────────

  private async findDrift(
    instructions: InstructionProfile,
    codebase: CodebaseProfile,
    workspaceUri: vscode.Uri
  ): Promise<DriftIssue[]> {
    const issues: DriftIssue[] = [];

    // 1. Path drift: instruction references paths that don't exist
    for (const claim of instructions.claims.filter(c => c.category === 'path-reference')) {
      const pathExists = codebase.modules.some(m => m.path.includes(claim.claim) || claim.claim.includes(m.path));
      if (!pathExists) {
        // Check if path exists at repo root
        let found = false;
        try {
          await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceUri, claim.claim));
          found = true;
        } catch { /* not at root */ }

        // Also check relative to the source file's directory (skills reference relative paths)
        if (!found && claim.sourceFile) {
          const sourceDir = claim.sourceFile.substring(0, claim.sourceFile.lastIndexOf('/'));
          if (sourceDir) {
            const resolvedPath = `${sourceDir}/${claim.claim}`;
            try {
              await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceUri, resolvedPath));
              found = true;
            } catch { /* not relative either */ }
          }
        }

        if (!found) {
          issues.push({
            type: 'path-drift',
            claim,
            reality: `Path "${claim.claim}" referenced in ${claim.sourceFile}:${claim.sourceLine} does not exist`,
            severity: 'important',
            file: claim.sourceFile,
          });
        }
      }
    }

    // 2. Structural drift: claims about module counts/structure that are wrong
    for (const claim of instructions.claims.filter(c => c.category === 'architecture')) {
      // Check if claim mentions specific module counts that are wrong
      const countMatch = claim.claim.match(/(\d+)\s+(?:file|module|component|service)/i);
      if (countMatch) {
        const claimed = parseInt(countMatch[1]);
        const actual = codebase.modules.filter(m => m.role !== 'test').length;
        if (Math.abs(claimed - actual) > actual * 0.3) {
          issues.push({
            type: 'structural-drift',
            claim,
            reality: `Claim says ${claimed} modules but codebase has ${actual}`,
            severity: 'important',
            file: claim.sourceFile,
          });
        }
      }
    }

    // 3. Semantic drift via LLM: check if key module descriptions match actual code
    if (this.copilotClient?.isAvailable() && codebase.hotspots.length > 0) {
      try {
        const llmDrift = await this.detectSemanticDrift(instructions, codebase, workspaceUri);
        issues.push(...llmDrift);
      } catch (err) {
        logger.debug('CrossRefEngine: semantic drift detection failed', err);
      }
    }

    return issues;
  }

  private async detectSemanticDrift(
    instructions: InstructionProfile,
    codebase: CodebaseProfile,
    workspaceUri: vscode.Uri
  ): Promise<DriftIssue[]> {
    // Pick top 3 hotspots and compare instruction claims vs actual code
    const hotspotModules = codebase.hotspots.slice(0, 3);
    const snippets: string[] = [];

    for (const path of hotspotModules) {
      try {
        const content = Buffer.from(
          await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspaceUri, path))
        ).toString('utf-8');
        // First 80 lines + exports
        const preview = content.split('\n').slice(0, 80).join('\n');
        snippets.push(`FILE: ${path}\n${preview}`);
      } catch { /* skip */ }
    }

    if (snippets.length === 0) return [];

    // What do instructions say about these files?
    const instructionMentions = instructions.claims
      .filter(c => hotspotModules.some(h => c.claim.includes(h) || h.includes(c.claim)))
      .map(c => `${c.sourceFile}: "${c.claim}"`)
      .join('\n');

    const prompt = `Compare what the instruction files claim about these code files vs what the code actually does. Find contradictions or outdated descriptions.

INSTRUCTION CLAIMS ABOUT THESE FILES:
${instructionMentions || '(No instructions mention these files)'}

ACTUAL CODE:
${snippets.join('\n\n---\n\n')}

Find specific contradictions, outdated information, or important aspects the instructions fail to mention.

Respond as JSON array:
[{"file":"path","issue":"specific contradiction or omission","severity":"critical|important|suggestion"}]`;

    const response = await this.copilotClient!.analyze(prompt, undefined, 60_000);
    const match = response.match(/\[[\s\S]*\]/);
    if (!match) return [];

    try {
      const parsed = JSON.parse(match[0]) as { file: string; issue: string; severity: string }[];
      return parsed.map(p => ({
        type: 'semantic-drift' as const,
        claim: { category: 'architecture' as const, claim: p.issue, sourceFile: p.file, sourceLine: 0, confidence: 0.7 },
        reality: p.issue,
        severity: (p.severity as 'critical' | 'important' | 'suggestion') || 'suggestion',
        file: p.file,
      }));
    } catch { return []; }
  }

  // ─── Quality Scoring ──────────────────────────────────────────────

  private scoreQuality(instructions: InstructionProfile, codebase: CodebaseProfile): InstructionQuality {
    const files = instructions.files;
    const claims = instructions.claims;

    // Specificity: ratio of path-reference claims + scoped instruction files to total content
    const pathClaims = claims.filter(c => c.category === 'path-reference').length;
    // Count scoped instruction files (with applyTo globs) as specificity signals
    const scopedFiles = files.filter(f => /(?:applyTo|paths|glob):\s*['"]?[^\s'"]+/i.test(f.content)).length;
    const totalLines = files.reduce((s, f) => s + f.content.split('\n').length, 0) || 1;
    const specificity = Math.min(100, Math.round(((pathClaims + scopedFiles * 10) / totalLines) * 500));

    // Accuracy: % of path references that exist in codebase (check modules + component dirs)
    const pathRefs = claims.filter(c => c.category === 'path-reference');
    const allKnownPaths = new Set([
      ...codebase.modules.map(m => m.path),
      ...((codebase as any).componentPaths || []),
    ]);
    const validPaths = pathRefs.filter(c =>
      [...allKnownPaths].some(p => p.includes(c.claim) || c.claim.includes(p))
    ).length;
    const accuracy = pathRefs.length > 0 ? Math.round((validPaths / pathRefs.length) * 100) : 50;

    // Coverage: % of critical modules mentioned OR covered by applyTo globs
    const criticalModules = codebase.modules.filter(m => m.role !== 'test' && m.role !== 'type-def' && m.lines > 100);
    const mentionedPaths = instructions.coveredPaths;

    // Also check applyTo glob patterns from instruction files
    const applyToGlobs: string[] = [];
    for (const f of files) {
      const match = f.content.match(/(?:applyTo|paths|glob):\s*['"]?([^'"\n]+)/i);
      if (match) applyToGlobs.push(match[1].trim());
    }

    const covered = criticalModules.filter(m => {
      // Direct mention
      if ([...mentionedPaths].some(p => m.path.includes(p))) return true;
      // Covered by applyTo glob
      for (const glob of applyToGlobs) {
        const patterns = glob.split(',').map(g => g.trim());
        for (const pattern of patterns) {
          // Extension-based glob: **/*.ext
          const extMatch = pattern.match(/\*\*\/\*\.(\w+)/);
          if (extMatch && m.path.endsWith(`.${extMatch[1]}`)) return true;
          // Directory glob: "detection/**" matches detection/adf/foo.json
          const dirPattern = pattern.replace(/\*\*.*$/, '').replace(/['"{}]/g, '');
          if (dirPattern && m.path.startsWith(dirPattern)) return true;
          // Simple wildcard: "src/*.py" → check prefix + extension
          const simpleMatch = pattern.match(/^([^*]+)\*\.(\w+)$/);
          if (simpleMatch && m.path.startsWith(simpleMatch[1]) && m.path.endsWith(`.${simpleMatch[2]}`)) return true;
        }
      }
      return false;
    }).length;
    const coverage = criticalModules.length > 0 ? Math.round((covered / criticalModules.length) * 100) : 0;

    // Freshness: penalize TODOs, FIXME, deprecated, placeholder text
    const allContent = files.map(f => f.content).join('\n');
    const staleMarkers = (allContent.match(/TODO|FIXME|DEPRECATED|placeholder|TBD|HACK/gi) || []).length;
    const freshness = Math.max(0, 100 - staleMarkers * 10);

    // Actionability: ratio of bullet points / short rules vs long prose
    const bulletLines = files.reduce((s, f) => s + (f.content.match(/^[-*]\s/gm) || []).length, 0);
    const actionability = Math.min(100, Math.round((bulletLines / totalLines) * 300));

    // Efficiency: tokens per meaningful claim (scoped files count as claims)
    const totalTokens = instructions.totalTokens || 1;
    const meaningfulClaims = claims.filter(c => c.confidence >= 0.7).length;
    // Scoped instruction files (with applyTo) are inherently efficient — count each as 5 claims
    const scopedFileCount = files.filter(f => /(?:applyTo|paths|glob):\s*['"]?[^\s'"]+/i.test(f.content)).length;
    const adjustedClaims = meaningfulClaims + scopedFileCount * 5;
    const tokensPerClaim = adjustedClaims > 0 ? totalTokens / adjustedClaims : totalTokens;
    const efficiency = Math.min(100, Math.max(0, Math.round(100 - (tokensPerClaim - 50) * 0.5)));

    const overall = Math.round(
      specificity * 0.15 + accuracy * 0.25 + coverage * 0.25 +
      freshness * 0.10 + actionability * 0.15 + efficiency * 0.10
    );

    return { specificity, accuracy, coverage, freshness, actionability, efficiency, overall };
  }
}
