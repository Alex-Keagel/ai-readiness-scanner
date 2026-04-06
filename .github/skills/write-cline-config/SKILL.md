---
name: write-cline-config
description: "Write AI-ready rule files and memory banks for Cline."
---

# Skill: Write Cline Configuration

Write AI-ready rule files and memory banks for Cline.

## Files to Generate

### `.clinerules/default-rules.md` (master rules)
- Session startup sequence: which files to read first
- Project overview, tech stack, conventions
- Under 200 lines for context efficiency
- Define session startup: "At the start of each session, read: 1. memory-bank/activeContext.md, 2. ..."

### `.clinerules/core/` (foundational context)
- `project-overview.md` — architecture, components, directory layout
- `technical-context.md` — tech stack, dependencies, environment setup
- `development-standards.md` — coding conventions, naming, patterns
- `security-guidelines.md` — secret handling, auth patterns, forbidden operations

### `.clinerules/domains/` (language-specific)
- One file per language: `python.md`, `typescript.md`, `kql.md`
- Language-specific conventions, imports, testing patterns

### `.clinerules/safe-commands.md` (L3)
Organized by category:
```markdown
## Build
- uv sync
- npm install

## Test
- pytest tests/ -v
- npm test

## Lint
- ruff check .
```
Never include: `rm -rf`, `sudo`, `DROP`, destructive operations

### `.clinerules/workflows/` (L4)
Step-by-step procedures with validation:
```markdown
## Steps
1. Read the relevant domain context
2. Implement the change
3. Run tests: `pytest tests/ -v`
4. Verify: check output matches expectations
5. Update memory-bank if patterns changed
```

### `memory-bank/` (L5)
- `projectbrief.md` — goals, scope, key requirements
- `productContext.md` — user needs, use cases, business logic
- `techContext.md` — stack details, integrations, infrastructure
- `systemPatterns.md` — architectural patterns in use
- `memoryBankManagement.md` — domain-to-directory mapping

### `.clinerules/workflows/update-memory-bank.md` (L5)
Instructions for the agent to update memory after completing tasks.

## Quality Rules
- Each file under 200 lines
- Reference REAL paths — never generic
- `safe-commands.md` organized by category, never include destructive commands
- Memory bank files must reflect ACTUAL project state
- Use conditional rules via `paths:` YAML frontmatter for scoping
