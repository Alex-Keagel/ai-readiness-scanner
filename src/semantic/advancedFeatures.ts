/**
 * Advanced Semantic Features:
 * 1. HyDE — Hypothetical Document Embeddings (search intent matching)
 * 2. Hierarchical Roll-Up Summarization (directory → module → architecture)
 * 3. Semantic Edge Labeling (call graph intent)
 * 4. Blast Radius Analysis (downstream impact prediction)
 * 5. Multi-Agent Code Auditing (Component Health Cards)
 * 6. Semantic Dead Code (feature-flagged/unreachable paths)
 */

import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';
import type { CallGraphEdge } from './callGraph';

// ─── Types ────────────────────────────────────────────────────────

export interface HyDEResult {
  path: string;
  queries: string[];
}

export interface RollUpSummary {
  directory: string;
  summary: string;
  childSummaries: string[];
  depth: number;
}

export interface LabeledEdge {
  from: string;
  to: string;
  intent: string;
  confidence: number;
}

export interface BlastRadiusResult {
  changedFile: string;
  affectedModules: BlastRadiusImpact[];
  totalAffected: number;
  maxDepth: number;
}

export interface BlastRadiusImpact {
  path: string;
  depth: number;
  relationship: string;  // how it's connected
  warning: string;       // LLM-generated impact warning
  confidence: number;
}

export interface ComponentHealthCard {
  componentPath: string;
  componentName: string;
  purpose: string;
  risks: string[];
  codeSmells: string[];
  suggestions: string[];
  overallHealth: 'healthy' | 'needs-attention' | 'at-risk';
}

export interface DeadBranch {
  path: string;
  condition: string;       // the branching condition
  configSource: string;    // which config file controls this
  confidence: number;
  reason: string;
}

// ─── 1. HyDE — Hypothetical Document Embeddings ──────────────────

/**
 * Generate hypothetical search queries for each important code module.
 * Developers search for solutions, not function names.
 */
export async function generateHyDEQueries(
  client: CopilotClient,
  modules: { path: string; summary: string; exports: string[]; role: string }[],
): Promise<HyDEResult[]> {
  const timer = logger.time('HyDE: generating hypothetical queries');
  const results: HyDEResult[] = [];

  // Only generate for important modules (core-logic, entry-point, utility with exports)
  const important = modules.filter(m =>
    (m.role === 'core-logic' || m.role === 'entry-point' || m.role === 'utility') &&
    m.exports.length > 0 && m.summary
  ).slice(0, 30);

  // Batch: 5 modules per LLM call
  for (let i = 0; i < important.length; i += 5) {
    const batch = important.slice(i, i + 5);
    const prompt = `For each code module below, generate 5 different search queries a developer might type when looking for this code. Think about problems they'd be solving, debugging scenarios, and feature requests.

${batch.map((m, idx) => `Module ${idx + 1}: ${m.path}
Summary: ${m.summary}
Exports: ${m.exports.slice(0, 5).join(', ')}`).join('\n\n')}

Respond as JSON array:
[{"path":"...","queries":["query1","query2","query3","query4","query5"]}]`;

    try {
      const response = await client.analyzeFast(prompt);
      const match = response.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]) as { path: string; queries: string[] }[];
        for (const item of parsed) {
          if (item.queries?.length) {
            results.push({ path: item.path, queries: item.queries.slice(0, 5) });
          }
        }
      }
    } catch (err) {
      logger.debug('HyDE: batch failed, skipping', { error: String(err) });
    }
  }

  timer?.end?.();
  logger.info(`HyDE: generated queries for ${results.length} modules`);
  return results;
}

// ─── 2. Hierarchical Roll-Up Summarization ───────────────────────

/**
 * Aggregate file-level summaries into directory → module → architecture summaries.
 */
