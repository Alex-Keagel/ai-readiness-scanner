import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';
import { AITool, AI_TOOLS } from '../scoring/types';
import { getPlatformExpertPrompt } from '../remediation/fixPrompts';
import { CrossRefResult, CoverageGap, DriftIssue, DeepRecommendation, CodebaseProfile, InstructionProfile } from './types';

export class RecommendationSynthesizer {
  constructor(private copilotClient: CopilotClient) {}

  async synthesize(
    crossRef: CrossRefResult,
    codebase: CodebaseProfile,
    instructions: InstructionProfile,
    tool: AITool
  ): Promise<DeepRecommendation[]> {
    const timer = logger.time('RecommendationSynthesizer');
    const recs: DeepRecommendation[] = [];

    // Phase 1: Deterministic recommendations from gaps (no LLM)
    recs.push(...this.gapsToRecommendations(crossRef, codebase, instructions, tool));

    // Phase 2: LLM enrichment — take top 8 recs, ask LLM for exact fix content
    if (this.copilotClient.isAvailable()) {
      try {
        await this.enrichWithLLM(recs.slice(0, 8), codebase, instructions, tool);
        // Validate enriched content
        await this.validateEnrichedContent(recs.filter(r => r.suggestedContent));
      } catch (err) {
        logger.debug('RecommendationSynthesizer: LLM enrichment failed', err);
      }
    }

    // Sort by impact
    recs.sort((a, b) => b.impactScore - a.impactScore);

    logger.info(`RecommendationSynthesizer: ${recs.length} deep recommendations`);
    timer?.end?.();
    return recs;
  }

  private gapsToRecommendations(
    crossRef: CrossRefResult,
    codebase: CodebaseProfile,
    instructions: InstructionProfile,
    tool: AITool
  ): DeepRecommendation[] {
    const recs: DeepRecommendation[] = [];
    const toolConfig = AI_TOOLS[tool];

    // Coverage gaps → specific recommendations
    for (const gap of crossRef.coverageGaps) {
      const rec = this.gapToRec(gap, codebase, tool);
      if (rec) recs.push(rec);
    }

    // Drift issues → fix recommendations
    for (const drift of crossRef.driftIssues) {
      recs.push(this.driftToRec(drift, tool));
    }

    // Quality-based recommendations
    const q = crossRef.instructionQuality;
    if (q.specificity < 40) {
      recs.push({
        id: 'quality-specificity',
        type: 'weak-description',
        severity: 'important',
        title: 'Instructions are too vague — add specific file paths and module names',
        description: `Your instruction files score ${q.specificity}/100 on specificity. They use general language instead of referencing actual file paths. Agents need concrete paths like \`src/scoring/maturityEngine.ts\` not "the scoring module".`,
        evidence: [`Specificity score: ${q.specificity}/100`, `Only ${instructions.claims.filter(c => c.category === 'path-reference').length} path references found`],
        targetFile: this.getMainInstructionFile(tool),
        impactScore: 70,
        affectedModules: [],
      });
    }

    if (q.coverage < 50) {
      const totalCritical = codebase.modules.filter(m => m.role === 'core-logic' && m.lines > 100).length;
      const uncoveredMods = codebase.modules
        .filter(m => m.role === 'core-logic' && m.lines > 100 && !instructions.coveredPaths.has(m.path))
        .slice(0, 5);
      const uncoveredCount = totalCritical - Math.round(totalCritical * q.coverage / 100);
      recs.push({
        id: 'quality-coverage',
        type: 'uncovered-module',
        severity: 'critical',
        title: `Instructions only cover ${q.coverage}% of critical modules`,
        description: `${uncoveredCount > 0 ? uncoveredCount : uncoveredMods.length} of ${totalCritical} critical modules have no instruction coverage. Agents will have no guidance for these areas and will hallucinate.`,
        evidence: uncoveredMods.map(m => `${m.path} (${m.lines} lines, ${m.fanIn} dependents, ${m.exportCount} exports)`),
        targetFile: this.getMainInstructionFile(tool),
        impactScore: 85,
        affectedModules: uncoveredMods.map(m => m.path),
      });
    }

    if (q.accuracy < 60) {
      const badPaths = instructions.claims
        .filter(c => c.category === 'path-reference')
        .filter(c => !codebase.modules.some(m => m.path.includes(c.claim)))
        .slice(0, 5);
      recs.push({
        id: 'quality-accuracy',
        type: 'stale-path',
        severity: 'critical',
        title: `${100 - q.accuracy}% of referenced paths don't exist — instructions are lying to the agent`,
        description: 'Your instruction files reference paths that do not exist in the repository. Agents will attempt to read/modify non-existent files.',
        evidence: badPaths.map(c => `"${c.claim}" referenced in ${c.sourceFile}:${c.sourceLine}`),
        targetFile: this.getMainInstructionFile(tool),
        impactScore: 90,
        affectedModules: badPaths.map(c => c.claim),
      });
    }

    return recs;
  }

