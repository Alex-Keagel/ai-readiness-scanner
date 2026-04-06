import * as vscode from 'vscode';
import { WorkspaceScanner } from '../scanner/workspaceScanner';
import { MarkdownReportGenerator } from '../report/markdownGenerator';
import { MATURITY_LEVELS, AITool, AI_TOOLS } from '../scoring/types';
import { CopilotClient } from '../llm/copilotClient';
import { MigrationEngine } from '../remediation/migrationEngine';
import type { ReadinessReport } from '../scoring/types';
import {
  formatReportForChat,
  formatLevelForChat,
  formatToolGuide,
  formatStructureComparison,
  formatGraphForChat,
  matchLevel,
} from './commands';
import { VibeReportGenerator } from '../live/vibeReport';

export class ChatParticipant {
  private scanner: WorkspaceScanner;
  private context: vscode.ExtensionContext;

  constructor(scanner: WorkspaceScanner, context: vscode.ExtensionContext) {
    this.scanner = scanner;
    this.context = context;
  }

  register(context: vscode.ExtensionContext): void {
    const participant = vscode.chat.createChatParticipant(
      'ai-readiness.readiness',
      this.handleRequest.bind(this)
    );
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
    context.subscriptions.push(participant);
  }

  private async handleRequest(
    request: vscode.ChatRequest,
    _chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<void> {
    const command = request.command;

    switch (command) {
      case 'scan':
        await this.handleScan(request, stream, token, false);
        break;
      case 'quick':
        await this.handleScan(request, stream, token, true);
        break;
      case 'report':
        await this.handleReport(request, stream, token);
        break;
      case 'level':
        await this.handleLevel(request, stream, token);
        break;
      case 'fix':
        await this.handleFix(request, stream, token);
        break;
      case 'fix-all':
        await this.handleFixAll(stream, token);
        break;
      case 'compare':
        await this.handleCompare(stream, token);
        break;
      case 'migrate':
        await this.handleMigrate(request, stream, token);
        break;
      case 'guide':
        await this.handleGuide(request, stream, token);
        break;
      case 'graph':
        await this.handleGraph(stream, token);
        break;
      case 'live':
        await this.handleLive(stream);
        break;
      case 'vibe':
        await this.handleVibe(request, stream);
        break;
      case 'levelup':
        await this.handleLevelUp(stream);
        break;
      case 'context':
        await this.handleContext(stream);
        break;
      default:
        await this.handleDefault(request, stream, token);
        break;
    }
  }

  private async handleScan(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    quickMode: boolean
  ): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      stream.markdown('❌ No workspace folder is open. Please open a project first.');
      return;
    }

    // Parse tool name from prompt (e.g., "@readiness /scan copilot")
    const toolArg = request.prompt.trim().toLowerCase();
    let selectedTool: AITool | undefined;
    if (toolArg && toolArg in AI_TOOLS) {
      selectedTool = toolArg as AITool;
    }

    if (!selectedTool) {
      stream.markdown('❓ Please specify a tool to scan for. Available tools: ' +
        (Object.keys(AI_TOOLS) as AITool[]).map(t => `\`${t}\``).join(', ') +
        '\n\nExample: `@readiness /scan copilot`');
      return;
    }

    const modeLabel = quickMode ? 'Quick' : 'Full';
    const toolLabel = AI_TOOLS[selectedTool];
    stream.markdown(`🔍 Starting **${modeLabel} Scan** of **${workspaceFolder.name}** for **${toolLabel.icon} ${toolLabel.name}**...\n\n`);

    let levelIndex = 0;
    const totalLevels = Object.keys(MATURITY_LEVELS).length;
    const progress: vscode.Progress<{ message?: string; increment?: number }> = {
      report: (value) => {
        if (value.message) {
          levelIndex++;
          stream.markdown(`🔍 Analyzing **${value.message}** (${levelIndex}/${totalLevels})...\n\n`);
        }
      },
    };

