---
name: skill-builder
description: 'Generate new SKILL.md files for GitHub Copilot that follow the agentskills.io specification. Analyzes the codebase to create project-specific, actionable skills with proper inputs, steps, outputs, and validation.'
tags:
  - skill
  - generator
  - copilot
  - meta
---

# Skill Builder

## When to use this skill
- When creating a new skill for a specific workflow in this project
- When a recurring development task should be automated via Copilot
- When the insights panel suggests a missing skill

## Prerequisites
- Understanding of the project's directory structure and tech stack
- Knowledge of the specific workflow to be automated

## Guidelines

### Step 1: Analyze the Workflow
- Identify the recurring task (e.g., "add a new Python service", "create a Bicep module")
- Map the manual steps a developer currently follows
- Identify which files are created/modified
- Note validation commands (tests, linters, builds)

### Step 2: Generate SKILL.md
Create the skill file at `.github/skills/{skill-name}/SKILL.md` with:

```yaml
---
name: skill-name-here
description: 'One-line description of what this skill does'
tags:
  - relevant
  - tags
---
```

### Step 3: Structure the Skill Body

```markdown
# Skill Title

## Inputs
- `param_name`: Description (type, default value if any)

## Steps
1. First action — reference ACTUAL project paths
2. Second action — use real commands from this project
3. Validation step — reference actual test/lint commands

## Outputs
- What files are created/modified
- What the developer should see on success

## Validation
- Command to verify the skill worked correctly
- Expected output or state
```

### Quality Rules
1. **Be specific** — reference ACTUAL paths from this project, not generic placeholders
2. **Use real commands** — `pytest tests/ -v` not "run tests"
3. **Include validation** — every skill must have a verification step
4. **Max 100 lines** — concise and actionable
5. **No duplicates** — check existing skills before creating a new one
6. **Proper frontmatter** — name (lowercase-hyphens), description (10-1024 chars)

## Output
A complete SKILL.md file ready to commit at `.github/skills/{name}/SKILL.md`
