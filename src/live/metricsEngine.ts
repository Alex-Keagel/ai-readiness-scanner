import type { AIEvent } from './sessionPoller';

export interface LiveMetrics {
  aipm: number;
  sessionAipm: number;
  concurrency: number;
  avgConcurrency: number;
  aipmPerAgent: number;
  sessionTokens: number;
  sessionPrompts: number;
  sessionToolCalls: number;
  peakAipm: number;
  peakConcurrency: number;
  sessionDuration: string;
  activePlatforms: string[];
  platformBreakdown: { platform: string; tokens: number; prompts: number; toolCalls: number }[];
  color: 'red' | 'yellow' | 'green' | 'purple';
  // Context window tracking per active agent session
  agentContextWindows: AgentContextWindow[];
  // Time-series history for charts
  history: {
    timestamps: number[];
    aipm: number[];
    tokens: number[];
    prompts: number[];
    toolCalls: number[];
    concurrency: number[];
  };
}

export interface AgentContextWindow {
  sessionId: string;
  platform: string;
  cumulativeTokens: number;    // total tokens consumed in this session
  estimatedLimit: number;      // model's context window size
  usagePercent: number;        // 0-100
  status: 'ok' | 'warning' | 'critical';  // <60% ok, 60-85% warning, >85% critical
}

const THRESHOLDS = {
  aipm: { red: 0, yellow: 100, green: 1500, purple: 6000 },
  concurrency: { red: 0, yellow: 1, green: 2, purple: 4 },
};

const ACTIVE_THRESHOLD_MS = 30_000;
const CURRENT_WINDOW_MS = 30_000;
const SESSION_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

export class LiveMetricsEngine {
  // [timestamp, tokens, sessionId]
  private tokenEvents: Array<[number, number, string]> = [];
  private sessionLastActivity = new Map<string, number>();
  private platformLastActivity = new Map<string, number>();
  private concurrencySamples: Array<[number, number]> = [];
  private sessionStart = Date.now();

  private totalTokens = 0;
  private totalPrompts = 0;
  private totalToolCalls = 0;
  private peakAipm = 0;
  private peakConcurrency = 0;
  private platformTokens = new Map<string, number>();
  private platformPrompts = new Map<string, number>();
  private platformToolCalls = new Map<string, number>();
  // Context window tracking: cumulative tokens per session
  private sessionCumulativeTokens = new Map<string, number>();
  private sessionPlatform = new Map<string, string>();

  // Time-series history
  private historyTimestamps: number[] = [];
  private historyAipm: number[] = [];
  private historyTokens: number[] = [];
  private historyPrompts: number[] = [];
  private historyToolCalls: number[] = [];
  private historyConcurrency: number[] = [];

  ingest(events: AIEvent[]): void {
    for (const event of events) {
      const ts = event.timestamp || Date.now();

      this.sessionLastActivity.set(event.sessionId, ts);
      this.platformLastActivity.set(event.platform, ts);

      switch (event.type) {
        case 'assistant':
          if (event.outputTokens > 0) {
            this.tokenEvents.push([ts, event.outputTokens, event.sessionId]);
            this.totalTokens += event.outputTokens;
            this.platformTokens.set(event.platform, (this.platformTokens.get(event.platform) || 0) + event.outputTokens);
            const prev = this.sessionCumulativeTokens.get(event.sessionId) || 0;
            this.sessionCumulativeTokens.set(event.sessionId, prev + event.outputTokens);
            this.sessionPlatform.set(event.sessionId, event.platform);
          }
          break;

        case 'user':
          this.totalPrompts++;
          this.platformPrompts.set(event.platform, (this.platformPrompts.get(event.platform) || 0) + 1);
          break;

        case 'tool_start':
        case 'tool_complete':
          this.totalToolCalls++;
          this.platformToolCalls.set(event.platform, (this.platformToolCalls.get(event.platform) || 0) + 1);
          break;

        case 'subagent_start':
          // Subagents create their own "session" for concurrency tracking
          this.sessionLastActivity.set(`${event.sessionId}:${event.agentName || 'sub'}`, ts);
          break;

        case 'subagent_complete':
          // Mark subagent session as done (remove from active)
          this.sessionLastActivity.delete(`${event.sessionId}:${event.agentName || 'sub'}`);
          break;
      }
    }
  }