    try {
      const report = await this.scanner.scan(
        workspaceFolder.uri,
        quickMode,
        progress,
        token,
        selectedTool
      );

      // Store last report for /levelup
      this.context.workspaceState.update('lastReport', report);

      stream.markdown('---\n\n');

      // CoT: stream signal-by-signal results
      stream.markdown('📋 **Evaluating maturity signals...**\n\n');

      for (const level of report.levels) {
        if (level.signals.length === 0) { continue; }
        stream.markdown(`**Level ${level.level}: ${level.name}**\n`);
        for (const signal of level.signals) {
          const icon = signal.detected ? '✅' : '❌';
          const scoreText = signal.detected ? ` (score: ${signal.score})` : '';
          stream.markdown(`  ${icon} \`${signal.signalId}\`${scoreText} — ${signal.finding}\n`);
        }
        stream.markdown('\n');
      }

      // Summary
      stream.markdown(`\n📊 **Result: Level ${report.primaryLevel} — ${report.levelName}** (${report.depth}% depth, score ${report.overallScore}/100)\n\n`);

      // Next steps
      const nextLevel = Math.min(6, report.primaryLevel + 1);
      const missingForNext = report.levels
        .flatMap(l => l.signals)
        .filter(s => !s.detected && s.level <= nextLevel);

      if (missingForNext.length > 0) {
        stream.markdown(`💡 **To reach Level ${nextLevel}:**\n`);
        for (const s of missingForNext.slice(0, 5)) {
          stream.markdown(`- Create/improve \`${s.signalId}\` — ${s.finding}\n`);
        }
        stream.markdown('\nType `@readiness /levelup` to start guided progression.\n');
      }

      stream.markdown('\n');
      stream.markdown(
        '_Use `/level <number>` for details on a specific level, or `/report` to generate a full markdown report._'
      );
    } catch (err) {
      if (err instanceof vscode.CancellationError) {
        stream.markdown('⚠️ Scan was cancelled.');
      } else {
        stream.markdown(
          `❌ Scan failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  private async handleReport(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      stream.markdown('❌ No workspace folder is open.');
      return;
    }

    const toolArg = request.prompt.trim().toLowerCase();
    let selectedTool: AITool | undefined;
    if (toolArg && toolArg in AI_TOOLS) {
      selectedTool = toolArg as AITool;
    }
    if (!selectedTool) {
      stream.markdown('❓ Please specify a tool. Example: `@readiness /report copilot`\n\n' +
        'Available tools: ' + (Object.keys(AI_TOOLS) as AITool[]).map(t => `\`${t}\``).join(', '));
      return;
    }

    stream.markdown('📄 Running scan and generating report...\n\n');

    const progress: vscode.Progress<{ message?: string; increment?: number }> = {
      report: () => {},
    };

    try {
      const report = await this.scanner.scan(
        workspaceFolder.uri,
        false,
        progress,
        token,
        selectedTool
      );

      const generator = new MarkdownReportGenerator();
      const markdown = generator.generate(report);

      const filePath = vscode.Uri.joinPath(workspaceFolder.uri, 'AI_READINESS_REPORT.md');
      await vscode.workspace.fs.writeFile(filePath, Buffer.from(markdown, 'utf-8'));

      stream.markdown(`✅ Report saved to **AI_READINESS_REPORT.md**\n\n`);
      stream.markdown(formatReportForChat(report));
    } catch (err) {
      if (err instanceof vscode.CancellationError) {
        stream.markdown('⚠️ Report generation was cancelled.');
      } else {
        stream.markdown(
          `❌ Report generation failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  private async handleLevel(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<void> {
    const input = request.prompt.trim();
    if (!input) {
      const levelList = Object.entries(MATURITY_LEVELS)
        .map(([k, v]) => `- **L${k}**: ${v.name} — ${v.description}`)
        .join('\n');
      stream.markdown(
        '❓ Please specify a level (1-6) and tool. Example: `@readiness /level 3 copilot`\n\n' + levelList
      );
      return;
    }

    // Parse level and optional tool from input (e.g., "3 copilot" or "3")
    const parts = input.split(/\s+/);
    const level = matchLevel(parts[0]);
    const toolArg = parts[1]?.toLowerCase();
    let selectedTool: AITool | undefined;
    if (toolArg && toolArg in AI_TOOLS) {
      selectedTool = toolArg as AITool;
    }

    if (!level) {
      const levelList = Object.entries(MATURITY_LEVELS)
        .map(([k, v]) => `- **L${k}**: ${v.name}`)
        .join('\n');
      stream.markdown(
        `❌ Could not match **"${input}"** to a level. Available levels:\n\n` + levelList
      );
      return;
    }

    if (!selectedTool) {
      stream.markdown('❓ Please also specify a tool. Example: `@readiness /level ' + level + ' copilot`\n\n' +
        'Available tools: ' + (Object.keys(AI_TOOLS) as AITool[]).map(t => `\`${t}\``).join(', '));
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      stream.markdown('❌ No workspace folder is open.');
      return;
    }

