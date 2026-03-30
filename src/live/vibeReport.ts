import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AITool, AI_TOOLS } from '../scoring/types';
import { generateRadarChartSVG, type RadarDataPoint } from '../metrics';
import { TACTICAL_GLASSBOX_CSS } from '../ui/theme';
import { logger } from '../logging';
import {
  type Turn,
  type SRESessionSummary,
  type SREMetrics,
  type GitCommitInfo,
  computeAllSREMetrics,
  getSREMetricColor,
  getSREMetricLabel,
} from './sreMetrics';
import { execSync } from 'child_process';

export interface VibeMetrics {
  // Hero stats
  totalSessions: number;
  totalMessages: number;
  totalUserMessages: number;
  totalAssistantMessages: number;
  totalToolCalls: number;
  totalOutputTokens: number;
  totalInputTokens: number;
  projects: string[];
  dateRange: { first: string; last: string };
  
  // Computed metrics
  autonomyRatio: number;       // (assistant_msgs + tool_calls) / user_msgs
  outputDensity: number;       // output_tokens / user_msgs
  avgSessionDepth: number;     // messages per session
  peakConcurrency: number;
  avgConcurrency: number;
  
  // Agentic Proficiency Score dimensions (0-100 each)
  aps: number;
  autonomyScore: number;
  delegationQualityScore: number;
  recoveryScore: number;
  sessionDepthScore: number;
  outputDensityScore: number;
  
  // Vibe classification
  vibeLevel: number;
  vibeLevelName: string;
  vibeLevelColor: string;
  
  // Archetype
  primaryArchetype: string;
  secondaryArchetype?: string;
  
  // Growth (first 25% vs last 25% of sessions)
  growth: {
    autonomy: { early: number; recent: number; delta: number; trend: 'improving' | 'stable' | 'declining' };
    depth: { early: number; recent: number; delta: number; trend: 'improving' | 'stable' | 'declining' };
    density: { early: number; recent: number; delta: number; trend: 'improving' | 'stable' | 'declining' };
  };
  
  // Session breakdown
  sessions: SessionSummary[];
  
  // Per-platform breakdown
  platformStats: { platform: string; sessions: number; messages: number; tokens: number }[];

  // Advanced Agent Dynamics
  tokenROI: number;              // output_tokens / input_tokens (higher = more efficient)
  toolCallSuccessRate: number;   // % of tool calls that succeeded (0-100)
  humanTakeoverRate: number;     // % of sessions where user messages >> agent messages
  contextSNR: number;            // signal-to-noise: output_tokens / (input_tokens + output_tokens) * 100
  guardrailInterventionRate: number; // tool failures / total tool calls * 100

  // SRE Reliability Metrics
  sreMetrics: SREMetrics;
  perPlatformSRE: { platform: string; metrics: SREMetrics }[];
}

interface SessionSummary {
  id: string;
  platform: string;
  project: string;
  startTime: string;
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolSuccesses: number;
  toolFailures: number;
  outputTokens: number;
  inputTokens: number;
  durationMinutes: number;
  turns: Turn[];
}

export class VibeReportGenerator {
  
  async generateReport(
    selectedTool: AITool,
    userName?: string
  ): Promise<string> {
    try {
    const metrics = await this.collectMetrics(selectedTool);
    
    if (metrics.totalSessions === 0) {
      return this.generateEmptyReport(selectedTool);
    }
    
    return this.renderHtml(metrics, selectedTool, userName);
    } catch (err) {
      logger.error('VibeReportGenerator: generateReport failed', err);
      return `<html><body><h2>❌ Vibe Report Error</h2><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`;
    }
  }

  private async collectMetrics(selectedTool: AITool): Promise<VibeMetrics> {
    const sessions: SessionSummary[] = [];
    
    switch (selectedTool) {
      case 'copilot':
        sessions.push(...await this.readCopilotSessions());
        break;
      case 'claude':
        sessions.push(...await this.readClaudeSessions());
        break;
      case 'cline':
        sessions.push(...await this.readClineSessions());
        break;
      case 'roo':
        sessions.push(...await this.readRooSessions());
        break;
      default:
        break;
    }
    
    const totalUserMessages = sessions.reduce((s, x) => s + x.userMessages, 0);
    const totalAssistantMessages = sessions.reduce((s, x) => s + x.assistantMessages, 0);
    const totalToolCalls = sessions.reduce((s, x) => s + x.toolCalls, 0);
    const totalOutputTokens = sessions.reduce((s, x) => s + x.outputTokens, 0);
    const totalInputTokens = sessions.reduce((s, x) => s + x.inputTokens, 0);
    const totalToolSuccesses = sessions.reduce((s, x) => s + x.toolSuccesses, 0);
    const totalToolFailures = sessions.reduce((s, x) => s + x.toolFailures, 0);
    
    const autonomyRatio = totalUserMessages > 0
      ? Math.round(((totalAssistantMessages + totalToolCalls) / totalUserMessages) * 10) / 10
      : 0;
    const outputDensity = totalUserMessages > 0
      ? Math.round(totalOutputTokens / totalUserMessages)
      : 0;
    const avgSessionDepth = sessions.length > 0
      ? Math.round(sessions.reduce((s, x) => s + x.messageCount, 0) / sessions.length)
      : 0;

    // --- Agentic Proficiency Score (APS) ---

    const clamp = (v: number) => Math.round(Math.min(100, Math.max(0, v)));

    // Autonomy Score: AR normalized 0-100
    const arRaw = totalUserMessages > 0
      ? (totalToolCalls + 0.25 * totalAssistantMessages) / totalUserMessages
      : 0;
    const autonomyScore = clamp(((arRaw - 1.5) / (10 - 1.5)) * 100);

    // Output Density Score: substance per prompt, discounted by action
    const odRaw = totalUserMessages > 0
      ? (totalOutputTokens / totalUserMessages) * Math.min(1, totalToolCalls / (3 * totalUserMessages))
      : 0;
    const outputDensityScore = clamp(((odRaw - 250) / (2500 - 250)) * 100);

    // Session Depth Score: log-scaled complexity
    const avgDepth = sessions.length > 0
      ? sessions.reduce((s, x) => s + Math.log(1 + x.toolCalls) + Math.log(1 + x.outputTokens / 500), 0) / sessions.length
      : 0;
    const sessionDepthScore = clamp(((avgDepth - 1.6) / (3.6 - 1.6)) * 100);

    // Recovery Score: low correction churn = better
    const correctionLoad = totalToolCalls > 0
      ? Math.max(totalUserMessages - 1, 0) / (totalToolCalls + 1)
      : 1;
    const recoveryScore = clamp(100 * Math.exp(-2 * correctionLoad));

    // Delegation Quality: context adequacy + action yield
    const contextPerPrompt = totalUserMessages > 0 ? totalOutputTokens / totalUserMessages : 0;
    const actionYield = totalUserMessages > 0
      ? Math.min(1, totalToolCalls / (5 * totalUserMessages))
      : 0;
    const delegationQualityScore = clamp(
      0.35 * Math.min(100, contextPerPrompt / 25) + 0.35 * actionYield * 100 + 0.30 * recoveryScore
    );

    // APS: weighted combination
    const aps = clamp(
      0.25 * autonomyScore +
      0.20 * delegationQualityScore +
      0.15 * recoveryScore +
      0.15 * sessionDepthScore +
      0.10 * outputDensityScore +
      0.15 * 50 // placeholder for concurrency/tool diversity
    );

    // Vibe Level
    const vibeLevelNames: string[] = ['Manual Coder', 'Assisted Coder', 'Pair Programmer', 'Delegator', 'Orchestrator', 'Agent Director'];
    const vibeLevelColors: string[] = ['#FF3B5C', '#FFB020', '#FFEA00', '#00E676', '#00E5FF', '#B388FF'];
    const vibeLevel = aps >= 90 ? 5 : aps >= 80 ? 4 : aps >= 65 ? 3 : aps >= 45 ? 2 : aps >= 25 ? 1 : 0;

    // Archetypes
    const archetypeScores: Record<string, number> = {
      Architect: 0.30 * Math.min(100, contextPerPrompt / 30) + 0.25 * delegationQualityScore + 0.25 * sessionDepthScore + 0.20 * recoveryScore,
      Sprinter: 0.35 * autonomyScore + 0.30 * (100 - Math.min(100, contextPerPrompt / 20)) + 0.35 * Math.min(100, sessions.length * 5),
      Perfectionist: 0.45 * (100 * Math.min(1, correctionLoad / 0.5)) + 0.25 * sessionDepthScore + 0.30 * outputDensityScore,
      Explorer: 0.50 * outputDensityScore + 0.25 * sessionDepthScore + 0.25 * autonomyScore,
      Delegator: 0.40 * autonomyScore + 0.30 * delegationQualityScore + 0.20 * recoveryScore + 0.10 * sessionDepthScore,
      Operator: 0.40 * autonomyScore + 0.25 * recoveryScore + 0.20 * sessionDepthScore + 0.15 * outputDensityScore,
    };
    const sorted = Object.entries(archetypeScores).sort((a, b) => b[1] - a[1]);
    const primaryArchetype = sorted[0][0];
    const secondaryArchetype = sorted[1][1] > 50 ? sorted[1][0] : undefined;

    // Growth: first 25% vs last 25% sessions
    const quarter = Math.max(1, Math.floor(sessions.length / 4));
    const earlySessions = sessions.slice(0, quarter);
    const recentSessions = sessions.slice(-quarter);
    const calcAvg = (arr: SessionSummary[], fn: (s: SessionSummary) => number) =>
      arr.length > 0 ? arr.reduce((s, x) => s + fn(x), 0) / arr.length : 0;

    const earlyAR = calcAvg(earlySessions, s => s.userMessages > 0 ? (s.toolCalls + s.assistantMessages) / s.userMessages : 0);
    const recentAR = calcAvg(recentSessions, s => s.userMessages > 0 ? (s.toolCalls + s.assistantMessages) / s.userMessages : 0);
    const earlyDepth = calcAvg(earlySessions, s => s.messageCount);
    const recentDepth = calcAvg(recentSessions, s => s.messageCount);
    const earlyDensity = calcAvg(earlySessions, s => s.userMessages > 0 ? s.outputTokens / s.userMessages : 0);
    const recentDensity = calcAvg(recentSessions, s => s.userMessages > 0 ? s.outputTokens / s.userMessages : 0);

    const toTrend = (d: number): 'improving' | 'stable' | 'declining' => d > 4 ? 'improving' : d < -4 ? 'declining' : 'stable';
    const autoDelta = recentAR - earlyAR;
    const depthDelta = recentDepth - earlyDepth;
    const densityDelta = recentDensity - earlyDensity;

    return {
      totalSessions: sessions.length,
      totalMessages: sessions.reduce((s, x) => s + x.messageCount, 0),
      totalUserMessages,
      totalAssistantMessages,
      totalToolCalls,
      totalOutputTokens,
      totalInputTokens: 0,
      projects: [...new Set(sessions.map(s => s.project))],
      dateRange: {
        first: sessions.length > 0 ? sessions[0].startTime : '',
        last: sessions.length > 0 ? sessions[sessions.length - 1].startTime : '',
      },
      autonomyRatio,
      outputDensity,
      avgSessionDepth,
      peakConcurrency: this.calculatePeakConcurrency(sessions),
      avgConcurrency: 1,
      aps,
      autonomyScore,
      delegationQualityScore,
      recoveryScore,
      sessionDepthScore,
      outputDensityScore,
      vibeLevel,
      vibeLevelName: vibeLevelNames[vibeLevel],
      vibeLevelColor: vibeLevelColors[vibeLevel],
      primaryArchetype,
      secondaryArchetype,
      growth: {
        autonomy: { early: Math.round(earlyAR * 10) / 10, recent: Math.round(recentAR * 10) / 10, delta: Math.round(autoDelta * 10) / 10, trend: toTrend(autoDelta) },
        depth: { early: Math.round(earlyDepth), recent: Math.round(recentDepth), delta: Math.round(depthDelta), trend: toTrend(depthDelta) },
        density: { early: Math.round(earlyDensity), recent: Math.round(recentDensity), delta: Math.round(densityDelta), trend: toTrend(densityDelta) },
      },
      sessions,
      platformStats: this.calculatePlatformStats(sessions),

      // Advanced Agent Dynamics
      tokenROI: totalOutputTokens > 0 && totalInputTokens > 0
        ? Math.round((totalOutputTokens / totalInputTokens) * 100) / 100
        : totalOutputTokens > 0 ? Infinity : 0,
      toolCallSuccessRate: totalToolSuccesses + totalToolFailures > 0
        ? Math.round((totalToolSuccesses / (totalToolSuccesses + totalToolFailures)) * 100)
        : 100,
      humanTakeoverRate: sessions.length > 0
        ? Math.round(sessions.filter(s => s.userMessages > 0 && (s.assistantMessages + s.toolCalls) / s.userMessages < 1.5).length / sessions.length * 100)
        : 0,
      contextSNR: totalOutputTokens + totalInputTokens > 0
        ? Math.round(totalOutputTokens / (totalOutputTokens + totalInputTokens) * 100)
        : 0,
      guardrailInterventionRate: totalToolCalls > 0
        ? Math.round(totalToolFailures / totalToolCalls * 100)
        : 0,

      // SRE Reliability Metrics
      ...this.computeSRE(sessions),
    };
  }

