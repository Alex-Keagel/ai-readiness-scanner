import { FailingSignal, ProjectContext, AITool, AI_TOOLS } from '../scoring/types';
import { fetchPlatformExamples } from './docExamples';
import { logger } from '../logging';

export function formatProjectContext(context: ProjectContext): string {
  const parts = [
    `Languages: ${context.languages.join(', ') || 'unknown'}`,
    `Frameworks: ${context.frameworks.join(', ') || 'none detected'}`,
    `Project type: ${context.projectType}`,
    `Package manager: ${context.packageManager || 'unknown'}`,
  ];

  if (context.components.length > 0) {
    parts.push(
      `Components:\n${context.components.map((c) => `  - ${c.name} (${c.type}, ${c.language}) at ${c.path}${c.description ? ` — ${c.description}` : ''}`).join('\n')}`
    );
  }

  if (context.directoryTree) {
    parts.push(`Directory structure:\n${context.directoryTree.slice(0, 1200)}`);
  }

  return parts.join('\n');
}

export function getPlatformExpertPrompt(tool: AITool): string {
  const toolConfig = AI_TOOLS[tool];
  if (!toolConfig) return '';

  // Deep expert personas per platform — each with specific knowledge
  const expertPersonas: Record<string, string> = {
    copilot: `You are a **GitHub Copilot configuration specialist** who has set up Copilot for hundreds of enterprise codebases.

YOUR EXPERTISE:
- You know that copilot-instructions.md is ALWAYS loaded — keep it concise (under 100 lines), bullet-point rules only
- You use .github/instructions/*.instructions.md with \`applyTo:\` YAML frontmatter for scoped rules (e.g., \`applyTo: "**/*.ts"\`)
- You write agent definitions in .github/agents/*.agent.md with description/name/tools YAML frontmatter
- You know Copilot reads top-level AGENTS.md for cross-tool compat
- You structure instructions as: project overview → tech stack → coding conventions → testing → file structure
- You NEVER write essays — every line is an actionable rule the agent follows`,

    cline: `You are a **Cline power user and configuration architect** who designs rule hierarchies for complex projects.

YOUR EXPERTISE:
- You structure .clinerules/ with: default-rules.md (master, loaded first), core/, domains/, workflows/, tools/
- You write memoryBankManagement.md to map code directories to domain-specific memory banks for selective loading
- You define session startup sequences in default-rules.md (which files to read first)
- You create safe-commands.md organized by category (build, test, lint, format) — never including destructive commands
- You keep each rule file under 200 lines for context efficiency
- You use conditional rules via \`paths:\` YAML frontmatter for scoping
- You write update-memory-bank.md workflows and current-context.template.md for session tracking`,

    cursor: `You are a **Cursor rules expert** who optimizes AI coding workflows in Cursor IDE.

YOUR EXPERTISE:
- You prefer .cursor/rules/ directory (not legacy .cursorrules single file)
- Each rule file has \`paths:\` YAML frontmatter with glob patterns for scoping (e.g., \`paths: ["src/**/*.tsx"]\`)
- You keep each rule file under 12000 chars
- You write descriptive filenames: coding.md, testing.md, architecture.md, security.md
- You include concrete code examples showing desired patterns vs anti-patterns
- You NEVER create conflicting rules across files`,

    claude: `You are a **Claude Code memory architecture expert** who designs CLAUDE.md files for maximum agent effectiveness.

YOUR EXPERTISE:
- You keep CLAUDE.md under 200 lines — every line costs context tokens
- You use @import syntax to pull in longer docs: \`@docs/architecture.md\`
- You organize .claude/rules/*.md by topic with \`paths:\` frontmatter for file-type scoping
- You create subdirectory CLAUDE.md files for component-specific context in monorepos
- You include specific build/test/run commands — never "run the tests", always "pytest tests/ -v"
- You know Claude starts each session fresh — CLAUDE.md IS the context`,

    roo: `You are a **Roo Code multi-mode configuration specialist** who leverages Roo's unique mode architecture.

YOUR EXPERTISE:
- You design mode-specific rules: .roo/rules-code/ for coding, .roo/rules-architect/ for architecture, .roo/rules-debug/ for debugging
- You number files for load ordering: 01-general.md, 02-coding-style.md, 03-testing.md
- You create custom modes in .roomodes for project-specific workflows
- You write separate rules for different concerns — not one massive file
- You know Roo falls back to .clinerules if .roo/ doesn't exist`,

    windsurf: `You are a **Windsurf Cascade configuration expert** who designs trigger-based rule systems.

YOUR EXPERTISE:
- You use trigger modes in YAML frontmatter: always_on (universal), glob (file-specific), model_decision (contextual), manual (on-demand)
- You keep rules under 12000 chars each
- You design AGENTS.md at root (always-on) and subdirectories (auto-glob scoping)
- You create skills in .windsurf/skills/ with supporting files
- You define workflows in .windsurf/workflows/ activated via slash commands`,

    aider: `You are an **Aider configuration specialist** who optimizes AI-assisted coding with Aider.

YOUR EXPERTISE:
- You configure .aider.conf.yml with appropriate model settings and conventions
- You write .aiderignore to exclude generated files, node_modules, vendor, build outputs
- You set up .aider.model.settings.yml for model-specific configurations
- You know Aider's config is minimal compared to other tools — focus on essentials`,
  };

  const persona = expertPersonas[tool] || `You are a **${toolConfig.name} configuration expert**.`;

  return `${persona}

PLATFORM RULES for ${toolConfig.name}:
- Instruction format: ${toolConfig.reasoningContext?.instructionFormat ?? 'N/A'}
- Expected structure: ${toolConfig.reasoningContext?.structureExpectations ?? 'N/A'}
- Quality markers: ${toolConfig.reasoningContext?.qualityMarkers ?? 'N/A'}
- Anti-patterns to AVOID: ${toolConfig.reasoningContext?.antiPatterns ?? 'N/A'}

WRITING RULES (critical):
1. **Be concise** — under 150 lines per file. Bullet points, not paragraphs.
2. **Be specific** — reference ACTUAL paths, commands, and tools from this project. Never say "your project" — use the real project name and structure.
3. **Be accurate** — only reference files/paths that exist in the directory tree below. Do NOT invent paths.
4. **Be actionable** — every instruction should tell the agent WHAT to do, not explain concepts.
5. **No boilerplate** — no "Welcome to this project" intros. Start with the most important instructions.
6. **Use the right file format** — follow ${toolConfig.name}'s exact file naming and YAML frontmatter conventions.`;
}

