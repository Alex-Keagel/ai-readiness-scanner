/**
 * Converts a tool-specific signal ID (e.g., "cline_l2_instructions") or
 * a shared signal ID (e.g., "project_structure_doc") into a human-readable label.
 */
export function humanizeSignalId(id: string): string {
  if (!id) return 'Unknown Signal';
  // Tool-specific IDs: "cline_l2_instructions", "copilot_l3_skills_and_tools"
  const match = id.match(/^[a-z]+_l(\d)_(.+)$/);
  if (match) {
    const categories: Record<string, string> = {
      instructions: 'Instructions & Rules',
      skills_and_tools: 'Skills, Tools & MCP',
      workflows: 'Workflows & Playbooks',
      memory_feedback: 'Memory & Feedback',
    };
    return categories[match[2]] || match[2].replace(/_/g, ' ');
  }

  // Shared / legacy signal IDs
  const sharedNames: Record<string, string> = {
    project_structure_doc: 'Project Structure Documented',
    conventions_documented: 'Coding Conventions',
    instruction_accuracy: 'Content Accuracy',
    memory_bank_accuracy: 'Memory Bank Accuracy',
    ignore_files: 'Ignore Files',
    mcp_config: 'MCP Server Config',
    agents_md: 'AGENTS.md',
    copilot_instructions: 'Copilot Instructions',
    copilot_domain_instructions: 'Domain-Specific Instructions',
    copilot_agents: 'Copilot Agents',
    copilot_skills: 'Copilot Skills',
    cline_rules: 'Cline Rules',
    cline_domains: 'Cline Domain Rules',
    cursor_rules: 'Cursor Rules',
    claude_instructions: 'Claude Instructions',
    roo_modes: 'Roo Code Modes',
    windsurf_rules: 'Windsurf Rules',
    aider_config: 'Aider Config',
    safe_commands: 'Safe Commands',
    tool_definitions: 'Tool Definitions',
    memory_bank: 'Memory Bank',
    agent_personas: 'Agent Personas',
    agent_workflows: 'Agent Workflows',
    task_playbooks: 'Task Playbooks',
    workflow_verification: 'Workflow Verification',
    error_recovery: 'Error Recovery',
    workflow_tool_refs: 'Workflow Tool References',
    domain_workflows: 'Domain Workflows',
    memory_bank_update: 'Memory Bank Updates',
    agent_evals: 'Agent Evaluations',
    retrospectives: 'Retrospectives',
    self_improve_workflow: 'Self-Improvement Workflow',
    feedback_ci: 'Feedback CI/Automation',
    orchestrator_agents: 'Orchestrator Agents',
    multi_agent_framework: 'Multi-Agent Framework',
    cross_repo_triggers: 'Cross-Repo Triggers',
    autonomous_actions: 'Autonomous Actions',
    agent_governance: 'Agent Governance',
    agent_specialization: 'Agent Specialization',
    azdevops_copilot: 'Azure DevOps Copilot Config',
  };

  return sharedNames[id] || id.replace(/_/g, ' ');
}

// ─── Nested Config Filter ───────────────────────────────────────────

/**
 * Checks if a file path is a nested config file from a sub-project.
 * Sub-projects (like an extension inside a monorepo) have their own
 * .github/, .clinerules/, memory-bank/ dirs that should NOT be treated
 * as the parent repo's AI config.
 *
 * Returns true if the path should be SKIPPED (it's nested config).
 */
export function isNestedConfig(relPath: string): boolean {
  // Config-like path segments that indicate AI agent configuration
  const CONFIG_SEGMENTS = ['/.github/', '/.clinerules/', '/.roo/', '/.cursor/',
    '/.windsurf/', '/.claude/', '/memory-bank/', '/CLAUDE.md', '/AGENTS.md'];

  // If the path starts with a known top-level config dir, it's repo-level — keep it
  if (relPath.startsWith('.github/') || relPath.startsWith('.clinerules/') ||
      relPath.startsWith('.roo/') || relPath.startsWith('.cursor/') ||
      relPath.startsWith('.windsurf/') || relPath.startsWith('.claude/') ||
      relPath.startsWith('memory-bank/') || relPath === 'CLAUDE.md' ||
      relPath === 'AGENTS.md' || relPath === '.cursorrules' ||
      relPath === '.aider.conf.yml' || relPath === '.aiderignore') {
    return false; // Top-level config — keep
  }

  // If the path contains a config segment deeper in the tree, it's nested — skip
  for (const seg of CONFIG_SEGMENTS) {
    if (relPath.includes(seg)) return true;
  }

  return false;
}

// ─── Retry with Exponential Backoff ─────────────────────────────────

