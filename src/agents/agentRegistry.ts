import * as vscode from 'vscode';
import { logger } from '../logging';

export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  persona: string;
  skills: string[];
  rules: string[];
  fullContent: string;
}

const agentCache = new Map<string, AgentDefinition>();

/**
 * Load an agent definition from agents/*.agent.md files bundled with the extension.
 * Parses YAML frontmatter for metadata and markdown body for persona/skills/rules.
 */
export async function loadAgent(
  agentName: string,
  extensionUri: vscode.Uri
): Promise<AgentDefinition | null> {
  if (agentCache.has(agentName)) {
    return agentCache.get(agentName)!;
  }

  try {
    const agentUri = vscode.Uri.joinPath(extensionUri, 'agents', `${agentName}.agent.md`);
    const content = Buffer.from(await vscode.workspace.fs.readFile(agentUri)).toString('utf-8');
    const agent = parseAgentFile(agentName, content);
    agentCache.set(agentName, agent);
    return agent;
  } catch (err) {
    logger.debug(`AgentRegistry: failed to load agent "${agentName}"`, err);
    return null;
  }
}

/**
 * Load all agent definitions from the agents/ directory.
 */
export async function loadAllAgents(
  extensionUri: vscode.Uri
): Promise<Map<string, AgentDefinition>> {
  try {
    const pattern = new vscode.RelativePattern(extensionUri, 'agents/*.agent.md');
    const files = await vscode.workspace.findFiles(pattern, undefined, 50);

    for (const uri of files) {
      const fileName = uri.path.split('/').pop() || '';
      const name = fileName.replace('.agent.md', '');
      if (!agentCache.has(name)) {
        try {
          const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
          agentCache.set(name, parseAgentFile(name, content));
        } catch { /* skip */ }
      }
    }

    logger.info(`AgentRegistry: loaded ${agentCache.size} agent definitions`);
  } catch (err) {
    logger.debug('AgentRegistry: failed to load agents', err);
  }

  return agentCache;
}

/**
 * Build an LLM system prompt from an agent definition.
 * Combines persona, skills, and rules into a structured prompt.
 */
export function buildAgentPrompt(agent: AgentDefinition): string {
  const parts: string[] = [];

  if (agent.persona) {
    parts.push(agent.persona);
  }

  if (agent.skills.length > 0) {
    parts.push('\n## Your Skills\n' + agent.skills.map((s, i) => `${i + 1}. ${s}`).join('\n'));
  }

  if (agent.rules.length > 0) {
    parts.push('\n## Rules\n' + agent.rules.map(r => `- ${r}`).join('\n'));
  }

  return parts.join('\n\n');
}

/**
 * Get an agent's prompt, falling back to a default prompt string if the agent file isn't available.
 */
export async function getAgentPrompt(
  agentName: string,
  extensionUri: vscode.Uri,
  fallbackPrompt: string
): Promise<string> {
  const agent = await loadAgent(agentName, extensionUri);
  if (agent) {
    return buildAgentPrompt(agent);
  }
  return fallbackPrompt;
}

/** Clear the agent cache (for testing or reload) */
export function clearAgentCache(): void {
  agentCache.clear();
}

// ─── Parser ─────────────────────────────────────────────────────

function parseAgentFile(name: string, content: string): AgentDefinition {
  let description = '';
  let tools: string[] = [];
  let parsedName = name;
  let body = content;

  // Parse YAML frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (fmMatch) {
    const fm = fmMatch[1];
    body = fmMatch[2];

    const nameMatch = fm.match(/name:\s*(.+)/);
    if (nameMatch) parsedName = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');

    const descMatch = fm.match(/description:\s*['"]?(.*?)['"]?\s*$/m);
    if (descMatch) description = descMatch[1].trim();

    const toolsMatch = fm.match(/tools:\s*\[(.*?)\]/);
    if (toolsMatch) {
      tools = toolsMatch[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
  }

  // Extract persona (first paragraph after # heading)
  let persona = '';
  const personaMatch = body.match(/## Persona\n([\s\S]*?)(?=\n##|$)/);
  if (personaMatch) {
    persona = personaMatch[1].trim();
  }

  // Extract skills
  const skills: string[] = [];
  const skillsMatch = body.match(/## Skills\n([\s\S]*?)(?=\n##|$)/);
  if (skillsMatch) {
    const lines = skillsMatch[1].split('\n');
    for (const line of lines) {
      const m = line.match(/^\d+\.\s+\*\*(.+?)\*\*\s*—\s*(.+)/);
      if (m) skills.push(`${m[1]}: ${m[2]}`);
    }
  }

  // Extract rules
  const rules: string[] = [];
  const rulesMatch = body.match(/## Rules\n([\s\S]*?)(?=\n##|$)/);
  if (rulesMatch) {
    const lines = rulesMatch[1].split('\n');
    for (const line of lines) {
      const m = line.match(/^-\s+(.+)/);
      if (m) rules.push(m[1]);
    }
  }

  return {
    name: parsedName,
    description,
    tools,
    persona,
    skills,
    rules,
    fullContent: content,
  };
}