export async function generateRollUpSummaries(
  client: CopilotClient,
  fileSummaries: { path: string; summary: string }[],
): Promise<RollUpSummary[]> {
  const timer = logger.time('RollUp: generating hierarchical summaries');
  const results: RollUpSummary[] = [];

  // Group files by directory (2 levels deep)
  const dirGroups = new Map<string, { path: string; summary: string }[]>();
  for (const file of fileSummaries) {
    if (!file.summary) continue;
    const parts = file.path.split('/');
    // Group at 2-level depth: "src/auth" or "python-workspace/components"
    const dir = parts.length >= 2 ? parts.slice(0, 2).join('/') : parts[0];
    if (!dirGroups.has(dir)) dirGroups.set(dir, []);
    dirGroups.get(dir)!.push(file);
  }

  // Generate directory-level summaries
  const dirSummaries: { dir: string; summary: string }[] = [];
  const dirsToSummarize = [...dirGroups.entries()].filter(([, files]) => files.length >= 2).slice(0, 20);

  for (let i = 0; i < dirsToSummarize.length; i += 3) {
    const batch = dirsToSummarize.slice(i, i + 3);
    const prompt = `Synthesize a concise module-level summary for each directory based on its files.

${batch.map(([dir, files]) => `## ${dir}/
Files:
${files.slice(0, 8).map(f => `- ${f.path.split('/').pop()}: ${f.summary}`).join('\n')}`).join('\n\n')}

For each directory, write ONE paragraph (2-3 sentences) capturing its overall purpose, key responsibilities, and how its files work together.

Respond as JSON array:
[{"directory":"...","summary":"..."}]`;

    try {
      const response = await client.analyzeFast(prompt);
      const match = response.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]) as { directory: string; summary: string }[];
        for (const item of parsed) {
          if (item.summary) {
            dirSummaries.push({ dir: item.directory, summary: item.summary });
            results.push({
              directory: item.directory,
              summary: item.summary,
              childSummaries: (dirGroups.get(item.directory) || []).map(f => f.summary),
              depth: 1,
            });
          }
        }
      }
    } catch (err) {
      logger.debug('RollUp: directory batch failed', { error: String(err) });
    }
  }

  // Generate architecture-level roll-up (top-level summary of all directories)
  if (dirSummaries.length >= 3) {
    try {
      const archPrompt = `Based on these module descriptions, write a 3-4 sentence architecture overview describing how they work together:

${dirSummaries.slice(0, 12).map(d => `- **${d.dir}**: ${d.summary}`).join('\n')}

Respond as JSON: {"summary":"..."}`;

      const archResponse = await client.analyzeFast(archPrompt);
      const archMatch = archResponse.match(/\{[\s\S]*\}/);
      if (archMatch) {
        const parsed = JSON.parse(archMatch[0]) as { summary: string };
        if (parsed.summary) {
          results.push({
            directory: '.',
            summary: parsed.summary,
            childSummaries: dirSummaries.map(d => d.summary),
            depth: 0,
          });
        }
      }
    } catch (err) {
      logger.debug('RollUp: architecture summary failed', { error: String(err) });
    }
  }

  timer?.end?.();
  logger.info(`RollUp: generated ${results.length} hierarchical summaries`);
  return results;
}

// ─── 3. Semantic Edge Labeling ───────────────────────────────────

/**
 * Add intent descriptions to the most important call graph edges.
 */
export async function labelEdges(
  client: CopilotClient,
  edges: CallGraphEdge[],
  moduleSummaries: Map<string, string>,
): Promise<LabeledEdge[]> {
  const timer = logger.time('EdgeLabels: labeling call graph edges');
  const results: LabeledEdge[] = [];

  // Score edges by importance (target fan-in)
  const targetCounts = new Map<string, number>();
  for (const e of edges) {
    targetCounts.set(e.to.path, (targetCounts.get(e.to.path) || 0) + 1);
  }
  const sorted = [...edges]
    .sort((a, b) => (targetCounts.get(b.to.path) || 0) - (targetCounts.get(a.to.path) || 0))
    .slice(0, 20);

  // Batch: 5 edges per call
  for (let i = 0; i < sorted.length; i += 5) {
    const batch = sorted.slice(i, i + 5);
    const prompt = `For each function call relationship, describe in ONE sentence WHY the caller uses the callee. Be specific about the data or logic being delegated.

${batch.map((e, idx) => {
  const callerSummary = moduleSummaries.get(e.from.path) || 'unknown module';
  const calleeSummary = moduleSummaries.get(e.to.path) || 'unknown module';
  return `${idx + 1}. ${e.from.path}::${e.from.name} calls ${e.to.path}::${e.to.name}
   Caller context: ${callerSummary}
   Callee context: ${calleeSummary}`;
}).join('\n\n')}

Respond as JSON array:
[{"from":"path::name","to":"path::name","intent":"one sentence why"}]`;

    try {
      const response = await client.analyzeFast(prompt);
      const match = response.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]) as { from: string; to: string; intent: string }[];
        for (const item of parsed) {
          if (item.intent) {
            results.push({
              from: item.from.split('::')[0] || item.from,
              to: item.to.split('::')[0] || item.to,
              intent: item.intent,
              confidence: 0.75,
            });
          }
        }
      }
    } catch (err) {
      logger.debug('EdgeLabels: batch failed', { error: String(err) });
    }
  }

  timer?.end?.();
  logger.info(`EdgeLabels: labeled ${results.length} edges with intent`);
  return results;
}