  private expireSessions(): void {
    const now = Date.now();
    for (const [id, lastTs] of this.sessionLastActivity) {
      if (now - lastTs > SESSION_EXPIRY_MS) {
        this.sessionLastActivity.delete(id);
        this.sessionCumulativeTokens.delete(id);
        this.sessionPlatform.delete(id);
      }
    }
  }

  compute(): LiveMetrics {
    this.expireSessions();
    const now = Date.now();

    // Current AIPM: tokens in last CURRENT_WINDOW_MS, annualized to per-minute
    const windowStart = now - CURRENT_WINDOW_MS;
    const recentTokens = this.tokenEvents
      .filter(([ts]) => ts >= windowStart)
      .reduce((sum, [, tokens]) => sum + tokens, 0);
    const aipm = Math.round(recentTokens * (60_000 / CURRENT_WINDOW_MS));

    // Session average AIPM
    const elapsed = now - this.sessionStart;
    const sessionAipm = elapsed > 0
      ? Math.round(this.totalTokens * (60_000 / elapsed))
      : 0;

    // Concurrency: sessions active in last ACTIVE_THRESHOLD_MS
    const activeThreshold = now - ACTIVE_THRESHOLD_MS;
    let activeSessions = 0;
    for (const [, lastTs] of this.sessionLastActivity) {
      if (lastTs >= activeThreshold) { activeSessions++; }
    }
    const concurrency = activeSessions;

    // Track concurrency samples for average
    this.concurrencySamples.push([now, concurrency]);
    // Keep last 5 minutes of samples
    const fiveMinAgo = now - 300_000;
    this.concurrencySamples = this.concurrencySamples.filter(([ts]) => ts >= fiveMinAgo);

    const avgConcurrency = this.concurrencySamples.length > 0
      ? this.concurrencySamples.reduce((sum, [, c]) => sum + c, 0) / this.concurrencySamples.length
      : 0;

    // Per-agent efficiency
    const aipmPerAgent = concurrency > 0 ? Math.round(aipm / concurrency) : aipm;

    // Update peaks
    if (aipm > this.peakAipm) { this.peakAipm = aipm; }
    if (concurrency > this.peakConcurrency) { this.peakConcurrency = concurrency; }

    // Active platforms
    const activePlatforms: string[] = [];
    for (const [platform, lastTs] of this.platformLastActivity) {
      if (lastTs >= activeThreshold) { activePlatforms.push(platform); }
    }

    // Prune old token events (keep last 5 minutes)
    this.tokenEvents = this.tokenEvents.filter(([ts]) => ts >= fiveMinAgo);

    // Color based on overall AIPM
    const color = this.getColor('aipm', aipm);

    // Context window tracking per active session
    const agentContextWindows: AgentContextWindow[] = [];
    for (const [sessionId, lastTs] of this.sessionLastActivity) {
      if (lastTs >= activeThreshold) {
        const cumTokens = this.sessionCumulativeTokens.get(sessionId) || 0;
        const platform = this.sessionPlatform.get(sessionId) || 'unknown';
        // Estimate context limit based on platform/model
        // Output tokens are ~25% of total context usage (input is ~3x output)
        const estimatedTotalUsage = cumTokens * 4; // rough: output * 4 ≈ total context
        const limit = this.getContextLimit(platform);
        const usagePercent = Math.min(100, Math.round((estimatedTotalUsage / limit) * 100));
        
        agentContextWindows.push({
          sessionId: sessionId.length > 12 ? sessionId.slice(0, 8) + '...' : sessionId,
          platform,
          cumulativeTokens: cumTokens,
          estimatedLimit: limit,
          usagePercent,
          status: usagePercent > 85 ? 'critical' : usagePercent > 60 ? 'warning' : 'ok',
        });
      }
    }

    // Append to time-series history
    const MAX_HISTORY = 300;
    this.historyTimestamps.push(now);
    this.historyAipm.push(aipm);
    this.historyTokens.push(this.totalTokens);
    this.historyPrompts.push(this.totalPrompts);
    this.historyToolCalls.push(this.totalToolCalls);
    this.historyConcurrency.push(concurrency);
    if (this.historyTimestamps.length > MAX_HISTORY) {
      this.historyTimestamps = this.historyTimestamps.slice(-MAX_HISTORY);
      this.historyAipm = this.historyAipm.slice(-MAX_HISTORY);
      this.historyTokens = this.historyTokens.slice(-MAX_HISTORY);
      this.historyPrompts = this.historyPrompts.slice(-MAX_HISTORY);
      this.historyToolCalls = this.historyToolCalls.slice(-MAX_HISTORY);
      this.historyConcurrency = this.historyConcurrency.slice(-MAX_HISTORY);
    }

    return {
      aipm,
      sessionAipm,
      concurrency,
      avgConcurrency: Math.round(avgConcurrency * 10) / 10,
      aipmPerAgent,
      sessionTokens: this.totalTokens,
      sessionPrompts: this.totalPrompts,
      sessionToolCalls: this.totalToolCalls,
      peakAipm: this.peakAipm,
      peakConcurrency: this.peakConcurrency,
      sessionDuration: this.formatDuration(elapsed),
      activePlatforms,
      platformBreakdown: this.computePlatformBreakdown(),
      color,
      agentContextWindows,
      history: {
        timestamps: [...this.historyTimestamps],
        aipm: [...this.historyAipm],
        tokens: [...this.historyTokens],
        prompts: [...this.historyPrompts],
        toolCalls: [...this.historyToolCalls],
        concurrency: [...this.historyConcurrency],
      },
    };
  }

