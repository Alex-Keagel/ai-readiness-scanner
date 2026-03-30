import * as vscode from 'vscode';
import { ComponentMapper } from './componentMapper';
import { MaturityEngine } from '../scoring/maturityEngine';
import { MaturityScanner } from './maturityScanner';
import { ComponentScorer } from '../scoring/componentScorer';
import { ReadinessReport, AITool, AI_TOOLS } from '../scoring/types';
import { CopilotClient } from '../llm/copilotClient';
import { LLMCache } from '../llm/cache';
import { DocsCache } from '../llm/docsCache';
import { InsightsEngine } from '../scoring/insightsEngine';
import { StructureAnalyzer } from './structureAnalyzer';
import { GraphBuilder, DependencyScanner } from '../graph';
import { WorkspaceIndexer } from '../semantic';
import { analyzeFileContent, calculateCodebaseMetrics, type FileAnalysis } from '../metrics';
import { logger } from '../logging';

export class WorkspaceScanner {
  private componentMapper: ComponentMapper;
  private engine: MaturityEngine;
  private maturityScanner: MaturityScanner;
  private componentScorer: ComponentScorer;
  private copilotClient: CopilotClient;
  private cache: LLMCache;
  private docsCache: DocsCache;
  private insightsEngine: InsightsEngine;
  private structureAnalyzer: StructureAnalyzer;
  private graphBuilder: GraphBuilder;
  private dependencyScanner: DependencyScanner;
  private workspaceIndexer?: WorkspaceIndexer;

  constructor(private context: vscode.ExtensionContext, workspaceIndexer?: WorkspaceIndexer, sharedClient?: CopilotClient) {
    this.engine = new MaturityEngine();
    this.copilotClient = sharedClient || new CopilotClient();
    this.componentMapper = new ComponentMapper(this.copilotClient);
    this.cache = new LLMCache(context);
    this.docsCache = new DocsCache(context);
    this.maturityScanner = new MaturityScanner(this.copilotClient, this.cache, this.engine, this.docsCache);
    this.componentScorer = new ComponentScorer();
    this.insightsEngine = new InsightsEngine(this.copilotClient);
    this.structureAnalyzer = new StructureAnalyzer(this.copilotClient);
    this.graphBuilder = new GraphBuilder();
    this.dependencyScanner = new DependencyScanner();
    this.workspaceIndexer = workspaceIndexer;
  }

