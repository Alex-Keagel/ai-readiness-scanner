import * as vscode from 'vscode';
import { TACTICAL_GLASSBOX_CSS } from './theme';
import { RunStorage, ScanRun } from '../storage/runStorage';
import { logger } from '../logging';
import { getAllSignals } from '../scoring/levelSignals';
import { AI_TOOLS, AITool } from '../scoring/types';
import { humanizeSignalId } from '../utils';
import { PlatformSignalFilter } from '../scoring/signalFilter';

export class SidebarPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ai-readiness.sidebar';
  private view?: vscode.WebviewView;

  constructor(
    private extensionUri: vscode.Uri,
    private runStorage: RunStorage
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    try {
      this.view = webviewView;
      webviewView.webview.options = { enableScripts: true };
      this.updateContent();

      webviewView.webview.onDidReceiveMessage(async (msg) => {
        try {
          switch (msg.command) {
            case 'scan': vscode.commands.executeCommand('ai-readiness.fullScan'); break;
            case 'quickScan': vscode.commands.executeCommand('ai-readiness.quickScan'); break;
            case 'guide': vscode.commands.executeCommand('ai-readiness.showGuide'); break;
            case 'vibe': vscode.commands.executeCommand('ai-readiness.vibeReport'); break;
            case 'live': vscode.commands.executeCommand('ai-readiness.liveStart'); break;
            case 'openRun': vscode.commands.executeCommand('ai-readiness.openRun', msg.runId); break;
            case 'deleteRun': vscode.commands.executeCommand('ai-readiness.deleteRun', msg.runId); break;
            case 'clearHistory': vscode.commands.executeCommand('ai-readiness.clearHistory'); break;
            case 'recommendations': vscode.commands.executeCommand('ai-readiness.fixAll'); break;
            case 'insights': vscode.commands.executeCommand('ai-readiness.showInsights'); break;
            case 'graph': vscode.commands.executeCommand('ai-readiness.showGraph'); break;
            case 'compare': vscode.commands.executeCommand('ai-readiness.compareRuns'); break;
            case 'report': vscode.commands.executeCommand('ai-readiness.showReport'); break;
            case 'setDepth': {
              const config = vscode.workspace.getConfiguration('ai-readiness');
              config.update('enrichmentDepth', msg.value, vscode.ConfigurationTarget.Global);
              break;
            }
            case 'setPlatform': {
              const config = vscode.workspace.getConfiguration('ai-readiness');
              config.update('selectedTool', msg.value, vscode.ConfigurationTarget.Global);
              break;
            }
            case 'setSetting': {
              const config = vscode.workspace.getConfiguration('ai-readiness');
              try {
                logger.info(`SidebarPanel: updating setting "${msg.key}"`, { value: typeof msg.value === 'object' ? JSON.stringify(msg.value).slice(0, 100) : msg.value });
                await config.update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
                logger.info(`SidebarPanel: setting "${msg.key}" updated`);
              } catch (settingErr) {
                logger.error(`SidebarPanel: failed to update setting "${msg.key}"`, settingErr);
                vscode.window.showErrorMessage(`Failed to save setting "${msg.key}": ${settingErr instanceof Error ? settingErr.message : String(settingErr)}`);
              }
              break;
            }
            case 'resetScoring': {
              const config = vscode.workspace.getConfiguration('ai-readiness');
              try {
                logger.info('SidebarPanel: resetting scoring weights to defaults');
                await config.update('dimensionWeights', { presence: 0.20, quality: 0.40, operability: 0.15, breadth: 0.25 }, vscode.ConfigurationTarget.Global);
                await config.update('componentTypeWeights', { service: 1.0, app: 1.0, library: 0.9, infra: 0.6, config: 0.4, script: 0.5, data: 0.3, unknown: 0.5 }, vscode.ConfigurationTarget.Global);
                await config.update('scoringMode', 'balanced', vscode.ConfigurationTarget.Global);
                await config.update('signalWeights', {}, vscode.ConfigurationTarget.Global);
                logger.info('SidebarPanel: scoring weights reset');
                this.refresh();
              } catch (resetErr) {
                logger.error('SidebarPanel: reset scoring weights failed', resetErr);
                vscode.window.showErrorMessage(`Failed to reset: ${resetErr instanceof Error ? resetErr.message : String(resetErr)}`);
              }
              break;
            }
          }
        } catch (err) {
          logger.error('SidebarPanel: message handler failed', err);
        }
      });
    } catch (err) {
      logger.error('SidebarPanel: resolveWebviewView failed', err);
    }
  }

  public refresh(): void {
    if (this.view) { this.updateContent(); }
  }

  private updateContent(): void {
    if (!this.view) { return; }
    try {
      this.view.webview.html = this.getHtml();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Sidebar] Render failed:', msg);
      this.view.webview.html = `<html><body><h3>Error loading sidebar</h3><pre>${msg}</pre><button onclick="location.reload()">Retry</button></body></html>`;
    }
  }

  private getHtml(): string {
    try {
    const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.name;
    let allRuns: ScanRun[] = [];
    try {
      allRuns = this.runStorage.getRuns() || [];
    } catch {
      allRuns = [];
    }
    const runs = currentWorkspace
      ? allRuns.filter(r => r?.projectName === currentWorkspace)
      : allRuns;
    const latest = runs.length > 0 ? runs[0] : undefined;
    const hasRuns = runs.length > 0;
    const hasMultiple = runs.length >= 2;

    const config = vscode.workspace.getConfiguration('ai-readiness');
    const depth = config.get<number>('enrichmentDepth') ?? 70;
    const selectedPlatform = config.get<string>('selectedTool') ?? 'ask';
    // Estimate file count from latest run or default
    const lastFileCount = latest?.report?.projectContext?.languages?.length ? latest.report.projectContext.languages.length * 200 : 500;
    const estEnrichedFiles = Math.min(lastFileCount, Math.round(lastFileCount * depth / 100));

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    ${TACTICAL_GLASSBOX_CSS}
    ${SIDEBAR_CSS}
  </style>
</head>
<body>
  <div class="sidebar">
    ${this.renderQuickActions()}
    ${hasRuns && latest ? this.renderCurrentScan(latest) : this.renderEmptyState()}
    ${hasRuns ? this.renderQuickLinks(hasMultiple) : ''}
    ${this.renderScanHistory(allRuns)}
    ${this.renderSettings(depth, selectedPlatform, lastFileCount, estEnrichedFiles)}
    ${this.renderScoringWeights(latest?.report)}
    ${this.renderFooter(hasRuns)}
  </div>
  <script>${SIDEBAR_JS}</script>
</body>
</html>`;
    } catch (err) {
      logger.error('SidebarPanel: render failed', err);
      return `<html><body><h2>❌ Render Error</h2><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`;
    }
  }

  private renderQuickActions(): string {
    try {
    return /* html */ `
    <div class="section quick-actions fade-in">
      <div class="action-grid">
        <button class="btn btn-primary action-btn" onclick="send('scan')">
          <span class="action-icon">🔍</span>
          <span>Scan</span>
        </button>
        <button class="btn action-btn" onclick="send('live')">
          <span class="action-icon">⚡</span>
          <span>Live AIPM</span>
        </button>
        <button class="btn action-btn" onclick="send('vibe')">
          <span class="action-icon">📊</span>
          <span>Vibe Report</span>
        </button>
      </div>
    </div>`;
    } catch (err) {
      logger.error('SidebarPanel: renderQuickActions failed', err);
      return '<div class="section">⚠️ Error rendering actions</div>';
    }
  }

  private renderCurrentScan(run: ScanRun): string {
    try {
    const levelColor = getLevelColor(run.level);
    return /* html */ `
    <div class="section fade-in">
      <div class="section-label">Current Scan</div>
      <div class="glass-card summary-card" onclick="send('report')" style="cursor:pointer">
        <div class="summary-header">
          <span class="badge badge-level badge-l${run.level}">L${run.level} ${run.levelName}</span>
          <span class="badge badge-score">${run.overallScore}/100</span>
        </div>
        <div class="summary-metrics">
          <div class="metric-mini">
            <span class="metric-mini-label">Depth</span>
            <div class="depth-bar">
              <div class="depth-bar-fill" style="width:${run.depth}%;background:${levelColor}"></div>
            </div>
            <span class="metric-mini-value">${run.depth}%</span>
          </div>
        </div>
        <div class="summary-meta">
          <span class="meta-item">${run.toolIcon} ${run.toolName}</span>
          <span class="meta-sep">·</span>
          <span class="meta-item">📂 ${this.escapeHtml(run.projectName)}</span>
        </div>
        <div class="summary-action">
          <span class="link-btn">View Report →</span>
        </div>
      </div>
    </div>`;
    } catch (err) {
      logger.error('SidebarPanel: renderCurrentScan failed', err);
      return '<div class="section">⚠️ Error rendering current scan</div>';
    }
  }

  private renderEmptyState(): string {
    try {
    return /* html */ `
    <div class="section empty-state fade-in">
      <div class="empty-icon">🎯</div>
      <div class="empty-title">AI Readiness Scanner</div>
      <div class="empty-text">Scan your repository to evaluate AI agent readiness.</div>
    </div>`;
    } catch (err) {
      logger.error('SidebarPanel: renderEmptyState failed', err);
      return '<div class="section">⚠️ Error rendering empty state</div>';
    }
  }

  private renderQuickLinks(hasMultiple: boolean): string {
    return /* html */ `
    <div class="section quick-links fade-in">
      <div class="links-row">
        <a class="qlink" onclick="send('insights')">💡 AI Strategy</a>
        <a class="qlink" onclick="send('graph')">🏗️ Structure</a>
        <a class="qlink" onclick="send('recommendations')">🔧 Action Center</a>
      </div>
      <div class="links-row">
        ${hasMultiple ? '<a class="qlink" onclick="send(\'compare\')">🔄 Compare</a>' : ''}
        <a class="qlink" onclick="send('report')">📄 Full Report</a>
      </div>
    </div>`;
  }

  private renderScanHistory(runs: ScanRun[]): string {
    try {
    if (runs.length === 0) { return ''; }

    // Group by repository
    const byRepo = new Map<string, ScanRun[]>();
    for (const run of runs) {
      const key = run.projectName;
      if (!byRepo.has(key)) byRepo.set(key, []);
      byRepo.get(key)!.push(run);
    }

    let repoSections = '';
    for (const [repoName, repoRuns] of byRepo) {
      const items = repoRuns.slice(0, 5).map((run) => {
        const levelColor = getLevelColor(run.level);
        const timeStr = new Date(run.timestamp).toLocaleString(undefined, {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        return /* html */ `
        <div class="history-item glass-card" onclick="send('openRun', '${run.id}')">
          <div class="history-left">
            <span class="level-dot" style="background:${levelColor}"></span>
            <div class="history-info">
              <div class="history-detail">
                ${run.toolIcon} L${run.level} · ${run.overallScore}/100 · ${timeStr}
              </div>
            </div>
          </div>
          <button class="delete-btn" onclick="event.stopPropagation();send('deleteRun','${run.id}')" title="Delete">🗑️</button>
        </div>`;
      }).join('');

      repoSections += `
        <div class="repo-group">
          <div class="repo-name">📂 ${this.escapeHtml(repoName)} <span class="history-count">${repoRuns.length}</span></div>
          ${items}
        </div>`;
    }

    return /* html */ `
    <div class="section fade-in">
      <div class="section-label history-header" onclick="toggleHistory()">
        <span>Scan History</span>
        <span class="history-count">${runs.length}</span>
        <span class="collapse-icon" id="collapse-icon">▼</span>
      </div>
      <div class="history-list" id="history-list">
        ${repoSections}
      </div>
    </div>`;
    } catch (err) {
      logger.error('SidebarPanel: renderScanHistory failed', err);
      return '<div class="section">⚠️ Error rendering scan history</div>';
    }
  }

  private renderSettings(depth: number, selectedPlatform: string, lastFileCount: number, estEnrichedFiles: number): string {
    try {
    const platforms = [
      { key: 'ask', label: 'Ask each time', icon: '❓' },
      { key: 'copilot', label: 'GitHub Copilot', icon: '🤖' },
      { key: 'cline', label: 'Cline', icon: '🔧' },
      { key: 'cursor', label: 'Cursor', icon: '📝' },
      { key: 'claude', label: 'Claude Code', icon: '🧠' },
      { key: 'roo', label: 'Roo Code', icon: '🦘' },
      { key: 'windsurf', label: 'Windsurf', icon: '🏄' },
      { key: 'aider', label: 'Aider', icon: '🔨' },
    ];
    const platformOptions = platforms.map(p =>
      `<option value="${p.key}" ${p.key === selectedPlatform ? 'selected' : ''}>${p.icon} ${p.label}</option>`
    ).join('');

    const config = vscode.workspace.getConfiguration('ai-readiness');
    const llmTimeout = config.get<number>('llmTimeout') ?? 45;
    const concurrency = config.get<number>('enrichmentConcurrency') ?? 5;
    const batchSize = config.get<number>('enrichmentBatchSize') ?? 10;
    const cacheTTL = config.get<number>('cacheTTL') ?? 7;

    return /* html */ `
    <div class="section settings-section fade-in">
      <div class="section-label" onclick="toggleSettings()" style="cursor:pointer">
        <span>⚙️ Settings</span>
        <span class="collapse-icon" id="settings-icon">▶</span>
      </div>
      <div class="settings-body" id="settings-body" style="display:none">
        <div class="setting-row">
          <label class="setting-label">AI Platform <span class="tooltip">ℹ️<span class="tooltip-text">Default AI platform to evaluate readiness for. Each platform has different file expectations and scoring weights.</span></span></label>
          <select class="setting-select" onchange="send('setPlatform', undefined, this.value)">
            ${platformOptions}
          </select>
        </div>
        <div class="setting-row">
          <label class="setting-label">Enrichment Coverage <span class="tooltip">ℹ️<span class="tooltip-text">Percentage of source files that get LLM semantic analysis (summary + keywords). Higher = better code understanding, slower first scan. Files are ranked by importance — most critical files enriched first.</span></span></label>
          <input type="range" class="setting-slider" min="10" max="100" step="5" value="${depth}" 
            oninput="updateDepthPreview(this.value)" 
            onchange="send('setDepth', undefined, undefined, parseInt(this.value))">
          <div class="depth-preview" id="depth-preview" data-total="${lastFileCount}">
            <span class="depth-value">${depth}%</span>
            <span class="depth-est">~${estEnrichedFiles} of ~${lastFileCount} files</span>
          </div>
        </div>
        <details class="advanced-settings">
          <summary class="advanced-toggle">⚙️ Advanced</summary>
          <div class="setting-row">
            <label class="setting-label">LLM Timeout <span class="tooltip">ℹ️<span class="tooltip-text">Default timeout for each LLM API call in seconds. Increase if scans frequently timeout on slow connections.</span></span></label>
            <div class="setting-inline"><input type="number" class="setting-input" min="15" max="300" value="${llmTimeout}" onchange="sendSetting('llmTimeout', parseInt(this.value))"><span class="setting-unit">sec</span></div>
          </div>
          <div class="setting-row">
            <label class="setting-label">Parallel LLM Calls <span class="tooltip">ℹ️<span class="tooltip-text">Number of parallel LLM calls during semantic enrichment. Higher = faster indexing but uses more API quota. Reduce if you hit rate limits.</span></span></label>
            <div class="setting-inline"><input type="number" class="setting-input" min="1" max="10" value="${concurrency}" onchange="sendSetting('enrichmentConcurrency', parseInt(this.value))"><span class="setting-unit">calls</span></div>
          </div>
          <div class="setting-row">
            <label class="setting-label">Files per Batch <span class="tooltip">ℹ️<span class="tooltip-text">Number of files grouped per LLM enrichment call. Higher = fewer API calls but larger prompts. Lower = more precise summaries.</span></span></label>
            <div class="setting-inline"><input type="number" class="setting-input" min="3" max="20" value="${batchSize}" onchange="sendSetting('enrichmentBatchSize', parseInt(this.value))"><span class="setting-unit">files</span></div>
          </div>
          <div class="setting-row">
            <label class="setting-label">Cache Duration <span class="tooltip">ℹ️<span class="tooltip-text">How long LLM analysis results are cached before re-evaluation. Cached results speed up subsequent scans.</span></span></label>
            <div class="setting-inline"><input type="number" class="setting-input" min="1" max="30" value="${cacheTTL}" onchange="sendSetting('cacheTTL', parseInt(this.value))"><span class="setting-unit">days</span></div>
          </div>
        </details>
      </div>
    </div>`;
    } catch (err) {
      logger.error('SidebarPanel: renderSettings failed', err);
      return '<div class="section">⚠️ Error rendering settings</div>';
    }
  }

  private renderScoringWeights(report?: any): string {
    try {
      const config = vscode.workspace.getConfiguration('ai-readiness');
      const dimWeights = config.get<Record<string, number>>('dimensionWeights') ?? { presence: 0.20, quality: 0.40, operability: 0.15, breadth: 0.25 };
      const typeWeights = config.get<Record<string, number>>('componentTypeWeights') ?? { service: 1.0, app: 1.0, library: 0.9, infra: 0.6, config: 0.4, script: 0.5, data: 0.3, unknown: 0.5 };
      const scoringMode = config.get<string>('scoringMode') ?? 'balanced';

      const dimTooltips: Record<string, string> = {
        presence: 'Are the expected config files present? (e.g. copilot-instructions.md, CLAUDE.md). Signals with category "file-presence" feed this dimension.',
        quality: 'Is content accurate, actionable, and well-structured? LLM evaluates instruction accuracy, reality-check pass rate, and business logic alignment. Signals with category "content-quality" feed this.',
        operability: 'Can the agent safely execute? Checks safe-commands, MCP configs, tool definitions, workflow verification, and error recovery docs.',
        breadth: 'How thorough is coverage across components? Measures domain-specific rules, per-language instructions, and cross-component documentation. Signals with category "depth" feed this.',
      };

      const typeTooltips: Record<string, string> = {
        service: 'Core business logic services. Full weight — agents most often modify these. Score = signals detected × quality × accuracy.',
        app: 'Application entry points. Full weight — primary codebase that agents interact with.',
        library: 'Shared libraries and utilities. High weight — changes here ripple across consumers.',
        infra: 'Infrastructure-as-code (Bicep, Terraform, CloudFormation). Moderate weight — often declarative, agents need structural understanding.',
        config: 'Configuration files (JSON, YAML settings). Lower weight — typically static and auto-generated.',
        script: 'Build, deploy, and utility scripts. Moderate weight — agents execute these but rarely modify them deeply.',
        data: 'Data files, migrations, fixtures. Low weight — often generated or managed by pipelines.',
        unknown: 'Unclassified components. Default moderate weight.',
      };

      // Map signals to dimensions using central filter (imported statically)
      const selectedPlatform = config.get<string>('selectedTool') ?? 'ask';
      const effectivePlatform = selectedPlatform !== 'ask' ? selectedPlatform : report?.selectedTool;
      const signalMultipliers = config.get<Record<string, number>>('signalWeights') ?? {};

      const signalsByDim: Record<string, { id: string; name: string; weight: number; category: string; level: number; multiplier: number }[]> = {
        presence: [], quality: [], operability: [], breadth: [],
      };

      if (effectivePlatform) {
        const grouped = PlatformSignalFilter.getByDimension(effectivePlatform as AITool);
        for (const [dim, signals] of Object.entries(grouped)) {
          for (const s of signals) {
            signalsByDim[dim].push({
              id: s.id,
              name: humanizeSignalId(s.id),
              weight: s.weight,
              category: s.category,
              level: s.level,
              multiplier: signalMultipliers[s.id] ?? 1.0,
            });
          }
        }
      } else {
        // No platform selected — show only shared signals
        const allSignals = getAllSignals();
        for (const s of allSignals) {
          if (!PlatformSignalFilter.SHARED_SIGNALS.has(s.id)) continue;
          const dim = PlatformSignalFilter.getSignalDimension(s.id, s.category);
          signalsByDim[dim].push({
            id: s.id,
            name: humanizeSignalId(s.id),
            weight: s.weight,
            category: s.category,
            level: s.level,
            multiplier: signalMultipliers[s.id] ?? 1.0,
          });
        }
      }

      const dimSliders = Object.entries(dimWeights).map(([key, val]) => {
        const pct = Math.round((val as number) * 100);
        const tooltip = dimTooltips[key] || '';
        const dimSignals = signalsByDim[key] || [];
        const signalRows = dimSignals.map(s => {
          const mult = Math.round(s.multiplier * 100);
          return `<div class="signal-weight-row">
            <span class="signal-weight-name">L${s.level} ${this.escapeHtml(s.name)}</span>
            <input type="range" class="signal-weight-slider" min="25" max="300" step="25" value="${mult}"
              oninput="this.nextElementSibling.textContent=this.value+'%'"
              onchange="updateSignalWeight('${s.id}', parseInt(this.value)/100)">
            <span class="signal-weight-val">${mult}%</span>
          </div>`;
        }).join('');

        return `<div class="dim-group">
          <div class="weight-row">
            <label class="weight-label">${key.charAt(0).toUpperCase() + key.slice(1)} <span class="tooltip">ℹ️<span class="tooltip-text">${this.escapeHtml(tooltip)}</span></span></label>
            <input type="range" class="weight-slider" min="0" max="100" step="5" value="${pct}"
              oninput="this.nextElementSibling.textContent=this.value+'%'"
              onchange="updateDimWeight('${key}', parseInt(this.value)/100)">
            <span class="weight-value">${pct}%</span>
          </div>
          ${dimSignals.length > 0 ? `
          <details class="dim-signals">
            <summary class="dim-signals-toggle">${dimSignals.length} signals · click to adjust individually</summary>
            <div class="dim-signals-body">${signalRows}</div>
          </details>` : ''}
        </div>`;
      }).join('');

      const typeSliders = Object.entries(typeWeights).map(([key, val]) => {
        const pct = Math.round((val as number) * 100);
        const tooltip = typeTooltips[key] || '';
        return `<div class="weight-row">
          <label class="weight-label">${key.charAt(0).toUpperCase() + key.slice(1)} <span class="tooltip">ℹ️<span class="tooltip-text">${this.escapeHtml(tooltip)}</span></span></label>
          <input type="range" class="weight-slider" min="0" max="100" step="5" value="${pct}"
            oninput="this.nextElementSibling.textContent=this.value+'%'"
            onchange="updateTypeWeight('${key}', parseInt(this.value)/100)">
          <span class="weight-value">${pct}%</span>
        </div>`;
      }).join('');

      return /* html */ `
      <div class="section settings-section fade-in">
        <div class="section-label" onclick="toggleScoringWeights()" style="cursor:pointer">
          <span>⚖️ Scoring Weights</span>
          <span class="collapse-icon" id="scoring-icon">▶</span>
        </div>
        <div class="scoring-body" id="scoring-body" style="display:none">
          ${this.renderScoringBreakdown(report, dimWeights, typeWeights, scoringMode)}
          <div class="weight-group" style="margin-top:12px">
            <div class="weight-group-title">EGDR Dimension Weights <span class="tooltip">ℹ️<span class="tooltip-text">Controls how the 4 dimensions contribute to each level score. Formula: raw signals × confidence × accuracy → per-dimension weighted average → quality gates → harmonic blend → anti-pattern deductions. Weights auto-normalize to 100%.</span></span></div>
            ${dimSliders}
          </div>
          <div class="weight-group" style="margin-top:12px">
            <div class="weight-group-title">Component Type Importance <span class="tooltip">ℹ️<span class="tooltip-text">Multiplier applied when aggregating component scores into the overall score. Core logic (service/app) at 100% means it contributes fully. Config at 40% means it only contributes 40% of its score to the overall. Overall = 70% signal score + 30% weighted component average.</span></span></div>
            ${typeSliders}
          </div>
          <div class="weight-group" style="margin-top:12px">
            <div class="weight-group-title">Scoring Mode <span class="tooltip">ℹ️<span class="tooltip-text">Controls how harshly uneven dimension scores are penalized. The score blends arithmetic mean (rewards strengths) with harmonic mean (penalizes gaps).</span></span></div>
            <div class="mode-selector">
              <button class="mode-btn ${scoringMode === 'lenient' ? 'active' : ''}" onclick="setScoringMode('lenient')">🟢 Lenient</button>
              <button class="mode-btn ${scoringMode === 'balanced' ? 'active' : ''}" onclick="setScoringMode('balanced')">🟡 Balanced</button>
              <button class="mode-btn ${scoringMode === 'strict' ? 'active' : ''}" onclick="setScoringMode('strict')">🔴 Strict</button>
            </div>
            <div class="mode-explain">
              <div class="mode-row${scoringMode === 'lenient' ? ' mode-active' : ''}"><span class="mode-tag" style="color:#2ed573">Lenient</span><span class="mode-blend">80/20</span><span class="mode-desc">Best areas shine. Weak dim barely hurts.</span></div>
              <div class="mode-row${scoringMode === 'balanced' ? ' mode-active' : ''}"><span class="mode-tag" style="color:#ffa502">Balanced</span><span class="mode-blend">65/35</span><span class="mode-desc">Weak areas drag score noticeably.</span></div>
              <div class="mode-row${scoringMode === 'strict' ? ' mode-active' : ''}"><span class="mode-tag" style="color:#ff4757">Strict</span><span class="mode-blend">50/50</span><span class="mode-desc">Weakest area tanks everything.</span></div>
              <div class="mode-example">Example: dims [80,80,10,80] → Lenient=55 · Balanced=50 · Strict=45</div>
            </div>
          </div>
          <button class="btn action-btn" style="margin-top:8px;width:100%;font-size:0.8em" onclick="resetScoringWeights()">🔄 Reset to Defaults</button>
        </div>
      </div>`;
    } catch (err) {
      logger.error('SidebarPanel: renderScoringWeights failed', err);
      return '<div class="section">⚠️ Error rendering scoring weights</div>';
    }
  }

  private renderScoringBreakdown(report: any, dimWeights: Record<string, number>, typeWeights: Record<string, number>, scoringMode: string): string {
    if (!report) {
      return '<div style="padding:8px;font-size:0.82em;color:var(--text-secondary)">Run a scan to see your scoring breakdown here.</div>';
    }
    try {
      const signals = (report.levels || []).flatMap((l: any) => l.signals || []);
      const detected = signals.filter((s: any) => s.detected);
      const avgScore = detected.length > 0 ? Math.round(detected.reduce((a: number, s: any) => a + s.score, 0) / detected.length) : 0;
      const highConf = detected.filter((s: any) => s.confidence === 'high').length;
      const realityChecks = signals.filter((s: any) => s.realityChecks?.length).flatMap((s: any) => s.realityChecks);
      const validChecks = realityChecks.filter((r: any) => r.status === 'valid').length;
      const invalidChecks = realityChecks.filter((r: any) => r.status === 'invalid').length;

      const modeArith = scoringMode === 'lenient' ? 80 : scoringMode === 'strict' ? 50 : 65;

      const hasStale = signals.some((s: any) => s.detected && s.realityChecks?.filter((r: any) => r.status === 'invalid').length >= 2);
      const hasBoilerplate = signals.some((s: any) => s.detected && s.score < 20 && s.confidence === 'high');
      const hasContradiction = signals.some((s: any) => s.businessFindings?.some((f: string) => f.startsWith('❌')));
      const hasNoTypes = signals.some((s: any) => s.signalId === 'codebase_type_strictness' && s.detected && s.score < 10);
      const hasUnsafe = signals.some((s: any) => s.signalId?.includes('workflow') && s.detected) && !signals.some((s: any) => s.signalId === 'safe_commands' && s.detected);
      let apMultiplier = 1.0;
      if (hasNoTypes) apMultiplier *= 0.95;
      if (hasStale) apMultiplier *= 0.93;
      if (hasBoilerplate) apMultiplier *= 0.96;
      if (hasContradiction) apMultiplier *= 0.89;
      if (hasUnsafe) apMultiplier *= 0.92;
      apMultiplier = Math.max(0.70, apMultiplier);
      const apPct = Math.round((1 - apMultiplier) * 100);

      const comps = report.componentScores || [];
      const compsByType = new Map<string, number>();
      for (const c of comps) { compsByType.set(c.type || 'unknown', (compsByType.get(c.type || 'unknown') || 0) + 1); }

      return `
        <div class="scoring-breakdown">
          <details class="pipeline-details">
            <summary class="breakdown-title">📊 Your Score Pipeline <span class="result-score" style="margin-left:auto;color:${report.overallScore >= 60 ? 'var(--color-emerald)' : report.overallScore >= 35 ? 'var(--color-amber)' : 'var(--color-crimson)'}">${report.overallScore}/100</span></summary>

          <div class="pipeline-step">
            <div class="step-head"><span class="step-num">①</span> Signal Detection</div>
            <div class="step-vals">${detected.length}/${signals.length} detected · avg ${avgScore}/100 · ${highConf} high conf</div>
            <div class="step-hint">💡 Raw score × confidence (high=1.0, med=0.85, low=0.65)</div>
          </div>

          <div class="pipeline-step">
            <div class="step-head"><span class="step-num">②</span> Reality Checks</div>
            <div class="step-vals">${validChecks}✅ ${invalidChecks}❌ of ${realityChecks.length} paths</div>
            <div class="step-hint">💡 Verifies file paths & commands in instructions. Invalid = agent hallucinations</div>
          </div>

          <div class="pipeline-step">
            <div class="step-head"><span class="step-num">③</span> Dimensions</div>
            <div class="step-vals">P=${Math.round(dimWeights.presence * 100)}% Q=${Math.round(dimWeights.quality * 100)}% O=${Math.round(dimWeights.operability * 100)}% B=${Math.round(dimWeights.breadth * 100)}%</div>
            <div class="step-hint">💡 Critical signals=3×, required=2×, recommended=1× weight within each dimension</div>
          </div>

          <div class="pipeline-step">
            <div class="step-head"><span class="step-num">④</span> Blend (${modeArith}/${100 - modeArith})</div>
            <div class="step-vals">${modeArith}% arithmetic + ${100 - modeArith}% harmonic</div>
            <div class="step-hint">💡 Example: dims [80,80,10,80] → arith=62, harm=28 → blend=${Math.round(modeArith / 100 * 62 + (1 - modeArith / 100) * 28)}</div>
          </div>

          <div class="pipeline-step${apMultiplier < 1 ? ' step-penalty' : ''}">
            <div class="step-head"><span class="step-num">⑤</span> Anti-Patterns</div>
            <div class="step-vals">${apMultiplier < 1 ? `×${apMultiplier.toFixed(2)} (−${apPct}%)` : '✅ None'}${hasNoTypes ? ' · no types(×0.95)' : ''}${hasStale ? ' · stale(×0.93)' : ''}${hasBoilerplate ? ' · boilerplate(×0.96)' : ''}${hasContradiction ? ' · contradictions(×0.89)' : ''}${hasUnsafe ? ' · unsafe(×0.92)' : ''}</div>
            <div class="step-hint">💡 Product stacking: multipliers compound. Floor: ×0.70. Combined with gates: floor ×0.40.</div>
          </div>

          <div class="pipeline-step">
            <div class="step-head"><span class="step-num">⑥</span> Components</div>
            <div class="step-vals">${comps.length} total · ${[...compsByType.entries()].map(([t, n]) => `${n}×${t}(${Math.round((typeWeights[t] ?? 0.5) * 100)}%)`).join(' ')}</div>
            <div class="step-hint">💡 service@100% fully counts. config@40%: score 90 → contributes 36. Prevents inflation from auto-generated files.</div>
          </div>

          <div class="pipeline-result">
            <span>→ Final</span>
            <span class="result-score" style="color:${report.overallScore >= 60 ? 'var(--color-emerald)' : report.overallScore >= 35 ? 'var(--color-amber)' : 'var(--color-crimson)'}">${report.overallScore}/100</span>
          </div>
          </details>
        </div>`;
    } catch (err) {
      logger.error('SidebarPanel: renderScoringBreakdown failed', err);
      return '';
    }
  }

  private renderFooter(hasRuns: boolean): string {
    try {
    return /* html */ `
    <div class="guide-section fade-in">
      <button class="btn action-btn guide-btn" onclick="send('guide')">
        <span class="action-icon">📚</span>
        <span>Platform Guide</span>
      </button>
    </div>
    <div class="footer fade-in">
      <div class="footer-text">💬 <code>@readiness</code> in Copilot Chat</div>
      ${hasRuns ? '<a class="qlink footer-clear" onclick="send(\'clearHistory\')">🗑️ Clear History</a>' : ''}
    </div>`;
    } catch (err) {
      logger.error('SidebarPanel: renderFooter failed', err);
      return '<div class="section">⚠️ Error rendering footer</div>';
    }
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

function getLevelColor(level: number): string {
  const colors: Record<number, string> = {
    1: '#FF3B5C', 2: '#FFB020', 3: '#FFEA00', 4: '#00E676', 5: '#00E5FF', 6: '#B388FF',
  };
  return colors[level] || '#888';
}

function formatTimeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) { return 'just now'; }
  if (mins < 60) { return `${mins}m ago`; }
  const hours = Math.floor(mins / 60);
  if (hours < 24) { return `${hours}h ago`; }
  const days = Math.floor(hours / 24);
  if (days < 7) { return `${days}d ago`; }
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const SIDEBAR_CSS = `
/* ─── Sidebar Overrides ─── */
body {
  font-size: 0.85em;
  padding: 0;
  overflow-x: hidden;
}
body::before { display: none; }

.sidebar {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 100vh;
}

/* ─── Sections ─── */
.section { }
.section-label {
  font-size: 0.75em;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ─── Quick Actions ─── */
.action-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}
.action-btn {
  flex-direction: column;
  gap: 2px !important;
  padding: 10px 4px !important;
  font-size: 0.78em !important;
  text-align: center;
  justify-content: center;
  border-radius: 8px !important;
}
.action-icon {
  font-size: 1.2em;
  line-height: 1;
}

/* ─── Latest Summary Card ─── */
.summary-card {
  padding: 12px !important;
  border-radius: 10px !important;
}
.summary-card:hover {
  transform: translateY(-1px);
}
.summary-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.summary-metrics {
  margin-bottom: 8px;
}
.metric-mini {
  display: flex;
  align-items: center;
  gap: 8px;
}
.metric-mini-label {
  font-size: 0.78em;
  color: var(--text-muted);
  min-width: 38px;
}
.depth-bar {
  flex: 1;
  height: 4px;
  background: var(--bg-elevated);
  border-radius: 2px;
  overflow: hidden;
}
.depth-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.5s ease;
}
.metric-mini-value {
  font-family: var(--font-mono);
  font-size: 0.78em;
  font-weight: 600;
  color: var(--text-secondary);
  min-width: 32px;
  text-align: right;
}
.summary-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.78em;
  color: var(--text-secondary);
  margin-bottom: 6px;
}
.meta-sep { color: var(--text-muted); }
.summary-action {
  text-align: right;
}
.link-btn {
  font-size: 0.78em;
  color: var(--color-cyan);
  cursor: pointer;
}
.link-btn:hover { text-decoration: underline; }