  private computePlatformBreakdown(): { platform: string; tokens: number; prompts: number; toolCalls: number }[] {
    const platforms = new Set([...this.platformTokens.keys(), ...this.platformPrompts.keys(), ...this.platformToolCalls.keys()]);
    return [...platforms].map(p => ({
      platform: p,
      tokens: this.platformTokens.get(p) || 0,
      prompts: this.platformPrompts.get(p) || 0,
      toolCalls: this.platformToolCalls.get(p) || 0,
    })).sort((a, b) => b.tokens - a.tokens);
  }

  reset(): void {
    this.tokenEvents = [];
    this.sessionLastActivity.clear();
    this.platformLastActivity.clear();
    this.concurrencySamples = [];
    this.sessionStart = Date.now();
    this.totalTokens = 0;
    this.totalPrompts = 0;
    this.totalToolCalls = 0;
    this.peakAipm = 0;
    this.peakConcurrency = 0;
    this.platformTokens.clear();
    this.platformPrompts.clear();
    this.platformToolCalls.clear();
    this.sessionCumulativeTokens.clear();
    this.sessionPlatform.clear();
    this.historyTimestamps = [];
    this.historyAipm = [];
    this.historyTokens = [];
    this.historyPrompts = [];
    this.historyToolCalls = [];
    this.historyConcurrency = [];
  }

  getColor(metric: string, value: number): 'red' | 'yellow' | 'green' | 'purple' {
    const t = THRESHOLDS[metric as keyof typeof THRESHOLDS];
    if (!t) { return 'red'; }
    if (value >= t.purple) { return 'purple'; }
    if (value >= t.green) { return 'green'; }
    if (value >= t.yellow) { return 'yellow'; }
    return 'red';
  }

  private formatDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) { return `${h}h ${m}m`; }
    if (m > 0) { return `${m}m ${s}s`; }
    return `${s}s`;
  }

  private getContextLimit(platform: string): number {
    // Estimated context window sizes per platform
    const limits: Record<string, number> = {
      copilot: 1_000_000,  // Claude Opus 4.6 1M via Copilot
      claude: 200_000,     // Claude direct
      cline: 200_000,      // Via Copilot LM API
      roo: 200_000,        // Via Copilot LM API
      cursor: 200_000,     // Varies by model
      windsurf: 200_000,
    };
    return limits[platform] || 200_000;
  }
}
