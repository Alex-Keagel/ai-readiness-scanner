import * as vscode from 'vscode';
import { SignalResult, LevelScore, MaturityLevel, FileContent, ProjectContext, LevelSignal, MATURITY_LEVELS, AITool, AI_TOOLS, RealityCheckRef } from '../scoring/types';
import { getSignalsByLevel, getAllSignals } from '../scoring/levelSignals';
import { CopilotClient } from '../llm/copilotClient';
import { LLMCache } from '../llm/cache';
import { DocsCache } from '../llm/docsCache';
import { MaturityEngine } from '../scoring/maturityEngine';
import { RealityChecker, RealityReport } from './realityChecker';
import { logger } from '../logging';
import { getPlatformExpertPrompt } from '../remediation/fixPrompts';
import { analyzeFileContent, calculateCodebaseMetrics } from '../metrics';
import { auditContextEfficiency } from '../scoring/contextAudit';
import { PlatformSignalFilter } from '../scoring/signalFilter';

const EXCLUDE_GLOB = '**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/vendor/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/target/**,**/coverage/**';

export class MaturityScanner {
  private realityChecker: RealityChecker;

  constructor(
    private copilotClient: CopilotClient,
    private cache: LLMCache,
    private engine: MaturityEngine,
    private docsCache?: DocsCache
  ) {
    this.realityChecker = new RealityChecker(copilotClient);
  }

  async scanAllLevels(
    workspaceUri: vscode.Uri,
    context: ProjectContext,
    quickMode: boolean,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
    selectedTool: AITool
  ): Promise<LevelScore[]> {
    return this.scanForTool(workspaceUri, context, quickMode, progress, token, selectedTool);
  }

  private async scanForTool(
    workspaceUri: vscode.Uri,
    context: ProjectContext,
    quickMode: boolean,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
    tool: AITool
  ): Promise<LevelScore[]> {
    const toolConfig = AI_TOOLS[tool];
    const allSignalResults: SignalResult[] = [];

    // ── Phase 1: Gather all tool-level files in parallel ──
    if (token.isCancellationRequested) { return []; }
    progress.report({ message: `📂 Discovering ${toolConfig.name} configuration files...`, increment: 5 });

    const [l2Files, l3Files, l4Files, l5Files] = await Promise.all([
      toolConfig.level2Files.length > 0 ? this.findFiles(toolConfig.level2Files, workspaceUri, 20) : Promise.resolve([]),
      toolConfig.level3Files.length > 0 ? this.findFiles(toolConfig.level3Files, workspaceUri, 20) : Promise.resolve([]),
      toolConfig.level4Files.length > 0 ? this.findFiles(toolConfig.level4Files, workspaceUri, 20) : Promise.resolve([]),
      toolConfig.level5Files.length > 0 ? this.findFiles(toolConfig.level5Files, workspaceUri, 20) : Promise.resolve([]),
    ]);

    const totalFiles = l2Files.length + l3Files.length + l4Files.length + l5Files.length;
    logger.info(`Phase 3a: Found ${totalFiles} config files (L2:${l2Files.length} L3:${l3Files.length} L4:${l4Files.length} L5:${l5Files.length})`);
    progress.report({ message: `📂 Found ${totalFiles} config files (L2:${l2Files.length} L3:${l3Files.length} L4:${l4Files.length} L5:${l5Files.length})`, increment: 2 });

    const levelFiles = new Map<number, FileContent[]>();
    levelFiles.set(2, l2Files);
    levelFiles.set(3, l3Files);
    levelFiles.set(4, l4Files);
    levelFiles.set(5, l5Files);

    // ── Phase 2: Batch evaluate all tool levels in ONE LLM call ──
    if (token.isCancellationRequested) { return []; }
    logger.info(`Phase 3b: Batch evaluating tool levels (agent: ${toolConfig.name} expert, model: ${this.copilotClient.getFastModelName()})...`);
    progress.report({ message: `🧠 Analyzing ${toolConfig.name} signals across L2–L5 via LLM...`, increment: 5 });

    const toolLevelResults = await this.batchEvaluateToolLevels(tool, levelFiles, context, quickMode, token, progress);
    allSignalResults.push(...toolLevelResults);

    const detectedCount = toolLevelResults.filter(r => r.detected).length;
    logger.info(`Phase 3b: ${detectedCount}/${toolLevelResults.length} tool-level signals detected`);
    progress.report({ message: `🧠 ${detectedCount}/${toolLevelResults.length} signals detected — scoring quality...`, increment: 10 });

    // ── Phase 3: Business logic validation for L2 & L3 (needs tool level results) ──
    if (!quickMode && this.copilotClient.isAvailable()) {
      const l2Result = toolLevelResults.find(r => r.level === 2);
      const l3Result = toolLevelResults.find(r => r.level === 3);

      if ((l2Files.length > 0 || l3Files.length > 0) && workspaceUri) {
        if (token.isCancellationRequested) { return []; }
        progress.report({ message: `🔍 Cross-referencing instruction content against actual codebase...`, increment: 3 });

        const bizFiles = [...l2Files, ...l3Files].slice(0, 5);
        const bizResult = await this.validateBusinessLogic(bizFiles, workspaceUri, context, token, tool);

        progress.report({ message: `🔍 Content accuracy: ${bizResult.score >= 0 ? bizResult.score + '/100' : 'skipped'}`, increment: 3 });

        if (bizResult.score >= 0) {
          if (l2Result && l2Result.detected) {
            l2Result.score = Math.round(l2Result.score * 0.6 + bizResult.score * 0.4);
            l2Result.businessFindings = bizResult.findings;
            l2Result.finding += ' | Business logic validated';
          }
          if (l3Result && l3Result.detected) {
            l3Result.score = Math.round(l3Result.score * 0.6 + bizResult.score * 0.4);
            l3Result.businessFindings = bizResult.findings;
            l3Result.finding += ' | Business logic validated';
          }
        }
      }
    }

    // ── Phase 4: Batch evaluate shared + accuracy signals ──
    if (token.isCancellationRequested) { return []; }
    logger.info('Phase 3c: Evaluating shared + accuracy signals...');
    progress.report({ message: `📋 Evaluating project structure, conventions, accuracy...`, increment: 5 });

    // PlatformSignalFilter imported statically
    const sharedIds = PlatformSignalFilter.getSharedSignalIds(tool);
    const sharedSignals = getSignalsByLevel(2 as MaturityLevel).filter(s =>
      ['project_structure_doc', 'conventions_documented', 'ignore_files'].includes(s.id)
    );
    const accuracySignals = getAllSignals().filter(s => sharedIds.includes(s.id) && !['project_structure_doc', 'conventions_documented', 'ignore_files'].includes(s.id));
    const allBatchSignals = [...sharedSignals, ...accuracySignals];

    const batchSignalResults = await this.batchEvaluateSignals(
      allBatchSignals, workspaceUri, context, quickMode, token, tool
    );
    allSignalResults.push(...batchSignalResults);

    // ── L1 Codebase quality signals (from AST analysis of app/library code) ──
    try {
      progress.report({ message: '📏 Measuring codebase quality signals...', increment: 2 });
      // analyzeFileContent, calculateCodebaseMetrics imported statically

      // Only analyze app/library/service code — exclude infra, config, data, script
      const APP_TYPES = new Set(['app', 'library', 'service']);
      const appComponents = context.components.filter(c => APP_TYPES.has(c.type));
      const appPaths = appComponents.map(c => c.path);
      logger.info(`L1: ${appComponents.length} app-layer components (${appPaths.join(', ') || 'none'}) of ${context.components.length} total`);

      // Find source files in app-layer components
      const codeExts = '{ts,tsx,js,jsx,py,cs,java,go,rs,rb}';
      let appGlobs: string[];
      if (appPaths.length > 0) {
        appGlobs = appPaths.map(p => `${p}/**/*.${codeExts}`);
      } else {
        // No app/service/library components found — scan all source code
        // This handles repos where components are typed as 'unknown'
        logger.info('L1: no app-layer components, scanning all source files');
        appGlobs = [`src/**/*.${codeExts}`, `lib/**/*.${codeExts}`, `**/*.${codeExts}`];
      }

      const codeFiles: vscode.Uri[] = [];
      for (const glob of appGlobs.slice(0, 10)) {
        try {
          const found = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceUri, glob),
            '**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/vendor/**',
            200
          );
          codeFiles.push(...found);
        } catch { /* skip */ }
      }

