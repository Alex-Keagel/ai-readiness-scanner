import * as vscode from 'vscode';
import { ReadinessReport, MATURITY_LEVELS, AI_TOOLS, AITool, StructureComparison } from '../scoring/types';
import { TACTICAL_GLASSBOX_CSS, getLevelColor, getLevelGlowClass, getSeverityGlowClass } from './theme';
import { DocsCache } from '../llm/docsCache';
import { logger } from '../logging';

const REFERENCE_DOCS_UPDATED = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export class GuidePanel {
  public static currentPanel: GuidePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private platformFileDates = new Map<string, { path: string; date: string }[]>();
  private liveDocsContent = new Map<string, { content: string; fetchedAt: string }>();
  private docsCache?: DocsCache;

  private constructor(panel: vscode.WebviewPanel, report: ReadinessReport, docsCache?: DocsCache) {
    this.panel = panel;
    this.report = report;
    this.docsCache = docsCache;
    this.initialize(report);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.command === 'refresh') {
          this.platformFileDates.clear();
          this.liveDocsContent.clear();
          await this.initialize(this.report);
          vscode.window.showInformationMessage('Platform guide refreshed with latest docs.');
        }
      } catch (err) {
        logger.error('GuidePanel: message handler failed', err);
      }
    }, null, this.disposables);
  }

  private async initialize(report: ReadinessReport): Promise<void> {
    try {
      await Promise.all([
        this.collectFileDates(report),
        this.fetchLiveDocs(),
      ]);
      this.panel.webview.html = this.getHtml(report);
    } catch (err) {
      logger.error('GuidePanel: initialize failed', err);
      this.panel.webview.html = `<html><body><h2>❌ Initialization Error</h2><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`;
    }
  }

  private async fetchLiveDocs(): Promise<void> {
    try {
    if (!this.docsCache) return;
    const toolEntries = Object.entries(AI_TOOLS) as [AITool, typeof AI_TOOLS[AITool]][];
    await Promise.all(toolEntries.map(async ([key, val]) => {
      const urls = val.docUrls?.rawExamples?.length
        ? val.docUrls.rawExamples
        : val.docUrls?.guideSources?.length
          ? val.docUrls.guideSources
          : [];
      if (urls.length === 0) return;
      try {
        const examples: string[] = [];
        for (const url of urls.slice(0, 2)) {
          const content = await this.docsCache!.fetchWithCache(url);
          if (content && content.length > 50) {
            examples.push(content.slice(0, 2000));
          }
        }
        if (examples.length > 0) {
          this.liveDocsContent.set(key, {
            content: examples.join('\n\n---\n\n'),
            fetchedAt: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          });
        }
      } catch { /* skip */ }
    }));
    } catch (err) {
      logger.error('GuidePanel: fetchLiveDocs failed', err);
    }
  }

  public static createOrShow(report: ReadinessReport, docsCache?: DocsCache): void;
  public static createOrShow(tool: AITool, docsCache?: DocsCache): void;
  public static createOrShow(reportOrTool: ReadinessReport | AITool, docsCache?: DocsCache): void {
    try {
    const column = vscode.ViewColumn.One;

    // Build a minimal report if just a tool was passed
    let report: ReadinessReport;
    if (typeof reportOrTool === 'string') {
      report = {
        projectName: '', scannedAt: '', primaryLevel: 1 as any, levelName: '',
        depth: 0, overallScore: 0, levels: [], componentScores: [], languageScores: [],
        projectContext: { languages: [], frameworks: [], projectType: 'unknown', packageManager: '', directoryTree: '', components: [] },
        selectedTool: reportOrTool, modelUsed: '', scanMode: 'quick',
      };
    } else {
      report = reportOrTool;
    }

    if (GuidePanel.currentPanel) {
      GuidePanel.currentPanel.panel.reveal(column);
      GuidePanel.currentPanel.panel.webview.html = GuidePanel.currentPanel.getHtml(report);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'aiReadinessGuide', '📚 Platform Guide',
      column, { enableScripts: true, retainContextWhenHidden: true }
    );
    GuidePanel.currentPanel = new GuidePanel(panel, report, docsCache);
    } catch (err) {
      logger.error('GuidePanel: failed to create', err);
      vscode.window.showErrorMessage(`Failed to open panel: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async collectFileDates(report: ReadinessReport): Promise<void> {
    try {
    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceUri) return;

    const platformFiles: Record<string, string[]> = {
      copilot: ['.github/copilot-instructions.md', '.github/instructions/**/*.md', '.github/agents/*.agent.md', '.github/skills/**/SKILL.md'],
      cline: ['.clinerules/default-rules.md', '.clinerules/core/**', '.clinerules/domains/**', '.clinerules/workflows/**', '.clinerules/safe-commands.md'],
      cursor: ['.cursor/rules/**', '.cursorrules'],
      claude: ['CLAUDE.md', '.claude/rules/**', '.claude/CLAUDE.md'],
      roo: ['.roo/rules/**', '.roomodes'],
      windsurf: ['.windsurf/rules/**', 'AGENTS.md'],
      aider: ['.aider.conf.yml', '.aiderignore'],
    };

    for (const [tool, patterns] of Object.entries(platformFiles)) {
      const files: { path: string; date: string }[] = [];
      for (const pattern of patterns) {
        try {
          const uris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceUri, pattern),
            '{**/node_modules/**,**/.git/**}', 10
          );
          for (const uri of uris) {
            try {
              const stat = await vscode.workspace.fs.stat(uri);
              const date = new Date(stat.mtime).toLocaleDateString(undefined, {
                year: 'numeric', month: 'short', day: 'numeric',
              });
              files.push({ path: vscode.workspace.asRelativePath(uri), date });
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
      if (files.length > 0) {
        this.platformFileDates.set(tool, files);
      }
    }
    } catch (err) {
      logger.error('GuidePanel: collectFileDates failed', err);
    }
  }

  private getHtml(report: ReadinessReport): string {
    try {
    const selectedTool = report.selectedTool as AITool;
    const toolMeta = AI_TOOLS[selectedTool] || AI_TOOLS['copilot'];

    const toolEntries = Object.entries(AI_TOOLS) as [AITool, typeof AI_TOOLS[AITool]][];

    const tabs = toolEntries.map(([key, val]) => {
      const isActive = key === selectedTool;
      return `<button class="guide-tab${isActive ? ' active' : ''}" onclick="switchGuide('${key}')">${val.icon} ${val.name}</button>`;
    }).join('');

    const panels = toolEntries.map(([key, val]) => {
      const isActive = key === selectedTool;
      const docLinks = val.docUrls;
      // Show file dates for this platform's config files found in workspace
      const fileInfo = this.platformFileDates.get(key) || [];
      const fileListHtml = fileInfo.length > 0
        ? fileInfo.map(f => `<li><code>${this.escapeHtml(f.path)}</code> <span style="color:var(--text-muted);font-size:0.85em">— ${f.date}</span></li>`).join('')
        : '<li style="color:var(--text-muted)">No configuration files found</li>';

      const liveDocs = this.liveDocsContent.get(key);
      const docsFetchDate = liveDocs?.fetchedAt;

      // Use live docs if available, otherwise static reference
      const instructionContent = liveDocs ? liveDocs.content : (val.reasoningContext?.instructionFormat || 'N/A');
      const instructionSource = liveDocs ? `live from GitHub — ${docsFetchDate}` : `static reference — ${REFERENCE_DOCS_UPDATED}`;

      return `<div id="guide-${key}" class="guide-tool-panel${isActive ? ' active' : ''}">
        <div class="guide-section">
          <h3>📄 Your ${val.name} Files</h3>
          <ul>${fileListHtml}</ul>
        </div>
        <div class="guide-section">
          <h3>📖 Instruction Format <span style="color:var(--text-muted);font-size:0.75em">(${instructionSource})</span></h3>
          <pre>${this.escapeHtml(val.reasoningContext?.instructionFormat || 'N/A')}</pre>
        </div>
        <div class="guide-section">
          <h3>📂 Expected Structure <span style="color:var(--text-muted);font-size:0.75em">(${instructionSource})</span></h3>
          <pre>${this.escapeHtml(val.reasoningContext?.structureExpectations || 'N/A')}</pre>
        </div>
        <div class="guide-section">
          <h3>✅ Quality Markers</h3>
          <pre>${this.escapeHtml(val.reasoningContext?.qualityMarkers || 'N/A')}</pre>
        </div>
        <div class="guide-section">
          <h3>⚠️ Anti-Patterns</h3>
          <pre>${this.escapeHtml(val.reasoningContext?.antiPatterns || 'N/A')}</pre>
        </div>
        ${liveDocs ? `<div class="guide-section">
          <h3>📜 Live Example from GitHub <span style="color:var(--text-muted);font-size:0.75em">(${docsFetchDate})</span></h3>
          <pre style="max-height:400px;overflow-y:auto">${this.escapeHtml(liveDocs.content)}</pre>
        </div>` : ''}
        <div class="doc-links">
          <h3>📚 Official Documentation</h3>
          <ul>
            ${docLinks.main ? `<li><a href="${docLinks.main}">📖 Main Documentation</a></li>` : ''}
            ${docLinks.rules ? `<li><a href="${docLinks.rules}">📋 Rules & Configuration</a></li>` : ''}
            ${docLinks.memory ? `<li><a href="${docLinks.memory}">🧠 Memory & Context</a></li>` : ''}
            ${docLinks.bestPractices ? `<li><a href="${docLinks.bestPractices}">⭐ Best Practices</a></li>` : ''}
          </ul>
        </div>
      </div>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Platform Guide</title>
  <style>
    ${TACTICAL_GLASSBOX_CSS}

    /* Panel-specific layout */
    body { padding: 20px; max-width: 1000px; margin: 0 auto; }
    h1 { border-bottom: 2px solid var(--border-subtle); padding-bottom: 12px; }
    .guide-tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 16px; }
    .guide-tab { padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border-subtle); background: var(--bg-elevated); color: var(--text-primary); cursor: pointer; font-size: 0.9em; transition: all 0.15s; font-family: var(--font-ui); }
    .guide-tab:hover { background: var(--bg-card-hover); border-color: var(--color-cyan); }
    .guide-tab.active { background: var(--color-cyan); color: #000; border-color: var(--color-cyan); font-weight: 600; }
    .guide-tool-panel { display: none; }
    .guide-tool-panel.active { display: block; }
    .guide-section { margin: 12px 0; padding: 16px; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 12px; transition: border-color 0.2s, box-shadow 0.2s; }
    .guide-section:hover { border-color: var(--border-active); box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3); }
    .guide-section h3 { margin: 0 0 10px 0; font-size: 1em; color: var(--color-cyan); }
    .guide-section pre { white-space: pre-wrap; font-size: 0.85em; margin: 0; font-family: var(--font-mono); line-height: 1.6; }
    .doc-links { margin: 12px 0; padding: 16px; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 12px; transition: border-color 0.2s, box-shadow 0.2s; }
    .doc-links:hover { border-color: var(--border-active); box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3); }
    .doc-links h3 { margin: 0 0 10px 0; color: var(--color-cyan); }
    .doc-links ul { margin: 0; padding-left: 16px; }
    .doc-links li { padding: 4px 0; font-size: 0.9em; }
    .doc-links a { color: var(--color-cyan); text-decoration: none; }
    .doc-links a:hover { text-decoration: underline; }

    .structure-section { background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 20px; margin: 20px 0; }
    .structure-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .structure-header h2 { margin: 0; font-size: 1.1em; }
    .structure-completeness { font-size: 1.4em; font-weight: bold; }
    .structure-item { padding: 8px 12px; margin: 4px 0; border-radius: 6px; font-size: 0.9em; display: flex; align-items: flex-start; gap: 8px; }
    .structure-item.present { background: var(--color-emerald-dim); border-left: 3px solid var(--color-emerald); }
    .structure-item.missing-required { background: var(--color-crimson-dim); border-left: 3px solid var(--color-crimson); }
    .structure-item.missing-optional { background: var(--bg-card); border-left: 3px solid var(--text-muted); opacity: 0.7; }
    .structure-item code { font-family: var(--font-mono); font-size: 0.95em; }
    .structure-item .description { color: var(--text-secondary); font-size: 0.85em; margin-left: 4px; }
    .structure-item .level-tag { font-size: 0.75em; padding: 1px 6px; border-radius: 3px; background: var(--bg-elevated); color: var(--text-primary); }
  </style>