  /** Convert SessionSummary[] to SRESessionSummary[] and compute all SRE metrics */
  private computeSRE(sessions: SessionSummary[]): { sreMetrics: SREMetrics; perPlatformSRE: { platform: string; metrics: SREMetrics }[] } {
    const toSRE = (s: SessionSummary): SRESessionSummary => ({
      id: s.id,
      platform: s.platform,
      project: s.project,
      startTime: s.startTime,
      turns: s.turns,
      toolCalls: s.toolCalls,
      toolSuccesses: s.toolSuccesses,
      toolFailures: s.toolFailures,
    });

    const sreSessions = sessions.map(toSRE);

    // Collect git data from current workspace
    const { commits, daySpan } = this.collectGitData();

    const sreMetrics = computeAllSREMetrics(sreSessions, commits, daySpan);

    // Per-platform breakdown (without git data — those are workspace-level)
    const platforms = [...new Set(sessions.map(s => s.platform))];
    const perPlatformSRE = platforms.map(platform => ({
      platform,
      metrics: computeAllSREMetrics(sreSessions.filter(s => s.platform === platform)),
    }));

    return { sreMetrics, perPlatformSRE };
  }

  /** Collect git commit history from the workspace for DORA + churn metrics */
  private collectGitData(): { commits: GitCommitInfo[]; daySpan: number } {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return { commits: [], daySpan: 0 };
    }

