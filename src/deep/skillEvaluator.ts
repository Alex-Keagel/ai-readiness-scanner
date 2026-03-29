import * as vscode from 'vscode';
import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';
import { DeepRecommendation } from './types';

// ─── Types ──────────────────────────────────────────────────────────

export interface SkillFile {
  path: string;
  content: string;
  name: string; // directory name (e.g. "build-bundle-validate")
}

export interface DimensionScore {
  score: number; // 0-100
  issues: string[];
  suggestions: string[];
}

export interface SkillEvaluation {
  skill: SkillFile;
  completeness: DimensionScore;
  accuracy: DimensionScore;
  actionability: DimensionScore;
  relevance: DimensionScore;
  security: DimensionScore;
  overall: number; // weighted composite
}

export interface SkillEvaluationResult {
  evaluations: SkillEvaluation[];
  recommendations: DeepRecommendation[];
}

// ─── Dimension weights ──────────────────────────────────────────────

const DIMENSION_WEIGHTS = {
  completeness: 0.25,
  accuracy: 0.30,
  actionability: 0.25,
  relevance: 0.10,
  security: 0.10,
};

// ─── Required SKILL.md sections ─────────────────────────────────────

const REQUIRED_SECTIONS = ['## Steps', '## Inputs', '## Outputs', '## Validation'];
const RECOMMENDED_SECTIONS = ['## Prerequisites', '## Error Handling', '## Examples'];

// ─── Skill Evaluator Pipeline ───────────────────────────────────────

export class SkillEvaluator {
  constructor(private copilotClient: CopilotClient) {}