/* ─── Quick Links ─── */
.links-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
}
.qlink {
  font-size: 0.8em;
  color: var(--text-secondary);
  cursor: pointer;
  text-decoration: none;
  transition: color 0.15s;
  white-space: nowrap;
}
.qlink:hover { color: var(--color-cyan); }

/* ─── Scan History ─── */
.history-header {
  cursor: pointer;
  user-select: none;
}
.history-count {
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 0.85em;
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
}
.collapse-icon {
  margin-left: auto;
  font-size: 0.7em;
  color: var(--text-muted);
  transition: transform 0.2s;
}
.collapse-icon.collapsed { transform: rotate(-90deg); }

.history-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: hidden;
  transition: max-height 0.3s ease;
}
.history-list.collapsed { max-height: 0 !important; }

.history-item {
  padding: 8px 10px !important;
  border-radius: 8px !important;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  gap: 8px;
}
.history-item:hover { transform: none; }
.history-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.level-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.history-info {
  min-width: 0;
}
.history-name {
  font-size: 0.85em;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.history-detail {
  font-size: 0.72em;
  color: var(--text-muted);
  white-space: nowrap;
}
.delete-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.8em;
  opacity: 0;
  transition: opacity 0.15s;
  padding: 2px 4px;
  border-radius: 4px;
  flex-shrink: 0;
}
.history-item:hover .delete-btn { opacity: 0.6; }
.delete-btn:hover { opacity: 1 !important; }