    const cwd = workspaceFolders[0].uri.fsPath;
    try {
      // Get last 90 days of git log with files changed
      const raw = execSync(
        'git log --since="90 days ago" --pretty=format:"%H|%aI|%s" --name-only --no-merges 2>/dev/null',
        { cwd, encoding: 'utf-8', timeout: 10000, maxBuffer: 5 * 1024 * 1024 }
      );

      if (!raw.trim()) { return { commits: [], daySpan: 0 }; }

      const commits: GitCommitInfo[] = [];
      const blocks = raw.trim().split('\n\n');

      for (const block of blocks) {
        const lines = block.split('\n');
        if (lines.length === 0) { continue; }
        const [hash, timestamp, ...msgParts] = lines[0].split('|');
        const message = msgParts.join('|');
        const filesChanged = lines.slice(1).filter(f => f.trim());

        const msgLower = message.toLowerCase();
        commits.push({
          hash: hash || '',
          timestamp: timestamp || '',
          message: message || '',
          filesChanged,
          isRevert: msgLower.startsWith('revert') || msgLower.includes('revert:'),
          isFix: /\bfix(es|ed)?\b/i.test(message) || /\bbug\b/i.test(message),
          isRelease: /\brelease\b/i.test(message) || /\bv?\d+\.\d+\.\d+/i.test(message) || msgLower.startsWith('chore(release)'),
        });
      }

      // Calculate day span
      if (commits.length > 0) {
        const sorted = commits.map(c => new Date(c.timestamp).getTime()).filter(t => !isNaN(t)).sort();
        const daySpan = sorted.length >= 2
          ? Math.ceil((sorted[sorted.length - 1] - sorted[0]) / 86400000)
          : 1;
        return { commits, daySpan: Math.max(1, daySpan) };
      }

      return { commits: [], daySpan: 0 };
    } catch (err) {
      logger.debug('Failed to collect git data for DORA metrics', { error: String(err) });
      return { commits: [], daySpan: 0 };
    }
  }
  
  private async readCopilotSessions(): Promise<SessionSummary[]> {
    const sessions: SessionSummary[] = [];
    const baseDir = path.join(os.homedir(), '.copilot', 'session-state');
    if (!fs.existsSync(baseDir)) { return sessions; }
    
    const dirs = fs.readdirSync(baseDir).filter(d => {
      const p = path.join(baseDir, d, 'events.jsonl');
      return fs.existsSync(p);
    });
    
    for (const dir of dirs) {
      try {
        const eventsFile = path.join(baseDir, dir, 'events.jsonl');
        const content = fs.readFileSync(eventsFile, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        
        let userMsgs = 0, assistantMsgs = 0, toolCalls = 0, outputTokens = 0;
        let toolSuccesses = 0, toolFailures = 0, inputTokens = 0;
        let startTime = '', project = 'unknown';
        const turns: Turn[] = [];
        
        // Try workspace.yaml first for better project name
        const workspaceFile = path.join(baseDir, dir, 'workspace.yaml');
        if (fs.existsSync(workspaceFile)) {
          try {
            const yamlContent = fs.readFileSync(workspaceFile, 'utf-8');
            const summaryMatch = yamlContent.match(/^summary:\s*(.+)$/m);
            const cwdMatch = yamlContent.match(/^cwd:\s*(.+)$/m);
            if (summaryMatch) {
              project = summaryMatch[1].trim();
            } else if (cwdMatch) {
              project = cwdMatch[1].trim().split('/').pop() || 'unknown';
            }
          } catch (err) { logger.warn('Failed to parse workspace.yaml', { file: workspaceFile, error: String(err) }); }
        }

        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (!startTime && event.timestamp) { startTime = event.timestamp; }
            if (event.type === 'user.message') {
              userMsgs++;
              const content = typeof event.data?.content === 'string' ? event.data.content : '';
              inputTokens += event.data?.inputTokens || (content ? Math.ceil(content.length / 4) : 0);
              turns.push({ role: 'user', content });
            }
            if (event.type === 'assistant.message') {
              assistantMsgs++;
              outputTokens += event.data?.outputTokens || 0;
              const content = typeof event.data?.content === 'string' ? event.data.content : '';
              turns.push({ role: 'assistant', content, tokens: event.data?.outputTokens });
            }
            if (event.type === 'tool.execution_start') { toolCalls++; }
            if (event.type === 'tool.execution_complete') {
              const success = event.data?.success !== false;
              if (success) { toolSuccesses++; } else { toolFailures++; }
            }
            if (project === 'unknown' && event.type === 'session.start') {
              const cwd = event.data?.context?.cwd || event.data?.cwd;
              if (cwd) {
                project = cwd.split('/').pop() || 'unknown';
              }
            }
          } catch (err) { logger.debug('Skipping malformed Copilot event line', { error: String(err) }); }
        }
        
        if (userMsgs + assistantMsgs > 0) {
          sessions.push({
            id: dir,
            platform: 'copilot',
            project,
            startTime,
            messageCount: userMsgs + assistantMsgs,
            userMessages: userMsgs,
            assistantMessages: assistantMsgs,
            toolCalls,
            toolSuccesses,
            toolFailures,
            outputTokens,
            inputTokens,
            durationMinutes: 0,
            turns,
          });
        }
      } catch (err) { logger.warn('Failed to read Copilot session directory', { dir, error: String(err) }); }
    }
    
    return sessions.sort((a, b) => a.startTime.localeCompare(b.startTime));
  }
  
  private async readClaudeSessions(): Promise<SessionSummary[]> {
    const sessions: SessionSummary[] = [];
    const baseDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(baseDir)) { return sessions; }
    
    const findJsonl = (dir: string): string[] => {
      const results: string[] = [];
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            results.push(path.join(dir, entry.name));
          } else if (entry.isDirectory()) {
            results.push(...findJsonl(path.join(dir, entry.name)));
          }
        }
      } catch (err) { logger.warn('Failed to traverse Claude projects directory', { dir, error: String(err) }); }
      return results;
    };
    
    for (const jsonlFile of findJsonl(baseDir).slice(0, 50)) {
      try {
        const content = fs.readFileSync(jsonlFile, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        
        let userMsgs = 0, assistantMsgs = 0, toolCalls = 0, outputTokens = 0;
        let startTime = '', project = 'unknown';
        const requestTokens = new Map<string, number>();
        const turns: Turn[] = [];
        
        for (const line of lines) {
          try {
            const record = JSON.parse(line);
            if (!startTime && record.timestamp) { startTime = record.timestamp; }
            if (record.type === 'user') {
              userMsgs++;
              const msgContent = typeof record.message?.content === 'string'
                ? record.message.content
                : Array.isArray(record.message?.content)
                  ? record.message.content.filter((b: { type?: string }) => b.type === 'text').map((b: { text?: string }) => b.text || '').join('\n')
                  : '';
              turns.push({ role: 'user', content: msgContent });
            }
            if (record.type === 'assistant') {
              assistantMsgs++;
              const usage = record.message?.usage || {};
              const reqId = record.requestId || record.message?.id || '';
              const outTokens = usage.output_tokens || 0;
              const prev = requestTokens.get(reqId) || 0;
              if (outTokens > prev) {
                outputTokens += outTokens - prev;
                requestTokens.set(reqId, outTokens);
              }
              const msgContent = typeof record.message?.content === 'string'
                ? record.message.content
                : Array.isArray(record.message?.content)
                  ? record.message.content.filter((b: { type?: string }) => b.type === 'text').map((b: { text?: string }) => b.text || '').join('\n')
                  : '';
              turns.push({ role: 'assistant', content: msgContent, tokens: outTokens });
            }
            if (record.cwd) {
              project = record.cwd.split('/').pop() || 'unknown';
            }
          } catch (err) { logger.debug('Skipping malformed Claude session line', { error: String(err) }); }
        }
        
        if (userMsgs + assistantMsgs > 0) {
          sessions.push({
            id: path.basename(jsonlFile, '.jsonl'),
            platform: 'claude',
            project: project.toLowerCase(),
            startTime,
            messageCount: userMsgs + assistantMsgs,
            userMessages: userMsgs,
            assistantMessages: assistantMsgs,
            toolCalls,
            toolSuccesses: toolCalls,
            toolFailures: 0,
            outputTokens,
            inputTokens: 0,
            durationMinutes: 0,
            turns,
          });
        }
      } catch (err) { logger.warn('Failed to read Claude session file', { file: jsonlFile, error: String(err) }); }
    }
    
    return sessions.sort((a, b) => a.startTime.localeCompare(b.startTime));
  }
  
  private async readClineSessions(): Promise<SessionSummary[]> {
    const sessions: SessionSummary[] = [];
    const editors = ['Code - Insiders', 'Code'];
    const extensionId = 'saoudrizwan.claude-dev';
    
    for (const editor of editors) {
      const baseDir = this.getGlobalStoragePath(editor, extensionId);
      if (!fs.existsSync(baseDir)) { continue; }
      
      let taskDirs: string[];
      try {
        taskDirs = fs.readdirSync(baseDir).filter(d => 
          fs.statSync(path.join(baseDir, d)).isDirectory()
        );
      } catch (err) { logger.warn('Failed to read Cline task directories', { dir: baseDir, error: String(err) }); continue; }
      
      for (const taskDir of taskDirs) {
        try {
          const histFile = path.join(baseDir, taskDir, 'api_conversation_history.json');
          if (!fs.existsSync(histFile)) { continue; }
          
          const data = JSON.parse(fs.readFileSync(histFile, 'utf-8'));
          if (!Array.isArray(data)) { continue; }
          
          let userMsgs = 0, assistantMsgs = 0, toolCalls = 0, outputTokens = 0;
          const turns: Turn[] = [];
          
          for (const msg of data) {
            if (msg.role === 'user') {
              userMsgs++;
              const content = typeof msg.content === 'string'
                ? msg.content
                : Array.isArray(msg.content)
                  ? msg.content.filter((b: { type?: string }) => b.type === 'text').map((b: { text?: string }) => b.text || '').join('\n')
                  : '';
              turns.push({ role: 'user', content });
            }
            if (msg.role === 'assistant') {
              assistantMsgs++;
              outputTokens += msg.metrics?.tokens?.completion || 0;
              if (Array.isArray(msg.content)) {
                toolCalls += msg.content.filter((b: unknown) => (b as { type?: string }).type === 'tool_use').length;
              }
              const content = typeof msg.content === 'string'
                ? msg.content
                : Array.isArray(msg.content)
                  ? msg.content.filter((b: { type?: string }) => b.type === 'text').map((b: { text?: string }) => b.text || '').join('\n')
                  : '';
              turns.push({ role: 'assistant', content, tokens: msg.metrics?.tokens?.completion });
            }
          }
          
          sessions.push({
            id: taskDir,
            platform: 'cline',
            project: 'unknown',
            startTime: new Date(parseInt(taskDir) || 0).toISOString(),
            messageCount: userMsgs + assistantMsgs,
            userMessages: userMsgs,
            assistantMessages: assistantMsgs,
            toolCalls,
            toolSuccesses: toolCalls,
            toolFailures: 0,
            outputTokens,
            inputTokens: 0,
            durationMinutes: 0,
            turns,
          });
        } catch (err) { logger.warn('Failed to parse Cline task history', { taskDir, error: String(err) }); }
      }
    }
    
    return sessions.sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  private async readRooSessions(): Promise<SessionSummary[]> {
    const sessions: SessionSummary[] = [];
    const editors = ['Code - Insiders', 'Code'];
    const extensionIds = ['rooveterinaryinc.roo-cline', 'microsoftai.ms-roo-cline'];
    
    for (const editor of editors) {
      for (const extId of extensionIds) {
        const baseDir = this.getGlobalStoragePath(editor, extId);
        if (!fs.existsSync(baseDir)) { continue; }
        
        let taskDirs: string[];
        try {
          taskDirs = fs.readdirSync(baseDir).filter(d =>
            fs.statSync(path.join(baseDir, d)).isDirectory()
          );
        } catch (err) { logger.warn('Failed to read Roo task directories', { dir: baseDir, error: String(err) }); continue; }
        
        for (const taskDir of taskDirs) {
          try {
            const histItemFile = path.join(baseDir, taskDir, 'history_item.json');
            if (!fs.existsSync(histItemFile)) { continue; }
            
            const histItem = JSON.parse(fs.readFileSync(histItemFile, 'utf-8'));
            
            // Roo's history_item.json has only token counts, no message content.
            // Try reading api_conversation_history.json for turns if available.
            const turns: Turn[] = [];
            const convFile = path.join(baseDir, taskDir, 'api_conversation_history.json');
            let userMsgs = 0, assistantMsgs = 0, toolCalls = 0;
            if (fs.existsSync(convFile)) {
              try {
                const convData = JSON.parse(fs.readFileSync(convFile, 'utf-8'));
                if (Array.isArray(convData)) {
                  for (const msg of convData) {
                    if (msg.role === 'user') {
                      userMsgs++;
                      const content = typeof msg.content === 'string' ? msg.content
                        : Array.isArray(msg.content) ? msg.content.filter((b: { type?: string }) => b.type === 'text').map((b: { text?: string }) => b.text || '').join('\n') : '';
                      turns.push({ role: 'user', content });
                    }
                    if (msg.role === 'assistant') {
                      assistantMsgs++;
                      if (Array.isArray(msg.content)) {
                        toolCalls += msg.content.filter((b: unknown) => (b as { type?: string }).type === 'tool_use').length;
                      }
                      const content = typeof msg.content === 'string' ? msg.content
                        : Array.isArray(msg.content) ? msg.content.filter((b: { type?: string }) => b.type === 'text').map((b: { text?: string }) => b.text || '').join('\n') : '';
                      turns.push({ role: 'assistant', content });
                    }
                  }
                }
              } catch { /* no conversation history */ }
            }

            sessions.push({
              id: taskDir,
              platform: 'roo',
              project: histItem.workspace?.split('/').pop() || 'unknown',
              startTime: new Date(histItem.ts || 0).toISOString(),
              messageCount: userMsgs + assistantMsgs,
              userMessages: userMsgs,
              assistantMessages: assistantMsgs,
              toolCalls,
              toolSuccesses: toolCalls,
              toolFailures: 0,
              outputTokens: histItem.tokensOut || 0,
              inputTokens: histItem.tokensIn || 0,
              durationMinutes: 0,
              turns,
            });
          } catch (err) { logger.warn('Failed to parse Roo task history', { taskDir, error: String(err) }); }
        }
      }
    }
    
    return sessions.sort((a, b) => a.startTime.localeCompare(b.startTime));
  }
  
  private getGlobalStoragePath(editor: string, extensionId: string): string {
    const home = os.homedir();
    if (process.platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', editor, 'User', 'globalStorage', extensionId, 'tasks');
    } else if (process.platform === 'win32') {
      return path.join(home, 'AppData', 'Roaming', editor, 'User', 'globalStorage', extensionId, 'tasks');
    }
    return path.join(home, '.config', editor, 'User', 'globalStorage', extensionId, 'tasks');
  }
  
  private calculatePeakConcurrency(sessions: SessionSummary[]): number {
    return sessions.length > 0 ? 1 : 0;
  }
  
  private calculatePlatformStats(sessions: SessionSummary[]) {
    const map = new Map<string, { sessions: number; messages: number; tokens: number }>();
    for (const s of sessions) {
      const existing = map.get(s.platform) || { sessions: 0, messages: 0, tokens: 0 };
      existing.sessions++;
      existing.messages += s.messageCount;
      existing.tokens += s.outputTokens;
      map.set(s.platform, existing);
    }
    return [...map.entries()].map(([platform, stats]) => ({ platform, ...stats }));
  }
  
  private generateEmptyReport(tool: AITool): string {
    const toolName = AI_TOOLS[tool]?.name || tool;
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Vibe Report</title>
    <style>body{font-family:system-ui;background:#1a1a2e;color:#eee;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
    .empty{text-align:center;padding:40px}.empty h1{font-size:2em;margin-bottom:10px}.empty p{color:#888;font-size:1.1em}</style>
    </head><body><div class="empty"><h1>No ${this.escapeHtml(toolName)} sessions found</h1>
    <p>Start coding with ${this.escapeHtml(toolName)} and your sessions will appear here.</p></div></body></html>`;
  }
  
  private renderHtml(metrics: VibeMetrics, tool: AITool, userName?: string): string {
    try {
    const toolName = AI_TOOLS[tool]?.name || tool;
    const toolIcon = AI_TOOLS[tool]?.icon || '🤖';
    const name = userName || 'Developer';
    
    const heroStats = [
      { label: 'Sessions', value: metrics.totalSessions.toLocaleString(), icon: '💬' },
      { label: 'Messages', value: metrics.totalMessages.toLocaleString(), icon: '📝' },
      { label: 'Tool Calls', value: metrics.totalToolCalls.toLocaleString(), icon: '🔧' },
      { label: 'Output Tokens', value: this.formatNumber(metrics.totalOutputTokens), icon: '⚡' },
      { label: 'Autonomy Ratio', value: `${metrics.autonomyRatio}x`, icon: '🤖' },
      { label: 'Output Density', value: this.formatNumber(metrics.outputDensity), icon: '📊' },
      { label: 'Avg Depth', value: `${metrics.avgSessionDepth} msgs`, icon: '📏' },
      { label: 'Projects', value: metrics.projects.length.toString(), icon: '📁' },
    ];
    
    const heroCardsHtml = heroStats.map(s => `
      <div class="hero-card glass-card">
        <div class="hero-icon">${s.icon}</div>
        <div class="hero-value">${s.value}</div>
        <div class="hero-label">${s.label}</div>
      </div>
    `).join('');
    
    const projectsHtml = metrics.projects.slice(0, 20).map(p => 
      `<span class="project-badge">${this.escapeHtml(p)}</span>`
    ).join('');
    
    const topSessions = [...metrics.sessions]
      .sort((a, b) => b.outputTokens - a.outputTokens)
      .slice(0, 20);
    
    const sessionRowsHtml = topSessions.map(s => `
      <tr>
        <td>${this.escapeHtml(s.project)}</td>
        <td>${s.platform}</td>
        <td>${s.userMessages}</td>
        <td>${s.assistantMessages}</td>
        <td>${s.toolCalls}</td>
        <td>${this.formatNumber(s.outputTokens)}</td>
        <td>${s.userMessages > 0 ? Math.round((s.assistantMessages + s.toolCalls) / s.userMessages * 10) / 10 : 0}x</td>
      </tr>
    `).join('');

    const trendIcon = (t: string) => t === 'improving' ? '↑' : t === 'declining' ? '↓' : '→';
    const trendColor = (t: string) => t === 'improving' ? 'var(--color-emerald)' : t === 'declining' ? 'var(--color-crimson)' : 'var(--text-secondary)';

    // Infrastructure Story: vibe summary + tooling colors
    const vibeSummary = metrics.autonomyScore > 80 && metrics.outputDensityScore > 80
      ? 'High-Output, Low-Friction. Agent operates efficiently with strong contextual understanding.'
      : metrics.autonomyScore > 50 && metrics.toolCallSuccessRate < 70
        ? 'High-Output, High-Friction. Agent generates rapidly but tool failures create bottlenecks.'
        : metrics.autonomyScore < 30
          ? 'Manual-Heavy. Agent requires frequent manual intervention — instructions may be insufficient.'
          : 'Developing. Agent proficiency is building — focus on instruction quality and tool coverage.';
    const vibeColor = metrics.vibeLevelColor;
    const toolSuccessColor = metrics.toolCallSuccessRate >= 90 ? 'var(--color-emerald)' : metrics.toolCallSuccessRate >= 70 ? 'var(--level-3)' : 'var(--color-crimson)';
    const htrColor = metrics.humanTakeoverRate <= 10 ? 'var(--color-emerald)' : metrics.humanTakeoverRate <= 30 ? 'var(--level-3)' : 'var(--color-crimson)';

    const archetypeDescriptions: Record<string, string> = {
      Architect: 'Detailed prompts, high context, deep sessions',
      Sprinter: 'Rapid-fire prompts, high concurrency',
      Perfectionist: 'Many correction cycles, revision loops',
      Explorer: 'Lots of read/search operations',
      Delegator: 'Fewer prompts, high action yield',
      Operator: 'Shell/test heavy, debugging loops',
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vibe Report — ${this.escapeHtml(name)}</title>
  <style>
    ${TACTICAL_GLASSBOX_CSS}

    /* Panel-specific layout */
    .header { text-align: center; margin-bottom: 40px; }
    .header h1 { font-size: 2.5em; background: linear-gradient(135deg, var(--color-cyan), var(--color-purple)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 8px; }
    .header .subtitle { color: var(--text-secondary); font-size: 1.1em; }
    .header .tool-badge { display: inline-block; margin-top: 12px; padding: 6px 16px; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 20px; font-size: 1.1em; }
    .header .date-range { color: var(--text-muted); margin-top: 8px; font-size: 0.9em; }
    
    .vibe-level { text-align: center; margin: 30px 0; }
    .aps-circle { width: 120px; height: 120px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto; }
    .aps-inner { width: 90px; height: 90px; border-radius: 50%; background: var(--bg-primary); display: flex; align-items: center; justify-content: center; font-size: 2em; font-weight: bold; font-family: var(--font-mono); }
    .vibe-name { font-size: 1.4em; font-weight: bold; margin-top: 12px; }
    .archetype { color: var(--text-secondary); margin-top: 4px; font-size: 1em; }
    
    .archetype-card { background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 20px; margin: 20px 0; display: flex; gap: 20px; align-items: center; transition: border-color 0.2s, box-shadow 0.2s; }
    .archetype-card:hover { border-color: var(--border-active); box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3); }
    .archetype-card .primary { font-size: 1.3em; font-weight: bold; }
    .archetype-card .desc { color: var(--text-secondary); font-size: 0.9em; margin-top: 4px; }
    .archetype-card .secondary { color: var(--text-muted); font-size: 0.85em; margin-top: 8px; }
    
    .dim-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
    .dim-row span:first-child { min-width: 90px; font-size: 0.85em; color: var(--text-secondary); }
    .dim-row span:last-child { min-width: 30px; font-weight: bold; text-align: right; font-family: var(--font-mono); }
    .dim-bar { flex: 1; height: 8px; background: var(--bg-elevated); border-radius: 4px; overflow: hidden; }
    .dim-bar > div { height: 100%; background: linear-gradient(90deg, var(--color-cyan), var(--color-purple)); border-radius: 4px; transition: width 0.5s; }
    
    .hero-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 30px 0; }
    .hero-card { border-radius: 12px; padding: 20px; text-align: center; }
    .hero-icon { font-size: 1.5em; margin-bottom: 8px; }
    .hero-value { font-size: 1.8em; font-weight: bold; color: var(--text-primary); font-family: var(--font-mono); }
    .hero-label { color: var(--text-secondary); font-size: 0.85em; margin-top: 4px; }
    
    h2 { margin: 40px 0 16px; font-size: 1.4em; color: var(--text-primary); border-bottom: 1px solid var(--border-subtle); padding-bottom: 8px; }
    
    .projects { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
    .project-badge { background: var(--bg-elevated); border: 1px solid var(--border-subtle); padding: 4px 12px; border-radius: 12px; font-size: 0.85em; }
    
    .growth-table td:last-child { font-size: 1.2em; }
    
    .formula { background: var(--bg-card); border: 1px solid var(--border-subtle); padding: 12px 20px; border-radius: 8px; margin: 12px 0; font-family: var(--font-mono); color: var(--text-secondary); }
    .formula strong { color: var(--text-primary); }

    .charts-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 16px 0; }
    .metric-chart { background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 16px; transition: border-color 0.2s; }
    .metric-chart:hover { border-color: var(--border-active); }
    .metric-chart .chart-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
    .metric-chart .chart-title { font-size: 0.9em; font-weight: 600; }
    .metric-chart .chart-current { font-size: 1.2em; font-weight: bold; font-family: var(--font-mono); }
    .metric-chart .chart-trend { font-size: 0.8em; padding: 2px 6px; border-radius: 4px; }
    .metric-chart svg { width: 100%; height: 80px; }
    .metric-chart .chart-range { display: flex; justify-content: space-between; font-size: 0.7em; color: var(--text-muted); margin-top: 4px; }
    
    @media (max-width: 600px) { .hero-grid { grid-template-columns: repeat(2, 1fr); } .charts-grid { grid-template-columns: 1fr; } }

    /* SRE Metrics */
    .sre-section { margin: 40px 0; }
    .sre-gauges { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; margin: 16px 0; }
    .sre-gauge { background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 20px; text-align: center; transition: border-color 0.2s, box-shadow 0.2s; }
    .sre-gauge:hover { border-color: var(--border-active); box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3); }
    .sre-gauge .gauge-value { font-size: 2em; font-weight: bold; font-family: var(--font-mono); }
    .sre-gauge .gauge-label { color: var(--text-secondary); font-size: 0.85em; margin-top: 4px; }
    .sre-gauge .gauge-sublabel { color: var(--text-muted); font-size: 0.75em; margin-top: 2px; }
    .sre-gauge .gauge-bar { width: 100%; height: 6px; background: var(--bg-elevated); border-radius: 3px; margin-top: 8px; overflow: hidden; }
    .sre-gauge .gauge-fill { height: 100%; border-radius: 3px; transition: width 0.5s; }
    
    .health-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 16px 0; }
    .health-card { background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 20px; }
    .health-card h3 { margin: 0 0 12px; font-size: 1.1em; }
    .health-bar-row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
    .health-bar-row .bar-label { min-width: 70px; font-size: 0.85em; color: var(--text-secondary); }
    .health-bar-row .bar-container { flex: 1; height: 20px; background: var(--bg-elevated); border-radius: 4px; overflow: hidden; }
    .health-bar-row .bar-fill { height: 100%; border-radius: 4px; display: flex; align-items: center; justify-content: flex-end; padding-right: 6px; font-size: 0.7em; font-weight: bold; min-width: 30px; }
    .prompt-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    .prompt-table td, .prompt-table th { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border-subtle); font-size: 0.85em; }
    .prompt-table th { color: var(--text-secondary); font-weight: 600; }
    .prompt-table .success-bar { display: inline-block; height: 8px; border-radius: 4px; margin-right: 6px; vertical-align: middle; }
    
    .platform-comparison { margin: 16px 0; }
    .platform-table { width: 100%; border-collapse: collapse; }
    .platform-table td, .platform-table th { padding: 8px 12px; text-align: center; border-bottom: 1px solid var(--border-subtle); font-size: 0.85em; }
    .platform-table th { color: var(--text-secondary); font-weight: 600; text-align: center; }
    .platform-table th:first-child, .platform-table td:first-child { text-align: left; }

    @media (max-width: 600px) { .sre-gauges { grid-template-columns: repeat(2, 1fr); } .health-grid { grid-template-columns: 1fr; } }

    /* Heatmap */
    .heatmap-container { margin: 16px 0; overflow-x: auto; }
    .heatmap-row { display: flex; align-items: center; gap: 2px; margin: 2px 0; }
    .heatmap-label { min-width: 36px; font-size: 0.7em; color: var(--text-muted); text-align: right; padding-right: 6px; }
    .heatmap-cell { width: 24px; height: 24px; border-radius: 3px; transition: transform 0.1s; }
    .heatmap-cell:hover { transform: scale(1.3); z-index: 1; }
    .heatmap-hours { display: flex; gap: 2px; margin-left: 38px; }
    .heatmap-hours span { width: 24px; text-align: center; font-size: 0.65em; color: var(--text-muted); }

    /* DORA */
    .dora-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 16px 0; }
    .dora-card { background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 16px; text-align: center; transition: border-color 0.2s; }
    .dora-card:hover { border-color: var(--border-active); }
    .dora-card .dora-value { font-size: 1.5em; font-weight: bold; font-family: var(--font-mono); }
    .dora-card .dora-label { color: var(--text-secondary); font-size: 0.85em; margin-top: 2px; }
    .dora-card .dora-rating { font-size: 0.75em; padding: 2px 8px; border-radius: 10px; display: inline-block; margin-top: 6px; }

    /* Regression */
    .regression-alert { padding: 12px 16px; border-radius: 8px; margin: 8px 0; display: flex; align-items: center; gap: 10px; }
    .regression-alert.critical { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); }
    .regression-alert.warning { background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.3); }
    .regression-alert .alert-icon { font-size: 1.2em; }
    .regression-alert .alert-text { flex: 1; font-size: 0.9em; }
    .regression-alert .alert-delta { font-family: var(--font-mono); font-weight: bold; }

    /* Churn */
    .churn-table { width: 100%; border-collapse: collapse; }
    .churn-table td, .churn-table th { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border-subtle); font-size: 0.85em; }
    .churn-table th { color: var(--text-secondary); font-weight: 600; }
    .churn-bar { display: inline-block; height: 8px; border-radius: 4px; vertical-align: middle; margin-right: 6px; }

    @media (max-width: 600px) { .dora-grid { grid-template-columns: repeat(2, 1fr); } }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>${this.escapeHtml(name)}'s Vibe Report</h1>
    <div class="subtitle">Agentic Coding Assessment</div>
    <div class="tool-badge">${toolIcon} ${this.escapeHtml(toolName)}</div>
    ${metrics.dateRange.first ? `<div class="date-range">${new Date(metrics.dateRange.first).toLocaleDateString()} — ${new Date(metrics.dateRange.last).toLocaleDateString()}</div>` : ''}
  </div>
  
  <div class="vibe-level">
    <div class="aps-circle" style="background:conic-gradient(${metrics.vibeLevelColor} ${metrics.aps}%, #333 0)">
      <div class="aps-inner">${metrics.aps}</div>
    </div>
    <div class="vibe-name" style="color:${metrics.vibeLevelColor}">${metrics.vibeLevelName}</div>
    <div class="archetype">${this.escapeHtml(metrics.primaryArchetype)}${metrics.secondaryArchetype ? ` · ${this.escapeHtml(metrics.secondaryArchetype)}` : ''}</div>
  </div>
  
  <div class="archetype-card">
    <div>
      <div class="primary">🧬 ${this.escapeHtml(metrics.primaryArchetype)}</div>
      <div class="desc">${this.escapeHtml(archetypeDescriptions[metrics.primaryArchetype] || '')}</div>
      ${metrics.secondaryArchetype ? `<div class="secondary">Secondary: ${this.escapeHtml(metrics.secondaryArchetype)} — ${this.escapeHtml(archetypeDescriptions[metrics.secondaryArchetype] || '')}</div>` : ''}
    </div>
  </div>

  <div class="archetype-card" style="border-left: 4px solid ${vibeColor}">
    <div style="font-size: 0.9em; color: #94a3b8">
      <strong>Current Vibe:</strong> ${vibeSummary}
    </div>
  </div>
  
  <h2>📊 Proficiency Dimensions</h2>
  <div class="dimension-bars">
    <div class="dim-row"><span>Autonomy</span><div class="dim-bar"><div style="width:${metrics.autonomyScore}%"></div></div><span>${metrics.autonomyScore}</span></div>
    <div class="dim-row"><span>Delegation</span><div class="dim-bar"><div style="width:${metrics.delegationQualityScore}%"></div></div><span>${metrics.delegationQualityScore}</span></div>
    <div class="dim-row"><span>Recovery</span><div class="dim-bar"><div style="width:${metrics.recoveryScore}%"></div></div><span>${metrics.recoveryScore}</span></div>
    <div class="dim-row"><span>Depth</span><div class="dim-bar"><div style="width:${metrics.sessionDepthScore}%"></div></div><span>${metrics.sessionDepthScore}</span></div>
    <div class="dim-row"><span>Output</span><div class="dim-bar"><div style="width:${metrics.outputDensityScore}%"></div></div><span>${metrics.outputDensityScore}</span></div>
  </div>
  
  <h2>📈 Growth Scorecard</h2>
  <table class="growth-table">
    <thead>
      <tr><th>Metric</th><th>Early</th><th>Recent</th><th>Delta</th><th>Trend</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>Autonomy</td>
        <td>${metrics.growth.autonomy.early.toFixed(1)}x</td>
        <td>${metrics.growth.autonomy.recent.toFixed(1)}x</td>
        <td>${metrics.growth.autonomy.delta > 0 ? '+' : ''}${metrics.growth.autonomy.delta.toFixed(1)}</td>
        <td style="color:${trendColor(metrics.growth.autonomy.trend)}">${trendIcon(metrics.growth.autonomy.trend)} ${metrics.growth.autonomy.trend}</td>
      </tr>
      <tr>
        <td>Session Depth</td>
        <td>${metrics.growth.depth.early} msgs</td>
        <td>${metrics.growth.depth.recent} msgs</td>
        <td>${metrics.growth.depth.delta > 0 ? '+' : ''}${metrics.growth.depth.delta}</td>
        <td style="color:${trendColor(metrics.growth.depth.trend)}">${trendIcon(metrics.growth.depth.trend)} ${metrics.growth.depth.trend}</td>
      </tr>
      <tr>
        <td>Output Density</td>
        <td>${this.formatNumber(metrics.growth.density.early)} tok/msg</td>
        <td>${this.formatNumber(metrics.growth.density.recent)} tok/msg</td>
        <td>${metrics.growth.density.delta > 0 ? '+' : ''}${this.formatNumber(metrics.growth.density.delta)}</td>
        <td style="color:${trendColor(metrics.growth.density.trend)}">${trendIcon(metrics.growth.density.trend)} ${metrics.growth.density.trend}</td>
      </tr>
    </tbody>
  </table>

  <h2>📊 Metrics Over Time</h2>
  <div class="charts-grid">
    ${this.renderMetricChart('Autonomy Ratio', metrics.sessions, s => s.userMessages > 0 ? Math.round((s.assistantMessages + s.toolCalls) / s.userMessages * 10) / 10 : 0, '#00E5FF', 'x')}
    ${this.renderMetricChart('Output Density', metrics.sessions, s => s.userMessages > 0 ? Math.round(s.outputTokens / s.userMessages) : 0, '#B388FF', 'tok/msg')}
    ${this.renderMetricChart('Session Depth', metrics.sessions, s => s.messageCount, '#00E676', 'msgs')}
    ${this.renderMetricChart('Tool Calls', metrics.sessions, s => s.toolCalls, '#FFB020', 'calls')}
    ${this.renderMetricChart('Output Tokens', metrics.sessions, s => s.outputTokens, '#FFEA00', 'tok')}
    ${this.renderMetricChart('Efficiency', metrics.sessions, s => s.userMessages > 0 ? Math.round(s.toolCalls / s.userMessages * 100) / 100 : 0, '#00E5FF', 'tools/prompt')}
    ${this.renderMetricChart('Tool Success', metrics.sessions, s => s.toolCalls > 0 ? Math.round(s.toolSuccesses / s.toolCalls * 100) : 100, '#00E676', '%')}
  </div>
  
  <div class="hero-grid">${heroCardsHtml}</div>

  <h2>🔌 Tooling Ecosystem</h2>
  <div class="hero-grid">
    <div class="hero-card glass-card">
      <div class="hero-icon">🎯</div>
      <div class="hero-value" style="color:${toolSuccessColor}">${metrics.toolCallSuccessRate}%</div>
      <div class="hero-label">Tool Success</div>
    </div>
    <div class="hero-card glass-card">
      <div class="hero-icon">📡</div>
      <div class="hero-value">${metrics.contextSNR}%</div>
      <div class="hero-label">Context SNR</div>
    </div>
    <div class="hero-card glass-card">
      <div class="hero-icon">🔧</div>
      <div class="hero-value">${metrics.totalToolCalls.toLocaleString()}</div>
      <div class="hero-label">Total Tool Calls</div>
    </div>
    <div class="hero-card glass-card">
      <div class="hero-icon">🤝</div>
      <div class="hero-value" style="color:${htrColor}">${metrics.humanTakeoverRate}%</div>
      <div class="hero-label">Human Takeover</div>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:12px 0">
    <div class="formula"><strong>💰 Token ROI</strong> — ${metrics.tokenROI === Infinity ? '∞' : metrics.tokenROI + 'x'} (output tokens / input tokens)</div>
    <div class="formula"><strong>🛡️ Guardrail Rate</strong> — ${metrics.guardrailInterventionRate}% of tool calls triggered guardrails</div>
  </div>
  
  ${this.renderSRESection(metrics)}
  
  <h2>📊 What the Numbers Mean</h2>
  <div class="formula"><strong>APS</strong> = weighted(Autonomy×0.25 + Delegation×0.20 + Recovery×0.15 + Depth×0.15 + Output×0.10 + Diversity×0.15) = <strong>${metrics.aps}</strong></div>
  <div class="formula"><strong>Autonomy Ratio</strong> = (agent responses + tool calls) / your prompts = <strong>${metrics.autonomyRatio}x</strong></div>
  <div class="formula"><strong>Output Density</strong> = agent output tokens / your prompts = <strong>${this.formatNumber(metrics.outputDensity)} tokens/prompt</strong></div>
  <div class="formula"><strong>Avg Session Depth</strong> = messages per session = <strong>${metrics.avgSessionDepth}</strong></div>
  
  <h2>📁 Projects (${metrics.projects.length})</h2>
  <div class="projects">${projectsHtml}</div>
  
  <h2>🏆 Top Sessions by Output</h2>
  <table>
    <thead>
      <tr><th>Project</th><th>Platform</th><th>You</th><th>Agent</th><th>Tools</th><th>Tokens</th><th>Ratio</th></tr>
    </thead>
    <tbody>${sessionRowsHtml}</tbody>
  </table>
  
  <div style="text-align:center;margin-top:40px;color:var(--text-muted);font-size:0.85em">
    Generated by AI Readiness Scanner • ${new Date().toLocaleDateString()}
  </div>
</div>
</body>
</html>`;
    } catch (err) {
      logger.error('VibeReportGenerator: renderHtml failed', err);
      return `<html><body><h2>❌ Render Error</h2><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`;
    }
  }
  
  private renderVibeRadar(metrics: VibeMetrics): string {
    try {
    const data: RadarDataPoint[] = [
      { label: 'Autonomy', value: metrics.autonomyScore, color: '#00E5FF' },
      { label: 'Delegation', value: metrics.delegationQualityScore, color: '#B388FF' },
      { label: 'Recovery', value: metrics.recoveryScore, color: '#00E676' },
      { label: 'Depth', value: metrics.sessionDepthScore, color: '#00E5FF' },
      { label: 'Output', value: metrics.outputDensityScore, color: '#FFB020' },
    ];
    return generateRadarChartSVG(data, 240, true);
    } catch (err) {
      logger.error('VibeReportGenerator: renderVibeRadar failed', err);
      return '<div>⚠️ Error rendering radar chart</div>';
    }
  }

  private renderMetricChart(
    title: string,
    sessions: SessionSummary[],
    extractor: (s: SessionSummary) => number,
    color: string,
    unit: string
  ): string {
    try {
    if (sessions.length === 0) {
      return `<div class="metric-chart"><div class="chart-header"><span class="chart-title">${this.escapeHtml(title)}</span><span class="chart-current" style="color:${color}">—</span></div><div style="text-align:center;color:#64748b;padding:20px">No data</div></div>`;
    }

    const values = sessions.map(extractor);
    const maxVal = Math.max(...values, 1);
    const minVal = Math.min(...values);
    const currentVal = values[values.length - 1];
    const firstQuarter = values.slice(0, Math.max(1, Math.floor(values.length / 4)));
    const lastQuarter = values.slice(-Math.max(1, Math.floor(values.length / 4)));
    const earlyAvg = firstQuarter.reduce((a, b) => a + b, 0) / firstQuarter.length;
    const recentAvg = lastQuarter.reduce((a, b) => a + b, 0) / lastQuarter.length;
    const delta = recentAvg - earlyAvg;
    const trend = delta > 0.5 ? 'improving' : delta < -0.5 ? 'declining' : 'stable';
    const trendBg = trend === 'improving' ? 'rgba(0,230,118,0.15)' : trend === 'declining' ? 'rgba(255,59,92,0.15)' : 'rgba(148,163,184,0.15)';
    const trendFg = trend === 'improving' ? '#00E676' : trend === 'declining' ? '#FF3B5C' : '#94A3B8';
    const trendSym = trend === 'improving' ? '↑' : trend === 'declining' ? '↓' : '→';

    // Build SVG sparkline
    const w = 280;
    const h = 60;
    const padding = 2;
    const range = maxVal - minVal || 1;
    const points = values.map((v, i) => {
      const x = padding + (i / Math.max(1, values.length - 1)) * (w - 2 * padding);
      const y = h - padding - ((v - minVal) / range) * (h - 2 * padding);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const polyline = points.join(' ');
    const areaPoints = `${padding},${h} ${polyline} ${w - padding},${h}`;

    return `<div class="metric-chart">
      <div class="chart-header">
        <span class="chart-title">${this.escapeHtml(title)}</span>
        <span>
          <span class="chart-current" style="color:${color}">${this.formatNumber(currentVal)}</span>
          <span class="chart-trend" style="background:${trendBg};color:${trendFg}">${trendSym}</span>
        </span>
      </div>
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <polygon points="${areaPoints}" fill="${color}" fill-opacity="0.12" />
        <polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <circle cx="${points[points.length - 1].split(',')[0]}" cy="${points[points.length - 1].split(',')[1]}" r="3" fill="${color}" />
      </svg>
      <div class="chart-range">
        <span>${this.formatNumber(minVal)} ${this.escapeHtml(unit)}</span>
        <span>${this.formatNumber(maxVal)} ${this.escapeHtml(unit)}</span>
      </div>
    </div>`;
    } catch (err) {
      logger.error('VibeReportGenerator: renderMetricChart failed', err);
      return `<div class="metric-chart"><div class="chart-header"><span class="chart-title">${this.escapeHtml(title)}</span></div><div style="color:#64748b;padding:10px">⚠️ Error</div></div>`;
    }
  }

  private renderSRESection(metrics: VibeMetrics): string {
    const sre = metrics.sreMetrics;
    const hasTurns = metrics.sessions.some(s => s.turns.length > 0);

    if (!hasTurns) {
      return `
  <div class="sre-section">
    <h2>🛡️ SRE Reliability Metrics</h2>
    <div class="formula">No conversation content available for SRE analysis. Session data only includes counts — try platforms that store message history (Copilot CLI, Claude Code, Cline).</div>
    ${this.renderActivityHeatmap(sre)}
    ${this.renderDORASection(sre)}
    ${this.renderCodeChurn(sre)}
    ${this.renderCostSection(sre)}
  </div>`;
    }

    const gaugeHtml = (label: string, value: number, metricKey: string, sublabel: string, invert = false) => {
      const color = getSREMetricColor(metricKey, value);
      const labelText = getSREMetricLabel(metricKey, value);
      const fillPct = invert ? 100 - value : value;
      return `
      <div class="sre-gauge">
        <div class="gauge-value" style="color:${color}">${value}%</div>
        <div class="gauge-label">${label}</div>
        <div class="gauge-sublabel">${labelText} · ${sublabel}</div>
        <div class="gauge-bar"><div class="gauge-fill" style="width:${fillPct}%;background:${color}"></div></div>
      </div>`;
    };

    const healthBarHtml = (label: string, pct: number, color: string) => `
      <div class="health-bar-row">
        <span class="bar-label">${label}</span>
        <div class="bar-container">
          <div class="bar-fill" style="width:${Math.max(pct, 2)}%;background:${color}">${pct}%</div>
        </div>
      </div>`;

    const promptRows = sre.promptEffectiveness.categories
      .filter(c => c.totalPrompts > 0)
      .slice(0, 8)
      .map(c => {
        const barColor = c.successRate >= 80 ? 'var(--color-emerald)' : c.successRate >= 50 ? 'var(--level-3)' : 'var(--color-crimson)';
        return `<tr>
          <td style="text-transform:capitalize">${c.name}</td>
          <td>${c.totalPrompts}</td>
          <td><span class="success-bar" style="width:${c.successRate * 0.6}px;background:${barColor}"></span>${c.successRate}%</td>
          <td>${c.avgCorrections}</td>
        </tr>`;
      }).join('');

    // Platform comparison table (only if multiple platforms)
    let platformComparisonHtml = '';
    if (metrics.perPlatformSRE.length > 1) {
      const headers = metrics.perPlatformSRE.map(p =>
        `<th style="text-transform:capitalize">${p.platform}</th>`
      ).join('');
      const row = (label: string, extractor: (m: SREMetrics) => number, invert = false) => {
        const cells = metrics.perPlatformSRE.map(p => {
          const val = extractor(p.metrics);
          const color = getSREMetricColor(invert ? 'hallucinationIndex' : 'firstTrySuccess', val);
          return `<td style="color:${color};font-weight:bold;font-family:var(--font-mono)">${val}%</td>`;
        }).join('');
        return `<tr><td>${label}</td>${cells}</tr>`;
      };

      platformComparisonHtml = `
      <h2>🔀 Platform Comparison</h2>
      <div class="platform-comparison">
        <table class="platform-table">
          <thead><tr><th>Metric</th>${headers}</tr></thead>
          <tbody>
            ${row('Hallucination', m => m.hallucinationIndex, true)}
            ${row('Laziness', m => m.lazinessIndex, true)}
            ${row('First-Try', m => m.firstTrySuccess)}
            ${row('Flow', m => m.flowScore)}
            ${row('Context Rot', m => m.contextRot.rotScore, true)}
          </tbody>
        </table>
      </div>`;
    }

    const loopCount = sre.loops.length;
    const loopHtml = loopCount > 0
      ? `<div style="margin-top:8px;color:var(--color-crimson);font-size:0.85em">
          🔄 ${loopCount} correction loop${loopCount > 1 ? 's' : ''} detected — 
          ${sre.loops.slice(0, 3).map(l => `"${this.escapeHtml(l.topic)}" (${l.length} rounds)`).join(', ')}
         </div>`
      : '';

    return `
  <div class="sre-section">
    <h2>🛡️ SRE Reliability Metrics</h2>
    <div class="sre-gauges">
      ${gaugeHtml('Hallucination', sre.hallucinationIndex, 'hallucinationIndex', 'lower is better', true)}
      ${gaugeHtml('Laziness', sre.lazinessIndex, 'lazinessIndex', 'lower is better', true)}
      ${gaugeHtml('First-Try', sre.firstTrySuccess, 'firstTrySuccess', 'higher is better')}
      ${gaugeHtml('Flow', sre.flowScore, 'flowScore', 'higher is better')}
      ${gaugeHtml('Context Rot', sre.contextRot.rotScore, 'contextRot', 'lower is better', true)}
    </div>

    ${this.renderRegressionAlerts(sre)}

    <div class="health-grid">
      <div class="health-card">
        <h3>🏥 Session Health</h3>
        ${healthBarHtml('✅ Clean', sre.sessionHealth.clean, 'var(--color-emerald)')}
        ${healthBarHtml('⚠️ Bumpy', sre.sessionHealth.bumpy, 'var(--level-3)')}
        ${healthBarHtml('❌ Troubled', sre.sessionHealth.troubled, 'var(--color-crimson)')}
        <div style="color:var(--text-muted);font-size:0.8em;margin-top:8px">${sre.sessionHealth.totalSessions} sessions analyzed</div>
        ${loopHtml}
      </div>
      <div class="health-card">
        <h3>📝 Prompt Effectiveness</h3>
        <div style="font-size:0.85em;color:var(--text-secondary);margin-bottom:8px">
          Overall: <strong style="color:${getSREMetricColor('firstTrySuccess', sre.promptEffectiveness.overallSuccessRate)}">${sre.promptEffectiveness.overallSuccessRate}%</strong> success rate
        </div>
        <table class="prompt-table">
          <thead><tr><th>Category</th><th>Count</th><th>Success</th><th>Avg Fix</th></tr></thead>
          <tbody>${promptRows}</tbody>
        </table>
      </div>
    </div>
    
    ${platformComparisonHtml}
    ${this.renderActivityHeatmap(sre)}
    ${this.renderDORASection(sre)}
    ${this.renderCodeChurn(sre)}
    ${this.renderCostSection(sre)}
  </div>`;
  }

  private renderRegressionAlerts(sre: SREMetrics): string {
    const reg = sre.regression;
    if (reg.alerts.length === 0) { return ''; }

    const alertsHtml = reg.alerts.map(a => {
      const icon = a.severity === 'critical' ? '🚨' : '⚠️';
      const deltaStr = a.delta > 0 ? `+${a.delta}` : `${a.delta}`;
      return `<div class="regression-alert ${a.severity}">
        <span class="alert-icon">${icon}</span>
        <span class="alert-text">${this.escapeHtml(a.message)}</span>
        <span class="alert-delta" style="color:var(--color-crimson)">${deltaStr}</span>
      </div>`;
    }).join('');

    const trendIcon = reg.trend === 'degrading' ? '📉' : reg.trend === 'improving' ? '📈' : '➡️';

    return `
    <div style="margin:16px 0">
      <h3 style="margin:0 0 8px">${trendIcon} Regression Detection</h3>
      <div style="color:var(--text-secondary);font-size:0.85em;margin-bottom:8px">
        Comparing recent ${reg.recentWindow.sessionCount} sessions vs previous ${reg.previousWindow.sessionCount}
      </div>
      ${alertsHtml}
    </div>`;
  }

  private renderActivityHeatmap(sre: SREMetrics): string {
    const heatmap = sre.activityHeatmap;
    if (heatmap.totalActiveDays === 0) { return ''; }

    const maxVal = Math.max(1, ...heatmap.grid.flat());
    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    const cellColor = (count: number) => {
      if (count === 0) { return 'rgba(255,255,255,0.03)'; }
      const intensity = count / maxVal;
      const alpha = 0.15 + intensity * 0.85;
      return `rgba(0,229,255,${alpha.toFixed(2)})`;
    };

    const rows = dayLabels.map((day, dayIdx) => {
      const cells = heatmap.grid[dayIdx].map((count, hour) =>
        `<div class="heatmap-cell" style="background:${cellColor(count)}" title="${day} ${hour}:00 — ${count} session${count !== 1 ? 's' : ''}"></div>`
      ).join('');
      return `<div class="heatmap-row"><span class="heatmap-label">${day}</span>${cells}</div>`;
    }).join('');

    const hourLabels = Array.from({ length: 24 }, (_, i) =>
      i % 3 === 0 ? `<span>${i}</span>` : '<span></span>'
    ).join('');

    return `
    <h2>🗓️ Activity Heatmap</h2>
    <div class="heatmap-container">
      ${rows}
      <div class="heatmap-hours">${hourLabels}</div>
    </div>
    <div style="display:flex;gap:20px;margin:8px 0;font-size:0.85em;color:var(--text-secondary)">
      <span>📅 ${heatmap.totalActiveDays} active days</span>
      <span>🏆 Peak: ${heatmap.peakDay} ${heatmap.peakHour}:00</span>
      <span>⚡ Most productive: ${heatmap.mostProductiveWindow}</span>
    </div>`;
  }

  private renderDORASection(sre: SREMetrics): string {
    const dora = sre.doraMetrics;
    if (dora.overallRating === 'Low' && dora.deployFrequency.label === 'No data') { return ''; }

    const ratingColor = (r: string) => {
      switch (r) {
        case 'Elite': return 'var(--color-emerald)';
        case 'High': return 'var(--color-cyan)';
        case 'Medium': return 'var(--level-3)';
        default: return 'var(--color-crimson)';
      }
    };

    const card = (icon: string, label: string, level: typeof dora.deployFrequency) => `
      <div class="dora-card">
        <div style="font-size:1.2em">${icon}</div>
        <div class="dora-value">${level.value}${level.unit !== 'N/A' ? ` ${level.unit}` : ''}</div>
        <div class="dora-label">${label}</div>
        <div class="dora-rating" style="background:${ratingColor(level.rating)}20;color:${ratingColor(level.rating)}">${level.rating} · ${level.label}</div>
      </div>`;

    return `
    <h2>🚀 DORA Metrics for AI</h2>
    <div style="margin-bottom:8px;font-size:0.85em;color:var(--text-secondary)">
      Overall: <strong style="color:${ratingColor(dora.overallRating)}">${dora.overallRating}</strong> performer · from git history (last 90 days)
    </div>
    <div class="dora-grid">
      ${card('🚢', 'Deploy Frequency', dora.deployFrequency)}
      ${card('⏱️', 'Lead Time', dora.leadTime)}
      ${card('❌', 'Change Failure Rate', dora.changeFailureRate)}
      ${card('🔧', 'MTTR', dora.mttr)}
    </div>`;
  }

  private renderCodeChurn(sre: SREMetrics): string {
    const churn = sre.codeChurn;
    if (churn.hotFiles.length === 0) { return ''; }

    const maxEdits = Math.max(1, ...churn.hotFiles.map(f => f.editCount));
    const rows = churn.hotFiles.slice(0, 10).map(f => {
      const barWidth = Math.max(8, (f.editCount / maxEdits) * 100);
      const barColor = f.isUnstable ? 'var(--color-crimson)' : 'var(--color-cyan)';
      const icon = f.isUnstable ? '🔥' : '';
      return `<tr>
        <td style="font-family:var(--font-mono);font-size:0.8em">${icon} ${this.escapeHtml(f.path.split('/').slice(-2).join('/'))}</td>
        <td><span class="churn-bar" style="width:${barWidth}px;background:${barColor}"></span>${f.editCount}</td>
        <td>${f.sessionCount}</td>
      </tr>`;
    }).join('');

    const instColor = churn.instabilityScore <= 20 ? 'var(--color-emerald)' : churn.instabilityScore <= 50 ? 'var(--level-3)' : 'var(--color-crimson)';

    return `
    <h2>🔥 Code Churn</h2>
    <div style="margin-bottom:8px;font-size:0.85em;color:var(--text-secondary)">
      Instability: <strong style="color:${instColor}">${churn.instabilityScore}%</strong> · ${churn.totalChurnEvents} churn events · files re-edited across commits
    </div>
    <table class="churn-table">
      <thead><tr><th>File</th><th>Edits</th><th>Commits</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  private renderCostSection(sre: SREMetrics): string {
    const cost = sre.costEstimate;
    if (cost.totalCost === 0) { return ''; }

    const breakdownHtml = cost.breakdown.map(b =>
      `<span class="project-badge" style="border-color:var(--color-cyan)">${b.platform}: $${b.cost.toFixed(2)} (${b.sessions} sessions)</span>`
    ).join('');

    return `
    <h2>💰 Cost Per Outcome</h2>
    <div class="hero-grid" style="grid-template-columns: repeat(4, 1fr)">
      <div class="hero-card glass-card">
        <div class="hero-icon">💵</div>
        <div class="hero-value">$${cost.totalCost.toFixed(2)}</div>
        <div class="hero-label">Total Estimated</div>
      </div>
      <div class="hero-card glass-card">
        <div class="hero-icon">💬</div>
        <div class="hero-value">$${cost.costPerSession.toFixed(2)}</div>
        <div class="hero-label">Per Session</div>
      </div>
      <div class="hero-card glass-card">
        <div class="hero-icon">📝</div>
        <div class="hero-value">$${cost.costPerMessage.toFixed(3)}</div>
        <div class="hero-label">Per Message</div>
      </div>
      <div class="hero-card glass-card">
        <div class="hero-icon">🔧</div>
        <div class="hero-value">$${cost.costPerToolCall.toFixed(3)}</div>
        <div class="hero-label">Per Tool Call</div>
      </div>
    </div>
    <div class="projects" style="margin-top:8px">${breakdownHtml}</div>
    <div class="formula" style="margin-top:8px"><strong>💡</strong> Estimated using approximate model pricing ($3/M input, $15/M output). Actual costs depend on model tier and provider.</div>`;
  }

  private formatNumber(n: number): string {
    if (n >= 1000000) { return `${(n / 1000000).toFixed(1)}M`; }
    if (n >= 1000) { return `${(n / 1000).toFixed(1)}K`; }
    return n.toString();
  }
  
  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