    stream.markdown(`🔍 Scanning for **Level ${level}: ${MATURITY_LEVELS[level].name}** details...\n\n`);

    const progress: vscode.Progress<{ message?: string; increment?: number }> = {
      report: () => {},
    };

    try {
      const report = await this.scanner.scan(
        workspaceFolder.uri,
        false,
        progress,
        token,
        selectedTool
      );

      stream.markdown(formatLevelForChat(report, level));
    } catch (err) {
      if (err instanceof vscode.CancellationError) {
        stream.markdown('⚠️ Scan was cancelled.');
      } else {
        stream.markdown(
          `❌ Scan failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  private async handleFix(
    _request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken
  ): Promise<void> {
    stream.markdown(
      '🔧 **Fix Signal** — Coming in Phase 6 (Automated Remediation).\n\n' +
      'This command will automatically apply fixes for specific missing signals.'
    );
  }

  private async handleFixAll(
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken
  ): Promise<void> {
    stream.markdown(
      '🔧 **Fix All** — Coming in Phase 6 (Automated Remediation).\n\n' +
      'This command will batch-apply all auto-fixable signals in a single pass.'
    );
  }

  private async handleCompare(
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken
  ): Promise<void> {
    stream.markdown(
      '📊 **Compare** — Coming soon.\n\n' +
      'This command will compare the current scan results with a previous scan to show progress over time.'
    );
  }

  private async handleMigrate(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      stream.markdown('❌ No workspace folder is open. Please open a project first.');
      return;
    }

    // Parse "cline copilot" from prompt
    const args = request.prompt.trim().toLowerCase().split(/\s+/);
    let sourceTool: AITool | undefined;
    let targetTool: AITool | undefined;

    if (args.length >= 2 && args[0] in AI_TOOLS && args[1] in AI_TOOLS) {
      sourceTool = args[0] as AITool;
      targetTool = args[1] as AITool;
    }

    const copilotClient = new CopilotClient();
    const migrationEngine = new MigrationEngine(copilotClient);

    // Detect existing tools
    stream.markdown('🔍 Detecting existing AI tool configurations...\n\n');
    const existing = await migrationEngine.detectExistingTools(workspaceFolder.uri);

    if (existing.length === 0) {
      stream.markdown('❌ No AI tool configurations found to migrate from.\n\n');
      stream.markdown('Run `@readiness /scan` first and fix some signals to create configuration files.');
      return;
    }

    // Show what was found
    stream.markdown('**Found configurations:**\n\n');
    for (const e of existing) {
      stream.markdown(`- ${AI_TOOLS[e.tool].icon} **${AI_TOOLS[e.tool].name}** — ${e.fileCount} file(s)\n`);
    }
    stream.markdown('\n');

    // If tools weren't specified, prompt the user
    if (!sourceTool || !targetTool) {
      stream.markdown('💡 **Usage:** `@readiness /migrate <source> <target>`\n\n');
      stream.markdown('**Example:** `@readiness /migrate cline copilot`\n\n');
      const availableTools = Object.entries(AI_TOOLS)
        .map(([k, v]) => `\`${k}\` (${v.name})`)
        .join(', ');
      stream.markdown(`**Available tools:** ${availableTools}`);
      return;
    }

    if (sourceTool === targetTool) {
      stream.markdown('❌ Source and target tools must be different.');
      return;
    }

    const sourceEntry = existing.find(e => e.tool === sourceTool);
    if (!sourceEntry) {
      stream.markdown(`❌ No ${AI_TOOLS[sourceTool].name} configuration files found in this workspace.`);
      return;
    }

    stream.markdown(`🔄 Migrating **${AI_TOOLS[sourceTool].name}** → **${AI_TOOLS[targetTool].name}**...\n\n`);

    try {
      await copilotClient.initialize();

      const plan = await migrationEngine.planMigration(
        sourceTool, targetTool, sourceEntry.files,
        { languages: [], frameworks: [], projectType: 'unknown', packageManager: '', directoryTree: '', components: [] },
        token
      );

      stream.markdown(`### Migration Plan\n\n`);
      stream.markdown(`${plan.explanation}\n\n`);
      stream.markdown(`**Files to create (${plan.targetFiles.length}):**\n\n`);

      for (const f of plan.targetFiles) {
        stream.markdown(`- \`${f.path}\` ← \`${f.sourceFile}\`\n`);
        if (f.transformations.length > 0) {
          stream.markdown(`  - ${f.transformations.join(', ')}\n`);
        }
      }

      stream.markdown('\n💡 Run the **AI Readiness: Migrate Tool Configuration** command from the Command Palette to apply these files with preview.');
    } catch (err) {
      if (err instanceof vscode.CancellationError) {
        stream.markdown('⚠️ Migration was cancelled.');
      } else {
        stream.markdown(`❌ Migration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async handleGuide(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const toolArg = request.prompt.trim().toLowerCase();

    if (!toolArg) {
      stream.markdown('📚 **Platform Guides** — pick a tool to see what it expects:\n\n');
      for (const [key, meta] of Object.entries(AI_TOOLS)) {
        stream.markdown(`- ${meta.icon} **${meta.name}** — \`@readiness /guide ${key}\`\n`);
      }
      stream.markdown('\n_Specify a tool to see its full reasoning context._');
      return;
    }

    if (!(toolArg in AI_TOOLS)) {
      const validTools = (Object.keys(AI_TOOLS) as AITool[]).join(', ');
      stream.markdown(`❌ Unknown tool **"${toolArg}"**. Valid tools: ${validTools}`);
      return;
    }

    const tool = toolArg as AITool;
    const meta = AI_TOOLS[tool];
    stream.markdown(`Here's what **${meta.icon} ${meta.name}** expects in your repository:\n\n`);
    stream.markdown(formatToolGuide(tool));

    // Show structure comparison if a recent report is available
    const lastReport = this.context.workspaceState.get<ReadinessReport>('lastReport');
    if (lastReport?.structureComparison && lastReport.selectedTool === tool) {
      stream.markdown('\n\n');
      stream.markdown(formatStructureComparison(lastReport.structureComparison));
    } else {
      stream.markdown('\n\n_Run `@readiness /scan ' + toolArg + '` to see expected vs actual file comparison._');
    }
  }