// ─── 4. Blast Radius Analysis ────────────────────────────────────

/**
 * Predict downstream impact of changing a specific module.
 */
export async function analyzeBlastRadius(
  client: CopilotClient,
  changedFile: string,
  callEdges: CallGraphEdge[],
  moduleSummaries: Map<string, string>,
): Promise<BlastRadiusResult> {
  const timer = logger.time('BlastRadius: analyzing impact');

  // BFS from changed file through call graph
  const adjacency = new Map<string, Set<string>>();
  for (const e of callEdges) {
    if (!adjacency.has(e.from.path)) adjacency.set(e.from.path, new Set());
    adjacency.get(e.from.path)!.add(e.to.path);
    // Also reverse: if callee changes, callers are affected
    if (!adjacency.has(e.to.path)) adjacency.set(e.to.path, new Set());
    adjacency.get(e.to.path)!.add(e.from.path);
  }

  const visited = new Map<string, number>(); // path → depth
  const queue: [string, number][] = [[changedFile, 0]];
  visited.set(changedFile, 0);

  while (queue.length > 0) {
    const [current, depth] = queue.shift()!;
    if (depth >= 4) continue; // max depth 4
    const neighbors = adjacency.get(current) || new Set();
    for (const next of neighbors) {
      if (!visited.has(next)) {
        visited.set(next, depth + 1);
        queue.push([next, depth + 1]);
      }
    }
  }

  visited.delete(changedFile);
  const affected = [...visited.entries()]
    .sort(([, a], [, b]) => a - b)
    .slice(0, 10);

  if (affected.length === 0) {
    timer?.end?.();
    return { changedFile, affectedModules: [], totalAffected: 0, maxDepth: 0 };
  }

  // LLM: analyze logical coupling for top affected modules
  const changedSummary = moduleSummaries.get(changedFile) || 'unknown module';
  const prompt = `A developer is changing "${changedFile}": ${changedSummary}

These downstream modules may be affected:
${affected.slice(0, 5).map(([path, depth]) => {
  const summary = moduleSummaries.get(path) || 'unknown';
  return `- ${path} (${depth} hops away): ${summary}`;
}).join('\n')}

For each affected module, write a specific warning about what could break. Focus on data format assumptions, behavioral contracts, and shared state.

Respond as JSON array:
[{"path":"...","warning":"specific impact warning","confidence":0.7}]`;

  const impacts: BlastRadiusImpact[] = [];
  try {
    const response = await client.analyzeFast(prompt);
    const match = response.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { path: string; warning: string; confidence?: number }[];
      for (const item of parsed) {
        const depth = visited.get(item.path) || 1;
        impacts.push({
          path: item.path,
          depth,
          relationship: depth === 1 ? 'direct caller/callee' : `${depth} hops away`,
          warning: item.warning,
          confidence: item.confidence || 0.7,
        });
      }
    }
  } catch (err) {
    logger.debug('BlastRadius: LLM analysis failed', { error: String(err) });
  }

  // Add remaining affected modules without LLM warnings
  for (const [path, depth] of affected) {
    if (!impacts.some(i => i.path === path)) {
      impacts.push({
        path,
        depth,
        relationship: depth === 1 ? 'direct caller/callee' : `${depth} hops away`,
        warning: `May be affected by changes to ${changedFile}`,
        confidence: 0.5,
      });
    }
  }

  timer?.end?.();
  logger.info(`BlastRadius: ${impacts.length} modules affected by changes to ${changedFile}`);
  return {
    changedFile,
    affectedModules: impacts.sort((a, b) => a.depth - b.depth),
    totalAffected: visited.size,
    maxDepth: Math.max(...[...visited.values()]),
  };
}

// ─── 5. Multi-Agent Code Auditing ────────────────────────────────

/**
 * Run 3-agent audit on critical components: Explainer + Red Teamer + Critic.
 */