      logger.info(`L1: found ${codeFiles.length} source files from ${appGlobs.length} glob patterns`);

      if (codeFiles.length > 0) {
        const analyses = await Promise.all(
          codeFiles.slice(0, 100).map(async (uri) => {
            try {
              const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
              const ext = uri.fsPath.split('.').pop()?.toLowerCase() || '';
              const langMap: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', cs: 'csharp', java: 'java', go: 'go', rs: 'rust', rb: 'ruby' };
              return analyzeFileContent(uri.fsPath, content, langMap[ext] || 'typescript');
            } catch { return null; }
          })
        );
        const validAnalyses = analyses.filter((a): a is NonNullable<typeof a> => a !== null);

        if (validAnalyses.length > 0) {
          // Use LLM to get accurate procedure/documentation counts on a sample
          let totalProcs = validAnalyses.reduce((s, a) => s + a.totalProcedures, 0);
          let docProcs = validAnalyses.reduce((s, a) => s + a.documentedProcedures, 0);

          if (this.copilotClient?.isAvailable()) {
            try {
              // Sample up to 10 files, send their signatures to LLM for accurate counting
              const sample = validAnalyses
                .filter(a => a.totalProcedures > 0)
                .sort((a, b) => b.totalProcedures - a.totalProcedures)
                .slice(0, 10);

              if (sample.length > 0) {
                const fileSummaries = await Promise.all(sample.map(async (a) => {
                  const uri = codeFiles.find(u => u.fsPath.endsWith(a.path) || vscode.workspace.asRelativePath(u) === a.path);
                  if (!uri) return null;
                  const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
                  // Extract first 150 lines or full file if short
                  const preview = content.split('\n').slice(0, 150).join('\n');
                  return { path: a.path, preview, regexTotal: a.totalProcedures, regexDoc: a.documentedProcedures };
                }));

                const validSummaries = fileSummaries.filter(s => s !== null);
                if (validSummaries.length > 0) {
                  const prompt = `Count the actual function/method/class declarations (NOT control flow like if/for/while/switch/catch) in each file. Also count how many have a docstring, JSDoc comment, or descriptive comment immediately before them.

${validSummaries.map(s => `FILE: ${s!.path}\n\`\`\`\n${s!.preview.slice(0, 3000)}\n\`\`\`\nRegex detected: ${s!.regexTotal} procedures, ${s!.regexDoc} documented`).join('\n\n')}

Respond as JSON array: [{"path":"...","totalProcedures":N,"documentedProcedures":N}]`;

                  // Use main model (not fast) for accurate procedure counting
                  const response = await this.copilotClient.analyze(prompt, undefined, 60_000);
                  const match = response.match(/\[[\s\S]*\]/);
                  if (match) {
                    const llmCounts = JSON.parse(match[0]) as { path: string; totalProcedures: number; documentedProcedures: number }[];

                    // Calculate correction factor from sample
                    let regexTotal = 0, regexDoc = 0, llmTotal = 0, llmDoc = 0;
                    for (const lc of llmCounts) {
                      const sa = sample.find(s => s.path === lc.path || lc.path.endsWith(s.path));
                      if (sa) {
                        regexTotal += sa.totalProcedures;
                        regexDoc += sa.documentedProcedures;
                        llmTotal += lc.totalProcedures;
                        llmDoc += lc.documentedProcedures;
                      }
                    }

                    if (regexTotal > 0 && llmTotal > 0) {
                      const totalFactor = llmTotal / regexTotal;
                      const docFactor = regexDoc > 0 ? llmDoc / regexDoc : 1;
                      
                      // Sanity check: if correction is too extreme (>3x or <0.1x), skip it
                      // Also skip if LLM doc ratio is drastically lower than regex ratio
                      const regexRatio = regexDoc / regexTotal;
                      const llmRatio = llmDoc / llmTotal;
                      if (totalFactor > 0.1 && totalFactor < 3.0 && !(regexRatio > 0.3 && llmRatio < 0.1)) {
                        totalProcs = Math.round(totalProcs * totalFactor);
                        docProcs = Math.round(docProcs * docFactor);
                        logger.info(`L1 LLM correction applied: regex=${regexTotal}/${regexDoc} → LLM=${llmTotal}/${llmDoc} → factors: total=${totalFactor.toFixed(2)}, doc=${docFactor.toFixed(2)} → adjusted: ${totalProcs}/${docProcs}`);
                      } else {
                        logger.info(`L1 LLM correction SKIPPED (extreme): regex=${regexTotal}/${regexDoc} (${Math.round(regexRatio*100)}%) → LLM=${llmTotal}/${llmDoc} (${Math.round(llmRatio*100)}%) — keeping regex counts`);
                      }
                    }
                  }
                }
              }
            } catch (err) {
              logger.debug('L1 LLM procedure correction failed, using regex counts', err);
            }
          }

          logger.info(`L1 analysis: ${validAnalyses.length} files, ${totalProcs} procedures, ${docProcs} documented (${totalProcs > 0 ? Math.round(docProcs/totalProcs*100) : 0}%)`);

          const depGraph = validAnalyses.filter(a => a.importCount > 0).map(a => ({ source: a.path, targets: [] as string[] }));
          const metrics = calculateCodebaseMetrics(validAnalyses, depGraph);
          // Override semantic density with LLM-corrected ratio
          const correctedDensity = totalProcs > 0 ? Math.round((docProcs / totalProcs) * 100) : metrics.semanticDensity;

          allSignalResults.push(
            { signalId: 'codebase_type_strictness', level: 1 as MaturityLevel, detected: true, score: Math.round(metrics.typeStrictnessIndex), finding: `Type strictness: ${Math.round(metrics.typeStrictnessIndex)}/100 across ${validAnalyses.length} app-layer files`, files: [], confidence: 'high' as const },
            { signalId: 'codebase_semantic_density', level: 1 as MaturityLevel, detected: true, score: correctedDensity, finding: `Semantic density: ${correctedDensity}/100 — ${docProcs}/${totalProcs} procedures documented across ${validAnalyses.length} files`, files: [], confidence: 'high' as const },
          );
          logger.info(`L1 signals: typeStrictness=${Math.round(metrics.typeStrictnessIndex)}, semanticDensity=${correctedDensity} from ${validAnalyses.length} app-layer files`);
        }
      }

      // Context efficiency from context audit (if available) or estimate
      // auditContextEfficiency imported statically
      const effResult = await auditContextEfficiency(workspaceUri, context, 0, tool);
      allSignalResults.push(
        { signalId: 'codebase_context_efficiency', level: 1 as MaturityLevel, detected: true, score: effResult.score, finding: `Context efficiency: ${effResult.score}/100 (${effResult.budgetPct}% of budget used, ${effResult.totalTokens} tokens)`, files: [], confidence: 'high' as const },
      );
      logger.info(`L1 signal: contextEfficiency=${effResult.score} (${effResult.budgetPct}% budget)`);
    } catch (err) {
      logger.error('L1 codebase signals FAILED — type strictness and semantic density will be missing', err);
    }

    // ── Build level scores ──
    const levelScores: LevelScore[] = [];
    for (let level = 1; level <= 6; level++) {
      levelScores.push(this.engine.calculateLevelScore(level as MaturityLevel, allSignalResults, tool));
    }
    return levelScores;
  }

  private async evaluateToolLevel(
    tool: AITool,
    level: number,
    category: string,
    patterns: string[],
    files: FileContent[],
    context: ProjectContext,
    quickMode: boolean,
    token?: vscode.CancellationToken
  ): Promise<SignalResult> {
    const toolConfig = AI_TOOLS[tool];
    const signalId = `${tool}_l${level}_${category}`;

    if (files.length === 0) {
      return {
        signalId,
        level: level as MaturityLevel,
        detected: false,
        score: 0,
        finding: `No ${toolConfig.name} ${category.replace(/_/g, ' ')} files found. Expected: ${patterns.join(', ')}`,
        files: [],
        confidence: 'high',
      };
    }

    // Run reality checks on the instruction files
    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    let realityReport: RealityReport | undefined;
    let realityChecks: RealityCheckRef[] | undefined;
    if (workspaceUri) {
      realityReport = await this.realityChecker.validateFiles(files, workspaceUri, context);
      if (realityReport.checks.length > 0) {
        realityChecks = realityReport.checks;
      }
    }

    // Deterministic scoring
    if (quickMode || !this.copilotClient.isAvailable()) {
      const result = this.evaluateToolLevelDeterministic(tool, level, category, files, realityReport);
      if (realityChecks) { result.realityChecks = realityChecks; }
      return result;
    }

    // LLM deep analysis — include reality check results in prompt
    const realitySummary = realityReport
      ? this.realityChecker.formatForPrompt(realityReport)
      : '';
    const prompt = await this.buildToolLevelPrompt(tool, level, category, files, context, realitySummary);
    try {
      const response = await this.copilotClient.analyzeFast(prompt, token);
      const parsed = this.parseResponse(response);
      if (parsed) {
        let finalScore = parsed.score;
        let businessFindings: string[] | undefined;

        // For L2 (instructions) and L3 (skills), also validate business logic
        if ((level === 2 || level === 3) && workspaceUri) {
          const bizResult = await this.validateBusinessLogic(files, workspaceUri, context, token, tool);
          if (bizResult.score >= 0) {
            finalScore = Math.round(parsed.score * 0.6 + bizResult.score * 0.4);
            businessFindings = bizResult.findings;
          }
        }

        const result: SignalResult = {
          signalId,
          level: level as MaturityLevel,
          detected: parsed.detected,
          score: finalScore,
          finding: parsed.finding + (businessFindings?.length ? ' | Business logic validated' : ''),
          files: files.map(f => f.relativePath),
          modelUsed: this.copilotClient.getModelName(),
          confidence: parsed.confidence,
          businessFindings,
        };
        if (realityChecks) { result.realityChecks = realityChecks; }
        return result;
      }
    } catch (err) {
      logger.warn('LLM evaluation failed for tool level, falling back to deterministic', { error: err instanceof Error ? err.message : String(err) });
    }

    const fallback = this.evaluateToolLevelDeterministic(tool, level, category, files, realityReport);
    if (realityChecks) { fallback.realityChecks = realityChecks; }
    return fallback;
  }

  private evaluateToolLevelDeterministic(
    tool: AITool,
    level: number,
    category: string,
    files: FileContent[],
    realityReport?: RealityReport
  ): SignalResult {
    const toolConfig = AI_TOOLS[tool];
    const substantialFiles = files.filter(f => f.content.length > 100);
    let score = substantialFiles.length > 0
      ? Math.min(100, Math.round(Math.log2(1 + substantialFiles.length) / Math.log2(6) * 100))
      : 0;

    // Blend in reality accuracy score if available
    let findingSuffix = '';
    if (realityReport && realityReport.totalChecks > 0) {
      const accuracyWeight = 0.3;
      score = Math.min(100, Math.round(score * (1 - accuracyWeight) + realityReport.accuracyScore * accuracyWeight));
      const invalidCount = realityReport.invalid;
      const warnCount = realityReport.warnings;
      if (invalidCount > 0 || warnCount > 0) {
        findingSuffix = ` — ${realityReport.valid}/${realityReport.totalChecks} reality checks valid`;
        if (invalidCount > 0) { findingSuffix += `, ${invalidCount} invalid`; }
        if (warnCount > 0) { findingSuffix += `, ${warnCount} stale`; }
      }
    }

    return {
      signalId: `${tool}_l${level}_${category}`,
      level: level as MaturityLevel,
      detected: substantialFiles.length > 0,
      score,
      finding: substantialFiles.length > 0
        ? `Found ${substantialFiles.length} ${toolConfig.name} ${category.replace(/_/g, ' ')} file(s): ${files.slice(0, 3).map(f => f.relativePath).join(', ')}${files.length > 3 ? ` (+${files.length - 3} more)` : ''}${findingSuffix}`
        : `No substantial ${toolConfig.name} ${category.replace(/_/g, ' ')} files found`,
      files: files.map(f => f.relativePath),
      modelUsed: 'deterministic',
      confidence: 'medium',
    };
  }

  // ─── Batch Tool-Level Evaluation ──────────────────────────────────────

  private levelCategory(level: number): string {
    const categories: Record<number, string> = {
      2: 'instructions',
      3: 'skills_and_tools',
      4: 'workflows',
      5: 'memory_feedback',
    };
    return categories[level] || 'unknown';
  }

  private async batchEvaluateToolLevels(
    tool: AITool,
    levelFiles: Map<number, FileContent[]>,
    context: ProjectContext,
    quickMode: boolean,
    token?: vscode.CancellationToken,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<SignalResult[]> {
    // If quick mode or LLM unavailable, fall back to per-level deterministic
    if (quickMode || !this.copilotClient.isAvailable()) {
      const results: SignalResult[] = [];
      for (const [level, files] of levelFiles) {
        const category = this.levelCategory(level);
        results.push(this.evaluateToolLevelDeterministic(tool, level, category, files));
      }
      return results;
    }

    // Run reality checks in parallel for all levels
    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const realityResults = new Map<number, { report?: RealityReport; checks?: RealityCheckRef[] }>();

    if (workspaceUri) {
      logger.info('Phase 3b: Running reality checks on config files...');
      progress?.report({ message: `🔍 Running reality checks on config files...` });
      const realityTimer = logger.time('Phase 3b: Reality checks');
      const realityPromises = [...levelFiles.entries()].map(async ([level, files]) => {
        if (files.length === 0) { return; }
        const report = await this.realityChecker.validateFiles(files, workspaceUri, context);
        realityResults.set(level, {
          report,
          checks: report.checks.length > 0 ? report.checks : undefined,
        });
      });
      await Promise.all(realityPromises);
      realityTimer?.end?.();
      logger.info(`Phase 3b: Reality checks complete — ${realityResults.size} levels, ${[...realityResults.values()].reduce((n, r) => n + (r.report?.totalChecks || 0), 0)} total checks`);
      progress?.report({ message: `🔍 Reality checks complete — ${realityResults.size} levels validated` });
    }

    // Build combined prompt for all levels at once
    logger.info('Phase 3b: Building batch prompt + fetching live docs...');
    const promptTimer = logger.time('Phase 3b: Prompt build + docs fetch');
    progress?.report({ message: `🧠 Building analysis prompt for LLM...` });
    const prompt = await this.buildBatchToolLevelPrompt(tool, levelFiles, context, realityResults);
    const promptKb = Math.round(prompt.length / 1024);
    promptTimer?.end?.();
    logger.info(`Phase 3b: Prompt ready (${promptKb}KB), sending to ${this.copilotClient.getFastModelName()} (Flash)...`);
    progress?.report({ message: `🧠 Sending ${promptKb}KB prompt to Flash LLM — waiting for response...` });

    try {
      const llmTimer = logger.time('Phase 3b: LLM batch analysis');
      const response = await this.copilotClient.analyzeFast(prompt, token);
      llmTimer?.end?.();
      logger.info('Phase 3b: LLM response received, parsing...');
      progress?.report({ message: `🧠 LLM response received — parsing results...` });
      return this.parseBatchResponse(tool, response, levelFiles, realityResults);
    } catch (err) {
      logger.warn('Batch LLM analysis failed, falling back to deterministic for all levels', { error: err instanceof Error ? err.message : String(err) });
      // Fallback to deterministic for all levels
      const results: SignalResult[] = [];
      for (const [level, files] of levelFiles) {
        const category = this.levelCategory(level);
        const realityData = realityResults.get(level);
        const result = this.evaluateToolLevelDeterministic(tool, level, category, files, realityData?.report);
        if (realityData?.checks) { result.realityChecks = realityData.checks; }
        results.push(result);
      }
      return results;
    }
  }

  private async buildBatchToolLevelPrompt(
    tool: AITool,
    levelFiles: Map<number, FileContent[]>,
    context: ProjectContext,
    realityResults: Map<number, { report?: RealityReport; checks?: RealityCheckRef[] }>
  ): Promise<string> {
    const toolConfig = AI_TOOLS[tool];

    const levelDescriptions: Record<number, string> = {
      2: 'INSTRUCTIONS — Clear, accurate instructions that tell the agent how to behave',
      3: 'SKILLS & TOOLS — Reusable skills, tool integrations (MCP), safe-command lists',
      4: 'WORKFLOWS — End-to-end playbooks an agent can follow start-to-finish',
      5: 'MEMORY & FEEDBACK — Mechanism to record learnings and improve over time',
    };

    let fileSections = '';
    for (const [level, files] of levelFiles) {
      if (files.length === 0) { continue; }
      const fileContents = files.slice(0, 4).map(f =>
        `### ${f.relativePath}\n\`\`\`\n${f.content.slice(0, 1500)}\n\`\`\``
      ).join('\n\n');

      const realityData = realityResults.get(level);
      const realitySummary = realityData?.report
        ? this.realityChecker.formatForPrompt(realityData.report)
        : '';

      fileSections += `
--- LEVEL ${level}: ${levelDescriptions[level] || 'Unknown'} ---
${fileContents}
${realitySummary ? `\nREALITY CHECKS FOR L${level}:\n${realitySummary}` : ''}
`;
    }

    // Use live docs if available, fall back to static (5s timeout)
    let docsBlock: string;
    if (this.docsCache) {
      try {
        const docsTimeout = new Promise<null>(resolve => setTimeout(() => resolve(null), 15000));
        const liveDocs = await Promise.race([this.docsCache.getToolDocs(tool), docsTimeout]);
        docsBlock = liveDocs || this.buildStaticDocsBlock(toolConfig);
        if (!liveDocs) { logger.debug('Live docs fetch timed out or empty, using static'); }
      } catch {
        docsBlock = this.buildStaticDocsBlock(toolConfig);
      }
    } else {
      docsBlock = this.buildStaticDocsBlock(toolConfig);
    }

    const expertPrompt = getPlatformExpertPrompt(tool);

    return `${expertPrompt}

You are now EVALUATING (not generating) a repository's readiness for **${toolConfig.name}** across MULTIPLE maturity levels in a SINGLE pass.

${docsBlock}

Project REALITY (ground truth):
- Languages: ${context.languages.join(', ')}
- Type: ${context.projectType}
- Package manager: ${context.packageManager}
${context.buildTasks ? `- Build/automation tasks (.vscode/tasks.json):\n${context.buildTasks}` : ''}
- Directory structure:
${context.directoryTree.slice(0, 800)}

${fileSections}

For EACH level that has files, score 0-100 based on:
1. ACCURACY — do references match the real project?
2. COMPLETENESS — does it cover major components?
3. QUALITY — is it specific and actionable?
4. TOOL-SPECIFIC — does it follow ${toolConfig.name} patterns?

Score ranges:
- 90-100: Excellent  - 70-89: Good  - 50-69: Partial  - 30-49: Weak  - 0-29: Poor

Respond with ONLY valid JSON array:
[
  {"level": 2, "detected": true/false, "score": 0-100, "finding": "one sentence", "confidence": "high|medium|low"},
  {"level": 3, "detected": true/false, "score": 0-100, "finding": "one sentence", "confidence": "high|medium|low"},
  {"level": 4, "detected": true/false, "score": 0-100, "finding": "one sentence", "confidence": "high|medium|low"},
  {"level": 5, "detected": true/false, "score": 0-100, "finding": "one sentence", "confidence": "high|medium|low"}
]
Only include levels that have files to evaluate.`;
  }

  private parseBatchResponse(
    tool: AITool,
    response: string,
    levelFiles: Map<number, FileContent[]>,
    realityResults: Map<number, { report?: RealityReport; checks?: RealityCheckRef[] }>
  ): SignalResult[] {
    const results: SignalResult[] = [];

    try {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) { throw new Error('No JSON array found'); }
      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        level: number;
        detected: boolean;
        score: number;
        finding: string;
        confidence: 'high' | 'medium' | 'low';
      }>;

      for (const item of parsed) {
        const level = item.level;
        const category = this.levelCategory(level);
        const files = levelFiles.get(level) || [];
        const realityData = realityResults.get(level);

        const result: SignalResult = {
          signalId: `${tool}_l${level}_${category}`,
          level: level as MaturityLevel,
          detected: item.detected,
          score: Math.max(0, Math.min(100, item.score)),
          finding: item.finding,
          files: files.map(f => f.relativePath),
          modelUsed: this.copilotClient.getModelName(),
          confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'medium',
        };
        if (realityData?.checks) { result.realityChecks = realityData.checks; }
        results.push(result);
      }
    } catch (err) {
      logger.warn('Batch response parsing failed, falling back to deterministic for all levels', { error: err instanceof Error ? err.message : String(err) });
      // Fallback: deterministic for all levels
      for (const [level, files] of levelFiles) {
        const category = this.levelCategory(level);
        const realityData = realityResults.get(level);
        const result = this.evaluateToolLevelDeterministic(tool, level, category, files, realityData?.report);
        if (realityData?.checks) { result.realityChecks = realityData.checks; }
        results.push(result);
      }
    }