  private async handleGraph(
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const lastReport = this.context.workspaceState.get<ReadinessReport>('lastReport');

    if (!lastReport?.knowledgeGraph) {
      stream.markdown(
        '🕸️ No knowledge graph available. Run `@readiness /scan` or `@readiness /quick` first to build the graph.'
      );
      return;
    }

    const graph = lastReport.knowledgeGraph as import('../graph/types').KnowledgeGraph;
    stream.markdown(formatGraphForChat(graph));
  }

  private async handleLive(
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    stream.markdown('⚡ **Live AIPM Tracker**\n\n');
    stream.markdown(
      'The Live AIPM Tracker monitors AI token throughput in real-time across Copilot CLI and Claude Code.\n\n' +
      '**Commands:**\n\n' +
      '- **Start tracking:** Run `AI Readiness: Start Live AIPM Tracker` from the Command Palette\n' +
      '- **Open dashboard:** Run `AI Readiness: Show Live Dashboard`\n' +
      '- **Stop tracking:** Run `AI Readiness: Stop Live Tracker`\n\n' +
      '**What it tracks:**\n\n' +
      '| Metric | Description |\n|---|---|\n' +
      '| AIPM | AI tokens per minute (15s rolling window) |\n' +
      '| Concurrency | Number of active agent sessions |\n' +
      '| AIPM/Agent | Per-agent efficiency |\n' +
      '| Peak stats | Highest AIPM and concurrency reached |\n\n' +
      '**Data sources:**\n' +
      '- 🤖 Copilot CLI (`~/.copilot/session-state/*/events.jsonl`)\n' +
      '- 🧠 Claude Code (`~/.claude/projects/*/*.jsonl`)\n\n'
    );

    // Start tracking if not already running
    await vscode.commands.executeCommand('ai-readiness.liveStart');
    stream.markdown('_Tracker started! Check the status bar for live AIPM._');
  }

