---
name: write-windsurf-config
description: "Write AI-ready trigger-based rules for Windsurf."
---

# Skill: Write Windsurf Configuration

Write AI-ready trigger-based rules for Windsurf.

## Files to Generate

### `.windsurf/rules/*.md` (trigger-based rules)
Each file MUST have `trigger:` YAML frontmatter:
```yaml
---
trigger: always_on
---
```

Trigger modes:
- `always_on` — universal rules, loaded every session
- `glob` — activated for specific file patterns (needs `globs:` field)
- `model_decision` — AI decides when to apply based on context
- `manual` — only activated via slash command

Create:
- `project-overview.md` (trigger: always_on) — project context
- `python-conventions.md` (trigger: glob, globs: ["**/*.py"]) — Python rules
- `testing.md` (trigger: model_decision) — test guidance

### `AGENTS.md` (root, always-on)
- Location-scoped: root AGENTS.md is always loaded
- Subdirectory AGENTS.md files auto-scoped to that directory
- Cross-tool compatible (also read by Copilot)

### `.windsurf/skills/*/` (L3)
Multi-step procedures with supporting files:
- `SKILL.md` — steps to follow
- Supporting files (templates, configs)

### `.windsurf/workflows/` (L4)
Repeatable workflows activated via slash commands.

## Quality Rules
- Use trigger modes appropriately — don't make everything `always_on`
- Each rule file under 12,000 characters
- Skills include supporting files, not just instructions
- AGENTS.md in subdirectories for component-specific rules
- Reference REAL project paths