.show-more {
  text-align: center;
  padding: 4px 0;
}

/* ─── Empty State ─── */
.empty-state {
  text-align: center;
  padding: 24px 12px;
}
.empty-icon { font-size: 2em; margin-bottom: 8px; }
.empty-title {
  font-size: 1em;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}
.empty-text {
  font-size: 0.82em;
  color: var(--text-secondary);
  line-height: 1.5;
}
.empty-state .btn {
  width: 100%;
  justify-content: center;
}

/* ─── Footer ─── */
.guide-section {
  padding: 8px 0;
  border-top: 1px solid var(--border-subtle);
  margin-top: auto;
}
.guide-btn {
  width: 100%;
  justify-content: center;
  padding: 8px 12px;
}
.footer {
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
  text-align: center;
}
.footer-text {
  font-size: 0.75em;
  color: var(--text-muted);
  margin-bottom: 6px;
}
.footer-text code {
  color: var(--color-cyan);
  font-size: 1em;
}
.footer-clear {
  font-size: 0.72em;
  display: inline-block;
  margin-top: 2px;
}

/* Settings */
.settings-section { border-top: 1px solid var(--border-subtle); padding-top: 8px; }
.settings-body { padding: 8px 0; }
.setting-row { margin: 8px 0; }
.advanced-settings { margin-top: 8px; }
.advanced-toggle { font-size: 0.78em; color: var(--text-secondary); cursor: pointer; list-style: none; padding: 4px 0; }
.advanced-toggle::-webkit-details-marker { display: none; }
.advanced-toggle::before { content: '▸ '; font-size: 0.8em; }
.advanced-settings[open] .advanced-toggle::before { content: '▾ '; }
.setting-label { font-size: 0.78em; color: var(--text-secondary); display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }

/* CSS Tooltips */
.tooltip { position: relative; cursor: pointer; font-size: 0.95em; display: inline-block; }
.tooltip .tooltip-text {
  display: none;
  position: fixed; z-index: 9999;
  background: #e8eaf0; color: #1a1c2a;
  border: 1px solid #b0b4c0; border-radius: 10px;
  padding: 14px 16px; font-size: 12px; line-height: 1.65;
  min-width: 180px; max-width: calc(100vw - 32px); width: auto;
  box-shadow: 0 8px 28px rgba(0,0,0,0.35);
  font-weight: 400; letter-spacing: 0.01em;
  word-wrap: break-word; overflow-wrap: break-word; white-space: normal;
}
.tooltip.open .tooltip-text { display: block; }
.setting-select {
  width: 100%; padding: 5px 8px; border-radius: 6px; font-size: 0.82em;
  background: var(--bg-elevated); color: var(--text-primary);
  border: 1px solid var(--border-subtle); font-family: var(--font-ui);
}
.setting-slider {
  width: 100%; accent-color: var(--color-cyan); margin: 4px 0;
}
.setting-inline {
  display: flex; align-items: center; gap: 6px;
}
.setting-input {
  width: 70px; padding: 4px 8px; border-radius: 6px; font-size: 0.82em;
  background: var(--bg-elevated); color: var(--text-primary);
  border: 1px solid var(--border-subtle); font-family: var(--font-mono);
  text-align: right;
}
.setting-unit {
  font-size: 0.75em; color: var(--text-muted);
}
.depth-preview {
  display: flex; justify-content: space-between; font-size: 0.75em; color: var(--text-muted);
}
.depth-value { font-weight: 600; color: var(--color-cyan); font-family: var(--font-mono); }
.depth-est { font-style: italic; }