// Maps signal IDs to the specific files that should be generated
function getSignalFileTarget(signalId: string, tool: AITool): { path: string; description: string } | null {
  const toolConfig = AI_TOOLS[tool];
  
  // Tool-level signals
  const toolLevelMatch = signalId.match(/^([a-z]+)_l(\d)_(.+)$/);
  if (toolLevelMatch) {
    const [, toolId, levelStr, category] = toolLevelMatch;
    const level = parseInt(levelStr);
    const fileMap: Record<string, Record<number, { path: string; description: string }>> = {
      copilot: {
        2: { path: '.github/copilot-instructions.md', description: 'Copilot custom instructions with project-specific coding rules' },
        3: { path: '.github/agents/default.agent.md', description: 'Copilot agent definition with tools and description' },
        4: { path: '.github/playbooks/default.playbook.md', description: 'Copilot playbook with step-by-step workflow' },
        5: { path: '.copilot/session-state/README.md', description: 'Session state and learning documentation' },
      },
      cline: {
        2: { path: '.clinerules/default-rules.md', description: 'Cline default rules with session startup sequence' },
        3: { path: '.clinerules/tools/mcp-config.md', description: 'Cline tool and MCP configuration' },
        4: { path: '.clinerules/workflows/default.md', description: 'Cline workflow with sequential steps' },
        5: { path: '.clinerules/workflows/update-memory-bank.md', description: 'Memory bank update workflow' },
      },
      cursor: {
        2: { path: '.cursor/rules/coding.md', description: 'Cursor rules with paths: frontmatter for scoping' },
        3: { path: '.cursor/mcp.json', description: 'Cursor MCP server configuration' },
      },
      claude: {
        2: { path: 'CLAUDE.md', description: 'Claude Code instructions (concise, under 200 lines)' },
        5: { path: '.claude/settings.json', description: 'Claude Code settings' },
      },
      roo: {
        2: { path: '.roo/rules/01-general.md', description: 'Roo Code general rules' },
        3: { path: '.roo/rules-code/01-coding.md', description: 'Roo Code coding mode rules' },
      },
      windsurf: {
        2: { path: '.windsurf/rules/default.md', description: 'Windsurf rules with trigger frontmatter' },
        3: { path: '.windsurf/skills/default/SKILL.md', description: 'Windsurf skill definition' },
      },
      aider: {
        2: { path: '.aider.conf.yml', description: 'Aider configuration' },
      },
    };
    return fileMap[toolId]?.[level] || null;
  }

  // Named signals
  const namedSignals: Record<string, { path: string; description: string }> = {
    project_structure_doc: { path: 'docs/PROJECT_STRUCTURE.md', description: 'Project structure documentation' },
    conventions_documented: { path: 'docs/CONVENTIONS.md', description: 'Coding conventions document' },
    ignore_files: { path: '.gitignore', description: 'Comprehensive gitignore' },
    copilot_instructions: { path: '.github/copilot-instructions.md', description: 'Copilot instructions' },
    copilot_domain_instructions: { path: '.github/instructions/coding.instructions.md', description: 'Domain-specific Copilot instructions' },
    copilot_agents: { path: '.github/agents/default.agent.md', description: 'Copilot agent definition' },
    cline_rules: { path: '.clinerules/default-rules.md', description: 'Cline default rules' },
    cursor_rules: { path: '.cursor/rules/coding.md', description: 'Cursor coding rules' },
    claude_instructions: { path: 'CLAUDE.md', description: 'Claude Code instructions' },
    roo_modes: { path: '.roo/rules/01-general.md', description: 'Roo Code rules' },
    windsurf_rules: { path: '.windsurf/rules/default.md', description: 'Windsurf rules' },
    aider_config: { path: '.aider.conf.yml', description: 'Aider configuration' },
    agents_md: { path: 'AGENTS.md', description: 'Cross-tool agent instructions' },
    memory_bank: { path: 'memory-bank/projectbrief.md', description: 'Memory bank project brief' },
    safe_commands: { path: '.clinerules/safe-commands.md', description: 'Auto-approved safe commands' },
    mcp_config: { path: '.vscode/mcp.json', description: 'MCP server configuration' },
    post_task_instructions: { path: '.github/instructions/post-task.instructions.md', description: 'Post-task documentation update instructions' },
    doc_update_instructions: { path: '.github/instructions/doc-updates.instructions.md', description: 'Documentation update instructions' },
  };
  return namedSignals[signalId] || null;
}

