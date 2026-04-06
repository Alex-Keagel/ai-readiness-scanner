import * as http from 'http';
import * as https from 'https';
import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';
import { getPlatformExpertPrompt } from '../remediation/fixPrompts';
import { AITool,AI_TOOLS } from '../scoring/types';

export interface PlatformGuide {
  platform: string;
  platformName: string;
  generatedAt: string;
  fileHierarchy: {
    path: string;
    level: number;
    required: boolean;
    description: string;
    maxSize: string;
    format: string;
    contentGuidelines: string;
  }[];
  qualityCriteria: {
    criterion: string;
    weight: number;
    description: string;
    goodExample: string;
    badExample: string;
  }[];
  antiPatterns: {
    pattern: string;
    severity: 'critical' | 'warning';
    description: string;
    fix: string;
  }[];
  bestPractices: string[];
  sources: { url: string; fetchedAt: string }[];
}

export class GuideGenerator {
  constructor(private copilotClient: CopilotClient) {}

  async generateGuide(tool: AITool): Promise<PlatformGuide> {
    const config = AI_TOOLS[tool];
    if (!config) throw new Error(`Unknown tool: ${tool}`);

    logger.info(`Guide generator: generating guide for ${config.name}...`);
    const timer = logger.time(`Guide generation: ${config.name}`);

    // 1. Fetch source content
    const sources: { url: string; content: string; fetchedAt: string }[] = [];
    const guideUrls = config.docUrls?.guideSources || [];
    const rawExampleUrls = config.docUrls?.rawExamples || [];
    const allUrls = [...guideUrls, ...rawExampleUrls].slice(0, 4);

    if (allUrls.length > 0) {
      const fetchResults = await Promise.all(
        allUrls.map(async url => {
          try {
            const content = await this.fetchUrl(url);
            if (content && content.length > 50) {
              return { url, content: content.slice(0, 5000), fetchedAt: new Date().toISOString() };
            }
          } catch { /* skip */ }
          return null;
        })
      );
      sources.push(...fetchResults.filter((r): r is NonNullable<typeof r> => r !== null));
    }

    logger.info(`Guide generator: fetched ${sources.length} sources for ${config.name}`);

    // 2. Build expert prompt
    const expertPrompt = getPlatformExpertPrompt(tool);
    const sourceBlock = sources.length > 0
      ? sources.map(s => `### Source: ${s.url}\n\`\`\`\n${s.content}\n\`\`\``).join('\n\n')
      : 'No external sources available — use your built-in knowledge.';

    const prompt = `${expertPrompt}

Based on your deep expertise with **${config.name}** and the reference sources below, generate a COMPREHENSIVE platform guide.

REFERENCE SOURCES:
${sourceBlock}

STATIC KNOWLEDGE (may be outdated — prefer your latest knowledge):
- Instruction format: ${config.reasoningContext?.instructionFormat || 'N/A'}
- Structure: ${config.reasoningContext?.structureExpectations || 'N/A'}
- Quality: ${config.reasoningContext?.qualityMarkers || 'N/A'}
- Anti-patterns: ${config.reasoningContext?.antiPatterns || 'N/A'}

Generate a COMPLETE platform guide as JSON with this EXACT structure:
{
  "fileHierarchy": [
    {"path": ".github/copilot-instructions.md", "level": 2, "required": true, "description": "Root instructions loaded on every interaction", "maxSize": "100 lines", "format": "Markdown with bullet-point rules", "contentGuidelines": "Project overview, coding conventions, tech stack, file structure. No essays — every line is actionable."}
  ],
  "qualityCriteria": [
    {"criterion": "Specificity", "weight": 30, "description": "References actual project paths, commands, and tools", "goodExample": "Use pytest for testing: pytest tests/ -v", "badExample": "Run the tests using your preferred framework"}
  ],
  "antiPatterns": [
    {"pattern": "Essay-style instructions", "severity": "critical", "description": "Long paragraphs instead of bullet rules waste context tokens", "fix": "Rewrite as numbered bullet points, max 1 sentence each"}
  ],
  "bestPractices": [
    "Keep root instructions under 100 lines — they load on every interaction",
    "Use path-scoped instructions for domain-specific rules"
  ]
}

Include AT LEAST:
- 8-15 files in fileHierarchy (cover L2 through L5)
- 5-8 quality criteria
- 4-6 anti-patterns
- 5-10 best practices

Respond with ONLY the JSON object — no markdown fences, no explanation.`;

    // 3. Call LLM
    try {
      if (!this.copilotClient.isAvailable()) {
        await this.copilotClient.initialize();
      }
      const response = await this.copilotClient.analyze(prompt, undefined, 120_000);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        timer?.end?.();
        logger.info(`Guide generator: ${config.name} guide generated — ${parsed.fileHierarchy?.length || 0} files, ${parsed.qualityCriteria?.length || 0} criteria`);

        return {
          platform: tool,
          platformName: config.name,
          generatedAt: new Date().toISOString(),
          fileHierarchy: parsed.fileHierarchy || [],
          qualityCriteria: parsed.qualityCriteria || [],
          antiPatterns: parsed.antiPatterns || [],
          bestPractices: parsed.bestPractices || [],
          sources: sources.map(s => ({ url: s.url, fetchedAt: s.fetchedAt })),
        };
      }
    } catch (err) {
      logger.error(`Guide generator: failed for ${config.name}`, err);
    }

    timer?.end?.();
    // Fallback: empty guide
    return {
      platform: tool,
      platformName: config.name,
      generatedAt: new Date().toISOString(),
      fileHierarchy: [],
      qualityCriteria: [],
      antiPatterns: [],
      bestPractices: [],
      sources: [],
    };
  }

  private fetchUrl(url: string): Promise<string | null> {
    return new Promise((resolve) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { timeout: 10000, headers: { 'User-Agent': 'VSCode-AI-Readiness/2.0' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.fetchUrl(res.headers.location).then(resolve);
          return;
        }
        if (res.statusCode !== 200) { resolve(null); return; }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          let text = Buffer.concat(chunks).toString('utf-8');
          // Strip HTML tags if it's an HTML page
          if (text.includes('<html') || text.includes('<!DOCTYPE')) {
            text = text
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<nav[\s\S]*?<\/nav>/gi, '')
              .replace(/<header[\s\S]*?<\/header>/gi, '')
              .replace(/<footer[\s\S]*?<\/footer>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
          }
          resolve(text);
        });
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }
}
