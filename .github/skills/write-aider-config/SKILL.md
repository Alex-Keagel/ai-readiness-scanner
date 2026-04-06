---
name: write-aider-config
description: "Write AI-ready configuration for Aider."
---

# Skill: Write Aider Configuration

Write AI-ready configuration for Aider.

## Files to Generate

### `.aider.conf.yml` (main config)
```yaml
# Model settings
model: gpt-4o
edit-format: diff

# Context management
auto-commits: true
auto-lint: true
lint-cmd: ruff check --fix .

# File handling
read: [README.md, ARCHITECTURE.md]
```

### `.aiderignore` (file exclusions)
Exclude generated/vendor files:
```
node_modules/
dist/
build/
*.pyc
__pycache__/
.git/
*.lock
coverage/
.venv/
vendor/
```

### `.aider.model.settings.yml` (optional, model-specific)
Model-specific configurations for different backends.

## Quality Rules
- `.aiderignore` MUST exclude node_modules, dist, build, vendor, __pycache__
- Config should reference project-specific lint/test commands
- Keep it minimal — Aider's config system is simple
- `read:` should list the most important context files