/* Scoring weights */
.weight-group { }
.weight-group-title { font-size: 0.82em; font-weight: 600; color: var(--text-primary); margin-bottom: 6px; display: flex; align-items: center; gap: 4px; }
.weight-row { display: grid; grid-template-columns: 100px 1fr 36px; align-items: center; gap: 8px; padding: 3px 0; }
.weight-label { font-size: 0.8em; color: var(--text-secondary); display: flex; align-items: center; gap: 3px; white-space: nowrap; overflow: hidden; }
.weight-slider { width: 100%; height: 4px; -webkit-appearance: none; appearance: none; background: var(--bg-elevated); border-radius: 2px; outline: none; cursor: pointer; }
.weight-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: var(--color-cyan); cursor: pointer; }
.weight-value { font-size: 0.78em; color: var(--text-primary); text-align: right; font-variant-numeric: tabular-nums; }
.mode-selector { display: flex; gap: 4px; }
.mode-btn { flex: 1; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border-subtle); background: var(--bg-elevated); color: var(--text-secondary); cursor: pointer; font-size: 0.78em; font-weight: 600; transition: all 0.15s; text-align: center; }
.mode-btn:hover { border-color: var(--color-cyan); }
.mode-btn.active { background: rgba(0,210,255,0.12); border-color: var(--color-cyan); color: var(--color-cyan); }
.mode-explain { margin-top: 6px; font-size: 0.78em; }
.mode-row { display: flex; gap: 6px; align-items: center; padding: 3px 6px; border-radius: 4px; opacity: 0.6; }
.mode-row.mode-active { opacity: 1; background: rgba(255,255,255,0.03); }
.mode-tag { font-weight: 700; min-width: 58px; }
.mode-blend { color: var(--text-secondary); min-width: 36px; font-variant-numeric: tabular-nums; }
.mode-desc { color: var(--text-secondary); }
.mode-example { margin-top: 4px; padding: 4px 6px; font-size: 0.92em; color: var(--text-secondary); font-style: italic; border-left: 2px solid rgba(0,210,255,0.2); }

