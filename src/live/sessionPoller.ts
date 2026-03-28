import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../logging';

export interface AIEvent {
  type: 'user' | 'assistant' | 'tool_start' | 'tool_complete' | 'subagent_start' | 'subagent_complete';
  timestamp: number;
  sessionId: string;
  platform: string;
  outputTokens: number;
  contentChars: number;
  toolName?: string;
  agentName?: string;
  model?: string;
}

interface SessionFile {
  path: string;
  lastSize: number;
  platform: string;
  sessionId: string;
}

interface ClineMessage {
  role: string;
  content: unknown;
  modelInfo?: {
    modelId?: string;
    providerId?: string;
    mode?: string;
  };
  metrics?: {
    tokens?: {
      prompt?: number;
      completion?: number;
      cached?: number;
    };
    cost?: number;
  };
}

interface RooHistoryItem {
  id?: string;
  task?: string;
  tokensIn?: number;
  tokensOut?: number;
  totalCost?: number;
  workspace?: string;
  mode?: string;
  ts?: number;
}

export class SessionPoller {
  private sessions = new Map<string, SessionFile>();
  private pollInterval: ReturnType<typeof setInterval> | undefined;
  private claudeRequestTokens = new Map<string, number>(); // requestId → last seen output_tokens
  private clineMessageCounts = new Map<string, number>(); // filePath → last processed message index
  private rooLastTokens = new Map<string, number>(); // filePath → last seen tokensOut
  private platformFilter: string;
  private pollCount = 0;

  constructor(selectedTool: string) {
    this.platformFilter = selectedTool;
  }

  async poll(): Promise<AIEvent[]> {
    this.pollCount++;
    if (this.pollCount % 100 === 0) {
      this.purgeStaleSessions();
    }
    const events: AIEvent[] = [];
    const filter = this.platformFilter;
    if (filter === 'copilot' || filter === 'all') {
      events.push(...await this.pollCopilotCLI());
    }
    if (filter === 'claude' || filter === 'all') {
      events.push(...await this.pollClaudeCode());
    }
    if (filter === 'cline' || filter === 'all') {
      events.push(...await this.pollCline());
    }
    if (filter === 'roo' || filter === 'all') {
      events.push(...await this.pollRooCode());
    }
    return events;
  }

  private async pollCopilotCLI(): Promise<AIEvent[]> {
    const copilotDir = path.join(os.homedir(), '.copilot', 'session-state');
    if (!fs.existsSync(copilotDir)) { return []; }

    const events: AIEvent[] = [];

    try {
      const sessionDirs = fs.readdirSync(copilotDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const dir of sessionDirs) {
        const eventsFile = path.join(copilotDir, dir.name, 'events.jsonl');
        if (!fs.existsSync(eventsFile)) { continue; }

        const key = `copilot:${dir.name}`;
        const newLines = this.readNewLines(key, eventsFile, 'copilot', dir.name);
        for (const line of newLines) {
          const parsed = this.parseCopilotEvent(line, dir.name);
          if (parsed) { events.push(parsed); }
        }
      }
    } catch (err) {
      logger.warn('Failed to read Copilot CLI session directory', { error: err instanceof Error ? err.message : String(err) });
    }

    return events;
  }

