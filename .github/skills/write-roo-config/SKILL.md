---
name: write-roo-config
description: "Write AI-ready mode-specific rules for Roo Code."
---

# Skill: Write Roo Code Configuration

Write AI-ready mode-specific rules for Roo Code.

## Files to Generate

### `.roo/rules/*.md` (general workspace rules)
- Number files for load ordering: `01-general.md`, `02-coding-style.md`, `03-testing.md`
- Project overview, tech stack, conventions

### `.roo/rules-code/*.md` (coding mode)
Rules applied when Roo is in "code" mode:
- Language-specific conventions
- Import patterns, error handling
- Testing requirements

### `.roo/rules-architect/*.md` (architecture mode)
Rules applied when Roo is in "architect" mode:
- Architecture principles, module boundaries
- Design patterns in use
- Component interaction rules

### `.roo/rules-debug/*.md` (debug mode)
Rules applied when Roo is in "debug" mode:
- Debugging strategies per language
- Common error patterns
- Log analysis guidance

### `.roomodes` (custom modes)
Define project-specific modes:
```json
{
  "customModes": [
    {
      "slug": "data-pipeline",
      "name": "Data Pipeline Expert",
      "roleDefinition": "You specialize in data pipeline development..."
    }
  ]
}
```

## Quality Rules
- Number files for ordering (01-, 02-, 03-)
- Separate rules by mode (code vs architect vs debug)
- Create custom modes for project-specific workflows
- Each file focused on one concern
- Reference REAL project paths
