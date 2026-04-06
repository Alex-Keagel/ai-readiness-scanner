---
name: write-claude-config
description: "Write AI-ready CLAUDE.md and rules for Claude Code."
---

# Skill: Write Claude Code Configuration

Write AI-ready CLAUDE.md and rules for Claude Code.

## Files to Generate

### `CLAUDE.md` (root, always loaded)
- **MUST be under 200 lines** — every line costs context tokens
- Structure: project overview → build commands → coding conventions → file structure
- Use `@import` for longer docs: `@docs/architecture.md`
- Include EXACT build/test/run commands — never "run the tests", always `pytest tests/ -v`
- Specific to THIS project — no generic boilerplate

### `.claude/rules/*.md` (topic-scoped)
Each file supports `paths:` YAML frontmatter:
```yaml
---
paths:
  - "**/*.py"
---
```
- `code-style.md` — language conventions, patterns, naming
- `testing.md` — test frameworks, patterns, coverage
- `security.md` — secret handling, auth, input validation

### Subdirectory `CLAUDE.md` files (monorepo)
- Place `CLAUDE.md` in each major component directory
- These load on-demand when Claude works in that directory
- Component-specific context, commands, patterns

### `.claude/settings.json` (L5)
Claude Code settings for the project.

## Quality Rules
- Root CLAUDE.md UNDER 200 lines — this is critical
- Use `@import` syntax to reference longer docs
- Include specific build/test commands with actual package manager
- Subdirectory CLAUDE.md for component-specific context in monorepos
- No generic advice — every instruction is project-specific