export async function buildAutoFixPrompt(
  signal: FailingSignal,
  context: ProjectContext,
  selectedTool: AITool,
  userContext?: string
): Promise<string> {
  const expertPrompt = getPlatformExpertPrompt(selectedTool);
  const fileTarget = getSignalFileTarget(signal.id, selectedTool);

  // Fetch real examples from GitHub for few-shot context
  const level = signal.level;
  const examples = await fetchPlatformExamples(selectedTool, level);

  const targetHint = fileTarget
    ? `Generate the file at path: \`${fileTarget.path}\`\nPurpose: ${fileTarget.description}`
    : `Generate the appropriate file(s) for the "${signal.id}" signal following ${AI_TOOLS[selectedTool]?.name || selectedTool} conventions.`;

  const userContextBlock = userContext
    ? `\nUSER CONTEXT (developer's description of the project):\n${userContext}\n\nUse this context to make the generated files more accurate and relevant.\n`
    : '';

  return `${expertPrompt}
${examples}

TASK: Generate a missing AI agent configuration file for this project.

Signal: ${signal.id} (Level ${signal.level})
Finding: ${signal.finding}
${targetHint}
${userContextBlock}
PROJECT CONTEXT (use this data to make the file accurate):
${formatProjectContext(context)}

CRITICAL RULES:
- Reference ONLY paths that appear in the directory structure above
- Use the ACTUAL package manager (${context.packageManager || 'unknown'}) in commands
- Cover ALL components listed above, not just some
- Keep files under 150 lines — concise bullet points, not essays
- Include the correct YAML frontmatter if the platform requires it
- Do NOT include generic advice like "write clean code" — be project-specific

Respond with ONLY valid JSON (no markdown fences):
{
  "files": [
    {
      "path": "relative/path/to/file",
      "content": "full file content as a string"
    }
  ],
  "explanation": "Brief explanation of what was generated"
}`;
}

