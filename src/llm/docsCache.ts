import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { AITool, AI_TOOLS, DocUrls, ReasoningContext } from '../scoring/types';
import { logger } from '../logging';

interface CachedDoc {
  content: string;
  fetchedAt: number;
  url: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DOCS_CACHE_KEY = 'docsCache';

export class DocsCache {
  private cache = new Map<string, CachedDoc>();

  constructor(private context: vscode.ExtensionContext) {
    const saved = context.workspaceState.get<Record<string, CachedDoc>>(DOCS_CACHE_KEY);
    if (saved) {
      for (const [key, val] of Object.entries(saved)) {
        this.cache.set(key, val);
      }
    }
  }

  async getToolDocs(tool: AITool): Promise<string> {
    const config = AI_TOOLS[tool];
    if (!config?.docUrls?.main) {
      return config?.reasoningContext ? this.formatFallback(config.reasoningContext) : '';
    }

    const urls = config.docUrls;
    const docs: string[] = [];

    // Only fetch raw GitHub URLs (raw.githubusercontent.com) — regular doc sites are JS-rendered and unusable
    const rawExampleUrls = (urls.rawExamples || []).slice(0, 3);

    if (rawExampleUrls.length > 0) {
      const allFetches = await Promise.all(
        rawExampleUrls.map(async (rawUrl) => {
          const content = await this.fetchWithCache(rawUrl);
          return content && content.length > 50 ? { url: rawUrl, content } : null;
        })
      );

      const examples = allFetches
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .map(r => {
          const truncated = r.content.length > 3000 ? r.content.slice(0, 3000) + '\n...(truncated)' : r.content;
          return `### Real-world example\nSource: ${r.url}\n\`\`\`\n${truncated}\n\`\`\``;
        });
      if (examples.length > 0) {
        docs.push(`## Official Examples (from GitHub)\n${examples.join('\n\n')}`);
      }
    }

    // Always include static reasoning context (reliable, no network needed)
    if (config?.reasoningContext) {
      docs.push(this.formatFallback(config.reasoningContext));
    }

    if (docs.length === 0) {
      return config?.reasoningContext ? this.formatFallback(config.reasoningContext) : '';
    }

    return docs.join('\n\n---\n\n');
  }

  async fetchWithCache(url: string): Promise<string | null> {
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      logger.debug(`Docs cache hit: ${url}`);
      return cached.content;
    }

    // Try up to 2 attempts
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        logger.debug(`Fetching docs: ${url}${attempt > 0 ? ' (retry)' : ''}`);
        const content = await this.fetchUrl(url);
        if (content) {
          const cleaned = this.htmlToText(content);
          const truncated = cleaned.length > 3000
            ? cleaned.slice(0, 3000) + '\n...(truncated)'
            : cleaned;

          const entry: CachedDoc = { content: truncated, fetchedAt: Date.now(), url };
          this.cache.set(url, entry);
          await this.persistCache();

          return truncated;
        }
      } catch (err) {
        if (attempt === 1) {
          logger.warn('Failed to fetch docs after retry', { url, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    // Return stale cache if available
    if (cached) { return cached.content; }
    return null;
  }

  private async persistCache(): Promise<void> {
    const cacheObj: Record<string, CachedDoc> = {};
    for (const [k, v] of this.cache) { cacheObj[k] = v; }
    await this.context.workspaceState.update(DOCS_CACHE_KEY, cacheObj);
  }

  private fetchUrl(url: string, redirectCount = 0): Promise<string | null> {
    if (redirectCount > 5) { return Promise.resolve(null); }
    return new Promise((resolve) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { timeout: 10000 }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.fetchUrl(res.headers.location, redirectCount + 1).then(resolve);
          return;
        }
        if (res.statusCode !== 200) { resolve(null); return; }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  private htmlToText(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim();
  }

  private formatFallback(rc: ReasoningContext): string {
    return `## Structure Expectations (cached)\n${rc.structureExpectations}\n\n## Quality Markers\n${rc.qualityMarkers}\n\n## Anti-Patterns\n${rc.antiPatterns}`;
  }

  getDocUrls(tool: AITool): DocUrls {
    return AI_TOOLS[tool]?.docUrls || { main: '', rules: '' };
  }
}