  async scan(
    workspaceUri: vscode.Uri,
    quickMode: boolean,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
    selectedTool: AITool
  ): Promise<ReadinessReport> {
    const scanStart = Date.now();
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - scanStart) / 1000);
      progress.report({ message: `⏱️ Scan running (${elapsed}s elapsed)...` });
    }, 10_000);

    try {
    // Phase 1: Connect to LLM (before indexing so enrichment can use fast model)
    const endPhase1 = logger.time('Phase 1: Connect to LLM');
    if (!quickMode) {
      progress.report({ message: '🤖 Connecting to Copilot LLM...', increment: 0 });
      const available = await this.copilotClient.initialize();
      if (!available) {
        const choice = await vscode.window.showWarningMessage(
          'Copilot LLM not available. Run in quick mode?', 'Quick Mode', 'Cancel'
        );
        if (choice !== 'Quick Mode') throw new vscode.CancellationError();
        quickMode = true;
      }
    }
    endPhase1.end();

    // Phase 0: Semantic indexing (after LLM init so enrichment can use fast model)
    if (this.workspaceIndexer) {
      const endPhase0 = logger.time('Phase 0: Semantic indexing');
      try {
        progress.report({ message: '🔎 Indexing workspace files for semantic understanding...', increment: 0 });
        await this.workspaceIndexer.indexWorkspace(workspaceUri, progress, token);
      } catch (err) {
        logger.warn('Semantic indexing failed, continuing without it', err);
      } finally {
        endPhase0.end();
      }
    }

    // Phase 2: Map workspace components
    const endPhase2 = logger.time('Phase 2: Map workspace components');
    progress.report({ message: '📦 Discovering components & sub-projects...', increment: 10 });

    // Collect semantic data from index (if available) for graph-first grouping
    let semanticData: { path: string; summary: string; dependencies: string[]; exports: string[]; complexity: string }[] | undefined;
    if (this.workspaceIndexer) {
      try {
        const cached = this.workspaceIndexer.getSemanticCache().getAll();
        if (cached.length > 0) {
          semanticData = cached.map(c => ({
            path: c.path,
            summary: c.summary || '',
            dependencies: c.dependencies || [],
            exports: c.exports || [],
            complexity: c.complexity || 'unknown',
          }));
          logger.info(`Phase 2: passing ${semanticData.length} semantic entries to component mapper`);
        }
      } catch { /* non-critical */ }
    }

    const projectContext = await this.componentMapper.mapWorkspace(workspaceUri, !quickMode, token, semanticData);

    const langList = projectContext.languages.slice(0, 4).join(', ');
    progress.report({ message: `📦 Found ${projectContext.components.length} components (${langList}) — enriching...`, increment: 2 });

    // Enrich components with semantic cache data
    if (this.workspaceIndexer) {
      try {
        const cachedData = this.workspaceIndexer.getSemanticCache().getAll();
        for (const comp of projectContext.components) {
          const cached = cachedData.find(c => comp.path && c.path.includes(comp.path));
          if (cached && !comp.description) {
            comp.description = cached.summary;
          }
        }
      } catch (err) {
        logger.warn('Semantic cache enrichment failed', err);
      }
    }
    endPhase2.end();

    // Phase 3: Scan maturity levels (~50% of work, sub-progress reported by maturityScanner)
    const endPhase3 = logger.time('Phase 3: Scan maturity levels');
    logger.info(`Phase 3: Starting maturity signal scan for ${AI_TOOLS[selectedTool]?.name || selectedTool}...`);
    progress.report({ message: '📊 Scanning maturity signals across all levels...', increment: 5 });
    const levelScores = await this.maturityScanner.scanAllLevels(
      workspaceUri, projectContext, quickMode, progress, token, selectedTool
    );
    logger.info(`Phase 3: ${levelScores.length} levels scored`);
    endPhase3.end();

    // Phase 3d: Context architecture audit
    let contextAuditResult: ReadinessReport['contextAudit'];
    const endPhase3d = logger.time('Phase 3d: Context architecture audit');
    progress.report({ message: '🔌 Auditing tooling & context architecture...', increment: 3 });
    try {
      const { runContextAudit } = await import('../scoring/contextAudit');
      contextAuditResult = await runContextAudit(workspaceUri, projectContext, selectedTool);
      logger.info(`Phase 3d: Context audit complete — MCP:${contextAuditResult!.mcpHealth.score} Skills:${contextAuditResult!.skillQuality.score} Efficiency:${contextAuditResult!.contextEfficiency.score} Security:${contextAuditResult!.toolSecurity.score}`);
    } catch (err) {
      logger.warn('Context architecture audit failed', err);
    }
    endPhase3d.end();

    // Phase 4: Score components and languages
    const endPhase4 = logger.time('Phase 4: Score components and languages');
    logger.info(`Phase 4: Scoring ${projectContext.components.length} components...`);
    progress.report({ message: '⚙️ Scoring individual components...', increment: 10 });
    const componentScores = await this.componentScorer.scoreComponents(workspaceUri, projectContext, selectedTool);
    const languageScores = await this.componentScorer.scoreLanguages(workspaceUri, projectContext, componentScores, selectedTool);
    logger.info(`Phase 4: ${componentScores.length} components scored, ${languageScores.length} languages`);
    endPhase4.end();

    // Phase 5: Build report
    const endPhase5 = logger.time('Phase 5: Build report');
    progress.report({ message: '🏆 Calculating maturity level & EGDR score...', increment: 5 });
    const projectName = vscode.workspace.workspaceFolders?.[0]?.name || 'Unknown';
    const modelName = quickMode ? 'deterministic' : this.copilotClient.getModelName();
    const report = this.engine.calculateReport(
      projectName, levelScores, projectContext,
      componentScores, languageScores, modelName,
      quickMode ? 'quick' : 'full',
      selectedTool
    );
    endPhase5.end();
    logger.info(`Phase 5: Report built — L${report.primaryLevel} ${report.levelName}, score ${report.overallScore}/100, depth ${report.depth}%`);

    // Attach context audit result (collected in Phase 3d, before report existed)
    if (contextAuditResult) {
      report.contextAudit = contextAuditResult;
    }

    // Phase 6: Calculate codebase readiness metrics
    const endPhase6 = logger.time('Phase 6: Calculate codebase readiness metrics');
    progress.report({ message: '🧠 Analyzing codebase readiness (semantic density, type strictness)...', increment: 5 });
    try {
      const langExtMap: Record<string, string> = {
        'typescript': '**/*.{ts,tsx}', 'javascript': '**/*.{js,jsx}', 'python': '**/*.py',
        'c#': '**/*.cs', 'csharp': '**/*.cs', 'go': '**/*.go', 'rust': '**/*.rs',
        'java': '**/*.java', 'ruby': '**/*.rb',
      };
      const fileAnalyses: FileAnalysis[] = [];
      const depGraph: { source: string; targets: string[] }[] = [];

      for (const lang of projectContext.languages.slice(0, 5)) {
        const pattern = langExtMap[lang.toLowerCase()];
        if (!pattern) continue;
        const files = await vscode.workspace.findFiles(
          new vscode.RelativePattern(workspaceUri, pattern),
          '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/vendor/**}',
          200
        );
        const batchSize = 20;
        for (let i = 0; i < files.length; i += batchSize) {
          const batch = files.slice(i, i + batchSize);
          const results = await Promise.all(batch.map(async (file) => {
            try {
              const doc = await vscode.workspace.openTextDocument(file);
              return analyzeFileContent(vscode.workspace.asRelativePath(file), doc.getText(), lang.toLowerCase());
            } catch (err) {
              logger.warn(`Failed to analyze file: ${file.fsPath}`, err);
              return null;
            }
          }));
          for (const analysis of results) {
            if (analysis) {
              fileAnalyses.push(analysis);
              if (analysis.importCount > 0) {
                depGraph.push({ source: analysis.path, targets: Array(analysis.importCount).fill('') });
              }
            }
          }
        }
      }

      if (fileAnalyses.length > 0) {
        report.codebaseMetrics = calculateCodebaseMetrics(fileAnalyses, depGraph);
      }
    } catch (err) {
      logger.warn('Codebase readiness metrics calculation failed', err);
    } finally {
      endPhase6.end();
    }

    // Phase 7: Structure comparison
    const endPhase7 = logger.time('Phase 7: Structure comparison');
    progress.report({ message: '📐 Comparing repo structure against platform expectations...', increment: 5 });
    try {
      const toolConfig = AI_TOOLS[selectedTool];
      const docsContent = toolConfig?.reasoningContext?.structureExpectations ?? '';
      report.structureComparison = await this.structureAnalyzer.analyzeStructure(
        selectedTool, workspaceUri, projectContext, docsContent, token
      );
    } catch (err) {
      logger.warn('Structure comparison failed', err);
    } finally {
      endPhase7.end();
    }

    // Phase 8: Build knowledge graph
    const endPhase8 = logger.time('Phase 8: Build knowledge graph');
    progress.report({ message: '🕸️ Building component dependency graph...', increment: 5 });
    try {
      const dependencies = await this.dependencyScanner.scanDependencies(workspaceUri, report.componentScores);
      const graph = this.graphBuilder.buildGraph(report, dependencies);
      report.knowledgeGraph = graph;
    } catch (err) {
      logger.warn('Knowledge graph construction failed', err);
    } finally {
      endPhase8.end();
    }

    // Store enrichment percentage used
    const enrichPct = vscode.workspace.getConfiguration('ai-readiness').get<number>('enrichmentDepth') ?? 70;
    (report as any).enrichmentPct = enrichPct;

    await this.context.workspaceState.update('lastReport', report);
    logger.info(`Scan result: L${report.primaryLevel} ${report.levelName} — ${report.overallScore}/100 — ${report.componentScores.length} components`);
    return report;
    } finally {
      clearInterval(heartbeat);
      const totalSeconds = Math.round((Date.now() - scanStart) / 1000);
      logger.info(`Scan completed in ${totalSeconds}s`);
    }
  }
}