  private gapToRec(gap: CoverageGap, codebase: CodebaseProfile, tool: AITool): DeepRecommendation | null {
    const mod = codebase.modules.find(m => m.path === gap.module);

    switch (gap.type) {
      case 'uncovered-module':
        return {
          id: `uncovered-${gap.module.replace(/[^a-z0-9]/gi, '_')}`,
          type: 'uncovered-module',
          severity: gap.severity,
          title: `Add ${gap.module} to instruction files`,
          description: gap.evidence,
          evidence: [
            gap.evidence,
            mod ? `Exports: ${mod.exports.slice(0, 5).join(', ')}` : '',
            mod ? `Role: ${mod.role}, Complexity: ${mod.complexity}` : '',
          ].filter(Boolean),
          targetFile: this.getMainInstructionFile(tool),
          impactScore: gap.severity === 'critical' ? 80 : gap.severity === 'important' ? 60 : 40,
          affectedModules: [gap.module],
        };

      case 'uncovered-pipeline':
        return {
          id: `pipeline-${gap.module.replace(/[^a-z0-9]/gi, '_')}`,
          type: 'uncovered-pipeline',
          severity: gap.severity,
          title: `Create workflow documentation for "${gap.module}" pipeline`,
          description: gap.evidence,
          evidence: [gap.evidence],
          targetFile: `.github/skills/${gap.module.split('/').pop()?.replace(/\.[^.]+$/, '')}/SKILL.md`,
          impactScore: 65,
          affectedModules: [gap.module],
        };

      case 'missing-skill':
        return {
          id: `skill-${gap.module}`,
          type: 'missing-skill',
          severity: gap.severity,
          title: `Create "${gap.module}" skill`,
          description: gap.evidence,
          evidence: [gap.evidence],
          targetFile: `.github/skills/${gap.module}/SKILL.md`,
          impactScore: 50,
          affectedModules: [],
        };

      case 'weak-description':
        return {
          id: `docstring-${gap.module.replace(/[^a-z0-9]/gi, '_')}`,
          type: 'weak-description',
          severity: gap.severity,
          title: `Add module docstring to ${gap.module}`,
          description: gap.evidence,
          evidence: [gap.evidence],
          targetFile: `${gap.module}.suggestions.md`,
          impactScore: 35,
          affectedModules: [gap.module],
        };

      default:
        return null;
    }
  }

  private driftToRec(drift: DriftIssue, tool: AITool): DeepRecommendation {
    return {
      id: `drift-${drift.file.replace(/[^a-z0-9]/gi, '_')}-${drift.type}`,
      type: drift.type === 'path-drift' ? 'stale-path' : drift.type === 'structural-drift' ? 'structural-drift' : 'semantic-drift',
      severity: drift.severity,
      title: drift.type === 'path-drift'
        ? `Fix stale path reference in ${drift.file}`
        : drift.type === 'structural-drift'
          ? `Update outdated architecture claim in ${drift.file}`
          : `Fix semantic mismatch in ${drift.file}`,
      description: drift.reality,
      evidence: [`Claim: "${drift.claim.claim}" in ${drift.claim.sourceFile}:${drift.claim.sourceLine}`, `Reality: ${drift.reality}`],
      targetFile: drift.file,
      impactScore: drift.severity === 'critical' ? 85 : 60,
      affectedModules: [drift.file],
    };
  }