  async evaluate(
    workspaceUri: vscode.Uri,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<SkillEvaluationResult> {
    const timer = logger.time('SkillEvaluator');

    // Phase 0: Discover skill files
    progress?.report({ message: '📂 Discovering skill files...' });
    const skills = await this.discoverSkills(workspaceUri);
    if (skills.length === 0) {
      timer?.end?.();
      return { evaluations: [], recommendations: [] };
    }
    logger.info(`SkillEvaluator: found ${skills.length} skills`);

    // Phase 1: Completeness (deterministic)
    progress?.report({ message: '📋 Evaluating completeness...' });
    const completenessScores = skills.map(s => this.evaluateCompleteness(s));

    // Phase 2: Accuracy (deterministic + LLM)
    progress?.report({ message: '🎯 Checking accuracy...' });
    const accuracyScores = await this.evaluateAccuracy(skills, workspaceUri);

    // Phase 3: Actionability (LLM)
    progress?.report({ message: '⚡ Assessing actionability...' });
    const actionabilityScores = await this.evaluateActionability(skills);

    // Phase 4: Relevance (LLM)
    progress?.report({ message: '🔄 Checking relevance...' });
    const relevanceScores = await this.evaluateRelevance(skills, workspaceUri);

    // Phase 5: Security (deterministic + LLM)
    progress?.report({ message: '🔒 Security review...' });
    const securityScores = await this.evaluateSecurity(skills);

    // Combine evaluations
    const evaluations: SkillEvaluation[] = skills.map((skill, i) => {
      const eval_: SkillEvaluation = {
        skill,
        completeness: completenessScores[i],
        accuracy: accuracyScores[i],
        actionability: actionabilityScores[i],
        relevance: relevanceScores[i],
        security: securityScores[i],
        overall: 0,
      };
      eval_.overall = Math.round(
        eval_.completeness.score * DIMENSION_WEIGHTS.completeness +
        eval_.accuracy.score * DIMENSION_WEIGHTS.accuracy +
        eval_.actionability.score * DIMENSION_WEIGHTS.actionability +
        eval_.relevance.score * DIMENSION_WEIGHTS.relevance +
        eval_.security.score * DIMENSION_WEIGHTS.security
      );
      return eval_;
    });

    // Phase 6: Validator — cross-check evaluations for consistency
    progress?.report({ message: '✅ Validating evaluations...' });
    await this.validateEvaluations(evaluations);

    // Phase 7: Generate improvement recommendations
    progress?.report({ message: '💡 Generating improvements...' });
    const recommendations = await this.synthesizeRecommendations(evaluations);

    logger.info(`SkillEvaluator: ${evaluations.length} skills evaluated, ${recommendations.length} improvements`);
    timer?.end?.();
    return { evaluations, recommendations };
  }

  // ─── Phase 0: Discover ──────────────────────────────────────────

  private async discoverSkills(workspaceUri: vscode.Uri): Promise<SkillFile[]> {
    const skills: SkillFile[] = [];
    const patterns = [
      '.github/skills/**/SKILL.md',
      '.github/skills/**/*.md',
      '.windsurf/skills/**/*.md',
    ];

    for (const glob of patterns) {
      try {
        const found = await vscode.workspace.findFiles(
          new vscode.RelativePattern(workspaceUri, glob),
          '**/node_modules/**', 100
        );
        for (const uri of found) {
          try {
            const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
            const relPath = vscode.workspace.asRelativePath(uri, false);
            const parts = relPath.split('/');
            const name = parts[parts.length - 2] || parts[parts.length - 1].replace('.md', '');
            if (!skills.some(s => s.path === relPath)) {
              skills.push({ path: relPath, content, name });
            }
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip bad glob */ }
    }

    return skills;
  }

  // ─── Phase 1: Completeness Evaluator (deterministic) ────────────

  evaluateCompleteness(skill: SkillFile): DimensionScore {
    const issues: string[] = [];
    const suggestions: string[] = [];
    let score = 100;

    // Required sections
    for (const section of REQUIRED_SECTIONS) {
      if (!skill.content.includes(section) && !skill.content.includes(section.toLowerCase())) {
        issues.push(`Missing required section: ${section}`);
        score -= 20;
      }
    }

    // Recommended sections
    for (const section of RECOMMENDED_SECTIONS) {
      if (!skill.content.includes(section) && !skill.content.includes(section.toLowerCase())) {
        suggestions.push(`Consider adding section: ${section}`);
        score -= 5;
      }
    }

    // Steps should be numbered
    const stepsSection = skill.content.match(/## Steps[\s\S]*?(?=##|$)/i);
    if (stepsSection) {
      const stepLines = stepsSection[0].split('\n').filter(l => /^\s*\d+[\.\)]\s/.test(l));
      if (stepLines.length === 0) {
        issues.push('Steps section has no numbered steps');
        score -= 15;
      } else if (stepLines.length < 3) {
        suggestions.push(`Only ${stepLines.length} steps — consider adding more detail`);
        score -= 5;
      }
    }

    // Inputs should have type annotations
    const inputsSection = skill.content.match(/## Inputs[\s\S]*?(?=##|$)/i);
    if (inputsSection) {
      const inputLines = inputsSection[0].split('\n').filter(l => /^[-*]\s+`/.test(l));
      const withTypes = inputLines.filter(l => /:\s*(string|number|boolean|array|path|glob|semver|list)/.test(l));
      if (inputLines.length > 0 && withTypes.length < inputLines.length * 0.5) {
        suggestions.push('Most inputs lack type annotations (e.g., `: string`, `: path`)');
        score -= 5;
      }
    }

    // Outputs should be defined
    const outputsSection = skill.content.match(/## Outputs[\s\S]*?(?=##|$)/i);
    if (outputsSection) {
      const outputLines = outputsSection[0].split('\n').filter(l => /^[-*]\s+`/.test(l));
      if (outputLines.length === 0) {
        issues.push('Outputs section is empty — agents won\'t know what to expect');
        score -= 10;
      }
    }

    // Content length check
    if (skill.content.length < 200) {
      issues.push('Skill file is very short (<200 chars) — likely too vague for agents');
      score -= 15;
    }

    return { score: Math.max(0, Math.min(100, score)), issues, suggestions };
  }

  // ─── Phase 2: Accuracy Evaluator (deterministic + LLM) ─────────

  private async evaluateAccuracy(skills: SkillFile[], workspaceUri: vscode.Uri): Promise<DimensionScore[]> {
    const results: DimensionScore[] = [];

    for (const skill of skills) {
      const issues: string[] = [];
      const suggestions: string[] = [];
      let score = 100;

      // Extract paths referenced in the skill
      const pathRefs = this.extractPaths(skill.content);
      let invalidPaths = 0;
      for (const ref of pathRefs) {
        try {
          await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceUri, ref));
        } catch {
          invalidPaths++;
          issues.push(`Referenced path "${ref}" does not exist`);
        }
      }
      if (pathRefs.length > 0) {
        const accuracy = (pathRefs.length - invalidPaths) / pathRefs.length;
        score = Math.round(accuracy * 70) + 30; // 30 base + 70 from accuracy
      }

      // Extract commands and check they are plausible
      const commands = this.extractCommands(skill.content);
      for (const cmd of commands) {
        if (cmd.includes('undefined') || cmd.includes('TODO') || cmd.includes('FIXME')) {
          issues.push(`Command contains placeholder: "${cmd}"`);
          score -= 10;
        }
      }

      // LLM verification for complex accuracy
      if (this.copilotClient.isAvailable() && skill.content.length > 100) {
        try {
          const llmScore = await this.llmAccuracyCheck(skill);
          if (llmScore !== null) {
            // Blend: 60% deterministic, 40% LLM
            score = Math.round(score * 0.6 + llmScore * 0.4);
            if (llmScore < 50) {
              issues.push('LLM detected potential inaccuracies in skill steps');
            }
          }
        } catch { /* LLM failed, use deterministic only */ }
      }

      results.push({ score: Math.max(0, Math.min(100, score)), issues, suggestions });
    }

    return results;
  }

  private async llmAccuracyCheck(skill: SkillFile): Promise<number | null> {
    const prompt = `Rate the factual accuracy of this skill definition (0-100). Check if commands, file paths, and technical claims are consistent and plausible.

SKILL: ${skill.name}
CONTENT:
${skill.content.slice(0, 2000)}

Respond ONLY as JSON: {"score": 0-100, "issues": ["specific issue"]}`;

    const response = await this.copilotClient.analyzeFast(prompt);
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return typeof parsed.score === 'number' ? parsed.score : null;
    } catch { return null; }
  }

  // ─── Phase 3: Actionability Evaluator (LLM) ────────────────────

  private async evaluateActionability(skills: SkillFile[]): Promise<DimensionScore[]> {
    if (!this.copilotClient.isAvailable()) {
      return skills.map(() => ({ score: 50, issues: ['LLM unavailable — actionability not evaluated'], suggestions: [] }));
    }

    const batch = skills.slice(0, 15).map(s =>
      `SKILL "${s.name}" (${s.path}):\n${s.content.slice(0, 1500)}`
    ).join('\n\n---\n\n');

    const prompt = `You are an agent actionability evaluator. For each skill below, rate (0-100) whether an AI coding agent could execute the steps end-to-end without human clarification.

Check for:
- Ambiguous steps ("do the right thing", "update as needed")
- Missing prerequisites (tools, env vars, permissions needed but not listed)
- Unclear output format (agent won't know if it succeeded)
- Steps that require human judgment that an agent can't make
- Missing error handling (what if step 3 fails?)

${batch}

Respond ONLY as JSON:
[{"skill": "name", "score": 0-100, "issues": ["specific issue"], "suggestions": ["improvement"]}]`;

    try {
      const response = await this.copilotClient.analyze(prompt, undefined, 120_000);
      const match = response.match(/\[[\s\S]*\]/);
      if (!match) return skills.map(() => ({ score: 50, issues: [], suggestions: [] }));

      const parsed = JSON.parse(match[0]) as { skill: string; score: number; issues: string[]; suggestions: string[] }[];
      return skills.map(s => {
        const result = parsed.find(p => p.skill === s.name || s.name.includes(p.skill) || p.skill.includes(s.name));
        return result
          ? { score: result.score, issues: result.issues || [], suggestions: result.suggestions || [] }
          : { score: 50, issues: [], suggestions: [] };
      });
    } catch {
      return skills.map(() => ({ score: 50, issues: ['Actionability evaluation failed'], suggestions: [] }));
    }
  }

  // ─── Phase 4: Relevance Evaluator (LLM) ────────────────────────

  private async evaluateRelevance(skills: SkillFile[], workspaceUri: vscode.Uri): Promise<DimensionScore[]> {
    if (!this.copilotClient.isAvailable()) {
      return skills.map(() => ({ score: 50, issues: ['LLM unavailable'], suggestions: [] }));
    }

    // Get current project context
    const packageJson = await this.readFile(workspaceUri, 'package.json');
    let projectContext = 'No package.json found';
    if (packageJson) {
      try {
        projectContext = `package.json scripts: ${Object.keys(JSON.parse(packageJson).scripts || {}).join(', ')}`;
      } catch { projectContext = 'package.json exists but could not be parsed'; }
    }

    const batch = skills.slice(0, 15).map(s =>
      `SKILL "${s.name}": ${s.content.slice(0, 800)}`
    ).join('\n\n---\n\n');

    const prompt = `You are a skill relevance evaluator. Rate (0-100) whether each skill is still relevant to this project's CURRENT state.

PROJECT CONTEXT:
${projectContext}

SKILLS:
${batch}

Check for:
- Skills referencing tools/commands the project no longer uses
- Skills for workflows that have been superseded (e.g., manual deploy when CI/CD exists)
- Skills too generic to be useful (could apply to ANY project)
- Skills perfectly tailored to this specific project structure

Respond ONLY as JSON:
[{"skill": "name", "score": 0-100, "issues": ["outdated reason"], "suggestions": ["update suggestion"]}]`;

    try {
      const response = await this.copilotClient.analyze(prompt, undefined, 120_000);
      const match = response.match(/\[[\s\S]*\]/);
      if (!match) return skills.map(() => ({ score: 50, issues: [], suggestions: [] }));

      const parsed = JSON.parse(match[0]) as { skill: string; score: number; issues: string[]; suggestions: string[] }[];
      return skills.map(s => {
        const result = parsed.find(p => p.skill === s.name || s.name.includes(p.skill) || p.skill.includes(s.name));
        return result
          ? { score: result.score, issues: result.issues || [], suggestions: result.suggestions || [] }
          : { score: 50, issues: [], suggestions: [] };
      });
    } catch {
      return skills.map(() => ({ score: 50, issues: ['Relevance evaluation failed'], suggestions: [] }));
    }
  }

  // ─── Phase 5: Security Evaluator (deterministic + LLM) ─────────

  private async evaluateSecurity(skills: SkillFile[]): Promise<DimensionScore[]> {
    const results: DimensionScore[] = [];

    for (const skill of skills) {
      const issues: string[] = [];
      const suggestions: string[] = [];
      let score = 100;

      // Deterministic: check for dangerous patterns
      const dangerous = [
        { pattern: /rm\s+-rf\s+[\/~]/, issue: 'Contains unrestricted rm -rf on root/home paths' },
        { pattern: /\$\{?\w*PASSWORD\}?/i, issue: 'References PASSWORD variable — ensure it\'s not hardcoded' },
        { pattern: /\$\{?\w*SECRET\}?/i, issue: 'References SECRET variable — ensure proper secret management' },
        { pattern: /\$\{?\w*TOKEN\}?/i, issue: 'References TOKEN variable — ensure proper secret management' },
        { pattern: /curl\s+.*\|\s*(?:bash|sh)/i, issue: 'Pipe-to-shell pattern — potential command injection risk' },
        { pattern: /eval\s*\(/, issue: 'Uses eval() — potential code injection risk' },
        { pattern: /chmod\s+777/, issue: 'Sets 777 permissions — overly permissive' },
        { pattern: /--force|--no-verify/i, issue: 'Uses force/no-verify flags — bypasses safety checks' },
      ];

      for (const { pattern, issue } of dangerous) {
        if (pattern.test(skill.content)) {
          issues.push(issue);
          score -= 15;
        }
      }

      // Check for safe-command patterns
      if (skill.content.match(/npm\s+(publish|deploy)|git\s+push|docker\s+push/i)) {
        if (!skill.content.match(/confirm|approval|review|dry.?run/i)) {
          suggestions.push('Deployment/publish commands should require confirmation or have a dry-run option');
          score -= 10;
        }
      }

      // Check for error handling mention
      if (!skill.content.match(/error|fail|exception|catch|rollback|abort/i)) {
        suggestions.push('No error handling mentioned — what should the agent do if a step fails?');
        score -= 5;
      }

      results.push({ score: Math.max(0, Math.min(100, score)), issues, suggestions });
    }

    // LLM security review for batch
    if (this.copilotClient.isAvailable() && skills.length > 0) {
      try {
        const batch = skills.slice(0, 10).map(s => `"${s.name}": ${s.content.slice(0, 800)}`).join('\n---\n');
        const prompt = `You are a security auditor. Review these skill definitions for security risks. Only flag REAL issues, not hypothetical ones.

${batch}

Respond ONLY as JSON:
[{"skill": "name", "issues": ["specific security issue"], "score_adjustment": -5 to -30}]`;

        const response = await this.copilotClient.analyzeFast(prompt);
        const match = response.match(/\[[\s\S]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]) as { skill: string; issues: string[]; score_adjustment: number }[];
          for (const p of parsed) {
            const idx = skills.findIndex(s => s.name === p.skill || s.name.includes(p.skill));
            if (idx >= 0 && idx < results.length && p.issues?.length > 0) {
              results[idx].issues.push(...p.issues);
              results[idx].score = Math.max(0, results[idx].score + (p.score_adjustment || -10));
            }
          }
        }
      } catch { /* LLM security review failed — use deterministic only */ }
    }

    return results;
  }

  // ─── Phase 6: Validator ─────────────────────────────────────────

  private async validateEvaluations(evaluations: SkillEvaluation[]): Promise<void> {
    if (!this.copilotClient.isAvailable() || evaluations.length === 0) return;

    // Cross-check: if completeness is high but accuracy is low, flag inconsistency
    for (const eval_ of evaluations) {
      if (eval_.completeness.score > 80 && eval_.accuracy.score < 30) {
        eval_.accuracy.issues.push('⚠️ Validator: skill appears well-structured but references are mostly invalid — may have been auto-generated');
      }
      if (eval_.actionability.score > 80 && eval_.security.score < 30) {
        eval_.security.issues.push('⚠️ Validator: highly actionable skill has security concerns — agent will eagerly execute unsafe steps');
      }
      if (eval_.relevance.score < 30 && eval_.completeness.score > 70) {
        eval_.relevance.suggestions.push('Consider removing or rewriting this skill — it\'s well-structured but no longer relevant');
      }
    }

    // LLM consistency check on the worst-scored skills
    const worstSkills = evaluations
      .filter(e => e.overall < 50)
      .sort((a, b) => a.overall - b.overall)
      .slice(0, 5);

    if (worstSkills.length === 0) return;

    try {
      const summary = worstSkills.map(e =>
        `"${e.skill.name}" (overall: ${e.overall}): completeness=${e.completeness.score}, accuracy=${e.accuracy.score}, actionability=${e.actionability.score}, relevance=${e.relevance.score}, security=${e.security.score}. Issues: ${[...e.completeness.issues, ...e.accuracy.issues, ...e.actionability.issues].slice(0, 3).join('; ')}`
      ).join('\n');

      const prompt = `You are a meta-validator. Review these skill evaluations for consistency. Flag any scores that seem wrong (e.g., high accuracy but issues mention invalid paths).

${summary}

Respond ONLY as JSON:
[{"skill": "name", "dimension": "completeness|accuracy|actionability|relevance|security", "adjustment": -20 to +20, "reason": "why"}]`;

      const response = await this.copilotClient.analyzeFast(prompt);
      const match = response.match(/\[[\s\S]*\]/);
      if (match) {
        const adjustments = JSON.parse(match[0]) as { skill: string; dimension: string; adjustment: number; reason: string }[];
        for (const adj of adjustments) {
          const eval_ = worstSkills.find(e => e.skill.name === adj.skill);
          if (eval_ && adj.dimension in eval_) {
            const dim = eval_[adj.dimension as keyof SkillEvaluation] as DimensionScore;
            if (dim && typeof dim.score === 'number') {
              dim.score = Math.max(0, Math.min(100, dim.score + adj.adjustment));
              dim.suggestions.push(`Validator adjusted: ${adj.reason}`);
            }
          }
        }
        // Recalculate overall after adjustments
        for (const eval_ of worstSkills) {
          eval_.overall = Math.round(
            eval_.completeness.score * DIMENSION_WEIGHTS.completeness +
            eval_.accuracy.score * DIMENSION_WEIGHTS.accuracy +
            eval_.actionability.score * DIMENSION_WEIGHTS.actionability +
            eval_.relevance.score * DIMENSION_WEIGHTS.relevance +
            eval_.security.score * DIMENSION_WEIGHTS.security
          );
        }
      }
    } catch { /* Validator LLM failed — use unadjusted scores */ }
  }

  // ─── Phase 7: Synthesize Recommendations ────────────────────────

  private async synthesizeRecommendations(evaluations: SkillEvaluation[]): Promise<DeepRecommendation[]> {
    const recs: DeepRecommendation[] = [];

    for (const eval_ of evaluations) {
      if (eval_.overall >= 80) continue; // Skip well-scoring skills

      const allIssues = [
        ...eval_.completeness.issues.map(i => `[Completeness] ${i}`),
        ...eval_.accuracy.issues.map(i => `[Accuracy] ${i}`),
        ...eval_.actionability.issues.map(i => `[Actionability] ${i}`),
        ...eval_.relevance.issues.map(i => `[Relevance] ${i}`),
        ...eval_.security.issues.map(i => `[Security] ${i}`),
      ];
      const allSuggestions = [
        ...eval_.completeness.suggestions,
        ...eval_.accuracy.suggestions,
        ...eval_.actionability.suggestions,
        ...eval_.relevance.suggestions,
        ...eval_.security.suggestions,
      ];

      const worstDim = this.worstDimension(eval_);
      const severity: 'critical' | 'important' | 'suggestion' =
        eval_.overall < 30 ? 'critical' :
        eval_.overall < 60 ? 'important' : 'suggestion';

      recs.push({
        id: `skill-improve-${eval_.skill.name}`,
        type: 'weak-description',
        severity,
        title: `Improve skill "${eval_.skill.name}" — ${worstDim.name} is weak (${worstDim.score}/100)`,
        description: allIssues.slice(0, 3).join('. ') || `Overall score ${eval_.overall}/100 — needs improvement`,
        evidence: [
          `Overall: ${eval_.overall}/100`,
          `Completeness: ${eval_.completeness.score}/100`,
          `Accuracy: ${eval_.accuracy.score}/100`,
          `Actionability: ${eval_.actionability.score}/100`,
          `Relevance: ${eval_.relevance.score}/100`,
          `Security: ${eval_.security.score}/100`,
          ...allIssues.slice(0, 3),
        ],
        targetFile: eval_.skill.path,
        suggestedContent: allSuggestions.length > 0
          ? `Suggested improvements:\n${allSuggestions.map(s => `- ${s}`).join('\n')}`
          : undefined,
        impactScore: Math.max(20, 100 - eval_.overall),
        affectedModules: [eval_.skill.path],
      });
    }

    return recs.sort((a, b) => b.impactScore - a.impactScore);
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private extractPaths(content: string): string[] {
    const paths: string[] = [];
    const patterns = [
      /`([a-zA-Z0-9_.\-/]+\/[a-zA-Z0-9_.\-/]+[a-zA-Z0-9])`/g,
      /(?:from|in|at|edit|read|write)\s+`?([a-zA-Z0-9_.\-/]+\/[a-zA-Z0-9_.\-/]+)`?/gi,
    ];
    const falsePaths = new Set(['try/catch', 'async/await', 'if/else', 'input/output', 'read/write']);
    for (const pat of patterns) {
      pat.lastIndex = 0;
      let m;
      while ((m = pat.exec(content)) !== null) {
        const p = m[1].replace(/^\.\//, '');
        if (p.includes('/') && p.length > 3 && !falsePaths.has(p.toLowerCase())) {
          paths.push(p);
        }
      }
    }
    return [...new Set(paths)];
  }

  private extractCommands(content: string): string[] {
    const commands: string[] = [];
    const patterns = [
      /`((?:npm|npx|yarn|pnpm|node|python|pip|go|cargo|make|bash|sh|pwsh|dotnet)\s+[^`]+)`/g,
      /(?:run|execute)\s+`([^`]+)`/gi,
    ];
    for (const pat of patterns) {
      pat.lastIndex = 0;
      let m;
      while ((m = pat.exec(content)) !== null) {
        commands.push(m[1]);
      }
    }
    return commands;
  }

  private worstDimension(eval_: SkillEvaluation): { name: string; score: number } {
    const dims = [
      { name: 'Completeness', score: eval_.completeness.score },
      { name: 'Accuracy', score: eval_.accuracy.score },
      { name: 'Actionability', score: eval_.actionability.score },
      { name: 'Relevance', score: eval_.relevance.score },
      { name: 'Security', score: eval_.security.score },
    ];
    return dims.sort((a, b) => a.score - b.score)[0];
  }

  private async readFile(workspaceUri: vscode.Uri, path: string): Promise<string | null> {
    try {
      const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspaceUri, path));
      return Buffer.from(content).toString('utf-8');
    } catch { return null; }
  }
}