    // Add empty results for levels without files
    for (const [level, files] of levelFiles) {
      if (files.length === 0 && !results.some(r => r.level === level)) {
        const category = this.levelCategory(level);
        results.push({
          signalId: `${tool}_l${level}_${category}`,
          level: level as MaturityLevel,
          detected: false,
          score: 0,
          finding: `${AI_TOOLS[tool].name} does not have ${category.replace(/_/g, ' ')} files`,
          files: [],
          confidence: 'high',
        });
      }
    }

    return results;
  }

  // ─── Batch Signal Evaluation ──────────────────────────────────────

  private async batchEvaluateSignals(
    signals: LevelSignal[],
    workspaceUri: vscode.Uri,
    context: ProjectContext,
    quickMode: boolean,
    token?: vscode.CancellationToken,
    tool?: AITool
  ): Promise<SignalResult[]> {
    // Gather files for all signals first
    logger.info(`Phase 3c: Gathering files for ${signals.length} signals...`);
    const signalFiles = new Map<string, FileContent[]>();
    const filePromises = signals.map(async (signal) => {
      const files = await this.findFiles(signal.filePatterns, workspaceUri);
      signalFiles.set(signal.id, files);
    });
    await Promise.all(filePromises);

    const results: SignalResult[] = [];

    // Filter to signals that have files and need LLM evaluation
    const evaluableSignals = signals.filter(s => {
      const files = signalFiles.get(s.id);
      return files && files.length > 0;
    });

    // Add "not detected" for signals with no files
    for (const signal of signals) {
      const files = signalFiles.get(signal.id) || [];
      if (files.length === 0) {
        results.push({
          signalId: signal.id,
          level: signal.level,
          detected: false,
          score: 0,
          finding: `Not detected: ${signal.description}`,
          files: [],
          confidence: 'high',
        });
      }
    }

    if (evaluableSignals.length === 0) { return results; }

    // Quick mode or no LLM: deterministic for all
    if (quickMode || !this.copilotClient.isAvailable()) {
      for (const signal of evaluableSignals) {
        results.push(this.evaluateDeterministic(signal, signalFiles.get(signal.id)!));
      }
      return results;
    }

    // Check cache for all signals first
    const uncachedSignals: LevelSignal[] = [];
    for (const signal of evaluableSignals) {
      const files = signalFiles.get(signal.id)!;
      const cacheKey = files.map(f => f.content);
      const cached = this.cache.get(signal.id, cacheKey);
      if (cached) {
        results.push({
          signalId: signal.id,
          level: signal.level,
          detected: cached.result !== 'fail',
          score: cached.result === 'pass' ? 80 : cached.result === 'fail' ? 0 : 50,
          finding: cached.finding,
          files: files.map(f => f.relativePath),
          modelUsed: `${this.copilotClient.getModelName()} (cached)`,
          confidence: cached.confidence,
        });
      } else {
        uncachedSignals.push(signal);
      }
    }

    if (uncachedSignals.length === 0) {
      logger.info(`Phase 3c: All ${evaluableSignals.length} signals cached`);
      return results;
    }

    logger.info(`Phase 3c: ${uncachedSignals.length} uncached signals, sending to ${this.copilotClient.getFastModelName()} (agent: ${tool ? AI_TOOLS[tool]?.name + ' expert' : 'generic'})...`);

    // Build batch prompt for all uncached signals
    const signalSections = uncachedSignals.map(signal => {
      const files = signalFiles.get(signal.id)!;
      const fileContents = files.slice(0, 3).map(f =>
        `### ${f.relativePath}\n\`\`\`\n${f.content.slice(0, 1500)}\n\`\`\``
      ).join('\n');
      return `--- SIGNAL: "${signal.name}" (ID: ${signal.id}, Level ${signal.level}) ---
${signal.description}
${fileContents}`;
    }).join('\n\n');

    const expertPrompt = tool ? getPlatformExpertPrompt(tool) : '';
    const toolName = tool ? (AI_TOOLS[tool]?.name || tool) : 'AI agent';

    const prompt = `${expertPrompt}

You are now EVALUATING (not generating) MULTIPLE AI Agent Readiness signals for **${toolName}** in a single pass.

Project REALITY:
- Languages: ${context.languages.join(', ')}
- Type: ${context.projectType}
- Package manager: ${context.packageManager}
- Directory structure:
${context.directoryTree.slice(0, 600)}

${signalSections}

For EACH signal, cross-reference files against actual project structure. Score 0-100 based on accuracy, completeness, quality.

Respond with ONLY valid JSON array:
[
  {"signalId": "signal_id_here", "detected": true/false, "score": 0-100, "finding": "one sentence", "confidence": "high|medium|low"}
]`;

    try {
      const response = await this.copilotClient.analyzeFast(prompt, token);
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Array<{
          signalId: string;
          detected: boolean;
          score: number;
          finding: string;
          confidence: 'high' | 'medium' | 'low';
        }>;

        for (const item of parsed) {
          const signal = uncachedSignals.find(s => s.id === item.signalId);
          if (!signal) { continue; }
          const files = signalFiles.get(signal.id)!;

          // Cache the result
          this.cache.set(signal.id, files.map(f => f.content), {
            result: item.detected ? 'pass' : 'fail',
            finding: item.finding,
            confidence: item.confidence,
            cachedAt: new Date().toISOString(),
          });

          results.push({
            signalId: signal.id,
            level: signal.level,
            detected: item.detected,
            score: Math.max(0, Math.min(100, item.score)),
            finding: item.finding,
            files: files.map(f => f.relativePath),
            modelUsed: this.copilotClient.getModelName(),
            confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'medium',
          });
        }

        // Any signals not in response → deterministic fallback
        for (const signal of uncachedSignals) {
          if (!results.some(r => r.signalId === signal.id)) {
            results.push(this.evaluateDeterministic(signal, signalFiles.get(signal.id)!));
          }
        }
      } else {
        throw new Error('No JSON array');
      }
    } catch (err) {
      logger.warn('Batch signal evaluation failed, falling back to deterministic', { error: err instanceof Error ? err.message : String(err) });
      for (const signal of uncachedSignals) {
        results.push(this.evaluateDeterministic(signal, signalFiles.get(signal.id)!));
      }
    }

    return results;
  }

  private async buildToolLevelPrompt(
    tool: AITool,
    level: number,
    category: string,
    files: FileContent[],
    context: ProjectContext,
    realitySummary: string = ''
  ): Promise<string> {
    const toolConfig = AI_TOOLS[tool];
    const levelDescriptions: Record<number, string> = {
      2: `INSTRUCTIONS: Does ${toolConfig.name} have clear, accurate instructions that tell the agent how to behave in this specific project? Check: Are paths referenced correct? Does the tech stack match reality? Are conventions specific to this project?`,
      3: `SKILLS & TOOLS: Does ${toolConfig.name} have reusable skills, tool integrations (MCP), safe-command lists, or persistent context (memory banks)? Check: Are tool configs valid? Are skills actionable? Is the memory bank up-to-date?`,
      4: `WORKFLOWS: Does ${toolConfig.name} have end-to-end playbooks an agent can follow start-to-finish? Check: Are steps sequenced? Are there validation/exit criteria? Do workflows reference actual tools and files?`,
      5: `MEMORY & FEEDBACK: Does ${toolConfig.name} have a mechanism to record learnings, update context, and improve over time? Check: Is the memory bank update workflow defined? Are retrospectives recorded? Is there an eval harness?`,
    };

    const fileContents = files.slice(0, 8).map(f =>
      `### ${f.relativePath}\n\`\`\`\n${f.content.slice(0, 2000)}\n\`\`\``
    ).join('\n\n');

    const realityBlock = realitySummary
      ? `\n${realitySummary}\n\nUse these automated reality checks as evidence. If many paths are invalid or commands are wrong, score lower.\n`
      : '';

    // Try to use live docs; fall back to static reasoningContext
    let docsBlock: string;
    if (this.docsCache) {
      const liveDocs = await this.docsCache.getToolDocs(tool);
      if (liveDocs) {
        docsBlock = `OFFICIAL ${toolConfig.name.toUpperCase()} DOCUMENTATION (live):
${liveDocs}

Use this documentation to evaluate whether the files follow ${toolConfig.name}'s current best practices.`;
      } else {
        docsBlock = this.buildStaticDocsBlock(toolConfig);
      }
    } else {
      docsBlock = this.buildStaticDocsBlock(toolConfig);
    }

    return `${getPlatformExpertPrompt(tool)}

You are now EVALUATING (not generating) a repository's readiness for **${toolConfig.name}** (AI coding assistant).

EVALUATION: Level ${level} — ${category.replace(/_/g, ' ')}
${levelDescriptions[level] || ''}

${docsBlock}

Evaluate whether the files follow ${toolConfig.name}'s expected patterns, not generic "good documentation" standards.

Project REALITY (ground truth):
- Languages: ${context.languages.join(', ')}
- Type: ${context.projectType}
- Package manager: ${context.packageManager}
- Directory structure:
${context.directoryTree.slice(0, 800)}
${realityBlock}
${toolConfig.name} files found:
${fileContents}

Cross-reference the file content against the actual project structure. Score based on:
1. ACCURACY — do references match the real project? (paths, commands, tech stack)
2. COMPLETENESS — does it cover the major components visible in the directory tree?
3. QUALITY — is it specific and actionable, not generic boilerplate?
4. DEPTH — how thorough is the coverage for this level?
5. TOOL-SPECIFIC — does it follow ${toolConfig.name}'s expected patterns and avoid its anti-patterns?

Score 0-100:
- 90-100: Excellent — accurate, complete, project-specific, follows ${toolConfig.name} best practices
- 70-89: Good — mostly accurate, minor gaps
- 50-69: Partial — covers some aspects, missing others
- 30-49: Weak — generic or has significant inaccuracies
- 0-29: Poor — boilerplate, severely outdated, or largely inaccurate

Respond with ONLY valid JSON:
{"detected": true/false, "score": 0-100, "finding": "one sentence with specific evidence", "confidence": "high|medium|low"}`;
  }

  private buildStaticDocsBlock(toolConfig: typeof AI_TOOLS[AITool]): string {
    return `WHAT ${toolConfig.name.toUpperCase()} EXPECTS:
${toolConfig?.reasoningContext?.structureExpectations ?? ''}

QUALITY MARKERS for ${toolConfig.name}:
${toolConfig?.reasoningContext?.qualityMarkers ?? ''}

ANTI-PATTERNS for ${toolConfig.name}:
${toolConfig?.reasoningContext?.antiPatterns ?? ''}`;
  }

  private async evaluateSignal(
    signal: LevelSignal,
    workspaceUri: vscode.Uri,
    context: ProjectContext,
    quickMode: boolean,
    token?: vscode.CancellationToken
  ): Promise<SignalResult> {
    // 1. Discover files matching the signal's patterns
    const files = await this.findFiles(signal.filePatterns, workspaceUri);

    // 2. If no files found, signal not detected
    if (files.length === 0) {
      return {
        signalId: signal.id,
        level: signal.level,
        detected: false,
        score: 0,
        finding: `Not detected: ${signal.description}`,
        files: [],
        confidence: 'high',
      };
    }

    // 4. Deterministic scoring (quick mode)
    if (quickMode || !this.copilotClient.isAvailable()) {
      return this.evaluateDeterministic(signal, files);
    }

    // 5. LLM deep analysis
    return this.evaluateWithLLM(signal, files, context, token);
  }

  private evaluateDeterministic(signal: LevelSignal, files: FileContent[]): SignalResult {
    const fileCount = files.length;
    const countScore = Math.min(1, Math.log2(1 + fileCount) / Math.log2(1 + 5));

    let markerScore = 0;
    if (signal.contentMarkers.length > 0) {
      const allContent = files.map(f => f.content).join('\n');
      const markersFound = signal.contentMarkers.filter(marker =>
        new RegExp(marker, 'i').test(allContent)
      ).length;
      markerScore = markersFound / signal.contentMarkers.length;
    } else {
      markerScore = 1;
    }

    // Penalize tiny files (< 50 chars likely empty/placeholder)
    const substantialFiles = files.filter(f => f.content.length > 50);
    const substanceRatio = fileCount > 0 ? substantialFiles.length / fileCount : 0;

    const rawScore = Math.round(((countScore * 0.3) + (markerScore * 0.4) + (substanceRatio * 0.3)) * 100);

    return {
      signalId: signal.id,
      level: signal.level,
      detected: true,
      score: rawScore,
      finding: `Found ${fileCount} file(s): ${files.slice(0, 3).map(f => f.relativePath).join(', ')}${fileCount > 3 ? ` (+${fileCount - 3} more)` : ''}`,
      files: files.map(f => f.relativePath),
      confidence: 'medium',
    };
  }

  private async evaluateWithLLM(
    signal: LevelSignal,
    files: FileContent[],
    context: ProjectContext,
    token?: vscode.CancellationToken
  ): Promise<SignalResult> {
    // Check cache
    const cacheKey = files.map(f => f.content);
    const cached = this.cache.get(signal.id, cacheKey);
    if (cached) {
      return {
        signalId: signal.id,
        level: signal.level,
        detected: cached.result !== 'fail',
        score: cached.result === 'pass' ? 80 : cached.result === 'fail' ? 0 : 50,
        finding: cached.finding,
        files: files.map(f => f.relativePath),
        modelUsed: `${this.copilotClient.getModelName()} (cached)`,
        confidence: cached.confidence,
      };
    }

    try {
      const prompt = await this.buildSignalPrompt(signal, files, context);
      const response = await this.copilotClient.analyzeFast(prompt, token);
      const parsed = this.parseResponse(response);

      if (parsed) {
        // Cache result
        this.cache.set(signal.id, cacheKey, {
          result: parsed.detected ? 'pass' : 'fail',
          finding: parsed.finding,
          confidence: parsed.confidence,
          cachedAt: new Date().toISOString(),
        });

        return {
          signalId: signal.id,
          level: signal.level,
          detected: parsed.detected,
          score: parsed.score,
          finding: parsed.finding,
          files: files.map(f => f.relativePath),
          modelUsed: this.copilotClient.getModelName(),
          confidence: parsed.confidence,
        };
      }
    } catch (err) {
      logger.warn('LLM signal evaluation failed, falling back to deterministic', { error: err instanceof Error ? err.message : String(err) });
    }

    const det = this.evaluateDeterministic(signal, files);
    det.modelUsed = 'deterministic (LLM fallback)';
    return det;
  }

  private async buildSignalPrompt(signal: LevelSignal, files: FileContent[], context: ProjectContext, tool?: AITool): Promise<string> {
    const fileContents = files.slice(0, 5).map(f =>
      `### ${f.relativePath}\n\`\`\`\n${f.content.slice(0, 2000)}\n\`\`\``
    ).join('\n\n');

    // Determine which tool(s) this signal belongs to
    const { PlatformSignalFilter } = require('../scoring/signalFilter');
    const ownerTools = (Object.entries(AI_TOOLS) as [AITool, typeof AI_TOOLS[AITool]][])
      .filter(([key]) => PlatformSignalFilter.isRelevant(signal.id, key as AITool))
      .map(([key, cfg]) => ({ key: key as AITool, cfg }));

    // Use expert prompt for the primary tool
    const primaryTool = tool || ownerTools[0]?.key;
    const expertPrompt = primaryTool ? getPlatformExpertPrompt(primaryTool) : '';

    let toolContextBlock = '';
    if (ownerTools.length > 0) {
      const blocks: string[] = [];
      for (const { key, cfg } of ownerTools) {
        let docsContent: string;
        if (this.docsCache) {
          const liveDocs = await this.docsCache.getToolDocs(key);
          docsContent = liveDocs || this.buildStaticDocsBlock(cfg);
        } else {
          docsContent = this.buildStaticDocsBlock(cfg);
        }
        blocks.push(`\nTOOL: ${cfg.name}\n${docsContent}\n`);
      }
      toolContextBlock = blocks.join('\n');
    }

    return `${expertPrompt}

You are now EVALUATING (not generating) a repository's AI Agent Readiness — specifically whether instruction/context files are ACCURATE and up-to-date.

SIGNAL: "${signal.name}" (Level ${signal.level})${ownerTools.length > 0 ? ` — belongs to: ${ownerTools.map(t => t.cfg.name).join(', ')}` : ''}
${toolContextBlock}
Project REALITY (ground truth):
- Languages detected: ${context.languages.join(', ')}
- Project type: ${context.projectType}
- Package manager: ${context.packageManager}
- Actual directory structure:
${context.directoryTree.slice(0, 800)}

Files to evaluate:
${fileContents}

CRITICAL: Cross-reference the file content against the ACTUAL project structure above. Check for:

1. **Path accuracy**: Do file paths mentioned in the content (e.g., "src/api/", "python-workspace/") actually exist in the directory tree? Flag any references to non-existent paths.

2. **Tech stack accuracy**: Does the content correctly describe the languages and tools? If it says "TypeScript project" but the repo is Python, that's a FAIL. If it mentions "npm" but the project uses "uv", that's inaccurate.

3. **Command accuracy**: Do build/test/run commands match the actual package manager and project structure? (e.g., "pip install" vs "uv sync", "npm test" vs "pytest")

4. **Stale content**: Are there references to tools, patterns, or files that appear outdated or no longer match the current codebase?

5. **Completeness**: Does the content cover the major components visible in the directory tree, or does it only describe part of the project?

6. **Specificity**: Is this genuinely about THIS project, or is it generic boilerplate that could apply to any repo?
${ownerTools.length > 0 ? `\n7. **Tool-specific patterns**: Does the content follow the expected patterns for ${ownerTools.map(t => t.cfg.name).join('/')}, or does it exhibit known anti-patterns?\n` : ''}
Score 0-100 where:
- 90-100: Content is accurate, up-to-date, and matches the actual project
- 70-89: Mostly accurate with minor gaps or slightly outdated references  
- 50-69: Partially accurate but has significant gaps or stale content
- 30-49: Contains inaccuracies or references that don't match reality
- 0-29: Mostly inaccurate, generic boilerplate, or severely outdated

Respond with ONLY valid JSON:
{"detected": true/false, "score": 0-100, "finding": "one sentence citing specific accuracy issues or confirming accuracy", "confidence": "high|medium|low"}`;
  }

  private getLevelContext(level: MaturityLevel): string {
    const contexts: Record<MaturityLevel, string> = {
      1: 'Does the repo have any documentation at all?',
      2: 'Do instructions tell the agent HOW to behave in this specific repo?',
      3: 'Are there REUSABLE capabilities the agent can invoke (skills, tools, MCP)?',
      4: 'Is there an END-TO-END workflow the agent can follow from start to finish?',
      5: 'Can the agent RECORD learnings and IMPROVE its own behavior over time?',
      6: 'Can MULTIPLE agents COORDINATE across repos/services autonomously?',
    };
    return contexts[level];
  }

  private async findFiles(patterns: string[], workspaceUri: vscode.Uri, max: number = 10): Promise<FileContent[]> {
    const files: FileContent[] = [];
    for (const pattern of patterns) {
      if (files.length >= max) break;
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceUri, pattern), EXCLUDE_GLOB, max - files.length
      );
      for (const uri of uris) {
        try {
          const raw = await vscode.workspace.fs.readFile(uri);
          const content = Buffer.from(raw).toString('utf-8');
          const lines = content.split('\n');
          const truncated = lines.length > 500 ? lines.slice(0, 500).join('\n') + '\n...(truncated)' : content;
          files.push({ path: uri.fsPath, content: truncated, relativePath: vscode.workspace.asRelativePath(uri) });
        } catch (err) {
          logger.warn('Failed to read file, skipping', { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return files;
  }

  // ─── Business Logic Validation ──────────────────────────────────────

  private async validateBusinessLogic(
    files: FileContent[],
    workspaceUri: vscode.Uri,
    context: ProjectContext,
    token?: vscode.CancellationToken,
    tool?: AITool
  ): Promise<{ score: number; findings: string[] }> {
    if (!this.copilotClient.isAvailable()) {
      return { score: -1, findings: [] };
    }

    const sourceEvidence = await this.gatherSourceEvidence(workspaceUri, context);

    const docContents = files.slice(0, 5).map(f =>
      `### ${f.relativePath}\n\`\`\`\n${f.content.slice(0, 3000)}\n\`\`\``
    ).join('\n\n');

    const sourceContents = sourceEvidence.slice(0, 5).map(f =>
      `### ${f.relativePath}\n\`\`\`\n${f.content.slice(0, 1000)}\n\`\`\``
    ).join('\n\n');

    const toolConfig = tool ? AI_TOOLS[tool] : undefined;
    let toolContextBlock = '';
    if (toolConfig) {
      if (this.docsCache && tool) {
        const liveDocs = await this.docsCache.getToolDocs(tool);
        if (liveDocs) {
          toolContextBlock = `
TOOL-SPECIFIC CONTEXT (${toolConfig.name}, live docs):
${liveDocs}

Also verify that the documentation follows ${toolConfig.name}'s expected patterns and conventions.
`;
        } else {
          toolContextBlock = `
TOOL-SPECIFIC CONTEXT (${toolConfig.name}):
Expected instruction format: ${toolConfig?.reasoningContext?.instructionFormat ?? ''}
Expected structure: ${toolConfig?.reasoningContext?.structureExpectations ?? ''}
Quality markers: ${toolConfig?.reasoningContext?.qualityMarkers ?? ''}
Anti-patterns: ${toolConfig?.reasoningContext?.antiPatterns ?? ''}

Also verify that the documentation follows ${toolConfig.name}'s expected patterns and conventions.
`;
        }
      } else {
        toolContextBlock = `
TOOL-SPECIFIC CONTEXT (${toolConfig.name}):
Expected instruction format: ${toolConfig?.reasoningContext?.instructionFormat ?? ''}
Expected structure: ${toolConfig?.reasoningContext?.structureExpectations ?? ''}
Quality markers: ${toolConfig?.reasoningContext?.qualityMarkers ?? ''}
Anti-patterns: ${toolConfig?.reasoningContext?.antiPatterns ?? ''}

Also verify that the documentation follows ${toolConfig.name}'s expected patterns and conventions.
`;
      }
    }

    const prompt = `You are a code auditor verifying that documentation ACCURATELY describes what the code actually does.

DOCUMENTATION TO VERIFY:
${docContents}

ACTUAL SOURCE CODE (samples from the repo):
${sourceContents}

ACTUAL DIRECTORY STRUCTURE:
${context.directoryTree.slice(0, 1000)}

DETECTED LANGUAGES: ${context.languages.join(', ')}
DETECTED FRAMEWORKS: ${context.frameworks.join(', ')}
${toolContextBlock}

YOUR TASK: Cross-reference the business logic claims in the documentation against the actual code. Check:

1. **Purpose accuracy**: Does the described purpose/mission match what the code actually implements? If docs say "bot detection system" — are there files related to bot detection?

2. **Component accuracy**: Are described components/modules real? If docs say "3 components: pipeline, detector, reporter" — do those exist in the directory tree?

3. **Feature accuracy**: Are described features actually implemented? If docs say "ML model training" — are there training scripts/configs?

4. **Architecture accuracy**: Does the described architecture match the actual code organization? If docs say "microservices" but it's a monolith — that's inaccurate.

5. **Domain accuracy**: Do domain-specific descriptions match the code? If a domain doc describes "KQL query optimization" — are there KQL files?

6. **Scope accuracy**: Does the documentation cover ALL major components, or does it ignore significant parts of the codebase?

Rate the business logic accuracy 0-100:
- 90-100: Documentation accurately describes what the code does
- 70-89: Mostly accurate, minor gaps or slightly outdated claims
- 50-69: Partially accurate — some claims don't match reality
- 30-49: Significant inaccuracies — docs describe something different from the code
- 0-29: Documentation is misleading or describes a different project

List SPECIFIC findings — cite the document claim and the code evidence for/against it.

Respond with ONLY valid JSON:
{
  "score": 0-100,
  "findings": [
    "✅ productContext.md claims 'bot detection' — confirmed: found bot_classification/ and bot_detection/ in source",
    "⚠️ project-overview.md claims 'reporting dashboard' — no dashboard-related files found",
    "❌ README says 'REST API' — no API routes or server setup found in source"
  ]
}`;

    try {
      const response = await this.copilotClient.analyzeFast(prompt, token);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          score: typeof parsed.score === 'number' ? Math.max(0, Math.min(100, parsed.score)) : 50,
          findings: Array.isArray(parsed.findings) ? parsed.findings.map(String) : [],
        };
      }
    } catch (err) {
      logger.warn('Business logic validation failed, returning default score', { error: err instanceof Error ? err.message : String(err) });
    }
    return { score: -1, findings: [] };
  }

  private async gatherSourceEvidence(
    workspaceUri: vscode.Uri,
    _context: ProjectContext
  ): Promise<FileContent[]> {
    const evidence: FileContent[] = [];
    const exclude = '**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/vendor/**,**/__pycache__/**,**/.venv/**,**/target/**';

    // 1. Entry points — main files, index files, app files
    const entryPatterns = [
      '**/main.{py,ts,js,go,rs}', '**/app.{py,ts,js}', '**/index.{ts,js}',
      '**/server.{py,ts,js}', '**/Program.cs', '**/Startup.cs',
      'src/**/mod.rs', '**/cmd/main.go',
    ];
    for (const pattern of entryPatterns) {
      if (evidence.length >= 8) break;
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceUri, pattern), exclude, 2
      );
      for (const uri of uris) {
        try {
          const raw = await vscode.workspace.fs.readFile(uri);
          const content = Buffer.from(raw).toString('utf-8');
          evidence.push({
            path: uri.fsPath,
            content: content.split('\n').slice(0, 50).join('\n'),
            relativePath: vscode.workspace.asRelativePath(uri),
          });
        } catch (err) {
          logger.warn('Failed to read source evidence file, skipping', { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    // 2. Config/manifest files that describe the project
    const configPatterns = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', '*.csproj'];
    for (const pattern of configPatterns) {
      if (evidence.length >= 12) break;
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceUri, pattern), exclude, 1
      );
      for (const uri of uris) {
        try {
          const raw = await vscode.workspace.fs.readFile(uri);
          const content = Buffer.from(raw).toString('utf-8');
          evidence.push({
            path: uri.fsPath,
            content: content.split('\n').slice(0, 80).join('\n'),
            relativePath: vscode.workspace.asRelativePath(uri),
          });
        } catch (err) {
          logger.warn('Failed to read config evidence file, skipping', { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    return evidence;
  }

  private parseResponse(response: string): { detected: boolean; score: number; finding: string; confidence: 'high' | 'medium' | 'low' } | null {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.detected !== 'boolean' || typeof parsed.score !== 'number') return null;
      return {
        detected: parsed.detected,
        score: Math.max(0, Math.min(100, parsed.score)),
        finding: String(parsed.finding || ''),
        confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
      };
    } catch (err) {
      logger.error('Failed to parse LLM response JSON', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }
}