  private async enrichWithLLM(
    recs: DeepRecommendation[],
    codebase: CodebaseProfile,
    instructions: InstructionProfile,
    tool: AITool
  ): Promise<void> {
    if (recs.length === 0) return;

    const expertPrompt = getPlatformExpertPrompt(tool);
    const toolConfig = AI_TOOLS[tool];

    // Build context for LLM
    const existingInstructions = instructions.files
      .slice(0, 3)
      .map(f => `${f.path}:\n${f.content.slice(0, 1500)}`)
      .join('\n---\n');

    const moduleList = codebase.modules
      .filter(m => m.role !== 'test' && m.role !== 'type-def')
      .sort((a, b) => b.fanIn - a.fanIn)
      .slice(0, 20)
      .map(m => `${m.path} (${m.role}, ${m.lines}L, ${m.exportCount} exports, fan-in:${m.fanIn})`)
      .join('\n');

    const gapSummary = recs.map((r, i) => `${i + 1}. [${r.severity}] ${r.title}\n   Evidence: ${r.evidence[0]}`).join('\n');

    const prompt = `${expertPrompt}

You are generating specific, evidence-backed recommendations for improving AI agent readiness.

EXISTING INSTRUCTION FILES:
${existingInstructions}

ACTUAL CODEBASE MODULES:
${moduleList}

PIPELINES: ${codebase.pipelines.map(p => `${p.name}: ${p.steps.map(s => s.file).join(' → ')}`).join('; ')}

GAPS FOUND:
${gapSummary}

For each gap, write the EXACT text that should be added to the instruction file. Be specific — reference real file paths, real function names, real module purposes. Do not write generic advice.

Respond as JSON array:
[{"gapIndex": 0, "suggestedContent": "exact text to add to the target file", "revisedTitle": "more specific title"}]`;

    try {
      const response = await this.copilotClient.analyze(prompt, undefined, 120_000);
      const match = response.match(/\[[\s\S]*\]/);
      if (match) {
        const enrichments = JSON.parse(match[0]) as { gapIndex: number; suggestedContent: string; revisedTitle?: string }[];
        for (const e of enrichments) {
          if (e.gapIndex >= 0 && e.gapIndex < recs.length) {
            if (e.suggestedContent) recs[e.gapIndex].suggestedContent = e.suggestedContent;
            if (e.revisedTitle) recs[e.gapIndex].title = e.revisedTitle;
          }
        }
        logger.info(`RecommendationSynthesizer: LLM enriched ${enrichments.length} recommendations with specific content`);
      }
    } catch (err) {
      logger.debug('RecommendationSynthesizer: LLM enrichment failed', err);
    }
  }

  private getMainInstructionFile(tool: AITool): string {
    const map: Record<string, string> = {
      copilot: '.github/copilot-instructions.md',
      cline: '.clinerules/default-rules.md',
      cursor: '.cursor/rules/default.md',
      claude: 'CLAUDE.md',
      roo: '.roo/rules/default.md',
      windsurf: '.windsurf/rules/default.md',
      aider: '.aider.conf.yml',
    };
    return map[tool] || '.github/copilot-instructions.md';
  }

  private async validateEnrichedContent(recs: DeepRecommendation[]): Promise<void> {
    if (recs.length === 0) return;
    try {
      const { OutputValidator } = await import('./outputValidator');
      const validator = new OutputValidator(this.copilotClient);
      const files = recs
        .filter(r => r.suggestedContent && r.targetFile)
        .map(r => ({ filePath: r.targetFile, content: r.suggestedContent! }));

      if (files.length === 0) return;
      const result = await validator.validate(files, 'Deep recommendation enrichment');

      for (const issue of result.issues) {
        if (issue.severity === 'error') {
          // Strip bad content from the recommendation
          const rec = recs.find(r => r.targetFile === issue.file);
          if (rec) {
            logger.warn(`RecommendationSynthesizer: validator rejected content for ${issue.file}: ${issue.issue}`);
            rec.suggestedContent = undefined;
          }
        }
      }
    } catch (err) {
      logger.debug('RecommendationSynthesizer: content validation failed', err);
    }
  }
}
