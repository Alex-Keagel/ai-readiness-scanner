import * as vscode from 'vscode';
import { WorkspaceScanner } from './scanner/workspaceScanner';
import { SidebarPanel } from './ui/sidebarPanel';
import { StatusBarManager } from './ui/statusBar';
import { WebviewReportPanel } from './ui/webviewPanel';
import { ChatParticipant } from './chat/participant';
import { MarkdownReportGenerator } from './report/markdownGenerator';
import { RemediationEngine } from './remediation/remediationEngine';
import { CopilotClient } from './llm/copilotClient';
import { MultiModelClient } from './llm/multiModelClient';
import { ReadinessReport, MATURITY_LEVELS, AITool, AI_TOOLS } from './scoring/types';
import { MigrationEngine } from './remediation/migrationEngine';
import { InsightsEngine } from './scoring/insightsEngine';
import { RepoMap } from './scanner/repoMapper';
import { SessionPoller } from './live/sessionPoller';
import { LiveMetricsEngine } from './live/metricsEngine';
import { LiveStatusBar } from './live/liveStatusBar';
import { LivePanel } from './live/livePanel';
import { VibeReportGenerator } from './live/vibeReport';
import { RunStorage } from './storage/runStorage';
import { FixStorage } from './storage/fixStorage';
import { GraphPanel } from './ui/graphPanel';
import { InsightsPanel } from './ui/insightsPanel';
import { GuidePanel } from './ui/guidePanel';
import { ComparisonPanel } from './ui/comparisonPanel';
import { RecommendationsPanel } from './ui/recommendationsPanel';
import { NarrativeGenerator } from './report/narrativeGenerator';
import { SemanticCache, WorkspaceIndexer, SemanticMCPProvider } from './semantic';
import { initLogger, logger } from './logging';
import { getPlatformExpertPrompt, formatProjectContext } from './remediation/fixPrompts';
import { humanizeSignalId, deduplicateInsights } from './utils';
import { DocsCache } from './llm/docsCache';

let currentReport: ReadinessReport | undefined;
let sidebarPanel: SidebarPanel;
let statusBarManager: StatusBarManager;
let livePoller: SessionPoller | undefined;
let liveEngine: LiveMetricsEngine | undefined;
let isBusy = false;

/** Guard against concurrent operations */
function acquireLock(operation: string): boolean {
  if (isBusy) {
    vscode.window.showWarningMessage(`Please wait — ${operation} is still running.`);
    return false;
  }
  isBusy = true;
  vscode.commands.executeCommand('setContext', 'ai-readiness.isBusy', true);
  return true;
}

function releaseLock(): void {
  isBusy = false;
  vscode.commands.executeCommand('setContext', 'ai-readiness.isBusy', false);
}

/** Get the current report only if it matches the active workspace */
function getValidReport(): ReadinessReport | undefined {
  if (!currentReport) return undefined;
  const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.name;
  if (currentWorkspace && currentReport.projectName !== currentWorkspace) {
    logger.info(`Report mismatch: report is for "${currentReport.projectName}" but workspace is "${currentWorkspace}" — clearing stale report`);
    currentReport = undefined;
    return undefined;
  }
  return currentReport;
}

function repairNarrativeSections(report: ReadinessReport, context: string): boolean {
  if (!report.narrativeSections) {
    return false;
  }

  const narrativeGen = new NarrativeGenerator(copilotClient);
  const changed = narrativeGen.sanitizeNarrativeSections(report);
  if (changed) {
    logger.info(`${context}: repaired cached narrative sections against current scan signals`);
  }
  return changed;
}

let liveStatusBar: LiveStatusBar | undefined;
let runStorage: RunStorage;
let fixStorage: FixStorage;
let multiModelClient: MultiModelClient;
let copilotClient: CopilotClient;

