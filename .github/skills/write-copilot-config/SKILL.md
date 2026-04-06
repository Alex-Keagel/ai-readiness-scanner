---
name: write-copilot-config
description: "Write AI-ready instruction files for GitHub Copilot."
---

# Skill: Write GitHub Copilot Configuration

Write AI-ready instruction files for GitHub Copilot.

## Files to Generate

### `.github/copilot-instructions.md` (always-on)
- Under 100 lines, bullet-point rules only
- Project overview: name, purpose, tech stack
- Coding conventions: naming, patterns, error handling
- File structure: key directories and their purpose
- Build/test commands: exact commands with the project's package manager
- Reference ACTUAL paths from the repo — never generic placeholders

### `.github/instructions/*.instructions.md` (scoped)
Each file MUST have YAML frontmatter with `applyTo:` glob:
```yaml
---
applyTo: "**/*.py"
---
```
- Create one per language/domain (python.instructions.md, typescript.instructions.md)
- Include language-specific conventions, imports, patterns

### `.github/agents/*.agent.md` (L3)
YAML frontmatter with `description`, `name`, `tools`:
```yaml
---
description: "When to invoke this agent..."
name: agent-name
tools: ['shell', 'read', 'edit', 'search']
---
```

## Quality Rules
- Be CONCISE — every line is an actionable rule
- Reference REAL paths from the directory tree
- Use the ACTUAL package manager (npm/uv/pip/cargo)
- No essays, no "Welcome to this project" intros
- No generic advice like "write clean code"