/* Scoring breakdown */
.scoring-breakdown { padding: 8px 0; margin-bottom: 8px; border-bottom: 1px solid var(--border-subtle); }
.breakdown-title { font-size: 0.85em; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; padding: 4px 0; }
.breakdown-title::-webkit-details-marker { display: none; }
.breakdown-title::before { content: '▸'; font-size: 0.7em; color: var(--text-secondary); }
.pipeline-details[open] .breakdown-title::before { content: '▾'; }
.pipeline-details { margin-bottom: 8px; border-bottom: 1px solid var(--border-subtle); padding-bottom: 8px; }
.pipeline-step { padding: 6px 8px; margin: 4px 0; border-radius: 6px; background: rgba(255,255,255,0.02); border-left: 2px solid rgba(255,255,255,0.08); }
.pipeline-step.step-penalty { border-left-color: var(--color-crimson); background: rgba(255,71,87,0.04); }
.step-head { font-size: 0.82em; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 4px; }
.step-num { color: var(--color-cyan); font-size: 0.9em; }
.step-vals { font-size: 0.8em; color: var(--text-primary); margin-top: 2px; font-variant-numeric: tabular-nums; }
.step-hint { font-size: 0.75em; color: var(--text-secondary); margin-top: 3px; line-height: 1.4; }
.pipeline-result { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; margin-top: 6px; border-radius: 8px; background: rgba(255,255,255,0.03); border: 1px solid var(--border-subtle); font-weight: 700; font-size: 0.9em; }
.result-score { font-size: 1.2em; font-weight: 800; }