export function activate(context: vscode.ExtensionContext) {
  initLogger(context);
  logger.info('AI Readiness Scanner activated');

  runStorage = new RunStorage(context);
  fixStorage = new FixStorage(context);

  // Set initial context based on existing runs
  vscode.commands.executeCommand('setContext', 'ai-readiness.hasResults', runStorage.getRuns().length > 0);
  vscode.commands.executeCommand('setContext', 'ai-readiness.hasMultipleRuns', runStorage.getRuns().length >= 2);

  // Restore latest report from saved runs (only if it matches current workspace)
  const latestRun = runStorage.getLatestRun();
  const currentWorkspaceName = vscode.workspace.workspaceFolders?.[0]?.name;
  if (latestRun && (!currentWorkspaceName || latestRun.report.projectName === currentWorkspaceName)) {
    currentReport = latestRun.report;
  }

  sidebarPanel = new SidebarPanel(context.extensionUri, runStorage);
  statusBarManager = new StatusBarManager();
  const reportGenerator = new MarkdownReportGenerator();
  copilotClient = new CopilotClient();
  multiModelClient = new MultiModelClient();
  const semanticCache = new SemanticCache(context);
  const workspaceIndexer = new WorkspaceIndexer(semanticCache, copilotClient);
  const docsCache = new DocsCache(context);
  const scanner = new WorkspaceScanner(context, workspaceIndexer, copilotClient);
  const mcpProvider = new SemanticMCPProvider(semanticCache, workspaceIndexer.getVectorStore());
  mcpProvider.register(context);
  context.subscriptions.push({ dispose: () => semanticCache.dispose() });
  const remediationEngine = new RemediationEngine(copilotClient);

  if (currentReport && repairNarrativeSections(currentReport, 'Activation')) {
    void runStorage.updateLatestReport(currentReport);
  }

  // Clear stale data when workspace changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      logger.info('Workspace changed — clearing stale report data');
      currentReport = undefined;
      InsightsPanel.currentPanel = undefined;
      statusBarManager.clear();
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarPanel.viewType, sidebarPanel)
  );

  statusBarManager.create(context);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('ai-readiness.fullScan', async () => {
      if (!acquireLock('a scan')) return;
      try {
        const tool = await pickAITool();
        if (!tool) { releaseLock(); return; }
        await runScan(scanner, context, tool);
      } catch (err) {
        logger.error('Command fullScan failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        releaseLock();
      }
    }),

    vscode.commands.registerCommand('ai-readiness.showReport', () => {
      try {
        let report = getValidReport();
        if (!report) {
          const latestRun = runStorage.getLatestRun();
          if (latestRun) { report = latestRun.report; currentReport = report; }
        }
        if (report) {
          repairNarrativeSections(report, 'showReport');
          WebviewReportPanel.createOrShow(context.extensionUri, report, report.repoMap as RepoMap | undefined);
        } else {
          vscode.window.showInformationMessage(
            'No scan results yet. Run "AI Readiness: Full Scan" first.'
          );
        }
      } catch (err) {
        logger.error('Command showReport failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand('ai-readiness.generateReport', async () => {
      try {
        if (!currentReport) {
          vscode.window.showInformationMessage(
            'No scan results yet. Run "AI Readiness: Full Scan" first.'
          );
          return;
        }
        const markdown = reportGenerator.generate(currentReport);
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }

        const filePath = vscode.Uri.joinPath(
          workspaceFolder.uri,
          'AI_READINESS_REPORT.md'
        );
        await vscode.workspace.fs.writeFile(
          filePath,
          Buffer.from(markdown, 'utf-8')
        );
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showInformationMessage(
          `Report saved to ${filePath.fsPath}`
        );
      } catch (err) {
        logger.error('Command generateReport failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand('ai-readiness.fixAll', async () => {
      if (!acquireLock('Action Center')) return;
      try {
      const tool = await pickAITool();
      if (!tool) { releaseLock(); return; }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;

      let report = getValidReport();

      // Run all prerequisites in one progress flow
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Preparing Action Center...',
        cancellable: true,
      }, async (progress, token) => {
        // Step 1: Scan if no report exists
        if (!report) {
          progress.report({ message: '🔍 Scanning workspace...', increment: 10 });
          report = await scanner.scan(workspaceFolder.uri, false, progress, token, tool);
          currentReport = report;
          if (!report || token.isCancellationRequested) return;
        }

        // Step 2: Generate insights if not present
        if (!report.insights?.length) {
          progress.report({ message: '💡 Generating insights...', increment: 20 });
          try {
            if (!copilotClient.isAvailable()) {
              await copilotClient.initialize();
            }
            const insightsEng = new InsightsEngine(copilotClient);
            const rawInsights = await insightsEng.generateInsights(report!, token);
            report!.insights = rawInsights.map((i: any) => ({
              title: i.title || 'Untitled insight',
              recommendation: i.recommendation || i.description || '',
              severity: i.severity === 'nice-to-have' ? 'suggestion' as const : i.severity === 'critical' ? 'critical' as const : i.severity === 'important' ? 'important' as const : 'suggestion' as const,
              category: i.category || 'improvement',
              estimatedImpact: i.estimatedImpact ? `+${i.estimatedImpact} points` : undefined,
              affectedComponent: i.affectedComponent || i.affectedLanguage,
              confidenceScore: i.estimatedImpact ? Math.min(0.9, 0.5 + (i.estimatedImpact / 20) * 0.4) : 0.6,
            }));
            logger.info(`Action Center: generated ${report!.insights!.length} insights`);
          } catch (err) {
            logger.warn('Action Center: insight generation failed, continuing with signal-only recs', err);
          }
        }

        // Step 3: Run deep analysis (cross-reference instructions vs code)
        // Skip if already computed during Full Scan
        if (!(report as any).deepAnalysis) {
        progress.report({ message: '🔬 Deep analysis: cross-referencing instructions vs code...', increment: 15 });
        try {
          const { runDeepAnalysis } = await import('./deep');
          const deepResult = await runDeepAnalysis(workspaceFolder.uri, copilotClient, tool, progress, undefined, report?.projectContext?.projectType);
          // Store deep analysis data regardless of recommendation count
          (report as any).deepAnalysis = {
            instructionQuality: deepResult.crossRef.instructionQuality,
            coveragePercent: deepResult.crossRef.coveragePercent,
            gapCount: deepResult.crossRef.coverageGaps.length,
            driftCount: deepResult.crossRef.driftIssues.length,
            complexity: deepResult.complexity,
            callGraph: deepResult.callGraph,
            dataFlow: deepResult.dataFlow,
          };
          // Enrich knowledge graph
          if (report!.knowledgeGraph) {
            try {
              const { GraphBuilder } = await import("./graph/graphBuilder");
              new GraphBuilder().enrichWithDeepAnalysis(report!.knowledgeGraph as any, deepResult as any);
              logger.info(`Action Center: knowledge graph enriched`);
            } catch (enrichErr) { logger.debug("Knowledge graph enrichment failed", { error: String(enrichErr) }); }
          }
          // Merge deep recommendations into insights
          if (deepResult.recommendations.length > 0) {
            if (!report!.insights) report!.insights = [];
            for (const rec of deepResult.recommendations) {
              report!.insights.push({
                title: rec.title,
                recommendation: rec.suggestedContent || rec.description,
                severity: rec.severity === 'critical' ? 'critical' : rec.severity === 'important' ? 'important' : 'suggestion',
                category: rec.type,
                estimatedImpact: `+${Math.min(20, Math.max(1, Math.round(rec.impactScore / 5)))} points`,
                affectedComponent: rec.affectedModules.join(', '),
                confidenceScore: (rec as any).confidence || Math.min(0.9, 0.5 + (rec.impactScore / 100) * 0.4),
              });
            }
            logger.info(`Action Center: deep analysis added ${deepResult.recommendations.length} recommendations`);
          }
          // Deduplicate all insights (regular + deep merged)
          if (report!.insights && report!.insights.length > 0) {
            const before = report!.insights.length;
            report!.insights = deduplicateInsights(report!.insights);
            if (report!.insights.length < before) {
              logger.info(`Action Center: deduped insights ${before} → ${report!.insights.length}`);
            }
          }
        } catch (err) {
          logger.warn('Action Center: deep analysis failed, using standard insights', err);
        }
        } else {
          logger.info('Action Center: reusing deep analysis from scan');
        }

        // Step 4: Generate narrative if not present
        if (!report!.narrativeSections) {
          progress.report({ message: '📊 Generating report narrative...', increment: 10 });
          try {
            const narrativeGen = new NarrativeGenerator(copilotClient);
            report!.narrativeSections = await narrativeGen.generate(report!);
          } catch (err) {
            logger.warn('Action Center: narrative generation failed', err);
          }
        } else if (repairNarrativeSections(report!, 'Action Center')) {
          await runStorage.updateLatestReport(report!);
        }
      });

      if (!report) return;

      // Re-save report with deep analysis + narrative data to persist in workspaceState
      currentReport = report;
      await runStorage.updateLatestReport(report);

      // Auto-detect project context from README (no user input needed)
      let userContext = '';
      try {
        const readmeUris = await vscode.workspace.findFiles(
          new vscode.RelativePattern(workspaceFolder.uri, '{README.md,readme.md,README.rst}'),
          null, 1
        );
        if (readmeUris.length > 0) {
          const content = Buffer.from(await vscode.workspace.fs.readFile(readmeUris[0])).toString('utf-8');
          // Extract first 500 chars as project context (title + description)
          userContext = content.slice(0, 500).replace(/\n/g, ' ').trim();
          logger.info(`Action Center: auto-detected project context from README (${userContext.length} chars)`);
        }
      } catch { /* no README — proceed without context */ }

      // Initialize multi-model client
      if (!multiModelClient.isAvailable()) {
        await multiModelClient.initialize();
      }

      RecommendationsPanel.createOrShow(
        report, tool, userContext,
        createGenerateHandler(report!, tool, workspaceFolder.uri, remediationEngine),
        createPreviewHandler(report!, tool, workspaceFolder.uri, remediationEngine),
        createChatHandler(report!, tool),
        fixStorage
      );
      } catch (err) {
        logger.error('Command fixAll failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        releaseLock();
      }
    }),

    vscode.commands.registerCommand('ai-readiness.fixSignal', async (item?: unknown) => {
      try {
      if (!currentReport) {
        vscode.window.showInformationMessage('No scan results yet. Run a scan first.');
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) { return; }

      if (!copilotClient.isAvailable()) {
        await copilotClient.initialize();
        if (!copilotClient.isAvailable()) {
          vscode.window.showErrorMessage('Copilot LLM required for remediation.');
          return;
        }
      }

      // Get all missing signals for quick pick
      const missingSignals = currentReport.levels
        .flatMap(ls => ls.signals)
        .filter(s => !s.detected);

      if (missingSignals.length === 0) {
        vscode.window.showInformationMessage('No missing signals to fix!');
        return;
      }

      const picks = missingSignals.map(s => ({
        label: `$(error) ${s.signalId}`,
        description: `L${s.level}`,
        detail: s.finding,
        signal: s,
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a signal to fix',
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (!selected) { return; }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `AI Readiness: Fixing ${selected.signal.signalId}...`,
          cancellable: true,
        },
        async (_progress, token) => {
          const signal = {
            id: selected.signal.signalId,
            level: selected.signal.level,
            finding: selected.signal.finding,
            confidence: selected.signal.confidence,
            modelUsed: selected.signal.modelUsed,
          };
          const fix = await remediationEngine.fixSignal(
            signal,
            currentReport!.projectContext,
            workspaceFolder.uri,
            currentReport!.selectedTool as AITool,
            token
          );
          if (fix) {
            vscode.window.showInformationMessage(
              `Fixed ${selected.signal.signalId}. Re-scan to see updated score.`
            );
          } else {
            vscode.window.showWarningMessage(
              `Could not generate fix for ${selected.signal.signalId}.`
            );
          }
        }
      );
      } catch (err) {
        logger.error('Command fixSignal failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    // Open a specific saved run
    vscode.commands.registerCommand('ai-readiness.openRun', (runId: string) => {
      try {
        const run = runStorage.getRun(runId);
        if (run) {
          currentReport = run.report;
          repairNarrativeSections(run.report, 'openRun');
          WebviewReportPanel.createOrShow(context.extensionUri, run.report, run.report.repoMap as RepoMap | undefined);
        }
      } catch (err) {
        logger.error('Command openRun failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    // Delete a saved run
    vscode.commands.registerCommand('ai-readiness.deleteRun', async (runIdOrItem?: string | any) => {
      try {
        const runId = typeof runIdOrItem === 'string' ? runIdOrItem : runIdOrItem?.command?.arguments?.[0];
        if (!runId) { return; }
        await runStorage.deleteRun(runId);
        vscode.commands.executeCommand('setContext', 'ai-readiness.hasResults', runStorage.getRuns().length > 0);
        vscode.commands.executeCommand('setContext', 'ai-readiness.hasMultipleRuns', runStorage.getRuns().length >= 2);
        sidebarPanel.refresh();
      } catch (err) {
        logger.error('Command deleteRun failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    // Clear all scan history
    vscode.commands.registerCommand('ai-readiness.clearHistory', async () => {
      try {
        const confirm = await vscode.window.showWarningMessage(
          'Delete all scan history? This cannot be undone.',
          { modal: true },
          'Delete All'
        );
        if (confirm !== 'Delete All') { return; }
        await runStorage.clearAll();
        await fixStorage.clearAll();
        await semanticCache.clear();
        currentReport = undefined;
        // Close any open panels
        try { (RecommendationsPanel.currentPanel as any)?.panel?.dispose(); } catch { /* */ }
        InsightsPanel.currentPanel = undefined;
        vscode.commands.executeCommand('setContext', 'ai-readiness.hasResults', false);
        vscode.commands.executeCommand('setContext', 'ai-readiness.hasMultipleRuns', false);
        sidebarPanel.refresh();
        vscode.window.showInformationMessage('All scan history, fix tracking, and caches cleared.');
      } catch (err) {
        logger.error('Command clearHistory failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    // Clear semantic cache
    vscode.commands.registerCommand('ai-readiness.clearSemanticCache', async () => {
      try {
        await semanticCache.clear();
        vscode.window.showInformationMessage('Semantic cache cleared. Next scan will re-index all files.');
      } catch (err) {
        logger.error('Command clearSemanticCache failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    // Open dedicated graph page
    vscode.commands.registerCommand('ai-readiness.showGraph', () => {
      try {
        let report = getValidReport();
        if (!report) {
          const latestRun = runStorage.getLatestRun();
          if (latestRun) { report = latestRun.report; }
        }
        if (!report) {
          vscode.window.showInformationMessage('Run a scan first to see the repository structure.');
          return;
        }
        GraphPanel.createOrShow(report);
      } catch (err) {
        logger.error('Command showGraph failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand('ai-readiness.showInteractiveGraph', () => {
      try {
        let report = getValidReport();
        if (!report) {
          const latestRun = runStorage.getLatestRun();
          if (latestRun) { report = latestRun.report; }
        }
        if (!report) {
          vscode.window.showInformationMessage('Run a scan first to build the knowledge graph.');
          return;
        }
        const { KnowledgeGraphPanel } = require('./ui/knowledgeGraphPanel');
        KnowledgeGraphPanel.createOrShow(report, context.extensionUri);
      } catch (err) {
        logger.error('Command showInteractiveGraph failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand('ai-readiness.showDeveloperNetwork', async () => {
      try {
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'Building Developer Profile...',
        }, async () => {
          const { collectDeveloperProfile, detectADORepos } = await import('./live/developerNetwork');
          const wsFolder = vscode.workspace.workspaceFolders?.[0];
          const cwd = wsFolder?.uri.fsPath || '';

          const detected = detectADORepos(cwd);
          const configRepos = vscode.workspace.getConfiguration('ai-readiness').get<string[]>('networkRepos') || [];
          const repoNames = [...new Set([...detected.repos, ...configRepos])];

          const profile = await collectDeveloperProfile(repoNames, detected.org || 'msazure', detected.project || 'One', cwd);
          const { DeveloperNetworkPanel } = await import('./ui/developerNetworkPanel');
          const refreshFn = async () => {
            const freshDetected = detectADORepos(cwd);
            const freshRepos = [...new Set([...freshDetected.repos, ...configRepos])];
            return collectDeveloperProfile(freshRepos, freshDetected.org || 'msazure', freshDetected.project || 'One', cwd);
          };
          DeveloperNetworkPanel.createOrShow(profile, context.extensionUri, refreshFn);
        });
      } catch (err) {
        logger.error('Command showDeveloperNetwork failed', err);
        vscode.window.showErrorMessage(`Developer Profile failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),


    // Open context architecture audit panel
    vscode.commands.registerCommand('ai-readiness.showContext', () => {
      try {
        let report = getValidReport();
        if (!report) {
          const latestRun = runStorage.getLatestRun();
          if (latestRun) { report = latestRun.report; }
        }
        if (!report?.contextAudit) {
          vscode.window.showInformationMessage('Run a scan first to see the context architecture audit.');
          return;
        }
        vscode.window.showInformationMessage(`Context Audit: MCP ${report.contextAudit.mcpHealth.score}/100, Skills ${report.contextAudit.skillQuality.score}/100, Efficiency ${report.contextAudit.contextEfficiency.score}/100`);
      } catch (err) {
        logger.error('Command showContext failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    // Export knowledge graph + deep analysis as JSON for debugging
    vscode.commands.registerCommand('ai-readiness.exportGraph', async () => {
      try {
        let report = getValidReport();
        if (!report) {
          const latestRun = runStorage.getLatestRun();
          if (latestRun) { report = latestRun.report; }
        }
        if (!report) {
          vscode.window.showInformationMessage('Run a scan first.');
          return;
        }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;

        // Ensure exported narratives are repaired against current signal ground truth
        const repaired = repairNarrativeSections(report, 'exportGraph');
        if (repaired) {
          await runStorage.updateLatestReport(report);
        }

        // Defense-in-depth: final text-level guard on IQ Sync narrative.
        // If repair failed silently or ran with stale code, catch the contradiction here.
        const iqSyncMetric = report.narrativeSections?.platformReadiness?.find(
          (m: any) => m.dimension === 'Instruction/Reality Sync',
        );
        if (iqSyncMetric) {
          const narrativeGen = new NarrativeGenerator(copilotClient);
          if ((narrativeGen as any).containsRootAbsenceClaim(iqSyncMetric.narrative)) {
            const tool = report.selectedTool as AITool;
            const allSignals = report.levels?.flatMap((l: any) => l.signals) ?? [];
            const rootFact = (narrativeGen as any).getRootInstructionFact(report, tool, allSignals);
            if (rootFact.present) {
              logger.warn('exportGraph: IQ Sync narrative STILL claims absence after repair — forcing deterministic override');
              iqSyncMetric.narrative = (narrativeGen as any).correctedIQSyncNarrative(
                true, rootFact.files, iqSyncMetric.score, tool, rootFact.canonicalPaths[0],
              );
              await runStorage.updateLatestReport(report);
            }
          }
        }

        const exportData = {
          projectName: report.projectName,
          scannedAt: report.scannedAt,
          overallScore: report.overallScore,
          primaryLevel: report.primaryLevel,
          componentCount: report.componentScores.filter(c => {
            const n = c.name.toLowerCase();
            return !n.endsWith('.tests') && !n.endsWith('.test') && !n.startsWith('testfx') && !n.includes('testutils');
          }).length,
          totalComponentCount: report.componentScores.length,
          insights: report.insights || [],
          narrativeSections: report.narrativeSections || null,
          knowledgeGraph: report.knowledgeGraph,
          deepAnalysis: (report as any).deepAnalysis,
          componentScores: report.componentScores.map(c => ({
            name: c.name, path: c.path, language: c.language, type: c.type,
            score: c.overallScore, level: c.primaryLevel, depth: c.depth,
            parentPath: c.parentPath, children: c.children,
            isGenerated: c.isGenerated, description: c.description,
            signals: c.signals,
          })),
        };

        const filePath = vscode.Uri.joinPath(workspaceFolder.uri, `ai-readiness-graph-${report.projectName}.json`);
        await vscode.workspace.fs.writeFile(filePath, Buffer.from(JSON.stringify(exportData, null, 2), 'utf-8'));
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showInformationMessage(`Knowledge graph exported to ${filePath.fsPath}`);
      } catch (err) {
        logger.error('Command exportGraph failed', err);
        vscode.window.showErrorMessage(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    // Open dedicated insights page — generate on-demand
    vscode.commands.registerCommand('ai-readiness.showInsights', async () => {
      if (!acquireLock('AI Strategy')) return;
      try {
      // Use current report or pick a saved run
      let report = getValidReport();
      if (!report) {
        const runs = runStorage.getRuns();
        if (runs.length === 0) {
          vscode.window.showInformationMessage('Run a scan first, then generate insights.');
          return;
        }
        // Use latest run
        report = runs[0].report;
      }

      // Always repair stale cached narratives, even when insights exist
      repairNarrativeSections(report, 'showInsights');

      // Generate insights on-the-fly if not already present
      if (!report.insights?.length) {
        try {
          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating insights...',
            cancellable: true,
          }, async (_progress, token) => {
            if (!copilotClient.isAvailable()) {
              await copilotClient.initialize();
            }
            const insightsEng = new InsightsEngine(copilotClient);
            const rawInsights = await insightsEng.generateInsights(report!, token);
            logger.info(`Insights: generated ${rawInsights.length} raw insights, mapping to panel format...`);
            report!.insights = rawInsights.map((i: any) => ({
              title: i.title || 'Untitled insight',
              recommendation: i.recommendation || i.description || '',
              severity: i.severity === 'nice-to-have' ? 'suggestion' as const : i.severity === 'critical' ? 'critical' as const : i.severity === 'important' ? 'important' as const : 'suggestion' as const,
              category: i.category || 'improvement',
              estimatedImpact: i.estimatedImpact ? `+${i.estimatedImpact} points` : undefined,
              affectedComponent: i.affectedComponent || i.affectedLanguage,
            }));
            logger.info(`Insights: ${report!.insights.length} insights mapped`);

            // Generate narrative sections for report (parallel with nothing — fast)
            if (!report!.narrativeSections) {
              try {
                logger.info('Narrative: generating report narrative sections...');
                const narrativeGen = new NarrativeGenerator(copilotClient);
                report!.narrativeSections = await narrativeGen.generate(report!);
                logger.info('Narrative: sections generated');
              } catch (narErr) {
                logger.warn('Narrative: generation failed, using fallbacks', narErr);
              }
            } else if (repairNarrativeSections(report!, 'Insights')) {
              await runStorage.updateLatestReport(report!);
            }
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Insight generation failed: ${msg}`);
          logger.error('Insights: Generation failed', err);
        }

        // Persist enriched report to storage and in-memory
        currentReport = report;
        await runStorage.updateLatestReport(report);
      }

      if (report.insights?.length) {
        logger.info(`Opening Insights panel with ${report.insights.length} insights`);
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        InsightsPanel.createOrShow(report, workspaceFolder ? async (signalId, action) => {
          if (!copilotClient.isAvailable()) {
            await copilotClient.initialize();
          }

          // Try matching a real signal first
          const tool = report!.selectedTool as AITool;
          const signal = report!.levels
            .flatMap(ls => ls.signals)
            .find(s => s.signalId === signalId);

          if (signal) {
            // Real signal — use remediation engine
            logger.info(`Insights: fixing real signal "${signalId}" via remediation engine`);
            const failingSignal = {
              id: signal.signalId,
              level: signal.level,
              finding: signal.finding,
              confidence: signal.confidence,
              modelUsed: signal.modelUsed,
            };
            const fix = await remediationEngine.fixSignal(
              failingSignal, report!.projectContext, workspaceFolder.uri, tool, undefined
            );
            if (!fix) {
              // fixSignal returned null — generate via LLM directly instead
              logger.info(`Insights: remediation returned null for "${signalId}", generating via LLM expert`);
              const insight = report!.insights?.find(i =>
                i.title?.toLowerCase().includes(signalId.toLowerCase().replace(/_/g, ' '))
              );
              const recommendation = insight?.recommendation || signal.finding || `Fix signal: ${signalId}`;
              await generateAndShowDiff(tool, report!, workspaceFolder, recommendation, signalId);
            }
          } else {
            // LLM-generated insight — find the insight and use its recommendation as the prompt
            const insight = report!.insights?.find(i => {
              const iId = `insight_${i.category}_${(i.title || '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}`;
              return iId === signalId;
            });
            if (!insight) {
              logger.warn(`Insights: no matching signal or insight for "${signalId}"`);
              vscode.window.showWarningMessage(`Could not find insight "${signalId}".`);
              return;
            }

            // Generate content using platform expert agent + show diff
            await generateAndShowDiff(tool, report!, workspaceFolder, insight.recommendation, signalId);
          }
        } : undefined);
      } else {
        vscode.window.showInformationMessage('No insights generated. Try running a full scan first.');
      }
      } catch (err) {
        logger.error('Command showInsights failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        releaseLock();
      }
    }),

    // Open platform guide — always ask which platform
    vscode.commands.registerCommand('ai-readiness.showGuide', async () => {
      try {
      const tool = await pickAITool();
      if (!tool) return;

      if (currentReport && currentReport.selectedTool === tool) {
        GuidePanel.createOrShow(currentReport, docsCache);
      } else {
        GuidePanel.createOrShow(tool, docsCache);
      }
      } catch (err) {
        logger.error('Command showGuide failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  // Migrate command
  context.subscriptions.push(
    vscode.commands.registerCommand('ai-readiness.migrate', async () => {
      try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;

      const migrationEngine = new MigrationEngine(copilotClient);
      const existing = await migrationEngine.detectExistingTools(workspaceFolder.uri);

      if (existing.length === 0) {
        vscode.window.showInformationMessage('No AI tool configurations found to migrate from.');
        return;
      }

      const sourcePicks = existing.map(e => ({
        label: `${AI_TOOLS[e.tool].icon} ${AI_TOOLS[e.tool].name}`,
        description: `${e.fileCount} files found`,
        tool: e.tool,
        files: e.files,
      }));

      const source = await vscode.window.showQuickPick(sourcePicks, {
        placeHolder: 'Migrate FROM which tool?',
      });
      if (!source) return;

      const targetPicks = Object.entries(AI_TOOLS)
        .filter(([key]) => key !== source.tool)
        .map(([key, val]) => ({
          label: `${val.icon} ${val.name}`,
          tool: key as AITool,
        }));

      const target = await vscode.window.showQuickPick(targetPicks, {
        placeHolder: `Migrate TO which tool? (from ${AI_TOOLS[source.tool].name})`,
      });
      if (!target) return;

      if (!copilotClient.isAvailable()) {
        await copilotClient.initialize();
      }

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Migrating ${AI_TOOLS[source.tool].name} → ${AI_TOOLS[target.tool].name}...`,
        cancellable: true,
      }, async (progress, token) => {
        const plan = await migrationEngine.planMigration(
          source.tool, target.tool, source.files,
          currentReport?.projectContext || { languages: [], frameworks: [], projectType: 'unknown', packageManager: '', directoryTree: '', components: [] },
          token
        );

        const created = await migrationEngine.previewAndApply(plan, workspaceFolder.uri);
        if (created > 0) {
          vscode.window.showInformationMessage(
            `Created ${created} ${AI_TOOLS[target.tool].name} files. Review and run a scan to verify.`
          );
        }
      });
      } catch (err) {
        logger.error('Command migrate failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  // Live AIPM Tracker commands
  context.subscriptions.push(
    vscode.commands.registerCommand('ai-readiness.liveStart', async () => {
      try {
      if (livePoller) {
        vscode.window.showInformationMessage('Live AIPM Tracker is already running.');
        return;
      }

      livePoller = new SessionPoller('all');
      liveEngine = new LiveMetricsEngine();
      liveStatusBar = new LiveStatusBar();

      // Load recent session data for initial display, then poll for new
      const recentEvents = await livePoller.loadRecent(500);
      if (recentEvents.length > 0) {
        liveEngine.ingest(recentEvents);
      }
      await livePoller.skipExisting();
      liveStatusBar.show();

      livePoller.startPolling(2000, (events) => {
        liveEngine!.ingest(events);
        const metrics = liveEngine!.compute();
        liveStatusBar!.update(metrics);
        if (LivePanel.currentPanel) {
          LivePanel.currentPanel.update(metrics);
        }
      });

      // Initial render with loaded data
      const metrics = liveEngine.compute();
      liveStatusBar.update(metrics);
      if (LivePanel.currentPanel) {
        LivePanel.currentPanel.update(metrics);
      }

      vscode.window.showInformationMessage(
        `⚡ Live AIPM Tracker started — polling all platforms. ${recentEvents.length > 0 ? `Loaded ${recentEvents.length} recent events.` : ''}`
      );
      } catch (err) {
        logger.error('Command liveStart failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand('ai-readiness.liveStop', () => {
      try {
      if (!livePoller) {
        vscode.window.showInformationMessage('Live AIPM Tracker is not running.');
        return;
      }

      livePoller.stopPolling();
      const summary = liveEngine ? liveEngine.compute() : undefined;

      livePoller = undefined;
      liveEngine = undefined;
      liveStatusBar?.hide();
      liveStatusBar?.dispose();
      liveStatusBar = undefined;

      if (summary) {
        vscode.window.showInformationMessage(
          `⚡ Tracker stopped — Session: ${summary.sessionTokens.toLocaleString()} tokens, ` +
          `${summary.sessionPrompts} prompts, peak ${summary.peakAipm.toLocaleString()} AIPM, ` +
          `${summary.sessionDuration}`
        );
      } else {
        vscode.window.showInformationMessage('Live AIPM Tracker stopped.');
      }
      } catch (err) {
        logger.error('Command liveStop failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand('ai-readiness.livePanel', () => {
      try {
      const panel = LivePanel.createOrShow();
      if (liveEngine) {
        const metrics = liveEngine.compute();
        panel.update(metrics);
      }

      if (!livePoller) {
        vscode.commands.executeCommand('ai-readiness.liveStart');
      }
      } catch (err) {
        logger.error('Command livePanel failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand('ai-readiness.vibeReport', async () => {
      try {
      const tool = await pickAITool();
      if (!tool) { return; }

      // Auto-detect name from git config
      let name = 'Developer';
      try {
        const { execSync } = require('child_process');
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (cwd) {
          name = execSync('git config user.name 2>/dev/null', { cwd, encoding: 'utf-8' }).trim() || 'Developer';
        }
      } catch { /* use default */ }


      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Generating Vibe Report...',
      }, async () => {
        const generator = new VibeReportGenerator();
        const html = await generator.generateReport(tool, name || undefined);

        const panel = vscode.window.createWebviewPanel(
          'vibeReport', `Vibe Report — ${name || 'Developer'}`,
          vscode.ViewColumn.One, { enableScripts: true }
        );
        panel.webview.html = html;
      });
      } catch (err) {
        logger.error('Command vibeReport failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    // Scan comparison
    vscode.commands.registerCommand('ai-readiness.compareRuns', async () => {
      try {
      const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.name;
      const allRuns = runStorage.getRuns();
      // Filter to current workspace only
      const runs = currentWorkspace
        ? allRuns.filter(r => r.projectName === currentWorkspace)
        : allRuns;

      if (runs.length < 2) {
        vscode.window.showInformationMessage(`Need at least 2 scans for "${currentWorkspace || 'this workspace'}" to compare.`);
        return;
      }

      const picks = runs.map(run => {
        const timeStr = new Date(run.timestamp).toLocaleString(undefined, {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        return {
          label: `${run.toolIcon} L${run.level} ${run.levelName} (${run.depth}%)`,
          description: `${run.projectName} · ${run.toolName} · ${timeStr}`,
          detail: `Score: ${run.overallScore}/100 · ${run.componentCount} components`,
          run,
        };
      });

      const first = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select the OLDER scan (baseline)',
      });
      if (!first) return;

      const remaining = picks.filter(p => p.run.id !== first.run.id);
      const second = await vscode.window.showQuickPick(remaining, {
        placeHolder: 'Select the NEWER scan (to compare against)',
      });
      if (!second) return;

      ComparisonPanel.createOrShow(first.run, second.run);
      } catch (err) {
        logger.error('Command compareRuns failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    // Export vibe report as standalone HTML
    vscode.commands.registerCommand('ai-readiness.exportVibeReport', async () => {
      try {
      const tool = await pickAITool();
      if (!tool) return;

      // Auto-detect name from git config
      let name = 'Developer';
      try {
        const { execSync } = require('child_process');
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (cwd) {
          name = execSync('git config user.name 2>/dev/null', { cwd, encoding: 'utf-8' }).trim() || 'Developer';
        }
      } catch { /* use default */ }


      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Generating Vibe Report for export...',
      }, async () => {
        const generator = new VibeReportGenerator();
        const html = await generator.generateReport(tool, name || undefined);

        // Ask where to save
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`vibe-report-${new Date().toISOString().slice(0, 10)}.html`),
          filters: { 'HTML Files': ['html'] },
          title: 'Save Vibe Report',
        });
        
        if (uri) {
          // Wrap in standalone HTML with proper meta tags
          const standalone = html.replace(
            '<head>',
            `<head>\n    <meta name="generator" content="AI Readiness Scanner - Vibe Report">\n    <meta name="date" content="${new Date().toISOString()}">`
          );
          await vscode.workspace.fs.writeFile(uri, Buffer.from(standalone, 'utf-8'));
          
          const openIt = await vscode.window.showInformationMessage(
            `Vibe Report saved to ${uri.fsPath}`,
            'Open in Browser'
          );
          if (openIt === 'Open in Browser') {
            vscode.env.openExternal(uri);
          }
        }
      });
      } catch (err) {
        logger.error('Command exportVibeReport failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand('ai-readiness.selectTool', async () => {
      try {
      const toolPicks = Object.entries(AI_TOOLS).map(([key, val]) => ({
        label: `${val.icon} ${val.name}`,
        description: `Check readiness for ${val.name}`,
        toolId: key as AITool,
      }));

      const selected = await vscode.window.showQuickPick(toolPicks, {
        placeHolder: 'Which AI assistant do you want to evaluate readiness for?',
      });
      if (!selected) return;

      await runScan(scanner, context, selected.toolId);
      } catch (err) {
        logger.error('Command selectTool failed', err);
        vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  // Register chat participant
  const chatParticipant = new ChatParticipant(scanner, context);
  chatParticipant.register(context);
}

async function pickAITool(): Promise<AITool | undefined> {
  const defaultTool = vscode.workspace.getConfiguration('ai-readiness').get<string>('selectedTool');
  if (defaultTool && defaultTool !== 'ask' && defaultTool in AI_TOOLS) {
    return defaultTool as AITool;
  }

  const toolPicks = Object.entries(AI_TOOLS).map(([key, val]) => ({
    label: `${val.icon} ${val.name}`,
    description: `Check readiness for ${val.name}`,
    toolId: key as AITool,
  }));

  const selected = await vscode.window.showQuickPick(toolPicks, {
    placeHolder: 'Which AI assistant do you want to evaluate readiness for?',
  });
  return selected?.toolId;
}

function createChatHandler(report: ReadinessReport, tool: AITool): (message: string) => Promise<string> {
  return async (question: string) => {
    if (!copilotClient.isAvailable()) {
      await copilotClient.initialize();
      if (!copilotClient.isAvailable()) {
        return 'LLM not available. Please ensure GitHub Copilot is active.';
      }
    }

    // If the question mentions a component, try to read its key files for context
    const questionLower = question.toLowerCase();
    let codeContext = '';
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const matchedComponent = report.componentScores.find(c =>
        questionLower.includes(c.name.toLowerCase()) ||
        questionLower.includes(c.path.toLowerCase())
      );
      if (matchedComponent) {
        // Read key files from the component (README, main entry, config)
        const compUri = vscode.Uri.joinPath(workspaceFolder.uri, matchedComponent.path);
        const filesToRead = ['README.md', 'main.py', 'index.ts', 'app.py', 'app.ts', 'pyproject.toml', 'package.json'];
        const readFiles: string[] = [];
        for (const fname of filesToRead) {
          if (readFiles.length >= 3) break;
          try {
            const fUri = vscode.Uri.joinPath(compUri, fname);
            const bytes = await vscode.workspace.fs.readFile(fUri);
            const content = Buffer.from(bytes).toString('utf-8');
            const truncated = content.length > 1500 ? content.slice(0, 1500) + '\n...(truncated)' : content;
            readFiles.push(`### ${matchedComponent.path}/${fname}\n\`\`\`\n${truncated}\n\`\`\``);
          } catch (err) { logger.warn('Could not read component source file', { file: fname, error: err instanceof Error ? err.message : String(err) }); }
        }
        if (readFiles.length > 0) {
          codeContext = `\n\nSOURCE CODE for "${matchedComponent.name}" (read from disk):\n${readFiles.join('\n\n')}`;
        }
      }
    }

    const signals = report.levels.flatMap(ls => ls.signals);
    const toolConfig = AI_TOOLS[tool];

    // Build rich context from all scan data
    const componentSummary = report.componentScores.length > 0
      ? `\nComponents (${report.componentScores.length}):\n${report.componentScores.map(c => 
          `- ${c.name} (${c.language}, ${c.type}) at ${c.path} — L${c.primaryLevel} ${c.depth}% [${c.signals.filter(s => s.present).length}/${c.signals.length} signals]${c.description ? ` — ${c.description}` : ''}`
        ).join('\n')}`
      : '';

    const languageSummary = report.languageScores.length > 0
      ? `\nLanguages:\n${report.languageScores.map(l => 
          `- ${l.language}: ${l.fileCount} files, L${l.primaryLevel} ${l.depth}% [${l.signals.filter(s => s.present).length}/${l.signals.length} signals]`
        ).join('\n')}`
      : '';

    const structureSummary = report.structureComparison
      ? `\nStructure Comparison (${report.structureComparison.toolName}):\n${report.structureComparison.expected.map(e => 
          `${e.exists ? '✅' : '❌'} ${e.path} — ${e.description} (L${e.level}${e.required ? ', required' : ''})`
        ).join('\n')}\nCompleteness: ${report.structureComparison.completeness}%`
      : '';

    const insightsSummary = report.insights?.length
      ? `\nInsights (${report.insights.length}):\n${report.insights.map(i => 
          `- [${i.severity}] ${i.title}: ${i.recommendation}`
        ).join('\n')}`
      : '';

    const projectContext = report.projectContext;
    const projectSummary = `Project Context:
- Languages: ${projectContext.languages.join(', ')}
- Frameworks: ${projectContext.frameworks.join(', ') || 'none'}
- Type: ${projectContext.projectType}
- Package manager: ${projectContext.packageManager}
${projectContext.buildTasks ? `- Build tasks:\n${projectContext.buildTasks}` : ''}
- Directory structure:\n${projectContext.directoryTree.slice(0, 600)}`;

    const systemContext = `You are an AI readiness advisor. You have FULL access to the scan results for this project.

${projectSummary}

Scan Results for ${toolConfig.name}:
- Level: L${report.primaryLevel} ${report.levelName} (${report.depth}% depth, score ${report.overallScore}/100)
- Scan mode: ${report.scanMode}, model: ${report.modelUsed}

Signals (${signals.filter(s => s.detected).length}/${signals.length} detected):
${signals.map(s => `- ${s.signalId}: ${s.detected ? `✅ score ${s.score}` : '❌ missing'} — ${s.finding}${s.realityChecks?.length ? ` [${s.realityChecks.filter(r => r.status === 'valid').length}/${s.realityChecks.length} reality checks valid]` : ''}${s.businessFindings?.length ? ` | Business: ${s.businessFindings.join('; ')}` : ''}`).join('\n')}
${componentSummary}
${languageSummary}
${structureSummary}
${insightsSummary}

Platform: ${toolConfig.name}
Expected structure: ${toolConfig.reasoningContext?.structureExpectations ?? ''}
Quality markers: ${toolConfig.reasoningContext?.qualityMarkers ?? ''}
Anti-patterns: ${toolConfig.reasoningContext?.antiPatterns ?? ''}

You can answer questions about:
- Why a signal is missing and how to fix it
- Component structure and what each component does — you have read the codebase and can explain any component's purpose, architecture, dependencies, and how it works
- Language-specific recommendations
- Platform-specific best practices for ${toolConfig.name}
- What AI instruction files to create/modify and what they should contain
- How to progress to the next level
- The scoring methodology and why the score is what it is
- Code questions about the project — explain what modules do, how they connect, what patterns they use

IDENTITY & BOUNDARIES:
You are an AI Readiness expert specializing in ${toolConfig.name} and 6 other AI coding platforms (Copilot, Cline, Cursor, Claude Code, Roo, Windsurf, Aider).

You CAN:
- Write AI guideline files (copilot-instructions.md, .clinerules, CLAUDE.md, .cursorrules, AGENTS.md, etc.)
- Write README files, memory banks, skills, workflows, playbooks
- Write documentation files (ARCHITECTURE.md, CONTRIBUTING.md, etc.)
- Answer code questions — explain what components do, how they work, their architecture
- Analyze project structure and recommend improvements for AI agent readiness

You CANNOT and MUST NOT:
- Write application source code (Python, TypeScript, Go, etc.)
- Write test code, fix bugs, or implement features
- Modify package.json dependencies, CI/CD pipelines, or infrastructure code
If asked to write application code, respond: "I'm an AI Readiness specialist — I write AI guidelines, instructions, memory banks, skills, and documentation. For application code, use your AI coding assistant (${toolConfig.name}) directly."

Be specific to THIS project. Reference actual paths, components, and languages.${codeContext}`;

    try {
      return await copilotClient.analyzeWithSystemPrompt(systemContext, question);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}

function createGenerateHandler(
  report: ReadinessReport,
  tool: AITool,
  workspaceUri: vscode.Uri,
  remediationEng: RemediationEngine
): (signalIds: string[]) => Promise<void> {
  return async (signalIds: string[]) => {
    logger.info(`Generate handler: ${signalIds.length} signals requested`);
    if (!multiModelClient.isAvailable() && !copilotClient.isAvailable()) {
      await copilotClient.initialize();
      if (!copilotClient.isAvailable()) {
        vscode.window.showErrorMessage('No LLM available for generation.');
        return;
      }
    }

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return;

    // Collect all generated files
    const generatedFiles: { filePath: string; content: string; existing: string; signalId: string }[] = [];
    const CONCURRENCY = 5;

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Generating ${signalIds.length} fixes (${CONCURRENCY} parallel)...`,
      cancellable: true,
    }, async (progress, token) => {
      let completed = 0;

      // Process in batches of CONCURRENCY
      for (let batch = 0; batch < signalIds.length; batch += CONCURRENCY) {
        if (token.isCancellationRequested) break;
        const batchIds = signalIds.slice(batch, batch + CONCURRENCY);
        
        progress.report({ message: `Batch ${Math.floor(batch / CONCURRENCY) + 1}/${Math.ceil(signalIds.length / CONCURRENCY)} (${completed}/${signalIds.length} done)` });

        const batchResults = await Promise.allSettled(
          batchIds.map(async (signalId) => {
            let retries = 1;
            while (retries >= 0) {
              try {
                return await generateFilesForSignal(signalId, report, tool, workspaceUri, wsFolder, remediationEng);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if ((msg.includes('Transport') || msg.includes('transport')) && retries > 0) {
                  retries--;
                  await new Promise(r => setTimeout(r, 2000));
                } else {
                  logger.warn(`Generate handler: failed for "${signalId}"`, err);
                  return [];
                }
              }
            }
            return [];
          })
        );

        for (const result of batchResults) {
          if (result.status === 'fulfilled' && result.value) {
            generatedFiles.push(...result.value);
          }
          completed++;
        }

        progress.report({ increment: (batchIds.length / signalIds.length) * 100 });
      }
    });

    if (generatedFiles.length === 0) {
      vscode.window.showInformationMessage('No files were generated.');
      return;
    }

    // Build WorkspaceEdit with needsConfirmation on each entry
    const edit = new vscode.WorkspaceEdit();

    for (const file of generatedFiles) {
      const targetUri = vscode.Uri.joinPath(wsFolder.uri, file.filePath);
      const metadata: vscode.WorkspaceEditEntryMetadata = {
        needsConfirmation: true,
        label: file.existing ? `✏️ Modify: ${file.filePath}` : `✨ Create: ${file.filePath}`,
        description: `${file.content.split('\n').length} lines`,
      };

      if (file.existing) {
        // For existing files: need to open the document to get proper range
        try {
          const doc = await vscode.workspace.openTextDocument(targetUri);
          const fullRange = new vscode.Range(
            new vscode.Position(0, 0),
            doc.lineAt(doc.lineCount - 1).range.end
          );
          edit.replace(targetUri, fullRange, file.content, metadata);
        } catch {
          // File might have been deleted between scan and now — treat as create
          edit.createFile(targetUri, { overwrite: true, ignoreIfExists: false, contents: Buffer.from(file.content, 'utf-8') }, metadata);
        }
      } else {
        // For new files: ensure parent directory exists, then create
        const parentDir = file.filePath.split('/').slice(0, -1).join('/');
        if (parentDir) {
          const parentUri = vscode.Uri.joinPath(wsFolder.uri, parentDir);
          try { await vscode.workspace.fs.createDirectory(parentUri); } catch { /* exists */ }
        }
        edit.createFile(targetUri, { overwrite: false, ignoreIfExists: true, contents: Buffer.from(file.content, 'utf-8') }, metadata);
      }
    }

    // Apply — VS Code shows refactor preview with checkboxes per file
    const applied = await vscode.workspace.applyEdit(edit);

    if (applied) {
      logger.info(`Generate handler: ${generatedFiles.length} files applied via refactor preview`);

      // Save fixes to persistent FixStorage with content hashes
      const workspace = wsFolder.name;
      const bySignal = new Map<string, { path: string; content: string }[]>();
      for (const f of generatedFiles) {
        const entries = bySignal.get(f.signalId) || [];
        entries.push({ path: f.filePath, content: f.content });
        bySignal.set(f.signalId, entries);
      }
      for (const [sid, files] of bySignal) {
        await fixStorage.saveFix({
          signalId: sid,
          files: files.map(f => ({ path: f.path, contentHash: FixStorage.hashContent(f.content) })),
          timestamp: new Date().toISOString(),
          status: 'pending-review',
          workspace,
        });
      }

      // Notify panel to update status
      RecommendationsPanel.currentPanel?.markPendingReview(signalIds);

      vscode.window.showInformationMessage(
        `Changes applied. Review in Source Control — commit to keep, revert to undo.`
      );
      await vscode.commands.executeCommand('workbench.view.scm');
    } else {
      logger.info('Generate handler: user cancelled refactor preview');
    }
  };
}

async function generateFilesForSignal(
  signalId: string,
  report: ReadinessReport,
  tool: AITool,
  workspaceUri: vscode.Uri,
  wsFolder: vscode.WorkspaceFolder,
  remediationEng: RemediationEngine
): Promise<{ filePath: string; content: string; existing: string; signalId: string }[]> {
  // Try real signals first
  const signal = report.levels.flatMap(ls => ls.signals).find(s => s.signalId === signalId);
  if (signal) {
    const failingSignal = { id: signal.signalId, level: signal.level, finding: signal.finding, confidence: signal.confidence, modelUsed: signal.modelUsed };
    const fix = await remediationEng.previewSignal(failingSignal, report.projectContext, workspaceUri, tool, undefined);

    // If remediation returned placeholder, fall back to LLM
    if (fix.length === 1 && (fix[0].path.includes('no content') || fix[0].path.includes('error'))) {
      return generateViaLLM(signal.finding, signalId, tool, report, wsFolder);
    }

    const results: { filePath: string; content: string; existing: string; signalId: string }[] = [];
    for (const f of fix) {
      if (f.path.startsWith('(')) continue;
      let existing = '';
      try { existing = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(wsFolder.uri, f.path))).toString('utf-8'); } catch { /* new */ }
      results.push({ filePath: f.path, content: f.content, existing, signalId });
    }
    return results;
  }

  // Fallback: insight or component
  const insight = report.insights?.find(i => {
    const iId = `insight_${i.category}_${(i.title || '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}`;
    return iId === signalId;
  });
  const compMatch = signalId.match(/^comp_(readme|docs)_(.+)$/);
  const component = compMatch ? report.componentScores?.find(c => c.path.replace(/[^a-zA-Z0-9]/g, '_') === compMatch[2]) : undefined;

  const recommendation = insight?.recommendation
    || (component && compMatch?.[1] === 'readme' ? `Create \`${component.path}/README.md\` describing what ${component.name} does, its API, how to test it, and how it connects to other components.` : null)
    || (component && compMatch?.[1] === 'docs' ? `Add documentation to \`${component.path}/\` explaining the architecture, dependencies, and integration points of ${component.name}.` : null);

  if (recommendation) {
    return generateViaLLM(recommendation, signalId, tool, report, wsFolder);
  }

  return [];
}

async function generateViaLLM(
  recommendation: string,
  signalId: string,
  tool: AITool,
  report: ReadinessReport,
  wsFolder: vscode.WorkspaceFolder
): Promise<{ filePath: string; content: string; existing: string; signalId: string }[]> {
  const expertPrompt = getPlatformExpertPrompt(tool);
  const projectCtx = formatProjectContext(report.projectContext);

  // Determine if this could be a multi-file recommendation
  const isMultiFile = true; // Always request structured multi-file format for reliability

  const formatInstruction = `If generating multiple files, use this exact format for EACH file:

=== FILE: path/to/file.md ===
(file content here — no code fences wrapping the content)
=== END FILE ===

If generating a single file, output ONLY the file content with no wrapping.
Always use the full file path starting from the repository root.
Do NOT wrap file content in markdown code fences (\`\`\`).`;

  const content = await copilotClient.analyze(
    `${expertPrompt}\n\nPROJECT CONTEXT:\n${projectCtx}\n\nTASK: ${recommendation}\n\n${formatInstruction}`,
    undefined, 120_000
  );

  // Parse multi-file response — try 3 formats
  const parsedFiles: { filePath: string; content: string; existing: string; signalId: string }[] = [];

  // Format 1: === FILE: path === ... === END FILE ===
  const fileBlocks = content.matchAll(/===\s*FILE:\s*(.+?)\s*===\n([\s\S]*?)===\s*END FILE\s*===/gi);
  for (const match of fileBlocks) {
    const filePath = match[1].trim();
    const fileContent = match[2].trim();
    let existing = '';
    try { existing = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(wsFolder.uri, filePath))).toString('utf-8'); } catch { /* new */ }
    parsedFiles.push({ filePath, content: fileContent, existing, signalId });
  }

  // If multi-file parsing found files, return them
  if (parsedFiles.length > 0) {
    logger.info(`generateViaLLM: parsed ${parsedFiles.length} files from multi-file response`);
    const protectedFiles = protectSourceFiles(parsedFiles, wsFolder);
    return validateAndRetry(protectedFiles, recommendation, signalId, tool, report, wsFolder);
  }

  // Fallback: try to split by markdown ## headers with file paths
  const sections = content.split(/^(?=##\s+`)/m).filter(s => s.trim());
  for (const sec of sections) {
    const pathMatch = sec.match(/^##\s+`([^`]+)`/);
    if (!pathMatch) continue;
    const filePath = pathMatch[1].trim();
    const body = sec.replace(/^##\s+`[^`]+`\s*\n/, '').trim();
    const fenced = body.match(/```(?:markdown|yaml|json|md)?\n([\s\S]*?)```/);
    const fileContent = fenced ? fenced[1].trim() : body;
    let existing = '';
    try { existing = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(wsFolder.uri, filePath))).toString('utf-8'); } catch { /* new */ }
    parsedFiles.push({ filePath, content: fileContent, existing, signalId });
  }

  if (parsedFiles.length > 0) {
    logger.info(`generateViaLLM: parsed ${parsedFiles.length} files from header-based response`);
    const protectedFiles = protectSourceFiles(parsedFiles, wsFolder);
    return validateAndRetry(protectedFiles, recommendation, signalId, tool, report, wsFolder);
  }

  // Format 3: **File: `path`** or **File: path** with ```code fences```
  const boldFileSections = content.split(/^(?=\*\*File:\s*)/m).filter(s => s.trim());
  for (const sec of boldFileSections) {
    const pathMatch = sec.match(/^\*\*File:\s*`?([^`*\n]+)`?\s*\*\*/);
    if (!pathMatch) continue;
    const filePath = pathMatch[1].trim();
    const body = sec.replace(/^\*\*File:.*\*\*\s*\n*/, '').trim();
    // Extract content from code fences if present
    const fenced = body.match(/```(?:markdown|yaml|json|md|typescript|javascript)?\n([\s\S]*?)```/);
    const fileContent = fenced ? fenced[1].trim() : body;
    if (fileContent.length < 10) continue; // skip empty sections
    let existing = '';
    try { existing = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(wsFolder.uri, filePath))).toString('utf-8'); } catch { /* new */ }
    parsedFiles.push({ filePath, content: fileContent, existing, signalId });
  }

  if (parsedFiles.length > 0) {
    logger.info(`generateViaLLM: parsed ${parsedFiles.length} files from **File:** format`);
    const protectedFiles = protectSourceFiles(parsedFiles, wsFolder);
    return validateAndRetry(protectedFiles, recommendation, signalId, tool, report, wsFolder);
  }

  // Final fallback: single file
  const pathMatch = recommendation.match(/`([^`]+\.[a-z]+)`/i) || recommendation.match(/Create\s+(\S+\.\w+)/i) || recommendation.match(/(\S+\/\S+\.\w+)/);
  const filePath = pathMatch?.[1] || `generated-${signalId.replace(/[^a-z0-9]/gi, '-').slice(0, 30)}.md`;

  let existing = '';
  try { existing = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(wsFolder.uri, filePath))).toString('utf-8'); } catch { /* new */ }

  parsedFiles.push({ filePath, content, existing, signalId });

  const protected1 = protectSourceFiles(parsedFiles, wsFolder);
  return validateAndRetry(protected1, recommendation, signalId, tool, report, wsFolder);
}

async function validateAndRetry(
  files: { filePath: string; content: string; existing: string; signalId: string }[],
  recommendation: string,
  signalId: string,
  tool: AITool,
  report: ReadinessReport,
  wsFolder: vscode.WorkspaceFolder,
  attempt: number = 1
): Promise<{ filePath: string; content: string; existing: string; signalId: string }[]> {
  if (!copilotClient.isAvailable() || files.length === 0 || attempt > 2) return files;

  try {
    const { OutputValidator } = await import('./deep/outputValidator');
    const validator = new OutputValidator(copilotClient);
    const result = await validator.validate(
      files.map(f => ({ filePath: f.filePath, content: f.content })),
      recommendation
    );

    if (result.valid) {
      if (result.issues.length > 0) {
        logger.info(`Validator: ${result.issues.length} warnings (non-blocking): ${result.issues.map(i => i.issue).join('; ')}`);
      }
      return files;
    }

    // Validation failed — fix deterministic issues inline
    const errorIssues = result.issues.filter(i => i.severity === 'error');
    logger.warn(`Validator: ${errorIssues.length} errors found on attempt ${attempt}, fixing...`);

    let needsRetry = false;
    for (const issue of errorIssues) {
      const fileIdx = files.findIndex(f => f.filePath === issue.file);
      if (fileIdx < 0) continue;

      // Auto-fix: code fence wrapping
      if (issue.issue.includes('code fences')) {
        files[fileIdx].content = files[fileIdx].content
          .replace(/^```\w*\n/, '').replace(/\n```\s*$/, '');
        logger.info(`Validator: auto-fixed code fence wrapping in ${issue.file}`);
      }
      // Auto-fix: JSON comments
      else if (issue.issue.includes('comments') && issue.file.endsWith('.json')) {
        files[fileIdx].content = files[fileIdx].content
          .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
        logger.info(`Validator: auto-removed JSON comments in ${issue.file}`);
      }
      // Auto-fix: empty content
      else if (issue.issue.includes('empty')) {
        files.splice(fileIdx, 1);
        logger.info(`Validator: removed empty file ${issue.file}`);
      }
      // Other errors need LLM retry
      else {
        needsRetry = true;
      }
    }

    if (needsRetry && attempt < 2) {
      // Retry with validator feedback
      logger.info(`Validator: retrying generation with feedback (attempt ${attempt + 1})`);
      const feedback = errorIssues.map(i => `- ${i.file}: ${i.issue}${i.suggestion ? '. Fix: ' + i.suggestion : ''}`).join('\n');
      const expertPrompt = getPlatformExpertPrompt(tool);
      const projectCtx = formatProjectContext(report.projectContext);

      const retryContent = await copilotClient.analyze(
        `${expertPrompt}\n\nPROJECT CONTEXT:\n${projectCtx}\n\nORIGINAL TASK: ${recommendation}\n\nYour previous output had these problems:\n${feedback}\n\nFix these issues and regenerate. Use === FILE: path === format. Do NOT wrap content in code fences.`,
        undefined, 120_000
      );

      // Re-parse
      const retryFiles: { filePath: string; content: string; existing: string; signalId: string }[] = [];
      const retryBlocks = retryContent.matchAll(/===\s*FILE:\s*(.+?)\s*===\n([\s\S]*?)===\s*END FILE\s*===/gi);
      for (const match of retryBlocks) {
        let existing = '';
        try { existing = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(wsFolder.uri, match[1].trim()))).toString('utf-8'); } catch { /* new */ }
        retryFiles.push({ filePath: match[1].trim(), content: match[2].trim(), existing, signalId });
      }

      if (retryFiles.length > 0) {
        const protectedRetry = protectSourceFiles(retryFiles, wsFolder);
        return validateAndRetry(protectedRetry, recommendation, signalId, tool, report, wsFolder, attempt + 1);
      }
    }

    return files;
  } catch (err) {
    logger.debug('Validator: validation failed, returning unvalidated files', err);
    return files;
  }
}

function protectSourceFiles(
  files: { filePath: string; content: string; existing: string; signalId: string }[],
  wsFolder: vscode.WorkspaceFolder
): { filePath: string; content: string; existing: string; signalId: string }[] {
  return files.map(f => {
    if (!f.existing) return f;
    const ext = f.filePath.split('.').pop()?.toLowerCase() || '';
    if (ext === 'md') return f;
    const suggestPath = `${f.filePath}.suggestions.md`;
    logger.info(`generateViaLLM: protecting existing "${f.filePath}" → advisory "${suggestPath}"`);
    return {
      filePath: suggestPath,
      content: `# Suggested Improvements for \`${f.filePath}\`\n\nThe following changes are recommended for this file. Apply them manually or use Copilot Chat to make the edits.\n\n---\n\n${f.content}`,
      existing: '',
      signalId: f.signalId,
    };
  });
}

function createPreviewHandler(
  report: ReadinessReport,
  tool: AITool,
  workspaceUri: vscode.Uri,
  remediationEng: RemediationEngine
): (signalId: string) => Promise<{ path: string; content: string }[]> {
  return async (signalId: string) => {
    logger.info(`Preview handler: requested for "${signalId}"`);
    if (!copilotClient.isAvailable()) {
      await copilotClient.initialize();
      if (!copilotClient.isAvailable()) {
        logger.error('Preview handler: no LLM available');
        return [{ path: '(error)', content: 'No LLM available for preview generation.' }];
      }
    }

    const signal = report.levels
      .flatMap(ls => ls.signals)
      .find(s => s.signalId === signalId);

    if (signal) {
      logger.info(`Preview handler: generating preview for "${signalId}" (L${signal.level})...`);
      const failingSignal = {
        id: signal.signalId,
        level: signal.level,
        finding: signal.finding,
        confidence: signal.confidence,
        modelUsed: signal.modelUsed,
      };

      const result = await remediationEng.previewSignal(
        failingSignal,
        report.projectContext,
        workspaceUri,
        tool,
        undefined
      );

      // If remediation engine returned placeholder, fall back to direct LLM generation
      if (result.length === 1 && (result[0].path.includes('no content') || result[0].path.includes('error'))) {
        logger.info(`Preview handler: remediation returned placeholder for "${signalId}", falling back to LLM`);
        const expertPrompt = getPlatformExpertPrompt(tool);
        const projectCtx = formatProjectContext(report.projectContext);
        const content = await copilotClient.analyze(
          `${expertPrompt}\n\nPROJECT CONTEXT:\n${projectCtx}\n\nTASK: Fix the "${humanizeSignalId(signalId)}" signal. ${signal.finding}\n\nGenerate ONLY the file content — no explanation, no code fences. Follow the platform's exact format.`,
          undefined, 60_000
        );
        const pathMatch = signal.finding.match(/`([^`]+\.[a-z]+)`/i) || signal.finding.match(/(\S+\/\S+\.\w+)/);
        const filePath = pathMatch?.[1] || `${signalId.replace(/[^a-z0-9]/gi, '-').slice(0, 30)}.md`;
        return [{ path: filePath, content }];
      }

      return result;
    }

    // Fallback: insight-based or component-based
    const insight = report.insights?.find(i => {
      const iId = `insight_${i.category}_${(i.title || '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}`;
      return iId === signalId;
    });
    const compMatch = signalId.match(/^comp_(readme|docs)_(.+)$/);
    const component = compMatch ? report.componentScores?.find(c => c.path.replace(/[^a-zA-Z0-9]/g, '_') === compMatch[2]) : undefined;

    const recommendation = insight?.recommendation
      || (component && compMatch?.[1] === 'readme' ? `Create \`${component.path}/README.md\` describing what ${component.name} does, its API, how to test it, and how it connects to other components.` : null)
      || (component && compMatch?.[1] === 'docs' ? `Add documentation to \`${component.path}/\` explaining the architecture of ${component.name}.` : null);

    if (recommendation) {
      logger.info(`Preview handler: using LLM for insight/component "${signalId}"`);
      const expertPrompt = getPlatformExpertPrompt(tool);
      const projectCtx = formatProjectContext(report.projectContext);
      const content = await copilotClient.analyze(`${expertPrompt}\n\nPROJECT CONTEXT:\n${projectCtx}\n\nTASK: ${recommendation}\n\nGenerate ONLY the file content — no explanation, no code fences.`, undefined, 60_000);
      const pathMatch = recommendation.match(/`([^`]+\.[a-z]+)`/i) || recommendation.match(/(\S+\/\S+\.\w+)/);
      const filePath = pathMatch?.[1] || `${signalId.replace(/[^a-z0-9]/gi, '-').slice(0, 30)}.md`;
      return [{ path: filePath, content }];
    }

    logger.warn(`Preview handler: signal "${signalId}" not found in report or insights`);
    return [{ path: '(error)', content: `Signal "${signalId}" not found in report.` }];
  };
}

async function generateAndShowDiff(
  tool: AITool,
  report: ReadinessReport,
  workspaceFolder: vscode.WorkspaceFolder,
  recommendation: string,
  signalId: string,
): Promise<boolean> {
  const expertPrompt = getPlatformExpertPrompt(tool);
  const projectCtx = formatProjectContext(report.projectContext);

  const prompt = `${expertPrompt}

PROJECT CONTEXT:
${projectCtx}

TASK: ${recommendation}

Generate ONLY the file content — no explanation, no markdown code fences around the entire output. Follow the platform's exact file format, naming conventions, and YAML frontmatter requirements.`;

  try {
    logger.info(`Generate+Diff: using ${AI_TOOLS[tool]?.name || tool} expert for "${signalId}"`);
    let content = await copilotClient.analyze(prompt, undefined, 120_000);

    // Extract file path from recommendation
    const pathMatch = recommendation.match(/`([^`]+\.[a-z]+)`/i)
      || recommendation.match(/Create\s+(\S+\.\w+)/i)
      || recommendation.match(/(\S+\/\S+\.\w+)/);
    const filePath = pathMatch?.[1] || `generated-${signalId.replace(/[^a-z0-9]/gi, '-').slice(0, 30)}.md`;

    // Validate generated content
    try {
      const { OutputValidator } = await import('./deep/outputValidator');
      const validator = new OutputValidator(copilotClient);
      const valResult = await validator.validate([{ filePath, content }], recommendation);
      if (!valResult.valid) {
        const errors = valResult.issues.filter(i => i.severity === 'error');
        logger.warn(`Generate+Diff: validation found ${errors.length} errors, auto-fixing...`);
        // Auto-fix code fence wrapping
        if (content.trimStart().startsWith('```') && content.trimEnd().endsWith('```')) {
          content = content.replace(/^```\w*\n/, '').replace(/\n```\s*$/, '');
        }
        // Auto-fix JSON comments
        if (filePath.endsWith('.json') && /^\s*\/\//m.test(content)) {
          content = content.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
        }
      }
    } catch { /* validation optional */ }

    const targetUri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);

    // Read existing content
    let existingContent = '';
    try {
      const existing = await vscode.workspace.fs.readFile(targetUri);
      existingContent = Buffer.from(existing).toString('utf-8');
    } catch { /* new file */ }

    // Show diff editor
    const originalDoc = await vscode.workspace.openTextDocument({ content: existingContent, language: filePath.endsWith('.md') ? 'markdown' : filePath.endsWith('.yml') || filePath.endsWith('.yaml') ? 'yaml' : 'plaintext' });
    const generatedDoc = await vscode.workspace.openTextDocument({ content, language: filePath.endsWith('.md') ? 'markdown' : filePath.endsWith('.yml') || filePath.endsWith('.yaml') ? 'yaml' : 'plaintext' });

    await vscode.commands.executeCommand('vscode.diff',
      originalDoc.uri, generatedDoc.uri,
      `${filePath} — ${existingContent ? 'Current → Generated' : 'New File Preview'}`
    );

    const action = await vscode.window.showInformationMessage(
      `${existingContent ? 'Update' : 'Create'} ${filePath}?`, 'Apply', 'Cancel'
    );
    if (action === 'Apply') {
      const parentDir = vscode.Uri.joinPath(workspaceFolder.uri, filePath.split('/').slice(0, -1).join('/'));
      try { await vscode.workspace.fs.createDirectory(parentDir); } catch { /* exists */ }
      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, 'utf-8'));
      vscode.window.showInformationMessage(`${existingContent ? 'Updated' : 'Created'} ${filePath}`);
      logger.info(`Generate+Diff: ${existingContent ? 'updated' : 'created'} ${filePath}`);
      return true;
    }
    return false;
  } catch (err) {
    logger.error(`Generate+Diff: failed for "${signalId}"`, err);
    vscode.window.showErrorMessage(`Generation failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function runScan(
  scanner: WorkspaceScanner,
  context: vscode.ExtensionContext,
  selectedTool: AITool
): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'AI Readiness: Scanning workspace...',
      cancellable: true,
    },
    async (progress, token) => {
      const scanStartTime = Date.now();
      try {
        // Phase 1: Core scan (signals, components, structure)
        progress.report({ message: '🔍 Scanning workspace signals...', increment: 10 });
        currentReport = await scanner.scan(
          workspaceFolder.uri,
          false,
          progress,
          token,
          selectedTool
        );

        if (!currentReport || token.isCancellationRequested) return;

        // Save initial scan result
        await runStorage.saveRun(currentReport);
        sidebarPanel.refresh();
        statusBarManager.update(currentReport);
        vscode.commands.executeCommand('setContext', 'ai-readiness.hasResults', true);
        vscode.commands.executeCommand('setContext', 'ai-readiness.hasMultipleRuns', runStorage.getRuns().length >= 2);

        // ── Run entire pipeline ──

        // Phase 2: Generate insights (LLM)
        if (!currentReport.insights?.length) {
          progress.report({ message: '💡 Generating AI insights...', increment: 15 });
          try {
            if (!copilotClient.isAvailable()) {
              await copilotClient.initialize();
            }
            const insightsEng = new InsightsEngine(copilotClient);
            const rawInsights = await insightsEng.generateInsights(currentReport, token);
            currentReport.insights = rawInsights.map((i: any) => ({
              title: i.title || 'Untitled insight',
              recommendation: i.recommendation || i.description || '',
              severity: i.severity === 'nice-to-have' ? 'suggestion' as const : i.severity === 'critical' ? 'critical' as const : i.severity === 'important' ? 'important' as const : 'suggestion' as const,
              category: i.category || 'improvement',
              estimatedImpact: i.estimatedImpact ? `+${i.estimatedImpact} points` : undefined,
              affectedComponent: i.affectedComponent || i.affectedLanguage,
              confidenceScore: i.estimatedImpact ? Math.min(0.9, 0.5 + (i.estimatedImpact / 20) * 0.4) : 0.6, // LLM-generated without debate validation
            }));
            logger.info(`Full scan: generated ${currentReport.insights.length} insights`);
          } catch (err) {
            logger.warn('Full scan: insight generation failed, continuing', err);
          }
        }
        if (token.isCancellationRequested) return;

        // Phase 3: Deep analysis (cross-reference instructions vs code)
        progress.report({ message: '🔬 Deep analysis: cross-referencing instructions vs code...', increment: 15 });
        try {
          const { runDeepAnalysis } = await import('./deep');
          const deepResult = await runDeepAnalysis(workspaceFolder.uri, copilotClient, selectedTool, progress, undefined, currentReport?.projectContext?.projectType);
          // Store deep analysis data regardless of recommendation count
          (currentReport as any).deepAnalysis = {
            instructionQuality: deepResult.crossRef.instructionQuality,
            coveragePercent: deepResult.crossRef.coveragePercent,
            gapCount: deepResult.crossRef.coverageGaps.length,
            driftCount: deepResult.crossRef.driftIssues.length,
            complexity: deepResult.complexity,
            callGraph: deepResult.callGraph,
            dataFlow: deepResult.dataFlow,
          };
          // Enrich knowledge graph with deep analysis data
          if (currentReport.knowledgeGraph) {
            try {
              const { GraphBuilder } = await import('./graph/graphBuilder');
              new GraphBuilder().enrichWithDeepAnalysis(currentReport.knowledgeGraph as any, deepResult as any);
              logger.info(`Full scan: knowledge graph enriched — ${(currentReport.knowledgeGraph as any).edges.length} edges`);
            } catch (enrichErr) { logger.debug('Knowledge graph enrichment failed', { error: String(enrichErr) }); }
          }
          // Merge deep recommendations into insights
          if (deepResult.recommendations.length > 0) {
            if (!currentReport.insights) currentReport.insights = [];
            for (const rec of deepResult.recommendations) {
              currentReport.insights.push({
                title: rec.title,
                recommendation: rec.suggestedContent || rec.description,
                severity: rec.severity === 'critical' ? 'critical' : rec.severity === 'important' ? 'important' : 'suggestion',
                category: rec.type,
                estimatedImpact: `+${Math.min(20, Math.max(1, Math.round(rec.impactScore / 5)))} points`,
                affectedComponent: rec.affectedModules.join(', '),
                confidenceScore: (rec as any).confidence || Math.min(0.9, 0.5 + (rec.impactScore / 100) * 0.4),
              });
            }
            logger.info(`Full scan: deep analysis added ${deepResult.recommendations.length} recommendations`);
          }
          // Deduplicate all insights (regular + deep merged)
          if (currentReport.insights && currentReport.insights.length > 0) {
            const before = currentReport.insights.length;
            currentReport.insights = deduplicateInsights(currentReport.insights);
            if (currentReport.insights.length < before) {
              logger.info(`Full scan: deduped insights ${before} → ${currentReport.insights.length}`);
            }
          }
        } catch (err) {
          logger.warn('Full scan: deep analysis failed, continuing', err);
        }
        if (token.isCancellationRequested) return;

        // Phase 4: Generate narrative
        if (!currentReport.narrativeSections) {
          progress.report({ message: '📊 Generating report narrative...', increment: 10 });
          try {
            const narrativeGen = new NarrativeGenerator(copilotClient);
            currentReport.narrativeSections = await narrativeGen.generate(currentReport);
            logger.info('Full scan: narrative generated');
          } catch (err) {
            logger.warn('Full scan: narrative generation failed', err);
          }
        } else if (repairNarrativeSections(currentReport, 'Full scan')) {
          await runStorage.updateLatestReport(currentReport);
        }

        // Save fully enriched report
        await runStorage.updateLatestReport(currentReport);
        sidebarPanel.refresh();

        const scanDuration = Math.round((Date.now() - scanStartTime) / 1000);
        const level = currentReport.primaryLevel;
        const levelInfo = MATURITY_LEVELS[level];
        vscode.window.showInformationMessage(
          `AI Readiness: Level ${level} — ${levelInfo.name} (Depth: ${currentReport.depth}%, Score: ${currentReport.overallScore}/100) [${scanDuration}s]`
        );

        // Auto-open the report
        WebviewReportPanel.createOrShow(context.extensionUri, currentReport, currentReport.repoMap as RepoMap | undefined);
      } catch (err) {
        if (err instanceof vscode.CancellationError) {
          vscode.window.showInformationMessage('Scan cancelled.');
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : '';
          logger.error(`Scan failed: ${msg}`, err);
          if (stack) { logger.debug(`Stack trace: ${stack}`); }
          vscode.window.showErrorMessage(`Scan failed: ${msg}`);
        }
      }
    }
  );
}

export function deactivate() {
  statusBarManager?.dispose();
  livePoller?.stopPolling();
  liveStatusBar?.dispose();
  liveStatusBar = undefined;
  livePoller = undefined;
  liveEngine = undefined;
  currentReport = undefined;
}