export async function auditComponent(
  client: CopilotClient,
  componentPath: string,
  componentName: string,
  summary: string,
  codeSnippet: string,
): Promise<ComponentHealthCard> {
  const timer = logger.time(`Audit: ${componentName}`);

  // Agent 1: Explainer
  const explainerPrompt = `You are a senior software architect. Explain the purpose and key design decisions of this component in 2-3 sentences.

Component: ${componentName} (${componentPath})
Summary: ${summary}
Code sample:
\`\`\`
${codeSnippet.slice(0, 2000)}
\`\`\`

Respond as JSON: {"purpose":"..."}`;

  // Agent 2: Red Teamer
  const redTeamPrompt = `You are a security-focused code reviewer looking for edge cases, race conditions, unhandled errors, and potential vulnerabilities.

Component: ${componentName} (${componentPath})
Summary: ${summary}
Code sample:
\`\`\`
${codeSnippet.slice(0, 2000)}
\`\`\`

List up to 5 specific risks. Respond as JSON: {"risks":["risk1","risk2"]}`;

  // Agent 3: Critic
  const criticPrompt = `You are a clean code advocate evaluating this component against SOLID principles, DRY, and repository conventions.

Component: ${componentName} (${componentPath})
Summary: ${summary}
Code sample:
\`\`\`
${codeSnippet.slice(0, 2000)}
\`\`\`

List up to 3 code smells and 3 improvement suggestions. Respond as JSON: {"codeSmells":["smell1"],"suggestions":["suggestion1"]}`;

  let purpose = summary;
  let risks: string[] = [];
  let codeSmells: string[] = [];
  let suggestions: string[] = [];

  // Run all 3 agents in parallel
  const [explainerRes, redTeamRes, criticRes] = await Promise.allSettled([
    client.analyzeFast(explainerPrompt),
    client.analyzeFast(redTeamPrompt),
    client.analyzeFast(criticPrompt),
  ]);

  try {
    if (explainerRes.status === 'fulfilled') {
      const m = explainerRes.value.match(/\{[\s\S]*\}/);
      if (m) { purpose = JSON.parse(m[0]).purpose || purpose; }
    }
  } catch { /* keep default */ }

  try {
    if (redTeamRes.status === 'fulfilled') {
      const m = redTeamRes.value.match(/\{[\s\S]*\}/);
      if (m) { risks = JSON.parse(m[0]).risks || []; }
    }
  } catch { /* keep empty */ }

  try {
    if (criticRes.status === 'fulfilled') {
      const m = criticRes.value.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        codeSmells = parsed.codeSmells || [];
        suggestions = parsed.suggestions || [];
      }
    }
  } catch { /* keep empty */ }

  const overallHealth: ComponentHealthCard['overallHealth'] =
    risks.length >= 3 ? 'at-risk' : risks.length >= 1 || codeSmells.length >= 2 ? 'needs-attention' : 'healthy';

  timer?.end?.();
  return { componentPath, componentName, purpose, risks, codeSmells, suggestions, overallHealth };
}

// ─── 6. Semantic Dead Code — Feature-Flagged Paths ───────────────

/**
 * Detect code paths that are logically unreachable due to config/feature flags.
 */
export async function detectDeadBranches(
  client: CopilotClient,
  modules: { path: string; role: string; lines: number }[],
  configFiles: { path: string; content: string }[],
): Promise<DeadBranch[]> {
  const timer = logger.time('DeadBranches: analyzing feature flags');

  if (configFiles.length === 0) {
    timer?.end?.();
    return [];
  }

  // Extract config values that look like feature flags
  const configContext = configFiles.slice(0, 3).map(f =>
    `### ${f.path}\n\`\`\`\n${f.content.slice(0, 1500)}\n\`\`\``
  ).join('\n\n');

  // Find modules with branching logic that references config
  const coreModules = modules
    .filter(m => m.role === 'core-logic' && m.lines > 100)
    .slice(0, 10);

  if (coreModules.length === 0) {
    timer?.end?.();
    return [];
  }

  const prompt = `Analyze these configuration files for feature flags, toggles, or permanently-off settings:

${configContext}

These are the core modules that may contain conditional logic based on these configs:
${coreModules.map(m => `- ${m.path} (${m.lines} lines)`).join('\n')}

Identify any code paths that appear PERMANENTLY UNREACHABLE because:
1. A feature flag is set to false/disabled and there's no mechanism to change it
2. A config value makes a condition impossible (e.g., max_retries=0 means retry loops never execute)
3. An environment variable references a deprecated service

Only list paths you're confident about. Respond as JSON array:
[{"path":"module path","condition":"the condition that's always false","configSource":"which config controls it","reason":"why it's unreachable"}]

If nothing is clearly unreachable, return an empty array [].`;

  const results: DeadBranch[] = [];
  try {
    const response = await client.analyzeFast(prompt);
    const match = response.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { path: string; condition: string; configSource: string; reason: string }[];
      for (const item of parsed) {
        results.push({
          path: item.path,
          condition: item.condition,
          configSource: item.configSource,
          confidence: 0.6, // LLM-inferred, not deterministic
          reason: item.reason,
        });
      }
    }
  } catch (err) {
    logger.debug('DeadBranches: analysis failed', { error: String(err) });
  }

  timer?.end?.();
  logger.info(`DeadBranches: found ${results.length} potentially unreachable paths`);
  return results;
}
