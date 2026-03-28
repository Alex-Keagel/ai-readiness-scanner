import * as https from 'https';
import { AITool } from '../scoring/types';
import { logger } from '../logging';

interface DocExample {
  url: string;
  description: string;
  level: number;
}

const PLATFORM_EXAMPLES: Record<string, DocExample[]> = {
  copilot: [
    {
      url: 'https://raw.githubusercontent.com/github/copilot-docs/main/.github/copilot-instructions.md',
      description: 'Official Copilot instructions example',
      level: 2,
    },
    {
      url: 'https://raw.githubusercontent.com/microsoft/vscode/main/.github/copilot-instructions.md',
      description: 'VS Code project Copilot instructions',
      level: 2,
    },
  ],
  cline: [
    {
      url: 'https://raw.githubusercontent.com/cline/cline/main/.clinerules',
      description: 'Official Cline rules example',
      level: 2,
    },
  ],
  cursor: [
    {
      url: 'https://raw.githubusercontent.com/pontusab/cursor.directory/main/.cursorrules',
      description: 'Cursor directory rules example',
      level: 2,
    },
  ],
  claude: [
    {
      url: 'https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/CLAUDE.md',
      description: 'Official Claude Code instructions',
      level: 2,
    },
  ],
  roo: [
    {
      url: 'https://raw.githubusercontent.com/RooVetGit/Roo-Code/main/.roorules',
      description: 'Official Roo Code rules',
      level: 2,
    },
  ],
  windsurf: [],
  aider: [
    {
      url: 'https://raw.githubusercontent.com/Aider-AI/aider/main/.aider.conf.yml',
      description: 'Official Aider config',
      level: 2,
    },
  ],
};

const exampleCache = new Map<string, { content: string; fetchedAt: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

export async function fetchPlatformExamples(tool: AITool, level?: number): Promise<string> {
  const examples = PLATFORM_EXAMPLES[tool] || [];
  const relevant = level ? examples.filter(e => e.level === level) : examples;

  if (relevant.length === 0) { return ''; }

  const fetched: string[] = [];

  for (const example of relevant.slice(0, 2)) {
    try {
      const content = await fetchWithCache(example.url);
      if (content && content.length > 50) {
        const truncated = content.length > 2000
          ? content.slice(0, 2000) + '\n...(truncated)'
          : content;
        fetched.push(`### Example: ${example.description}\nSource: ${example.url}\n\`\`\`\n${truncated}\n\`\`\``);
      }
    } catch (err) {
      logger.warn('Failed to fetch platform example', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (fetched.length === 0) { return ''; }

  return `\n\nREAL-WORLD EXAMPLES (use these as reference for format, structure, and tone — do NOT copy content, adapt to this project):\n${fetched.join('\n\n')}`;
}

async function fetchWithCache(url: string): Promise<string | null> {
  const cached = exampleCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.content;
  }

  try {
    const content = await fetchRaw(url);
    if (content) {
      exampleCache.set(url, { content, fetchedAt: Date.now() });
    }
    return content;
  } catch (err) {
    logger.warn('Failed to fetch URL for cache', { error: err instanceof Error ? err.message : String(err) });
    return cached?.content || null;
  }
}

function fetchRaw(url: string, redirects = 0): Promise<string | null> {
  if (redirects > 5) { return Promise.resolve(null); }
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchRaw(res.headers.location, redirects + 1).then(resolve);
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