</head>
<body>
  <h1>📚 Platform Guide</h1>

  <h2 style="margin-top:24px">Tool Configuration Reference</h2>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
    <div class="guide-tabs" style="margin-bottom:0">${tabs}</div>
    <button class="btn btn-small" onclick="vscode.postMessage({command:'refresh'})" title="Refresh file dates and documentation cache">🔄 Refresh</button>
  </div>
  ${panels}

  <script>
    const vscode = acquireVsCodeApi();
    function switchGuide(tool) {
      document.querySelectorAll('.guide-tool-panel').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.guide-tab').forEach(t => t.classList.remove('active'));
      document.getElementById('guide-' + tool).classList.add('active');
      document.querySelector('.guide-tab[onclick*="' + tool + '"]').classList.add('active');
    }
  </script>
</body>
</html>`;
    } catch (err) {
      logger.error('GuidePanel: render failed', err);
      return `<html><body><h2>❌ Render Error</h2><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`;
    }
  }

  private buildStructureSection(sc: StructureComparison): string {
    const completePct = Math.min(100, sc.completeness); // already a percentage (0-100)
    const color = completePct >= 80 ? 'var(--color-emerald)' : completePct >= 50 ? 'var(--level-3)' : 'var(--color-crimson)';

    return `<div class="structure-section">
      <div class="structure-header">
        <h2>📂 Expected vs Actual Structure — ${this.escapeHtml(sc.toolName)}</h2>
        <span class="structure-completeness" style="color:${color}">${completePct}%</span>
      </div>
      <div style="font-size:0.85em;color:var(--text-secondary);margin-bottom:12px">
        ${sc.presentCount} present · ${sc.missingCount} missing
      </div>
      ${sc.expected.map(item => {
        if (item.exists) {
          return `<div class="structure-item present">
            <span>✅</span>
            <code>${this.escapeHtml(item.path)}</code>
            <span class="description">${this.escapeHtml(item.description)}</span>
            <span class="level-tag">L${item.level}</span>
          </div>`;
        }
        const cls = item.required ? 'missing-required' : 'missing-optional';
        return `<div class="structure-item ${cls}">
          <span>${item.required ? '❌' : '○'}</span>
          <code>${this.escapeHtml(item.path)}</code>
          <span class="description">${this.escapeHtml(item.description)}</span>
          <span class="level-tag">L${item.level}</span>
        </div>`;
      }).join('')}
    </div>`;
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private dispose(): void {
    GuidePanel.currentPanel = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