/**
 * Retries an async function with exponential backoff.
 * @param fn The async function to retry
 * @param maxRetries Maximum number of retries (default 2, so 3 total attempts)
 * @param baseDelayMs Initial delay in ms (default 2000, doubles each retry)
 * @param label Optional label for logging
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  baseDelayMs = 2000,
  label?: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        const msg = err instanceof Error ? err.message : String(err);
        const isTimeout = msg.includes('timed out') || msg.includes('timeout');
        // Only retry on timeouts or transient errors, not on invalid responses
        if (!isTimeout && !msg.includes('rate limit') && !msg.includes('429') && !msg.includes('503')) {
          throw err; // Non-retryable error
        }
        try {
          const { logger } = require('./logging');
          logger.info(`${label || 'retryWithBackoff'}: attempt ${attempt + 1} failed (${msg}), retrying in ${delay}ms...`);
        } catch { /* logging not available */ }
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

// ─── Insight Deduplication ──────────────────────────────────────────

interface DeduplicableInsight {
  title: string;
  severity: 'critical' | 'important' | 'suggestion';
  category?: string;
  affectedComponent?: string;
  confidenceScore?: number;
}

/**
 * Normalizes a title for dedup matching.
 * Strips quotes, backticks, paths, scores, and issue counts to find semantic equivalents.
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[`'"]/g, '')                  // strip quotes/backticks
    .replace(/\s*\(\d+ issues?\)/g, '')     // strip "(3 issues)"
    .replace(/\s*—\s*.+$/, '')              // strip "— completeness is weak (5/100)"
    .replace(/\s+/g, ' ');                  // normalize whitespace
}

/**
 * Extracts skill name from insight titles for cross-pass dedup.
 * "Create test skill" → "test"
 * "Create .github/skills/test/SKILL.md..." → "test"
 * "Improve skill ev2 — ..." → "ev2"
 */
function extractSkillName(title: string): string | null {
  const lower = title.toLowerCase();
  // "Create "test" skill" or "Create 'deploy' skill"
  const quoted = lower.match(/(?:create|improve|add)\s+[`'"]*(\w[\w-]*)[`'"]*\s+skill/);
  if (quoted) return quoted[1];
  // "Create .github/skills/test/SKILL.md"
  const pathMatch = lower.match(/skills\/([^/]+)\/skill\.md/);
  if (pathMatch) return pathMatch[1];
  // "Improve skill "ev2""
  const improveMatch = lower.match(/(?:improve|update)\s+skill\s+[`'"]*(\w[\w-]*)/);
  if (improveMatch) return improveMatch[1];
  return null;
}

const SEV_ORDER: Record<string, number> = { critical: 0, important: 1, suggestion: 2 };

/**
 * Central dedup for all insights — call this ONCE after all sources are merged.
 *
 * Dedup keys (any match = duplicate):
 *  1. Exact normalized title
 *  2. Same component + same category
 *  3. Same component + overlapping title stem (first 40 chars after normalize)
 *
 * When duplicates collide, keeps the most severe; on tie, keeps highest confidence.
 */
export function deduplicateInsights<T extends DeduplicableInsight>(insights: T[]): T[] {
  if (insights.length <= 1) return insights;

  // Build dedup keys for each insight
  const keys: string[][] = insights.map(insight => {
    const result: string[] = [];

    // Key 1: normalized full title
    result.push(`title:${normalizeTitle(insight.title)}`);

    // Key 2: component + category (if both present)
    if (insight.affectedComponent && insight.category) {
      const comp = insight.affectedComponent.toLowerCase().trim();
      // Split multi-component strings ("path1, path2") and use each
      for (const c of comp.split(',').map(s => s.trim()).filter(Boolean)) {
        result.push(`comp-cat:${c}::${insight.category}`);
      }
    }

    // Key 3: component + title stem (first 40 normalized chars)
    if (insight.affectedComponent) {
      const comp = insight.affectedComponent.toLowerCase().trim();
      const stem = normalizeTitle(insight.title).slice(0, 40);
      for (const c of comp.split(',').map(s => s.trim()).filter(Boolean)) {
        result.push(`comp-stem:${c}::${stem}`);
      }
    }

    // Key 4: skill name dedup — "Create test skill" and "Create .github/skills/test/SKILL.md" are the same
    const skillName = extractSkillName(insight.title);
    if (skillName) {
      result.push(`skill:${skillName}`);
    }

    return result;
  });

  // For each key, track the "winner" index
  const keyWinner = new Map<string, number>();
  const kept = new Set<number>();

  for (let i = 0; i < insights.length; i++) {
    let dominated = false;

    for (const key of keys[i]) {
      if (keyWinner.has(key)) {
        const existingIdx = keyWinner.get(key)!;
        const existing = insights[existingIdx];
        const current = insights[i];

        const existSev = SEV_ORDER[existing.severity] ?? 2;
        const currSev = SEV_ORDER[current.severity] ?? 2;

        if (currSev < existSev || (currSev === existSev && (current.confidenceScore ?? 0) > (existing.confidenceScore ?? 0))) {
          // Current is better — replace winner
          kept.delete(existingIdx);
          keyWinner.set(key, i);
          kept.add(i);
        } else {
          // Existing wins — skip current
          dominated = true;
        }
      } else {
        keyWinner.set(key, i);
      }
    }

    if (!dominated) {
      kept.add(i);
    }
  }

  return insights.filter((_, i) => kept.has(i));
}