/* Dimension signal controls */
.dim-group { margin-bottom: 4px; }
.dim-signals { margin: 2px 0 6px 12px; }
.dim-signals-toggle { font-size: 0.75em; color: var(--text-secondary); cursor: pointer; list-style: none; padding: 2px 0; }
.dim-signals-toggle::-webkit-details-marker { display: none; }
.dim-signals-toggle::before { content: '▸ '; }
.dim-signals[open] .dim-signals-toggle::before { content: '▾ '; }
.dim-signals-body { padding: 4px 0; }
.signal-weight-row { display: grid; grid-template-columns: 110px 1fr 32px; align-items: center; gap: 6px; padding: 2px 0; }
.signal-weight-name { font-size: 0.72em; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.signal-weight-slider { width: 100%; height: 3px; -webkit-appearance: none; appearance: none; background: var(--bg-elevated); border-radius: 2px; outline: none; cursor: pointer; }
.signal-weight-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 10px; height: 10px; border-radius: 50%; background: var(--color-cyan); cursor: pointer; }
.signal-weight-val { font-size: 0.7em; color: var(--text-primary); text-align: right; font-variant-numeric: tabular-nums; }

/* Repo groups in history */
.repo-group { margin-bottom: 8px; }
.repo-name { font-size: 0.82em; font-weight: 600; padding: 4px 0; color: var(--text-primary); display: flex; align-items: center; gap: 6px; }
`;

const SIDEBAR_JS = `
const vscode = acquireVsCodeApi();

