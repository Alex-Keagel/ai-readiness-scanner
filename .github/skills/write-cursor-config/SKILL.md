# Skill: Write Cursor Configuration

Write AI-ready rule files for Cursor IDE.

## Files to Generate

### `.cursor/rules/*.md` (preferred, directory-based)
Each rule file MUST have YAML frontmatter:
```yaml
---
description: "Coding conventions for Python files"
globs: "**/*.py"
alwaysApply: false
---
```

Create topic-specific files:
- `coding.md` — general coding conventions, naming, patterns
- `testing.md` — test patterns, frameworks, coverage expectations
- `architecture.md` — project structure, module boundaries, import rules
- `security.md` — secret handling, input validation, auth patterns

### Key rules:
- Each file under 12,000 characters
- Use `globs:` for file-type scoping (e.g., `"**/*.py"`, `"src/**/*.ts"`)
- Descriptive filenames indicating scope
- Include code examples showing desired patterns vs anti-patterns
- Specific, verifiable instructions — not vague advice

### `.cursorignore` (optional)
Files/directories Cursor should not read or modify.

### `.cursor/mcp.json` (L3, optional)
MCP server configuration if applicable.

## Quality Rules
- Use `.cursor/rules/` directory, NOT legacy `.cursorrules` single file
- Each rule scoped with `globs:` — don't apply everything everywhere
- No conflicting rules across files
- Include concrete code examples
- Reference REAL project paths
