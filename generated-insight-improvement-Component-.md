# .editorconfig

```editorconfig
# EditorConfig – AI Readiness Scanner
# https://editorconfig.org

root = true

# Default rules for all files
[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

# TypeScript / JavaScript source files
[*.{ts,js}]
indent_style = space
indent_size = 2
max_line_length = 120

# JSON configuration files (package.json, tsconfig.json, launch.json, etc.)
[*.json]
indent_style = space
indent_size = 2
insert_final_newline = true

# Markdown documentation (docs/, README.md, instructions, specs)
[*.md]
trim_trailing_whitespace = false
indent_style = space
indent_size = 2

# YAML pipelines (.release-fpa/, .release-manifestRollout/)
[*.{yml,yaml}]
indent_style = space
indent_size = 2

# Shell scripts (scripts/install.sh)
[*.sh]
end_of_line = lf
indent_style = space
indent_size = 2

# PowerShell scripts (scripts/install.ps1)
[*.ps1]
end_of_line = crlf
indent_style = space
indent_size = 2

# SVG assets (media/icon.svg)
[*.svg]
indent_style = space
indent_size = 2
insert_final_newline = true

# VS Code extension packaging ignore
[.vscodeignore]
indent_style = space
indent_size = 2

# Git ignore
[.gitignore]
indent_style = space
indent_size = 2
```

## Documentation

This `.editorconfig` enforces consistent formatting across the **AI Readiness Scanner** VS Code extension repository.

### Scope & Purpose

- **Root-level config** — `root = true` prevents EditorConfig from searching parent directories.
- **Consistent indentation** — All source, config, and documentation files use 2-space indentation.
- **Line endings** — LF for all files except PowerShell scripts (`scripts/install.ps1`), which use CRLF for Windows compatibility.
- **Trailing whitespace** — Trimmed everywhere except Markdown files (`*.md`), where trailing spaces can denote line breaks.

### File Type Coverage

| Glob | Applies to | Key rules |
|------|-----------|-----------|
| `*` | All files | 2-space indent, UTF-8, LF, trim trailing whitespace |
| `*.{ts,js}` | `src/extension.ts`, `esbuild.js`, `vitest.config.ts` | 120-char line length guidance |
| `*.json` | `package.json`, `tsconfig.json`, `.vscode/launch.json`, `.vscode/tasks.json` | Final newline enforced |
| `*.md` | `README.md`, `docs/`, `.github/copilot-instructions.md` | Trailing whitespace preserved |
| `*.{yml,yaml}` | `.release-fpa/`, `.release-manifestRollout/` pipelines | 2-space indent |
| `*.sh` | `scripts/install.sh` | LF line endings |
| `*.ps1` | `scripts/install.ps1` | CRLF line endings |
| `*.svg` | `media/icon.svg` | Final newline enforced |

### How It Works

1. Install the [EditorConfig extension](https://marketplace.visualstudio.com/items?itemName=EditorConfig.EditorConfig) in VS Code (or use a supported editor).
2. The editor automatically applies formatting rules when creating or editing files.
3. These rules complement but do not replace linter/formatter configs (ESLint, Prettier) — EditorConfig handles editor-level basics.

### Maintenance

- When adding new file types to the repo, add a matching section here.
- Keep glob patterns aligned with actual project paths listed above.