// Click-to-toggle tooltips — use capture phase for reliability in webviews
document.addEventListener('click', function(e) {
  // Find tooltip trigger (the ℹ️ span or anything inside .tooltip)
  let target = e.target;
  let tip = null;
  // Walk up to find .tooltip (handles text nodes and nested elements)
  while (target && target !== document) {
    if (target.classList && target.classList.contains('tooltip')) {
      tip = target;
      break;
    }
    target = target.parentElement;
  }
  
  if (tip) {
    // Close all other tooltips
    document.querySelectorAll('.tooltip.open').forEach(function(t) { if (t !== tip) t.classList.remove('open'); });
    
    // Position tooltip near the ℹ️ icon
    var text = tip.querySelector('.tooltip-text');
    if (text) {
      var rect = tip.getBoundingClientRect();
      text.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 296)) + 'px';
      text.style.top = Math.max(8, rect.top - text.offsetHeight - 8) + 'px';
      // If it would go above viewport, show below
      if (rect.top - 200 < 0) {
        text.style.top = (rect.bottom + 8) + 'px';
      }
    }
    
    tip.classList.toggle('open');
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  // Click outside — close all
  document.querySelectorAll('.tooltip.open').forEach(function(t) { t.classList.remove('open'); });
}, true); // capture phase

function send(command, runId, platformValue, depthValue) {
  const msg = { command };
  if (runId !== undefined) msg.runId = runId;
  if (platformValue !== undefined) msg.value = platformValue;
  if (depthValue !== undefined) msg.value = depthValue;
  vscode.postMessage(msg);
}

function toggleHistory() {
  const list = document.getElementById('history-list');
  const icon = document.getElementById('collapse-icon');
  if (!list || !icon) return;
  list.classList.toggle('collapsed');
  icon.classList.toggle('collapsed');
}

function toggleSettings() {
  const body = document.getElementById('settings-body');
  const icon = document.getElementById('settings-icon');
  if (!body || !icon) return;
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? 'block' : 'none';
  icon.textContent = hidden ? '▼' : '▶';
}

function updateDepthPreview(val) {
  const preview = document.getElementById('depth-preview');
  if (!preview) return;
  const total = parseInt(preview.dataset.total || '500');
  const enriched = Math.min(total, Math.round(total * val / 100));
  preview.innerHTML = '<span class="depth-value">' + val + '%</span><span class="depth-est">~' + enriched + ' of ~' + total + ' files</span>';
}

function sendSetting(key, value) {
  console.log('[Sidebar] sendSetting:', key, value);
  vscode.postMessage({ command: 'setSetting', key: key, value: value });
}

function toggleScoringWeights() {
  const body = document.getElementById('scoring-body');
  const icon = document.getElementById('scoring-icon');
  if (!body || !icon) return;
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? 'block' : 'none';
  icon.textContent = hidden ? '▼' : '▶';
}

function updateDimWeight(key, value) {
  // Read current weights from all sliders, update the changed one
  const sliders = document.querySelectorAll('#scoring-body .weight-group:first-child .weight-slider');
  const weights = {};
  sliders.forEach(s => {
    const label = s.closest('.weight-row').querySelector('.weight-label').textContent.trim().split(' ')[0].toLowerCase();
    weights[label] = parseInt(s.value) / 100;
  });
  weights[key] = value;
  sendSetting('dimensionWeights', weights);
}

function updateTypeWeight(key, value) {
  const sliders = document.querySelectorAll('#scoring-body .weight-group:last-of-type .weight-slider');
  const weights = {};
  sliders.forEach(s => {
    const label = s.closest('.weight-row').querySelector('.weight-label').textContent.trim().split(' ')[0].toLowerCase();
    weights[label] = parseInt(s.value) / 100;
  });
  weights[key] = value;
  sendSetting('componentTypeWeights', weights);
}

function resetScoringWeights() {
  vscode.postMessage({ command: 'resetScoring' });
}

function setScoringMode(mode) {
  console.log('[Sidebar] setScoringMode:', mode);
  sendSetting('scoringMode', mode);
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
}

function updateSignalWeight(signalId, value) {
  console.log('[Sidebar] updateSignalWeight:', signalId, value);
  // Read current signal weights, update the changed one
  const current = {};
  document.querySelectorAll('.signal-weight-slider').forEach(s => {
    const row = s.closest('.signal-weight-row');
    if (!row) return;
    const name = row.querySelector('.signal-weight-name');
    // We use the onchange attribute to find the signal ID
    const match = s.getAttribute('onchange')?.match(/updateSignalWeight\\('([^']+)'/);
    if (match) current[match[1]] = parseInt(s.value) / 100;
  });
  current[signalId] = value;
  sendSetting('signalWeights', current);
}
`;
