---
name: dev-add-agent
description: "Create a new agent definition file that the extension loads at runtime for LLM system prompts."
---

# Dev: Add an Agent Definition

## Description
Create a new agent definition file that the extension loads at runtime for LLM system prompts.

## Inputs
- `agent_name`: string — kebab-case name (e.g., `security-auditor`)
- `persona`: string — one-line role description
- `skills`: string[] — list of agent capabilities
- `rules`: string[] — behavioral constraints
- `is_skill`: boolean — if true, create as SKILL.md instead of agent.md (for procedures with I/O/steps)

## Steps
1. **Create agent file** — If `is_skill` is false, create `agents/${agent_name}.agent.md`:
   ```yaml
   ---
   name: ${agent_name}
   description: "${persona}"
   tools: ['file-read', 'workspace-search']
   ---
   ```
   Add `## Persona`, `## Skills` (numbered with `**Name** — description`), `## Rules` (bulleted).

2. **Create skill file** — If `is_skill` is true, create `agents/skills/${agent_name}/SKILL.md`:
   Add `## Description`, `## Inputs` (typed), `## Steps` (numbered), `## Outputs`, `## Validation`, `## Error Handling`.

3. **Export from index** — Add the new agent/skill to `src/deep/index.ts` exports if it has a TypeScript class.

4. **Wire into code** — If the agent is used by a specific module:
   - Import `getAgentPrompt` from `src/agents/agentRegistry.ts`
   - Replace inline prompt string with `await getAgentPrompt('${agent_name}', context.extensionUri, fallbackPrompt)`

5. **Update .vscodeignore** — Verify `agents/` is NOT in `.vscodeignore` (it shouldn't be — agents must ship in the VSIX).

6. **Test** — Run `dev-build-test` skill. Verify VSIX includes the new file: `npx vsce ls --tree | grep ${agent_name}`.

## Outputs
- `agents/${agent_name}.agent.md` or `agents/skills/${agent_name}/SKILL.md`
- Updated exports if TypeScript class exists

## Validation
- File follows the YAML frontmatter + markdown body pattern
- Agent name is kebab-case
- VSIX includes the file (check with `vsce ls`)
- If wired into code, the `getAgentPrompt` call works (test in Extension Host)
