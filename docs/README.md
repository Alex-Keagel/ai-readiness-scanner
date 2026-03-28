# AI Readiness Scanner — Component Documentation

## What It Does

AI Readiness Scanner is a VS Code extension that analyzes a codebase and assesses its readiness for AI/agentic coding adoption. It scans project files, evaluates structure, patterns, and practices against criteria defined in [AGENTIC_CODING_ASSESSMENT_SPEC.md](./AGENTIC_CODING_ASSESSMENT_SPEC.md), then produces an actionable readiness report.

### Core Capabilities

- **Workspace scanning** — Traverses the active VS Code workspace to inventory files, structure, and configuration
- **Readiness assessment** — Scores the codebase against agentic coding readiness criteria (documentation, modularity, test coverage, CI/CD, etc.)
- **Report generation** — Outputs a Markdown insight report (e.g., `generated-insight-improvement-Component-.md`) with improvement recommendations
- **VS Code integration** — Registers commands and UI entry points via the extension activation lifecycle

## Architecture

```
src/
├── extension.ts   — Entry point: activates extension, registers VS Code commands
├── utils.ts       — Shared scanning/analysis utilities
```

- `extension.ts` exports an `activate(context: vscode.ExtensionContext)` function (required by VS Code extension API) and registers commands defined in `package.json` under `contributes.commands`.
- `utils.ts` contains pure/shared logic for file traversal, pattern matching, and score computation — kept separate for testability.

## Public API

This is a VS Code extension, not a library with a programmatic API. The public surface is:

| Surface | Identifier | Description |
|---------|-----------|-------------|
| **Activation event** | See `activationEvents` in `package.json` | Triggers extension load |
| **Commands** | Defined in `package.json` → `contributes.commands` | User-facing actions accessible via Command Palette |
| **Extension entry** | `activate()` / `deactivate()` in `src/extension.ts` | VS Code lifecycle hooks |

### Utility Exports (`src/utils.ts`)

Utility functions are internal but importable for testing. Refer to the file directly for current signatures — key areas include:

- File/directory traversal helpers
- Pattern detection and scoring logic
- Report formatting utilities

## How to Test

### Prerequisites

```bash
npm install
```

### Run Unit Tests

```bash
npm test
```

Tests use **Vitest** (configured in `vitest.config.ts`). Test files should be colocated or placed in a `test/` directory matching Vitest's default glob patterns.

### Run the Extension in Debug Mode

1. Open the repo in VS Code
2. Press **F5** (uses `.vscode/launch.json` → "Run Extension" profile)
3. A new Extension Development Host window opens with the extension loaded
4. Open a target workspace and invoke scanner commands via the Command Palette

### Build & Bundle

```bash
npx esbuild --bundle src/extension.ts --outdir=dist --platform=node --external:vscode
```

Or use the configured build task:

```bash
npm run compile
```

The bundler config lives in `esbuild.js`.

### Package as VSIX

```bash
npx @vscode/vsce package
```

## Gotchas

### 1. Multiple `.vsix` files in repo root
There are 8 `.vsix` binaries checked into the repository (`ai-readiness-scanner-1.1.1.vsix` through `1.1.8.vsix`). These are build artifacts and should ideally be in `.gitignore`. Don't assume the latest `.vsix` matches `HEAD` — always rebuild.

### 2. `vscode` is an external dependency
The `vscode` module is provided by the extension host at runtime. It must be listed in `devDependencies` (not `dependencies`) and marked as `external` in esbuild. Importing it in unit tests requires mocking — Vitest tests cannot load the real `vscode` API.

### 3. Single-file architecture
All extension logic lives in two files (`extension.ts` + `utils.ts`). When adding features, keep `extension.ts` thin (registration/activation only) and push logic into `utils.ts` or new modules for testability.

### 4. Generated report filename
The output file `generated-insight-improvement-Component-.md` has a trailing dash suggesting a template token that isn't being replaced. Check the report generation logic in `utils.ts` if component names are missing from output filenames.

### 5. Cross-platform install scripts
`scripts/install.ps1` (Windows) and `scripts/install.sh` (Unix/macOS) handle environment setup. They are **not** invoked by `npm install` automatically — run them manually on first setup if your environment needs system-level dependencies.

### 6. Assessment spec is the source of truth
All scoring criteria and readiness dimensions are defined in [`docs/AGENTIC_CODING_ASSESSMENT_SPEC.md`](./AGENTIC_CODING_ASSESSMENT_SPEC.md). Changes to assessment logic in code must stay in sync with this spec.