  private async handleVibe(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    const toolArg = request.prompt.trim().toLowerCase();
    let selectedTool: AITool | undefined;
    if (toolArg && toolArg in AI_TOOLS) {
      selectedTool = toolArg as AITool;
    }

    if (!selectedTool) {
      stream.markdown('❓ Please specify a tool. Example: `@readiness /vibe copilot`\n\n' +
        'Available tools: ' + (['copilot', 'claude', 'cline', 'roo'] as AITool[]).map(t => `\`${t}\``).join(', '));
      return;
    }

    stream.markdown(`📊 Generating **Vibe Report** for **${AI_TOOLS[selectedTool].icon} ${AI_TOOLS[selectedTool].name}**...\n\n`);

    try {
      const generator = new VibeReportGenerator();
      const html = await generator.generateReport(selectedTool);

      const panel = vscode.window.createWebviewPanel(
        'vibeReport', `Vibe Report — ${AI_TOOLS[selectedTool].name}`,
        vscode.ViewColumn.One, { enableScripts: true }
      );
      panel.webview.html = html;

      stream.markdown('✅ Vibe Report opened in a new tab!');
    } catch (err) {
      stream.markdown(`❌ Failed to generate Vibe Report: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleLevelUp(
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    const lastReport = this.context.workspaceState.get<ReadinessReport>('lastReport');

    if (!lastReport) {
      stream.markdown('❌ Run a scan first: `@readiness /scan [platform]`\n');
      return;
    }

    const currentLevel = lastReport.primaryLevel;
    const nextLevel = Math.min(6, currentLevel + 1);
    stream.markdown(`🚀 **Level Up: L${currentLevel} → L${nextLevel} for ${lastReport.selectedTool}**\n\n`);

    const missingSignals = lastReport.levels
      .flatMap(l => l.signals)
      .filter(s => !s.detected && s.level === nextLevel);

    if (missingSignals.length === 0) {
      stream.markdown(`✅ All Level ${nextLevel} signals are present! Your score needs to improve to qualify.\n`);
      stream.markdown(`Current L${nextLevel} score: ${lastReport.levels[nextLevel - 1]?.rawScore ?? 0}%\n`);
      return;
    }

    stream.markdown(`📋 **Missing signals for Level ${nextLevel}:**\n\n`);
    for (const signal of missingSignals) {
      stream.markdown(`- ❌ \`${signal.signalId}\` — ${signal.finding}\n`);
    }

    stream.markdown(`\n🔧 Use **"Improve Readiness"** from the sidebar to generate these files with multi-LLM consensus and diff preview.\n`);
    stream.markdown(`Or ask me: "What should my ${missingSignals[0]?.signalId} contain?"\n`);
  }

