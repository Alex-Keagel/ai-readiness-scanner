import * as vscode from 'vscode';
import { ReadinessReport, MATURITY_LEVELS, AI_TOOLS, AITool, SignalResult, FailingSignal, Insight } from '../scoring/types';
import { getFixTier } from '../remediation/fixClassifier';
import { humanizeSignalId } from '../utils';
import { TACTICAL_GLASSBOX_CSS, getSeverityGlowClass } from './theme';
import { logger } from '../logging';
import { FixStorage, PersistedFix } from '../storage/fixStorage';

interface Recommendation {
  signalId: string;
  level: number;
  name: string;
  finding: string;
  severity: 'critical' | 'important' | 'suggestion';
  tier: 'auto' | 'guided' | 'recommend';
  filePath: string; // what file will be generated
  impact: string;
  detected: boolean;
  score: number;
  confidenceScore?: number; // 0.0-1.0 from validation pipeline
  confidenceReason?: string; // why this confidence level
  validatorAgreed?: boolean;
  debateOutcome?: string;
}

export class RecommendationsPanel {
  public static currentPanel: RecommendationsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private recommendations: Recommendation[] = [];
  private appliedFixIds: Set<string> = new Set();
  private fixStatusMap: Map<string, PersistedFix['status']> = new Map();
  private fixStorage?: FixStorage;
  private qualityThreshold: number = 40;
  private confidenceThreshold: number = 0.5;
  private currentReport?: ReadinessReport;
  private currentTool?: AITool;
  private onGenerate?: (signalIds: string[], approvalMode: 'selected' | 'all') => Promise<void>;
  private onPreview?: (signalId: string) => Promise<{ path: string; content: string }[]>;
  private onChat?: (message: string) => Promise<string>;
  private userContext: string = '';

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Message handler — uses `this` so callbacks are always current
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'generate') {
        const ids = msg.signalIds as string[];
        const approvalMode = msg.approvalMode as 'selected' | 'all' || 'selected';
        logger.info(`Recommendations: generate requested for ${ids.length} signals (mode: ${approvalMode})`);
        logger.debug(`Recommendations: signal IDs: ${ids.join(', ')}`);
        if (!this.onGenerate) {
          logger.warn('Recommendations: no generate handler available');
          this.markError(ids, 'Generate handler not available. Close and reopen the Action Center.');
          return;
        }
        this.markGenerating(ids);
        try {
          const timer = logger.time('Recommendations: generate');
          await this.onGenerate(ids, approvalMode);
          timer?.end?.();
          logger.info(`Recommendations: generation complete for ${ids.length} signals`);
          this.markDone(ids);
        } catch (err) {
          logger.error(`Recommendations: generation failed`, err);
          this.markError(ids, err instanceof Error ? err.message : String(err));
        }
      } else if (msg.command === 'preview') {
        logger.info(`Recommendations: preview requested for "${msg.signalId}"`);
        if (this.onPreview) {
          try {
            const timer = logger.time('Recommendations: preview');
            const files = await this.onPreview(msg.signalId);
            timer?.end?.();
            logger.info(`Recommendations: preview generated ${files.length} files`);
            this.panel.webview.postMessage({ command: 'preview-result', signalId: msg.signalId, files });
          } catch (err) {
            logger.warn(`Recommendations: preview failed for "${msg.signalId}"`, { error: err instanceof Error ? err.message : String(err) });
            this.panel.webview.postMessage({ command: 'preview-result', signalId: msg.signalId, files: [] });
          }
        } else {
          logger.warn('Recommendations: no preview handler available');
          this.panel.webview.postMessage({ command: 'preview-result', signalId: msg.signalId, files: [{ path: '(error)', content: 'Preview handler not available. Close this panel and reopen it.' }] });
        }
      } else if (msg.command === 'chat') {
        const question = msg.message as string;
        logger.info(`Recommendations: chat question: "${question.slice(0, 80)}..."`);
        if (!this.onChat) {
          logger.warn('Recommendations: no chat handler available');
          return;
        }
        this.panel.webview.postMessage({ command: 'chat-typing' });
        try {
          const answer = await this.onChat(question);
          logger.info(`Recommendations: chat answered (${answer.length} chars)`);
          this.panel.webview.postMessage({ command: 'chat-response', message: answer });
        } catch (err) {
          logger.warn('Recommendations: chat failed', { error: err instanceof Error ? err.message : String(err) });
          this.panel.webview.postMessage({ command: 'chat-response', message: `Error: ${err}` });
        }
      } else if (msg.command === 'approve-fix') {
        const sid = msg.signalId as string;
        const workspace = vscode.workspace.workspaceFolders?.[0]?.name || '';
        if (this.fixStorage) {
          await this.fixStorage.updateStatus(sid, workspace, 'approved');
          this.fixStatusMap.set(sid, 'approved');
        }
        this.panel.webview.postMessage({ command: 'fix-status', signalId: sid, status: 'approved' });
      } else if (msg.command === 'decline-fix') {
        const sid = msg.signalId as string;
        const workspace = vscode.workspace.workspaceFolders?.[0]?.name || '';
        if (this.fixStorage) {
          await this.fixStorage.updateStatus(sid, workspace, 'declined');
          this.fixStatusMap.set(sid, 'declined');
        }
        this.panel.webview.postMessage({ command: 'fix-status', signalId: sid, status: 'declined' });
      } else if (msg.command === 'review-fix') {
        const sid = msg.signalId as string;
        const workspace = vscode.workspace.workspaceFolders?.[0]?.name || '';
        const fix = this.fixStorage?.getFix(sid, workspace);
        if (fix && fix.files.length > 0) {
          const wsFolder = vscode.workspace.workspaceFolders?.[0];
          if (wsFolder) {
            const fileUri = vscode.Uri.joinPath(wsFolder.uri, fix.files[0].path);
            try {
              const doc = await vscode.workspace.openTextDocument(fileUri);
              await vscode.window.showTextDocument(doc);
            } catch {
              vscode.window.showWarningMessage(`File not found: ${fix.files[0].path}`);
            }
          }
        }
      } else if (msg.command === 'regenerate-fix') {
        const sid = msg.signalId as string;
        const workspace = vscode.workspace.workspaceFolders?.[0]?.name || '';
        if (this.fixStorage) {
          await this.fixStorage.removeFix(sid, workspace);
          this.fixStatusMap.delete(sid);
        }
        // Trigger regeneration
        if (this.onGenerate) {
          this.markGenerating([sid]);
          try {
            await this.onGenerate([sid], 'selected');
            this.markDone([sid]);
          } catch (err) {
            this.markError([sid], String(err));
          }
        }
      } else if (msg.command === 'set-threshold') {
        this.qualityThreshold = msg.value as number;
        logger.info(`Action Center: quality threshold set to ${this.qualityThreshold}`);
        // Don't re-render — live filtering is handled client-side via input events
      } else if (msg.command === 'set-confidence-threshold') {
        this.confidenceThreshold = msg.value as number;
        logger.info(`Action Center: confidence threshold set to ${this.confidenceThreshold}`);
        // Don't re-render — live filtering is handled client-side via input events
      }
    }, null, this.disposables);
  }

  public static createOrShow(
    report: ReadinessReport,
    tool: AITool,
    userContext: string,
    onGenerate: (signalIds: string[], approvalMode: 'selected' | 'all') => Promise<void>,
    onPreview?: (signalId: string) => Promise<{ path: string; content: string }[]>,
    onChat?: (message: string) => Promise<string>,
    fixStorageInstance?: FixStorage
  ): RecommendationsPanel {
    try {
    const column = vscode.ViewColumn.One;

    // Always create fresh panel to avoid stale JS/HTML caching
    if (RecommendationsPanel.currentPanel) {
      try { RecommendationsPanel.currentPanel.panel.dispose(); } catch { /* already disposed */ }
      RecommendationsPanel.currentPanel = undefined;
    }

    const panel = vscode.window.createWebviewPanel(
      'aiReadinessRecommendations', '🔧 Action Center',
      column, { enableScripts: true }
    );

    const instance = new RecommendationsPanel(panel);
    instance.onGenerate = onGenerate;
    instance.onPreview = onPreview;
    instance.onChat = onChat;
    instance.userContext = userContext;
    instance.fixStorage = fixStorageInstance;
    instance.updateContent(report, tool);

    RecommendationsPanel.currentPanel = instance;
    return instance;
    } catch (err) {
      logger.error('RecommendationsPanel: failed to create', err);
      vscode.window.showErrorMessage(`Failed to open panel: ${err instanceof Error ? err.message : String(err)}`);
      return RecommendationsPanel.currentPanel!;
    }
  }

  private updateContent(report: ReadinessReport, tool: AITool): void {
    try {
      this.currentReport = report;
      this.currentTool = tool;
      this.recommendations = this.buildRecommendations(report, tool);
      
      // Load persisted fix statuses from FixStorage
      const workspace = vscode.workspace.workspaceFolders?.[0]?.name || '';
      this.fixStatusMap.clear();
      this.appliedFixIds.clear();
      if (this.fixStorage) {
        // Auto-resolve fixes whose signals now pass in the scan
        const detectedSignals = new Set(
          report.levels.flatMap(l => l.signals).filter(s => s.detected && s.score >= this.qualityThreshold).map(s => s.signalId)
        );
        
        for (const fix of this.fixStorage.getFixes(workspace)) {
          // If the signal this fix was for is now detected, auto-approve it
          if (fix.status === 'pending-review' && detectedSignals.has(fix.signalId)) {
            this.fixStorage.updateStatus(fix.signalId, workspace, 'approved');
            logger.info(`Auto-approved fix "${fix.signalId}" — signal now detected in scan`);
            continue; // Don't show it
          }
          // If signal still not detected, check if fix files exist (component/insight fixes)
          if (fix.status === 'pending-review' && fix.signalId.startsWith('comp_')) {
            // Component fix — check if the recommendation still exists
            const stillNeeded = this.recommendations.some(r => r.signalId === fix.signalId);
            if (!stillNeeded) {
              this.fixStorage.updateStatus(fix.signalId, workspace, 'approved');
              logger.info(`Auto-approved component fix "${fix.signalId}" — no longer in recommendations`);
              continue;
            }
          }
          
          this.fixStatusMap.set(fix.signalId, fix.status);
          this.appliedFixIds.add(fix.signalId);
        }
      }
      
      this.panel.webview.html = this.getHtml(report, tool);
    } catch (err) {
      logger.error('RecommendationsPanel: updateContent failed', err);
      this.panel.webview.html = `<html><body><h2>❌ Render Error</h2><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`;
    }
  }

  private markGenerating(ids: string[]): void {
    try {
      this.panel.webview.postMessage({ command: 'status', ids, status: 'generating' });
    } catch (err) {
      logger.error('RecommendationsPanel: markGenerating failed', err);
    }
  }

  private markDone(ids: string[]): void {
    try {
      this.panel.webview.postMessage({ command: 'status', ids, status: 'pending-review' });
    } catch (err) {
      logger.error('RecommendationsPanel: markDone failed', err);
    }
  }

  public markPendingReview(ids: string[]): void {
    try {
      this.panel.webview.postMessage({ command: 'status', ids, status: 'pending-review' });
    } catch (err) {
      logger.error('RecommendationsPanel: markPendingReview failed', err);
    }
  }

  private markError(ids: string[], error: string): void {
    try {
      this.panel.webview.postMessage({ command: 'status', ids, status: 'error', error });
    } catch (err) {
      logger.error('RecommendationsPanel: markError failed', err);
    }
  }

  private buildRecommendations(report: ReadinessReport, tool: AITool): Recommendation[] {
    try {
    const allSignals = report.levels.flatMap(ls => ls.signals);
    const recs: Recommendation[] = [];
    
    // ── 1. Signal-based recommendations (missing + low-scoring) ──
    const actionable = allSignals.filter(s => !s.detected || s.score < this.qualityThreshold);
    for (const s of actionable) {
      const tier = getFixTier(s.signalId);
      const severity: Recommendation['severity'] = 
        !s.detected && s.level <= 3 ? 'critical' :
        !s.detected ? 'important' : 'suggestion';
      recs.push({
        signalId: s.signalId,
        level: s.level,
        name: humanizeSignalId(s.signalId),
        finding: s.finding,
        severity,
        tier,
        filePath: this.inferFilePath(s.signalId, tool),
        impact: tier === 'auto' ? 'Will create new file' : tier === 'guided' ? 'Will modify existing file' : 'Manual guidance',
        detected: s.detected,
        score: s.score,
        confidenceScore: s.confidenceScore ?? 1.0, // deterministic checks = full confidence
        confidenceReason: s.confidenceScore != null && s.confidenceScore < 1.0 ? 'LLM-validated signal' : 'Deterministic: file/pattern detection',
        validatorAgreed: s.validatorAgreed,
        debateOutcome: s.debateOutcome,
      });
    }

    // ── 2. Insight-based recommendations (LLM-generated content issues) ──
    const insights = report.insights || [];
    const existingIds = new Set(recs.map(r => r.signalId));
    const existingTitleKeys = new Set(recs.map(r => r.name.toLowerCase().replace(/\d+/g, '').trim()));
    for (const insight of insights) {
      const insightId = `insight_${insight.category}_${(insight.title || '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}`;
      if (existingIds.has(insightId)) continue;

      // Dedup: skip if a similar title already exists (e.g. "Instructions only cover X%" variants)
      const titleKey = (insight.title || '').toLowerCase().replace(/\d+/g, '').trim();
      if (existingTitleKeys.has(titleKey)) continue;

      // Dedup: skip if a skill with the same name is already suggested
      const skillNameMatch = (insight.title || '').match(/[""'](\w[\w-]+)[""']|skill.*?[""](\w+)[""]|Create\s+[""](\w+)[""]|Suggested:\s*(\S+)/i);
      const skillName = (skillNameMatch?.[1] || skillNameMatch?.[2] || skillNameMatch?.[3] || skillNameMatch?.[4] || '').toLowerCase();
      if (skillName && existingTitleKeys.has(`skill:${skillName}`)) continue;
      if (skillName) existingTitleKeys.add(`skill:${skillName}`);

      existingIds.add(insightId);
      existingTitleKeys.add(titleKey);

      const filePath = insight.affectedComponent
        ? `${insight.affectedComponent}/` 
        : '(project-level)';

      recs.push({
        signalId: insightId,
        level: insight.severity === 'critical' ? 2 : insight.severity === 'important' ? 3 : 4,
        name: insight.title,
        finding: insight.recommendation,
        severity: insight.severity,
        tier: 'guided',
        filePath,
        impact: insight.estimatedImpact || 'Improves AI readiness',
        detected: true,
        score: 20,
        confidenceScore: insight.confidenceScore,
        confidenceReason: insight.confidenceScore && insight.confidenceScore >= 0.85 ? 'Deep analysis with validation' : 'LLM-generated insight',
      });
    }

    // ── 3. Component quality recommendations (low-scoring components) ──
    // Skip components already covered by insight-based recs (check both path AND name)
    const insightPaths = new Set(
      recs.filter(r => r.signalId.startsWith('insight_'))
        .map(r => r.filePath.replace(/\/README\.md$/, '').replace(/\/$/, ''))
    );
    const insightNames = new Set(
      recs.filter(r => r.signalId.startsWith('insight_'))
        .map(r => {
          const match = r.name.match(/[""]([^""]+)[""]/);
          return match ? match[1].toLowerCase() : '';
        })
        .filter(n => n)
    );
    const components = report.componentScores || [];
    // Cap component-level recs to top 10 lowest-scoring to avoid noise
    const eligibleComps = components
      .filter(c => c.overallScore < 50)
      .sort((a, b) => a.overallScore - b.overallScore);
    let compRecCount = 0;
    const MAX_COMP_RECS = 10;
    for (const comp of eligibleComps) {
      if (compRecCount >= MAX_COMP_RECS) break;
      // Skip if ANY existing rec already covers this component (by path, name, or filePath)
      const compPathNorm = comp.path.toLowerCase();
      const compNameNorm = comp.name.toLowerCase();
      const alreadyCovered = recs.some(r => {
        const recPath = r.filePath.replace(/\/README\.md$/, '').replace(/\/$/, '').toLowerCase();
        const recName = r.name.toLowerCase();
        return recPath === compPathNorm || recPath.includes(compPathNorm) || compPathNorm.includes(recPath) ||
               recName.includes(compNameNorm) || compNameNorm.includes(recName) ||
               insightPaths.has(comp.path) || insightPaths.has(comp.name) ||
               insightNames.has(compNameNorm);
      });
      if (alreadyCovered) continue;
      // Skip test projects — they don't need READMEs
      const nameLower = comp.name.toLowerCase();
      const pathLower = comp.path.toLowerCase();
      if (nameLower.endsWith('.tests') || nameLower.endsWith('tests') || nameLower.startsWith('test_') || nameLower.startsWith('testfx') || nameLower.includes('testutils') ||
          pathLower.includes('.tests/') || pathLower.includes('/tests/') || pathLower.endsWith('.tests')) continue;
      // Skip generated/exported components
      if (comp.isGenerated) continue;
      // Skip removed/deprecated components
      if (/(removed|deprecated|obsolete|archived)/i.test(nameLower) || /(removed|deprecated|obsolete|archived)/i.test(comp.description || '')) continue;
      // Skip virtual groups (scanner-internal aggregations, not real dirs)
      if (pathLower.includes('.group-')) continue;
      // Skip config/dotfile directories (infrastructure, not code agents edit)
      const topSeg = comp.path.split('/')[0];
      if (topSeg.startsWith('.') && !topSeg.startsWith('.github')) continue;
      const compSignals = comp.signals || [];
      const hasReadme = compSignals.some(s => s.signal?.includes('readme') && s.present);
      const hasDocs = compSignals.some(s => s.signal?.includes('doc') && s.present);

      if (!hasReadme) {
        const id = `comp_readme_${comp.path.replace(/[^a-zA-Z0-9]/g, '_')}`;
        if (!existingIds.has(id)) {
          existingIds.add(id);
          recs.push({
            signalId: id,
            level: 2,
            name: `Add README for ${comp.name}`,
            finding: `Component "${comp.name}" (${comp.path}) scores ${comp.overallScore}/100 and has no README. AI agents cannot understand what this component does or how to modify it safely.`,
            severity: comp.overallScore < 30 ? 'important' : 'suggestion',
            tier: 'guided',
            filePath: `${comp.path}/README.md`,
            impact: 'Agents understand component purpose',
            detected: false,
            score: 0,
            confidenceScore: 1.0,
            confidenceReason: 'Deterministic: file existence check',
          });
        }
      }

      if (!hasDocs && comp.overallScore < 35) {
        const id = `comp_docs_${comp.path.replace(/[^a-zA-Z0-9]/g, '_')}`;
        if (!existingIds.has(id)) {
          existingIds.add(id);
          const deps = comp.children?.length ? ` Connects to: ${comp.children.slice(0, 3).join(', ')}` : '';
          recs.push({
            signalId: id,
            level: 2,
            name: `Document ${comp.name} architecture`,
            finding: `Component "${comp.name}" lacks documentation explaining its purpose, API, and connections to other components.${deps} Without this, agents hallucinate dependencies.`,
            severity: 'suggestion',
            tier: 'guided',
            filePath: `${comp.path}/`,
            impact: 'Reduces agent hallucinations',
            detected: false,
            score: 0,
            confidenceScore: 1.0,
            confidenceReason: 'Deterministic: file existence check',
          });
        }
      }

      // Check for missing tests (app/service/library components)
      const hasTests = compSignals.some(s => s.signal === 'Tests' && s.present);
      const isTestable = comp.type === 'app' || comp.type === 'service' || comp.type === 'library';
      if (!hasTests && isTestable && !comp.isGenerated) {
        const id = `comp_tests_${comp.path.replace(/[^a-zA-Z0-9]/g, '_')}`;
        if (!existingIds.has(id)) {
          existingIds.add(id);
          recs.push({
            signalId: id,
            level: 3,
            name: `Add tests for ${comp.name}`,
            finding: `Component "${comp.name}" (${comp.path}) has no test directory or test files. AI agents cannot verify that generated code changes don't break existing functionality.`,
            severity: comp.type === 'app' || comp.type === 'service' ? 'important' : 'suggestion',
            tier: 'guided',
            filePath: `${comp.path}/tests/`,
            impact: 'Agents can verify code changes',
            detected: false,
            score: 0,
            confidenceScore: 1.0,
            confidenceReason: 'Deterministic: test directory check',
          });
        }
      }
      compRecCount++;
    }

    // Sort: critical first, then by level, then by tier
    return recs.sort((a, b) => {
      const sevOrder = { critical: 0, important: 1, suggestion: 2 };
      if (sevOrder[a.severity] !== sevOrder[b.severity]) return sevOrder[a.severity] - sevOrder[b.severity];
      if (a.level !== b.level) return a.level - b.level;
      const tierOrder = { auto: 0, guided: 1, recommend: 2 };
      return tierOrder[a.tier] - tierOrder[b.tier];
    });
    } catch (err) {
      logger.error('RecommendationsPanel: buildRecommendations failed', err);
      return [];
    }
  }

  private inferFilePath(signalId: string, tool: AITool): string {
    // Map common signal IDs to file paths
    const pathMap: Record<string, Record<string, string>> = {
      copilot: {
        copilot_instructions: '.github/copilot-instructions.md',
        copilot_domain_instructions: '.github/instructions/',
        copilot_agents: '.github/agents/',
        copilot_skills: '.github/skills/',
      },
      cline: {
        cline_rules: '.clinerules/default-rules.md',
        cline_domains: '.clinerules/domains/',
        safe_commands: '.clinerules/safe-commands.md',
        memory_bank: 'memory-bank/',
        memory_bank_update: '.clinerules/workflows/update-memory-bank.md',
      },
      cursor: {
        cursor_rules: '.cursor/rules/',
      },
      claude: {
        claude_instructions: 'CLAUDE.md',
      },
      roo: {
        roo_modes: '.roo/rules/',
      },
      windsurf: {
        windsurf_rules: '.windsurf/rules/',
        agents_md: 'AGENTS.md',
      },
      aider: {
        aider_config: '.aider.conf.yml',
      },
    };

    const toolPaths = pathMap[tool] || {};
    if (toolPaths[signalId]) return toolPaths[signalId];

    // Tool-level signals
    const toolMatch = signalId.match(/^([a-z]+)_l(\d)_(.+)$/);
    if (toolMatch) {
      const level = parseInt(toolMatch[2]);
      const files = (AI_TOOLS[tool] as any)?.[`level${level}Files`] as string[] | undefined;
      if (files?.length) return files[0];
    }

    // Generic
    const genericPaths: Record<string, string> = {
      project_structure_doc: 'docs/PROJECT_STRUCTURE.md',
      conventions_documented: 'CONTRIBUTING.md',
      ignore_files: '.gitignore',
      mcp_config: '.vscode/mcp.json',
      instruction_accuracy: '(improve existing files)',
      memory_bank_accuracy: '(improve memory-bank/ files)',
      post_task_instructions: '.github/instructions/post-task.instructions.md',
      doc_update_instructions: '.github/instructions/doc-updates.instructions.md',
    };
    return genericPaths[signalId] || `(${signalId})`;
  }

  private getHtml(report: ReadinessReport, tool: AITool): string {
    try {
    const toolMeta = AI_TOOLS[tool];
    const toolName = toolMeta?.name ?? tool;
    const toolIcon = toolMeta?.icon ?? '🔧';

    // Build the script block as a SEPARATE string to prevent backticks in
    // template expressions from breaking the outer template literal.
    const SCRIPT_BLOCK = this.getScriptBlock();
    
    // Filter out approved fixes — they're done
    const visibleRecs = this.recommendations.filter(r => this.fixStatusMap.get(r.signalId) !== 'approved');
    const critical = visibleRecs.filter(r => r.severity === 'critical');
    const important = visibleRecs.filter(r => r.severity === 'important');
    const suggestions = visibleRecs.filter(r => r.severity === 'suggestion');
    const approvedCount = this.recommendations.length - visibleRecs.length;
    const autoCount = visibleRecs.filter(r => r.tier === 'auto' || r.tier === 'guided').length;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Action Center</title>
  <style>
    ${TACTICAL_GLASSBOX_CSS}

    /* Panel-specific layout */
    body { padding: 20px; max-width: 1000px; margin: 0 auto; }
    h1 { border-bottom: 1px solid var(--border-subtle); padding-bottom: 12px; margin-bottom: 8px; }
    .subtitle { color: var(--text-secondary); font-size: 0.9em; margin-bottom: 20px; }
    
    .summary-bar { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
    .summary-stat { background: var(--bg-card); border: 1px solid var(--border-subtle); padding: 8px 14px; border-radius: 8px; font-size: 0.85em; }
    .summary-stat strong { font-size: 1.3em; }
    
    .actions { display: flex; gap: 8px; margin: 16px 0; align-items: center; }
    .select-info { font-size: 0.85em; color: var(--text-secondary); margin-left: 8px; }
    
    .section { margin: 20px 0; }
    .section-title { font-size: 1em; font-weight: 600; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
    
    .rec-card { border-radius: 12px; padding: 14px 16px; margin: 8px 0; display: flex; gap: 12px; align-items: flex-start; transition: opacity 0.3s; }
    .rec-card.critical { border-left: 4px solid var(--color-crimson); }
    .rec-card.important { border-left: 4px solid var(--level-3); }
    .rec-card.suggestion { border-left: 4px solid var(--color-cyan); }
    .rec-card.done { opacity: 0.5; border-left-color: var(--color-emerald); }
    .rec-card.generating { opacity: 0.7; }
    
    .rec-check { margin-top: 2px; width: 18px; height: 18px; accent-color: var(--color-cyan); cursor: pointer; flex-shrink: 0; }
    .rec-body { flex: 1; min-width: 0; }
    .rec-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .rec-name { font-weight: 600; font-size: 0.95em; }
    .rec-tag { font-size: 0.75em; padding: 2px 8px; border-radius: 4px; }
    .rec-tag.level { background: var(--bg-elevated); color: var(--text-primary); }
    .rec-tag.auto { background: var(--color-emerald-dim); color: var(--color-emerald); }
    .rec-tag.guided { background: var(--color-cyan-dim); color: var(--color-cyan); }
    .rec-tag.recommend { background: var(--color-amber-dim); color: var(--color-amber); }
    .rec-tag.missing { background: var(--color-crimson-dim); color: var(--color-crimson); }
    .rec-tag.low { background: var(--color-amber-dim); color: var(--color-amber); }
    .rec-tag.confidence-high { background: rgba(46,213,115,0.15); color: #2ed573; font-weight: 600; }
    .rec-tag.confidence-med { background: rgba(255,165,2,0.15); color: #ffa502; font-weight: 600; }
    .rec-tag.confidence-low { background: rgba(255,71,87,0.15); color: #ff4757; font-weight: 600; }
    .rec-card.low-confidence { opacity: 0.35; max-height: 40px; overflow: hidden; }
    .rec-finding { font-size: 0.85em; color: var(--text-secondary); margin: 6px 0; }
    .rec-deps { font-size: 0.8em; color: var(--color-amber); margin: 4px 0; padding: 4px 8px; background: rgba(255,165,2,0.08); border-radius: 4px; }
    .rec-meta { display: flex; gap: 12px; font-size: 0.8em; color: var(--text-secondary); flex-wrap: wrap; }
    .rec-meta code { font-family: var(--font-mono); background: var(--bg-elevated); padding: 1px 4px; border-radius: 3px; }
    .effort-quick { background: rgba(46,213,115,0.15); color: #2ed573; }
    .effort-medium { background: rgba(255,165,2,0.15); color: #ffa502; }
    .effort-involved { background: rgba(255,71,87,0.15); color: #ff4757; }
    .rec-status { font-size: 0.85em; margin-top: 6px; font-weight: 600; }
    .rec-status.generating { color: var(--color-amber); }
    .rec-status.done { color: var(--color-emerald); }
    .rec-status.pending-review { color: var(--color-emerald); }
    .rec-card.pending-review { opacity: 0.9; border-left-color: var(--color-emerald) !important; }
    .regen-btn { background: var(--bg-elevated); border: 1px solid var(--border-subtle); padding: 2px 8px; border-radius: 4px; color: var(--text-secondary); cursor: pointer; font-size: 0.8em; margin-left: 8px; }
    .regen-btn:hover { border-color: var(--border-active); color: var(--text-primary); }
    .rec-card.fix-approved { opacity: 0.6; border-left-color: var(--color-emerald) !important; }
    .rec-card.fix-declined { opacity: 0.5; border-left-color: var(--color-crimson) !important; }
    .rec-card.fix-declined .rec-name { text-decoration: line-through; }
    .rec-status.approved { color: var(--color-emerald); }
    .rec-status.declined { color: var(--color-crimson); }
    .rec-fix-actions { display: flex; align-items: center; gap: 6px; margin: 6px 0; flex-wrap: wrap; }
    .fix-action-btn { padding: 3px 10px; border-radius: 6px; border: 1px solid var(--border-subtle); background: var(--bg-elevated); color: var(--text-primary); cursor: pointer; font-size: 0.78em; transition: all 0.15s; }
    .fix-action-btn:hover { border-color: var(--color-cyan); }
    .fix-action-btn.approve:hover { border-color: var(--color-emerald); color: var(--color-emerald); }
    .fix-action-btn.decline:hover { border-color: var(--color-crimson); color: var(--color-crimson); }
    .fix-action-btn.review:hover { border-color: var(--color-cyan); color: var(--color-cyan); }
    .fix-action-btn.regenerate:hover { border-color: var(--color-amber); color: var(--color-amber); }
    .rec-status.error { color: var(--color-crimson); }
    
    .empty { text-align: center; padding: 40px; color: var(--text-secondary); }
    .context-box { background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; border-left: 3px solid var(--color-cyan); }
    .context-label { font-size: 0.8em; color: var(--text-secondary); margin-bottom: 4px; }
    .context-text { font-size: 0.9em; font-style: italic; }
    .rec-tag.model { background: var(--color-purple-dim); color: var(--color-purple); }
    .preview-file { margin: 8px 0; background: var(--bg-primary); border: 1px solid var(--border-subtle); border-radius: 8px; overflow: hidden; }
    .preview-path { padding: 6px 10px; font-size: 0.8em; font-weight: 600; border-bottom: 1px solid var(--border-subtle); }
    .preview-code { padding: 10px; font-size: 0.8em; margin: 0; white-space: pre-wrap; font-family: var(--font-mono); max-height: 300px; overflow-y: auto; }
    .preview-loading { padding: 12px; color: var(--text-secondary); font-style: italic; }
    
    .chat-section { margin-top: 24px; border-top: 2px solid var(--border-subtle); padding-top: 16px; }
    .chat-messages { background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 12px; max-height: 300px; overflow-y: auto; margin-bottom: 8px; min-height: 80px; }
    .chat-hint { color: var(--text-secondary); font-style: italic; font-size: 0.85em; padding: 8px; }
    .chat-msg { display: flex; gap: 8px; margin: 8px 0; align-items: flex-start; }
    .chat-msg.user { justify-content: flex-end; }
    .chat-avatar { font-size: 1.2em; flex-shrink: 0; }
    .chat-text { background: var(--bg-elevated); padding: 8px 12px; border-radius: 8px; font-size: 0.9em; max-width: 80%; line-height: 1.5; }
    .chat-msg.user .chat-text { background: var(--color-cyan); color: #000; }
    .chat-msg.assistant .chat-text { background: var(--bg-card); }
    .chat-input-row { display: flex; gap: 8px; }
    .chat-input { flex: 1; padding: 8px 12px; background: var(--bg-elevated); color: var(--text-primary); border: 1px solid var(--border-subtle); border-radius: 6px; font-size: 0.9em; font-family: var(--font-ui); }
    .threshold-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin: 8px 0; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 8px; flex-wrap: wrap; }
    .threshold-row label { font-size: 0.85em; white-space: nowrap; }
    .threshold-slider { flex: 1; min-width: 100px; height: 4px; -webkit-appearance: none; appearance: none; background: var(--bg-elevated); border-radius: 2px; cursor: pointer; }
    .threshold-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: var(--color-cyan); cursor: pointer; }
  </style>
</head>
<body>
  <h1>🔧 Action Center</h1>
  <div class="subtitle">${toolIcon} ${esc(toolName)} · Level ${report.primaryLevel} ${MATURITY_LEVELS[report.primaryLevel].name} · ${visibleRecs.length} recommendations${approvedCount > 0 ? ` · ${approvedCount} approved ✅` : ''}</div>

  <div class="context-box">
    <div class="context-label">📝 Your Context</div>
    <div class="context-text">${esc(this.userContext || 'No additional context provided')}</div>
  </div>

  <div class="summary-bar">
    <div class="summary-stat"><strong style="color:var(--color-crimson)">${critical.length}</strong> Critical</div>
    <div class="summary-stat"><strong style="color:var(--level-3)">${important.length}</strong> Important</div>
    <div class="summary-stat"><strong style="color:var(--color-cyan)">${suggestions.length}</strong> Suggestions</div>
    <div class="summary-stat"><strong style="color:var(--color-emerald)">${autoCount}</strong> Auto-fixable</div>
  </div>

  <div class="threshold-row">
    <label>Quality threshold: <strong id="thresholdVal">${this.qualityThreshold}</strong>/100</label>
    <input type="range" class="threshold-slider" id="thresholdSlider" min="10" max="80" step="5" value="${this.qualityThreshold}"
      
      >
    <span style="font-size:0.75em;color:var(--text-secondary)">Signals scoring below this appear as recommendations</span>
  </div>

  <div class="threshold-row">
    <label>Confidence filter: <strong id="confVal">${Math.round((this.confidenceThreshold ?? 0.5) * 100)}</strong>%</label>
    <input type="range" class="threshold-slider" id="confSlider" min="0" max="100" step="5" value="${Math.round((this.confidenceThreshold ?? 0.5) * 100)}"
      
      >
    <span style="font-size:0.75em;color:var(--text-secondary)">Dim recommendations below this confidence level</span>
  </div>

  <div class="actions">
    <button class="btn btn-primary" id="generateBtn" data-action="approveSelected" disabled>✅ Approve & Generate Selected (0)</button>
    <button class="btn btn-secondary" data-action="approveAll">✅ Approve All Fixable</button>
    <button class="btn btn-secondary" data-action="selectAll">☑ Select All</button>
    <button class="btn btn-secondary" data-action="deselectAll">☐ Deselect All</button>
    <button class="btn btn-secondary" data-action="hideGenerated" id="hideGenBtn">🔽 Hide Generated</button>
    <span class="select-info" id="selectInfo"></span>
  </div>

  ${critical.length > 0 ? `
  <div class="section">
    <div class="section-title">🔴 Critical — Fix these to progress</div>
    ${critical.map(r => this.renderCard(r)).join('')}
  </div>` : ''}

  ${important.length > 0 ? `
  <div class="section">
    <div class="section-title">🟡 Important — Improve your score</div>
    ${important.map(r => this.renderCard(r)).join('')}
  </div>` : ''}

  ${suggestions.length > 0 ? `
  <div class="section">
    <div class="section-title">🔵 Suggestions — Nice to have</div>
    ${suggestions.map(r => this.renderCard(r)).join('')}
  </div>` : ''}

  ${visibleRecs.length === 0 && approvedCount > 0 ? '<div class="empty"><h2>🎉 All fixes applied!</h2><p>' + approvedCount + ' recommendations approved. Re-scan to update your score.</p></div>' : ''}
  ${visibleRecs.length === 0 && approvedCount === 0 ? '<div class="empty"><h2>🎉 All signals pass!</h2><p>Your repo is fully configured for ' + esc(toolName) + '.</p></div>' : ''}

  <div class="chat-section">
    <h2 style="font-size:1em;margin-bottom:8px">💬 Ask about recommendations</h2>
    <div class="chat-messages" id="chatMessages">
      <div class="chat-hint">Ask questions like "Why is safe-commands critical for Cline?" or "What should my CLAUDE.md contain?"</div>
    </div>
    <div class="chat-input-row">
      <input type="text" id="chatInput" class="chat-input" placeholder="Ask about these recommendations..."  />
      <button class="btn btn-primary" data-action="sendChat">Send</button>
    </div>
  </div>

  ${SCRIPT_BLOCK}
</body>
</html>`;
    } catch (err) {
      logger.error('RecommendationsPanel: render failed', err);
      return `<html><body><h2>❌ Render Error</h2><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`;
    }
  }

  private getScriptBlock(): string {
    // Return script as a plain string built with quotes — NOT a template literal.
    // This prevents backticks in recommendation content from breaking the script.
    return '<scr' + 'ipt>\n' +
    '(function() {\n' +
    'var vscode;\n' +
    'try { vscode = acquireVsCodeApi(); } catch(e) { return; }\n' +
    '\n' +
    'var thresholdSlider = document.getElementById("thresholdSlider");\n' +
    'var confSlider = document.getElementById("confSlider");\n' +
    'var thresholdVal = document.getElementById("thresholdVal");\n' +
    'var confVal = document.getElementById("confVal");\n' +
    'var generateBtn = document.getElementById("generateBtn");\n' +
    'var hideGenBtn = document.getElementById("hideGenBtn");\n' +
    'var selectInfo = document.getElementById("selectInfo");\n' +
    '\n' +
    'if (thresholdSlider) {\n' +
    '  thresholdSlider.addEventListener("input", function() {\n' +
    '    var val = parseInt(this.value);\n' +
    '    if (thresholdVal) thresholdVal.textContent = String(val);\n' +
    '    var cards = document.querySelectorAll(".rec-card");\n' +
    '    for (var i = 0; i < cards.length; i++) {\n' +
    '      var score = parseInt(cards[i].getAttribute("data-score")) || 0;\n' +
    '      var isMissing = cards[i].querySelector(".missing") !== null;\n' +
    '      cards[i].style.display = (score < val || isMissing || score === 0) ? "" : "none";\n' +
    '    }\n' +
    '  });\n' +
    '}\n' +
    '\n' +
    'if (confSlider) {\n' +
    '  confSlider.addEventListener("input", function() {\n' +
    '    var val = parseInt(this.value);\n' +
    '    if (confVal) confVal.textContent = String(val);\n' +
    '    var threshold = val / 100;\n' +
    '    var cards = document.querySelectorAll(".rec-card");\n' +
    '    for (var i = 0; i < cards.length; i++) {\n' +
    '      var conf = parseFloat(cards[i].getAttribute("data-confidence")) || 1;\n' +
    '      if (conf < threshold) { cards[i].classList.add("low-confidence"); }\n' +
    '      else { cards[i].classList.remove("low-confidence"); }\n' +
    '    }\n' +
    '  });\n' +
    '}\n' +
    '\n' +
    'function bindBtn(sel, fn) { var els = document.querySelectorAll(sel); for (var i = 0; i < els.length; i++) els[i].addEventListener("click", fn); }\n' +
    'bindBtn("[data-action=selectAll]", function() { selectAll(); });\n' +
    'bindBtn("[data-action=deselectAll]", function() { deselectAll(); });\n' +
    'bindBtn("[data-action=approveAll]", function() { approveAll(); });\n' +
    'bindBtn("[data-action=approveSelected]", function() { approveSelected(); });\n' +
    'bindBtn("[data-action=hideGenerated]", function() { toggleGeneratedFilter(); });\n' +
    'bindBtn("[data-action=sendChat]", function() { sendChat(); });\n' +
    '\n' +
    'document.body.addEventListener("click", function(e) {\n' +
    '  var el = e.target;\n' +
    '  while (el && el !== document.body) {\n' +
    '    var action = el.getAttribute("data-action");\n' +
    '    var signal = el.getAttribute("data-signal");\n' +
    '    if (action && signal) {\n' +
    '      if (action === "preview") togglePreview(signal);\n' +
    '      else if (action === "reviewFix") vscode.postMessage({command:"review-fix",signalId:signal});\n' +
    '      else if (action === "approveFix") vscode.postMessage({command:"approve-fix",signalId:signal});\n' +
    '      else if (action === "declineFix") vscode.postMessage({command:"decline-fix",signalId:signal});\n' +
    '      else if (action === "regenerateFix") vscode.postMessage({command:"regenerate-fix",signalId:signal});\n' +
    '      return;\n' +
    '    }\n' +
    '    el = el.parentElement;\n' +
    '  }\n' +
    '});\n' +
    '\n' +
    'document.body.addEventListener("change", function(e) {\n' +
    '  if (e.target && e.target.classList && e.target.classList.contains("rec-check")) updateCount();\n' +
    '});\n' +
    '\n' +
    'var chatInput = document.getElementById("chatInput");\n' +
    'if (chatInput) chatInput.addEventListener("keydown", function(e) { if (e.key === "Enter") sendChat(); });\n' +
    '\n' +
    'updateCount();\n' +
    '\n' +
    'function updateCount() {\n' +
    '  var checked = document.querySelectorAll(".rec-check:checked");\n' +
    '  var count = 0; for (var i = 0; i < checked.length; i++) count++;\n' +
    '  if (generateBtn) { generateBtn.textContent = "\\u2705 Approve & Generate Selected (" + count + ")"; generateBtn.disabled = count === 0; }\n' +
    '}\n' +
    '\n' +
    'function selectAll() { var cbs = document.querySelectorAll(".rec-check"); for (var i = 0; i < cbs.length; i++) { if (!cbs[i].disabled) cbs[i].checked = true; } updateCount(); }\n' +
    'function deselectAll() { var cbs = document.querySelectorAll(".rec-check"); for (var i = 0; i < cbs.length; i++) cbs[i].checked = false; updateCount(); }\n' +
    '\n' +
    'var generatedHidden = false;\n' +
    'function toggleGeneratedFilter() {\n' +
    '  generatedHidden = !generatedHidden;\n' +
    '  if (hideGenBtn) hideGenBtn.textContent = generatedHidden ? "\\u{1F53C} Show Generated" : "\\u{1F53D} Hide Generated";\n' +
    '  var cards = document.querySelectorAll(".rec-card.pending-review");\n' +
    '  for (var i = 0; i < cards.length; i++) cards[i].style.display = generatedHidden ? "none" : "";\n' +
    '}\n' +
    '\n' +
    'function approveSelected() {\n' +
    '  var checked = document.querySelectorAll(".rec-check:checked");\n' +
    '  var ids = []; for (var i = 0; i < checked.length; i++) ids.push(checked[i].getAttribute("data-signal"));\n' +
    '  if (ids.length === 0) return;\n' +
    '  if (generateBtn) { generateBtn.disabled = true; generateBtn.textContent = "\\u23F3 Generating..."; }\n' +
    '  vscode.postMessage({command:"generate",signalIds:ids,approvalMode:"selected"});\n' +
    '}\n' +
    '\n' +
    'function approveAll() {\n' +
    '  var cbs = document.querySelectorAll(".rec-check");\n' +
    '  for (var i = 0; i < cbs.length; i++) { var t = cbs[i].getAttribute("data-tier"); if (t==="auto"||t==="guided") cbs[i].checked = true; }\n' +
    '  updateCount(); approveSelected();\n' +
    '}\n' +
    '\n' +
    'function togglePreview(signalId) {\n' +
    '  var preview = document.getElementById("preview-" + signalId);\n' +
    '  if (!preview) return;\n' +
    '  if (preview.style.display === "none") {\n' +
    '    preview.style.display = "block";\n' +
    '    preview.innerHTML = "<div class=\\"preview-loading\\">\\u23F3 Loading preview...</div>";\n' +
    '    vscode.postMessage({command:"preview",signalId:signalId});\n' +
    '  } else { preview.style.display = "none"; }\n' +
    '}\n' +
    '\n' +
    'function escapeHtml(text) { var d = document.createElement("div"); d.textContent = text; return d.innerHTML; }\n' +
    '\n' +
    'function sendChat() {\n' +
    '  var inp = document.getElementById("chatInput"); if (!inp) return;\n' +
    '  var msg = inp.value.trim(); if (!msg) return; inp.value = "";\n' +
    '  var area = document.getElementById("chatMessages"); if (!area) return;\n' +
    '  var hint = area.querySelector(".chat-hint"); if (hint) hint.remove();\n' +
    '  area.insertAdjacentHTML("beforeend", "<div class=\\"chat-msg user\\"><span class=\\"chat-avatar\\">\\u{1F464}</span><span class=\\"chat-text\\">" + escapeHtml(msg) + "</span></div>");\n' +
    '  area.scrollTop = area.scrollHeight;\n' +
    '  vscode.postMessage({command:"chat",message:msg});\n' +
    '}\n' +
    '\n' +
    'window.addEventListener("message", function(event) {\n' +
    '  var msg = event.data;\n' +
    '  if (msg.command === "status") {\n' +
    '    for (var idx = 0; idx < msg.ids.length; idx++) {\n' +
    '      var id = msg.ids[idx];\n' +
    '      var card = document.querySelector("[data-card=\\"" + id + "\\"]");\n' +
    '      if (!card) continue;\n' +
    '      card.classList.remove("generating","done");\n' +
    '      var old = card.querySelector(".rec-status"); if (old) old.remove();\n' +
    '      if (msg.status==="generating") { card.classList.add("generating"); card.insertAdjacentHTML("beforeend","<div class=\\"rec-status generating\\">\\u23F3 Generating...</div>"); }\n' +
    '      else if (msg.status==="pending-review") { card.classList.remove("generating"); card.classList.add("pending-review"); card.insertAdjacentHTML("beforeend","<div class=\\"rec-status pending-review\\">\\u2705 Generated</div>"); }\n' +
    '      else if (msg.status==="done") { card.classList.add("done"); card.insertAdjacentHTML("beforeend","<div class=\\"rec-status done\\">\\u2705 Generated</div>"); var cb=card.querySelector(".rec-check"); if(cb){cb.checked=false;cb.disabled=true;} }\n' +
    '      else if (msg.status==="error") { card.classList.remove("generating"); card.insertAdjacentHTML("beforeend","<div class=\\"rec-status error\\">\\u274C "+(msg.error||"Failed")+"</div>"); }\n' +
    '    }\n' +
    '    var gen = document.querySelectorAll(".generating");\n' +
    '    if (gen.length===0) { if(generateBtn){generateBtn.textContent="\\u2705 Approve & Generate Selected (0)";generateBtn.disabled=true;} updateCount(); }\n' +
    '  }\n' +
    '  if (msg.command === "preview-result") {\n' +
    '    var prev = document.getElementById("preview-" + msg.signalId);\n' +
    '    if (prev && msg.files && msg.files.length > 0) {\n' +
    '      var h = ""; for (var fi=0;fi<msg.files.length;fi++) h+="<div class=\\"preview-file\\"><div class=\\"preview-path\\">\\u{1F4C4} "+escapeHtml(msg.files[fi].path)+"</div><pre class=\\"preview-code\\">"+escapeHtml(msg.files[fi].content.slice(0,2000))+"</pre></div>";\n' +
    '      prev.innerHTML = h;\n' +
    '    } else if (prev) { prev.innerHTML = "<div class=\\"preview-loading\\">\\u26A0\\uFE0F No preview available</div>"; }\n' +
    '  }\n' +
    '  if (msg.command === "fix-status") {\n' +
    '    var fc = document.querySelector("[data-card=\\"" + msg.signalId + "\\"]"); if (!fc) return;\n' +
    '    fc.classList.remove("pending-review","fix-approved","fix-declined","generating");\n' +
    '    var oa = fc.querySelector(".rec-fix-actions"); if(oa) oa.remove();\n' +
    '    var os = fc.querySelector(".rec-status"); if(os) os.remove();\n' +
    '    if (msg.status==="approved") { fc.classList.add("fix-approved"); fc.querySelector(".rec-body").insertAdjacentHTML("afterbegin","<div class=\\"rec-status approved\\">\\u2705 Approved</div>"); }\n' +
    '    else if (msg.status==="declined") { fc.classList.add("fix-declined"); fc.querySelector(".rec-body").insertAdjacentHTML("afterbegin","<div class=\\"rec-fix-actions\\"><span class=\\"rec-status declined\\">\\u274C Declined</span></div>"); }\n' +
    '  }\n' +
    '  if (msg.command === "chat-typing") {\n' +
    '    var cm = document.getElementById("chatMessages");\n' +
    '    if (cm && !document.getElementById("chat-typing")) { cm.insertAdjacentHTML("beforeend","<div class=\\"chat-msg assistant\\" id=\\"chat-typing\\"><span class=\\"chat-avatar\\">\\u{1F916}</span><span class=\\"chat-text\\">Thinking...</span></div>"); cm.scrollTop=cm.scrollHeight; }\n' +
    '  }\n' +
    '  if (msg.command === "chat-response") {\n' +
    '    var ty = document.getElementById("chat-typing"); if(ty) ty.remove();\n' +
    '    var rm = document.getElementById("chatMessages");\n' +
    '    if (rm) { rm.insertAdjacentHTML("beforeend","<div class=\\"chat-msg assistant\\"><span class=\\"chat-avatar\\">\\u{1F916}</span><span class=\\"chat-text\\">" + escapeHtml(msg.message) + "</span></div>"); rm.scrollTop=rm.scrollHeight; }\n' +
    '  }\n' +
    '});\n' +
    '\n' +
    '})();\n' +
    '</scr' + 'ipt>';
  }

  private renderCard(r: Recommendation): string {
    const tierLabel = r.tier === 'auto' ? '⚡ Auto-fix' : r.tier === 'guided' ? '🔧 Guided' : '📖 Manual';
    const statusLabel = r.detected ? `Score: ${r.score}/100` : 'Missing';
    const statusClass = r.detected ? 'low' : 'missing';
    const canGenerate = r.tier === 'auto' || r.tier === 'guided';
    const alreadyApplied = this.appliedFixIds.has(r.signalId);
    const fixStatus = this.fixStatusMap.get(r.signalId);
    // Only disable checkbox for approved fixes — pending-review and declined can be re-selected
    const checkboxDisabled = fixStatus === 'approved';

    // Effort estimation
    const effort = r.tier === 'auto' ? '⚡ Quick' : r.tier === 'guided' ? '⏱ Medium' : '🔨 Involved';
    const effortClass = r.tier === 'auto' ? 'effort-quick' : r.tier === 'guided' ? 'effort-medium' : 'effort-involved';

    // Dependency hint
    const deps = this.getDependencyHint(r.signalId);

    const cardClass = fixStatus === 'approved' ? 'fix-approved' : fixStatus === 'declined' ? 'fix-declined' : fixStatus === 'pending-review' ? 'pending-review' : '';

    // Status + action buttons
    let statusHtml = '';
    if (fixStatus === 'pending-review') {
      statusHtml = `<div class="rec-fix-actions">
        <span class="rec-status pending-review">📝 Pending Review</span>
        <button class="fix-action-btn review" data-action="reviewFix" data-signal="${esc(r.signalId)}">📄 Review</button>
        <button class="fix-action-btn approve" data-action="approveFix" data-signal="${esc(r.signalId)}">✅ Approve</button>
        <button class="fix-action-btn decline" data-action="declineFix" data-signal="${esc(r.signalId)}">❌ Decline</button>
      </div>`;
    } else if (fixStatus === 'approved') {
      statusHtml = '<div class="rec-status approved">✅ Approved</div>';
    } else if (fixStatus === 'declined') {
      statusHtml = `<div class="rec-fix-actions">
        <span class="rec-status declined">❌ Declined</span>
        <button class="fix-action-btn regenerate" data-action="regenerateFix" data-signal="${esc(r.signalId)}">🔄 Regenerate</button>
      </div>`;
    }

    return `<div class="rec-card glass-card ${r.severity} ${getSeverityGlowClass(r.severity)} ${cardClass}" data-card="${esc(r.signalId)}" data-signal-id="${esc(r.signalId)}" data-score="${r.score}" data-confidence="${r.confidenceScore !== undefined ? r.confidenceScore : 1}">
      <input type="checkbox" class="rec-check" data-signal="${esc(r.signalId)}" data-tier="${r.tier}"  ${checkboxDisabled ? 'disabled' : ''}>
      <div class="rec-body">
        <div class="rec-header">
          <span class="rec-name">${esc(r.name)}</span>
          <span class="rec-tag level">L${r.level}</span>
          <span class="rec-tag ${r.tier}">${tierLabel}</span>
          <span class="rec-tag ${effortClass}">${effort}</span>
          <span class="rec-tag ${statusClass}">${statusLabel}</span>
          ${r.confidenceScore !== undefined ? `<span class="rec-tag confidence-${r.confidenceScore >= 0.8 ? 'high' : r.confidenceScore >= 0.5 ? 'med' : 'low'}" title="${esc(`Confidence: ${Math.round(r.confidenceScore * 100)}%\n${r.confidenceReason || (r.confidenceScore >= 0.95 ? 'Deterministic: file/pattern check' : r.confidenceScore >= 0.8 ? 'Deep analysis with validation' : 'LLM-generated insight')}${r.validatorAgreed === false ? '\nValidator disagreed' + (r.debateOutcome ? ': ' + r.debateOutcome : '') : ''}`)}">${r.confidenceScore >= 0.8 ? '🟢' : r.confidenceScore >= 0.5 ? '🟡' : '🔴'} ${Math.round(r.confidenceScore * 100)}%</span>` : ''}
        </div>
        <div class="rec-finding">${esc(r.finding)}</div>
        ${statusHtml}
        ${deps ? `<div class="rec-deps">⚠️ ${esc(deps)}</div>` : ''}
        <div class="rec-meta">
          <span>📄 <code>${esc(r.filePath)}</code></span>
          <span>📈 ${esc(r.impact)}</span>
        </div>
        <div class="rec-preview" id="preview-${esc(r.signalId)}" style="display:none">
          <div class="preview-loading">Loading preview...</div>
        </div>
        <button class="btn btn-secondary btn-small" data-action="preview" data-signal="${esc(r.signalId)}">👁 Preview</button>
      </div>
    </div>`;
  }

  private getDependencyHint(signalId: string): string | null {
    // Define dependency ordering: instructions must exist before skills, skills before workflows
    const depMap: Record<string, string[]> = {
      'copilot_agents': ['copilot_instructions'],
      'copilot_skills': ['copilot_instructions', 'copilot_agents'],
      'mcp_config': ['copilot_instructions'],
      'agent_workflows': ['copilot_instructions', 'copilot_skills', 'safe_commands'],
      'safe_commands': ['cline_rules'],
      'memory_bank': ['cline_rules'],
      'tool_definitions': ['cline_rules', 'safe_commands'],
      'memory_bank_update': ['memory_bank'],
      'task_playbooks': ['agent_workflows'],
      'workflow_verification': ['agent_workflows'],
    };

    const deps = depMap[signalId];
    if (!deps) return null;

    // Check if dependencies are missing in our recommendations
    const missingDeps = deps.filter(d =>
      this.recommendations.some(r => r.signalId === d && !r.detected)
    );

    if (missingDeps.length === 0) return null;
    return `Create ${missingDeps.map(d => humanizeSignalId(d)).join(', ')} first`;
  }

  private dispose(): void {
    RecommendationsPanel.currentPanel = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/`/g, '&#96;');
}