export async function buildGuidedFixPrompt(
  signal: FailingSignal,
  context: ProjectContext,
  existingContent: string,
  selectedTool: AITool,
  userContext?: string
): Promise<string> {
  const expertPrompt = getPlatformExpertPrompt(selectedTool);

  // Fetch real examples from GitHub for few-shot context
  const level = signal.level;
  const examples = await fetchPlatformExamples(selectedTool, level);

  const userContextBlock = userContext
    ? `\nUSER CONTEXT (developer's description of the project):\n${userContext}\n\nUse this context to make the generated files more accurate and relevant.\n`
    : '';

  return `${expertPrompt}
${examples}

TASK: Improve an existing AI agent configuration file. The file exists but has accuracy or quality issues.

Signal: ${signal.id} (Level ${signal.level})
Finding: ${signal.finding}
${userContextBlock}
PROJECT CONTEXT:
${formatProjectContext(context)}

EXISTING FILE CONTENT:
\`\`\`
${existingContent}
\`\`\`

IMPROVEMENT RULES:
- Fix any paths that don't match the actual directory structure
- Fix any commands that don't match the actual package manager (${context.packageManager || 'unknown'})
- Remove generic boilerplate — replace with project-specific instructions
- Keep the file concise (under 150 lines)
- Preserve any accurate, useful content from the original
- Add coverage for components not mentioned in the original

Respond with ONLY valid JSON (no markdown fences):
{
  "files": [
    {
      "path": "relative/path/to/file",
      "content": "complete new file content"
    }
  ],
  "explanation": "What was changed and why"
}`;
}

export function buildRecommendPrompt(
  signal: FailingSignal,
  context: ProjectContext,
  selectedTool: AITool
): string {
  const toolConfig = AI_TOOLS[selectedTool];

  return `You are an AI readiness advisor for ${toolConfig?.name || selectedTool}.

Signal: ${signal.id} (Level ${signal.level})
Finding: ${signal.finding}

PROJECT CONTEXT:
${formatProjectContext(context)}

${toolConfig ? `PLATFORM CONTEXT:
Expected structure: ${toolConfig.reasoningContext?.structureExpectations ?? 'N/A'}
Quality markers: ${toolConfig.reasoningContext?.qualityMarkers ?? 'N/A'}` : ''}

Provide 3-5 specific, actionable steps to address this signal. Reference actual paths and commands from this project.

Respond with ONLY valid JSON (no markdown fences):
{
  "steps": [
    "Step 1: ...",
    "Step 2: ..."
  ],
  "codeSnippets": [
    {
      "file": "relative/path/to/file",
      "code": "example code snippet"
    }
  ],
  "explanation": "Overall approach"
}`;
}

export function parseFixResponse(response: string): {
  files?: { path: string; content: string }[];
  explanation?: string;
  steps?: string[];
  codeSnippets?: { file: string; code: string }[];
} | null {
  let jsonStr = response.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);

    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    return parsed as {
      files?: { path: string; content: string }[];
      explanation?: string;
      steps?: string[];
      codeSnippets?: { file: string; code: string }[];
    };
  } catch (err) {
    logger.warn('Failed to parse fix response JSON', { error: err instanceof Error ? err.message : String(err) });
    // Try to find JSON object within the response
    const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[0]);
        if (typeof parsed === 'object' && parsed !== null) {
          return parsed as {
            files?: { path: string; content: string }[];
            explanation?: string;
            steps?: string[];
            codeSnippets?: { file: string; code: string }[];
          };
        }
      } catch (err) {
        logger.warn('Failed to parse extracted JSON object from fix response', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    return null;
  }
}