  private async handleContext(
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    const lastReport = this.context.workspaceState.get<ReadinessReport>('lastReport');

    stream.markdown('## 📊 Context & Session Overview\n\n');

    // Scan state
    if (lastReport) {
      const scannedAt = new Date(lastReport.scannedAt).toLocaleString();
      const componentCount = lastReport.componentScores?.length ?? 0;
      const signalCount = lastReport.levels?.flatMap(l => l.signals).length ?? 0;
      const detectedCount = lastReport.levels?.flatMap(l => l.signals).filter(s => s.detected).length ?? 0;

      stream.markdown(`### 🔍 Last Scan\n`);
      stream.markdown(`| Property | Value |\n|---|---|\n`);
      stream.markdown(`| Platform | ${lastReport.selectedTool} |\n`);
      stream.markdown(`| Scanned | ${scannedAt} |\n`);
      stream.markdown(`| Level | L${lastReport.primaryLevel} ${lastReport.levelName} |\n`);
      stream.markdown(`| Score | ${lastReport.overallScore}/100 (${lastReport.depth}% depth) |\n`);
      stream.markdown(`| Components | ${componentCount} |\n`);
      stream.markdown(`| Signals | ${detectedCount}/${signalCount} detected |\n`);
      stream.markdown(`| Model | ${lastReport.modelUsed} |\n`);
      stream.markdown(`| Mode | ${lastReport.scanMode} |\n\n`);

      // Codebase metrics if available
      if (lastReport.codebaseMetrics) {
        const m = lastReport.codebaseMetrics;
        stream.markdown(`### 🧠 Codebase Readiness\n`);
        stream.markdown(`| Metric | Score | Meaning |\n|---|---|---|\n`);
        stream.markdown(`| Semantic Density | ${m.semanticDensity}/100 | Comments & descriptive names ratio |\n`);
        stream.markdown(`| Type Strictness | ${m.typeStrictnessIndex}/100 | Explicit types & interfaces |\n`);
        stream.markdown(`| Low Fragmentation | ${m.contextFragmentation}/100 | Module self-containment |\n\n`);
      }
    } else {
      stream.markdown('⚠️ No scan results available. Run `@readiness /scan [platform]` first.\n\n');
    }

    // Session info
    stream.markdown(`### 💾 Extension State\n`);
    const runs = this.context.workspaceState.get<unknown[]>('scanRuns') || [];
    stream.markdown(`- **Saved scans:** ${Array.isArray(runs) ? runs.length : 0}\n`);
    stream.markdown(`- **Semantic cache:** ${this.context.workspaceState.get('semanticCacheSize') || 'empty'}\n\n`);

    stream.markdown(`### 🛠️ Available Actions\n`);
    stream.markdown(`- \`@readiness /scan copilot\` — Full scan\n`);
    stream.markdown(`- \`@readiness /levelup\` — Guided level progression\n`);
    stream.markdown(`- \`@readiness /vibe\` — Agentic coding assessment\n`);
    stream.markdown(`- **Clear History** — Use the 🗑️ button in the sidebar or Command Palette: "AI Readiness: Clear All Scan History"\n`);
  }

  private async handleDefault(
    _request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken
  ): Promise<void> {
    stream.markdown(
      '👋 **Welcome to the AI Readiness Scanner!**\n\n' +
      'I can assess your codebase\'s AI maturity across the 6-level maturity ladder.\n\n' +
      '**Available commands:**\n\n' +
      '- `/scan [tool]` — Run a full maturity scan (tool: copilot, cline, cursor, roo, claude, windsurf, aider)\n' +
      '- `/scan [tool]` — Run a scan for a specific AI tool\n' +
      '- `/report` — Generate and save a full markdown report\n' +
      '- `/level <number>` — Deep-dive into a specific level (e.g. `/level 3`)\n' +
      '- `/fix <signal>` — Auto-fix a specific signal _(coming soon)_\n' +
      '- `/fix-all` — Batch-fix all auto-fixable signals _(coming soon)_\n' +
      '- `/compare` — Compare with a previous scan _(coming soon)_\n' +
      '- `/migrate <source> <target>` — Migrate tool config (e.g. `/migrate cline copilot`)\n' +
      '- `/guide [tool]` — Show what a specific AI tool expects in your repo\n' +
      '- `/graph` — Show the knowledge graph of your repository\n' +
      '- `/live` — Start live AIPM tracking across AI tools\n' +
      '- `/vibe [tool]` — Generate a Vibe Report (agentic coding proficiency assessment)\n' +
      '- `/levelup` — Guided progression to the next maturity level\n\n' +
      '_Try `@readiness /scan` to get started!_'
    );
  }
}