  private parseCopilotEvent(line: string, sessionId: string): AIEvent | null {
    try {
      const raw = JSON.parse(line);
      const ts = raw.timestamp ? new Date(raw.timestamp).getTime() : Date.now();
      const data = raw.data || {};

      switch (raw.type) {
        case 'assistant.message':
          return {
            type: 'assistant',
            timestamp: ts,
            sessionId,
            platform: 'copilot',
            outputTokens: data.outputTokens || 0,
            contentChars: typeof data.content === 'string' ? data.content.length : 0,
            model: data.model,
          };

        case 'user.message':
          return {
            type: 'user',
            timestamp: ts,
            sessionId,
            platform: 'copilot',
            outputTokens: 0,
            contentChars: typeof data.content === 'string' ? data.content.length : 0,
          };

        case 'tool.execution_start':
          return {
            type: 'tool_start',
            timestamp: ts,
            sessionId,
            platform: 'copilot',
            outputTokens: 0,
            contentChars: 0,
            toolName: data.toolName || this.extractToolName(data),
          };

        case 'tool.execution_complete':
          return {
            type: 'tool_complete',
            timestamp: ts,
            sessionId,
            platform: 'copilot',
            outputTokens: 0,
            contentChars: 0,
            toolName: data.toolName || this.extractToolName(data),
          };

        case 'subagent.started':
          return {
            type: 'subagent_start',
            timestamp: ts,
            sessionId,
            platform: 'copilot',
            outputTokens: 0,
            contentChars: 0,
            agentName: data.agentName,
          };

        case 'subagent.completed':
          return {
            type: 'subagent_complete',
            timestamp: ts,
            sessionId,
            platform: 'copilot',
            outputTokens: data.outputTokens || 0,
            contentChars: 0,
            agentName: data.agentName,
          };

        default:
          return null;
      }
    } catch (err) {
      logger.debug('Failed to parse Copilot event line', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private extractToolName(data: Record<string, unknown>): string | undefined {
    if (typeof data.toolCallId === 'string') {
      const match = data.toolCallId.match(/^([a-zA-Z_-]+)/);
      if (match) { return match[1]; }
    }
    return undefined;
  }

  private async pollClaudeCode(): Promise<AIEvent[]> {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(claudeDir)) { return []; }

    const events: AIEvent[] = [];

    try {
      const jsonlFiles = this.findJsonlFiles(claudeDir);
      for (const filePath of jsonlFiles) {
        const sessionId = path.basename(path.dirname(filePath));
        const key = `claude:${filePath}`;
        const newLines = this.readNewLines(key, filePath, 'claude', sessionId);
        for (const line of newLines) {
          const parsed = this.parseClaudeEvent(line, sessionId);
          if (parsed) { events.push(parsed); }
        }
      }
    } catch (err) {
      logger.warn('Failed to read Claude Code session directory', { error: err instanceof Error ? err.message : String(err) });
    }

    return events;
  }

  private parseClaudeEvent(line: string, sessionId: string): AIEvent | null {
    try {
      const raw = JSON.parse(line);

      if (raw.type === 'assistant') {
        const usage = raw.message?.usage;
        const outputTokens = usage?.output_tokens || 0;
        const requestId = raw.requestId;

        // Deduplicate cumulative tokens: Claude reports cumulative per requestId
        if (requestId && outputTokens > 0) {
          const prevTokens = this.claudeRequestTokens.get(requestId) || 0;
          if (outputTokens <= prevTokens) { return null; } // Already counted
          const delta = outputTokens - prevTokens;
          this.claudeRequestTokens.set(requestId, outputTokens);

          return {
            type: 'assistant',
            timestamp: raw.timestamp ? new Date(raw.timestamp).getTime() : Date.now(),
            sessionId,
            platform: 'claude',
            outputTokens: delta,
            contentChars: this.extractClaudeContentLength(raw),
            model: raw.message?.model,
          };
        }

        if (outputTokens > 0) {
          return {
            type: 'assistant',
            timestamp: raw.timestamp ? new Date(raw.timestamp).getTime() : Date.now(),
            sessionId,
            platform: 'claude',
            outputTokens,
            contentChars: this.extractClaudeContentLength(raw),
            model: raw.message?.model,
          };
        }
      }

      if (raw.type === 'human') {
        return {
          type: 'user',
          timestamp: raw.timestamp ? new Date(raw.timestamp).getTime() : Date.now(),
          sessionId,
          platform: 'claude',
          outputTokens: 0,
          contentChars: 0,
        };
      }

      return null;
    } catch (err) {
      logger.debug('Failed to parse Claude event line', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private extractClaudeContentLength(raw: Record<string, unknown>): number {
    const message = raw.message as Record<string, unknown> | undefined;
    if (!message) { return 0; }
    const content = message.content;
    if (typeof content === 'string') { return content.length; }
    if (Array.isArray(content)) {
      return content.reduce((sum: number, block: unknown) => {
        if (typeof block === 'object' && block !== null && 'text' in block) {
          return sum + String((block as { text: string }).text).length;
        }
        return sum;
      }, 0);
    }
    return 0;
  }

  private findJsonlFiles(dir: string, depth = 0): string[] {
    if (depth > 3) { return []; }
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          results.push(fullPath);
        } else if (entry.isDirectory() && depth < 3) {
          results.push(...this.findJsonlFiles(fullPath, depth + 1));
        }
      }
    } catch (err) {
      logger.warn('Failed to read directory while scanning for JSONL files', { error: err instanceof Error ? err.message : String(err) });
    }
    return results;
  }

  private getGlobalStoragePaths(extensionId: string): string[] {
    const home = os.homedir();
    const platform = os.platform();
    const editors = ['Code', 'Code - Insiders'];
    const paths: string[] = [];

    for (const editor of editors) {
      if (platform === 'darwin') {
        paths.push(path.join(home, 'Library', 'Application Support', editor, 'User', 'globalStorage', extensionId, 'tasks'));
      } else if (platform === 'win32') {
        paths.push(path.join(home, 'AppData', 'Roaming', editor, 'User', 'globalStorage', extensionId, 'tasks'));
      } else {
        paths.push(path.join(home, '.config', editor, 'User', 'globalStorage', extensionId, 'tasks'));
      }
    }

    return paths;
  }

  private async pollCline(): Promise<AIEvent[]> {
    const events: AIEvent[] = [];
    const basePaths = this.getGlobalStoragePaths('saoudrizwan.claude-dev');

    for (const basePath of basePaths) {
      if (!fs.existsSync(basePath)) { continue; }

      try {
        const taskDirs = fs.readdirSync(basePath)
          .filter(d => {
            try { return fs.statSync(path.join(basePath, d)).isDirectory(); } catch (err) { logger.warn('Failed to stat Cline task directory', { error: err instanceof Error ? err.message : String(err) }); return false; }
          })
          .sort((a, b) => Number(b) - Number(a))
          .slice(0, 5);

        for (const taskDir of taskDirs) {
          const historyFile = path.join(basePath, taskDir, 'api_conversation_history.json');
          if (!fs.existsSync(historyFile)) { continue; }

          const key = `cline:${historyFile}`;

          // Check if file has changed via size
          let stat: fs.Stats;
          try { stat = fs.statSync(historyFile); } catch (err) { logger.warn('Failed to stat Cline history file', { error: err instanceof Error ? err.message : String(err) }); continue; }

          let session = this.sessions.get(key);
          if (!session) {
            session = { path: historyFile, lastSize: 0, platform: 'cline', sessionId: taskDir };
            this.sessions.set(key, session);
          }

          if (stat.size === session.lastSize) { continue; }
          session.lastSize = stat.size;

          try {
            const raw = fs.readFileSync(historyFile, 'utf-8');
            const messages: ClineMessage[] = JSON.parse(raw);
            if (!Array.isArray(messages)) { continue; }

            const lastIndex = this.clineMessageCounts.get(key) || 0;
            const newMessages = messages.slice(lastIndex);
            this.clineMessageCounts.set(key, messages.length);

            for (const msg of newMessages) {
              if (msg.role === 'assistant' && msg.metrics?.tokens?.completion && msg.metrics.tokens.completion > 0) {
                events.push({
                  type: 'assistant',
                  timestamp: Number(taskDir) || Date.now(),
                  sessionId: taskDir,
                  platform: 'cline',
                  outputTokens: msg.metrics.tokens.completion,
                  contentChars: this.extractClineContentLength(msg.content),
                  model: msg.modelInfo?.modelId,
                });
              } else if (msg.role === 'user') {
                events.push({
                  type: 'user',
                  timestamp: Number(taskDir) || Date.now(),
                  sessionId: taskDir,
                  platform: 'cline',
                  outputTokens: 0,
                  contentChars: this.extractClineContentLength(msg.content),
                });
              }
            }
          } catch (err) {
            logger.warn('Failed to parse Cline conversation history', { error: err instanceof Error ? err.message : String(err) });
          }
        }
      } catch (err) {
        logger.warn('Failed to read Cline task directory', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    return events;
  }

  private extractClineContentLength(content: unknown): number {
    if (typeof content === 'string') { return content.length; }
    if (Array.isArray(content)) {
      return content.reduce((sum: number, block: unknown) => {
        if (typeof block === 'object' && block !== null && 'text' in block) {
          return sum + String((block as { text: string }).text).length;
        }
        return sum;
      }, 0);
    }
    return 0;
  }

  private async pollRooCode(): Promise<AIEvent[]> {
    const events: AIEvent[] = [];
    const basePaths = [
      ...this.getGlobalStoragePaths('rooveterinaryinc.roo-cline'),
      ...this.getGlobalStoragePaths('microsoftai.ms-roo-cline'),
    ];

    for (const basePath of basePaths) {
      if (!fs.existsSync(basePath)) { continue; }

      try {
        const taskDirs = fs.readdirSync(basePath)
          .filter(d => {
            try { return fs.statSync(path.join(basePath, d)).isDirectory(); } catch (err) { logger.warn('Failed to stat Roo Code task directory', { error: err instanceof Error ? err.message : String(err) }); return false; }
          })
          .slice(0, 10);

        for (const taskDir of taskDirs) {
          const historyFile = path.join(basePath, taskDir, 'history_item.json');
          if (!fs.existsSync(historyFile)) { continue; }

          const key = `roo:${historyFile}`;

          let stat: fs.Stats;
          try { stat = fs.statSync(historyFile); } catch (err) { logger.warn('Failed to stat Roo Code history file', { error: err instanceof Error ? err.message : String(err) }); continue; }

          // Track via file size to detect changes
          let session = this.sessions.get(key);
          if (!session) {
            session = { path: historyFile, lastSize: 0, platform: 'roo', sessionId: taskDir };
            this.sessions.set(key, session);
          }

          if (stat.size === session.lastSize) { continue; }
          session.lastSize = stat.size;

          try {
            const raw = fs.readFileSync(historyFile, 'utf-8');
            const item: RooHistoryItem = JSON.parse(raw);

            const tokensOut = item.tokensOut || 0;
            if (tokensOut <= 0) { continue; }

            const prevTokens = this.rooLastTokens.get(key) || 0;
            if (tokensOut <= prevTokens) { continue; }
            const delta = tokensOut - prevTokens;
            this.rooLastTokens.set(key, tokensOut);

            events.push({
              type: 'assistant',
              timestamp: item.ts || Date.now(),
              sessionId: taskDir,
              platform: 'roo',
              outputTokens: delta,
              contentChars: 0,
              model: item.mode ? `roo/${item.mode}` : undefined,
            });
          } catch (err) {
            logger.warn('Failed to parse Roo Code history item', { error: err instanceof Error ? err.message : String(err) });
          }
        }
      } catch (err) {
        logger.warn('Failed to read Roo Code task directory', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    return events;
  }

  private readNewLines(key: string, filePath: string, platform: string, sessionId: string): string[] {
    let session = this.sessions.get(key);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      logger.warn('Failed to stat session file', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }

    if (!session) {
      session = { path: filePath, lastSize: 0, platform, sessionId };
      this.sessions.set(key, session);
    }

    if (stat.size <= session.lastSize) { return []; }

    try {
      const fd = fs.openSync(filePath, 'r');
      const bufSize = stat.size - session.lastSize;
      const buf = Buffer.alloc(bufSize);
      fs.readSync(fd, buf, 0, bufSize, session.lastSize);
      fs.closeSync(fd);
      session.lastSize = stat.size;

      return buf.toString('utf-8')
        .split('\n')
        .filter(line => line.trim().length > 0);
    } catch (err) {
      logger.warn('Failed to read new lines from session file', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  startPolling(intervalMs: number = 2000, callback: (events: AIEvent[]) => void): void {
    this.pollInterval = setInterval(async () => {
      try {
        const events = await this.poll();
        if (events.length > 0) { callback(events); }
      } catch (err) {
        logger.warn('Error during session polling cycle', { error: err instanceof Error ? err.message : String(err) });
      }
    }, intervalMs);
  }

  private purgeStaleSessions(): void {
    const staleThreshold = Date.now() - 24 * 60 * 60 * 1000; // 24 hours
    for (const [key, session] of this.sessions) {
      try {
        const stat = fs.statSync(session.path);
        if (stat.mtimeMs < staleThreshold) {
          this.sessions.delete(key);
        }
      } catch (err) {
        logger.warn('Failed to stat session file during purge, removing entry', { error: err instanceof Error ? err.message : String(err) });
        this.sessions.delete(key);
      }
    }
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
  }

  /**
   * Load recent events from the most recent session files (for initial dashboard display).
   * Returns up to `maxEvents` parsed events from the most recent session.
   */
  async loadRecent(maxEvents: number = 500): Promise<AIEvent[]> {
    const events: AIEvent[] = [];
    const filter = this.platformFilter;

    if (filter === 'copilot' || filter === 'all') {
      const copilotDir = path.join(os.homedir(), '.copilot', 'session-state');
      if (fs.existsSync(copilotDir)) {
      try {
        // Find session dirs with events.jsonl, sorted by modification time (newest first)
        const sessionDirs = fs.readdirSync(copilotDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => {
            const eventsFile = path.join(copilotDir, d.name, 'events.jsonl');
            try {
              const stat = fs.statSync(eventsFile);
              return { name: d.name, path: eventsFile, mtime: stat.mtimeMs, size: stat.size };
            } catch { return null; }
          })
          .filter((d): d is NonNullable<typeof d> => d !== null)
          .sort((a, b) => b.mtime - a.mtime);

        // Read from most recent sessions until we have enough events
        for (const session of sessionDirs.slice(0, 3)) {
          try {
            // Read last ~100KB of the file to get recent events
            const readSize = Math.min(session.size, 100_000);
            const fd = fs.openSync(session.path, 'r');
            const buf = Buffer.alloc(readSize);
            fs.readSync(fd, buf, 0, readSize, Math.max(0, session.size - readSize));
            fs.closeSync(fd);

            const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
            // Skip first line if we started mid-line
            const startIdx = session.size > readSize ? 1 : 0;
            for (const line of lines.slice(startIdx).slice(-maxEvents)) {
              const parsed = this.parseCopilotEvent(line, session.name);
              if (parsed) { events.push(parsed); }
            }
          } catch (err) { logger.warn('Failed to read recent Copilot session events', { error: err instanceof Error ? err.message : String(err) }); }
          if (events.length >= maxEvents) { break; }
        }
      } catch (err) { logger.warn('Failed to scan Copilot session directories for recent events', { error: err instanceof Error ? err.message : String(err) }); }
      }
    }

    return events.slice(-maxEvents);
  }

  async skipExisting(): Promise<void> {
    const filter = this.platformFilter;

    // Discover all files and set lastSize to current file size
    if (filter === 'copilot' || filter === 'all') {
    const copilotDir = path.join(os.homedir(), '.copilot', 'session-state');
    if (fs.existsSync(copilotDir)) {
      try {
        const sessionDirs = fs.readdirSync(copilotDir, { withFileTypes: true })
          .filter(d => d.isDirectory());
        for (const dir of sessionDirs) {
          const eventsFile = path.join(copilotDir, dir.name, 'events.jsonl');
          if (!fs.existsSync(eventsFile)) { continue; }
          const key = `copilot:${dir.name}`;
          const stat = fs.statSync(eventsFile);
          this.sessions.set(key, {
            path: eventsFile,
            lastSize: stat.size,
            platform: 'copilot',
            sessionId: dir.name,
          });
        }
      } catch (err) { logger.warn('Failed to skip existing Copilot sessions', { error: err instanceof Error ? err.message : String(err) }); }
    }
    }

    if (filter === 'claude' || filter === 'all') {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    if (fs.existsSync(claudeDir)) {
      try {
        const jsonlFiles = this.findJsonlFiles(claudeDir);
        for (const filePath of jsonlFiles) {
          const sessionId = path.basename(path.dirname(filePath));
          const key = `claude:${filePath}`;
          const stat = fs.statSync(filePath);
          this.sessions.set(key, {
            path: filePath,
            lastSize: stat.size,
            platform: 'claude',
            sessionId,
          });
        }
      } catch (err) { logger.warn('Failed to skip existing Claude sessions', { error: err instanceof Error ? err.message : String(err) }); }
    }
    }

    // Skip existing Cline tasks
    if (filter === 'cline' || filter === 'all') {
    const clinePaths = this.getGlobalStoragePaths('saoudrizwan.claude-dev');
    for (const basePath of clinePaths) {
      if (!fs.existsSync(basePath)) { continue; }
      try {
        const taskDirs = fs.readdirSync(basePath)
          .filter(d => { try { return fs.statSync(path.join(basePath, d)).isDirectory(); } catch (err) { logger.warn('Failed to stat Cline task directory during skip', { error: err instanceof Error ? err.message : String(err) }); return false; } })
          .sort((a, b) => Number(b) - Number(a))
          .slice(0, 5);
        for (const taskDir of taskDirs) {
          const historyFile = path.join(basePath, taskDir, 'api_conversation_history.json');
          if (!fs.existsSync(historyFile)) { continue; }
          const key = `cline:${historyFile}`;
          const stat = fs.statSync(historyFile);
          this.sessions.set(key, { path: historyFile, lastSize: stat.size, platform: 'cline', sessionId: taskDir });
          try {
            const raw = fs.readFileSync(historyFile, 'utf-8');
            const messages = JSON.parse(raw);
            if (Array.isArray(messages)) {
              this.clineMessageCounts.set(key, messages.length);
            }
          } catch (err) { logger.warn('Failed to parse Cline conversation history during skip', { error: err instanceof Error ? err.message : String(err) }); }
        }
      } catch (err) { logger.warn('Failed to read Cline task directories during skip', { error: err instanceof Error ? err.message : String(err) }); }
    }
    }

    // Skip existing Roo Code tasks
    if (filter === 'roo' || filter === 'all') {
    const rooPaths = [
      ...this.getGlobalStoragePaths('rooveterinaryinc.roo-cline'),
      ...this.getGlobalStoragePaths('microsoftai.ms-roo-cline'),
    ];
    for (const basePath of rooPaths) {
      if (!fs.existsSync(basePath)) { continue; }
      try {
        const taskDirs = fs.readdirSync(basePath)
          .filter(d => { try { return fs.statSync(path.join(basePath, d)).isDirectory(); } catch (err) { logger.warn('Failed to stat Roo Code task directory during skip', { error: err instanceof Error ? err.message : String(err) }); return false; } })
          .slice(0, 10);
        for (const taskDir of taskDirs) {
          const historyFile = path.join(basePath, taskDir, 'history_item.json');
          if (!fs.existsSync(historyFile)) { continue; }
          const key = `roo:${historyFile}`;
          const stat = fs.statSync(historyFile);
          this.sessions.set(key, { path: historyFile, lastSize: stat.size, platform: 'roo', sessionId: taskDir });
          try {
            const raw = fs.readFileSync(historyFile, 'utf-8');
            const item: RooHistoryItem = JSON.parse(raw);
            if (item.tokensOut && item.tokensOut > 0) {
              this.rooLastTokens.set(key, item.tokensOut);
            }
          } catch (err) { logger.warn('Failed to parse Roo Code history item during skip', { error: err instanceof Error ? err.message : String(err) }); }
        }
      } catch (err) { logger.warn('Failed to read Roo Code task directories during skip', { error: err instanceof Error ? err.message : String(err) }); }
    }
    }
  }
}
