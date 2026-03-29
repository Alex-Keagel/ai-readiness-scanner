# Extension Core (`src/`)

## What It Does

VS Code extension that scans a workspace for **agentic coding readiness**, scores it across multiple dimensions, and generates assessment reports.

Scoring criteria are defined in `src/scoring/levelSignals.ts` (signal definitions) and `src/scoring/maturityEngine.ts` (scoring pipeline). See the main [README](../README.md) for the full scoring methodology.

## Source Files

| File | Role |
|------|------|
| `extension.ts` | Entry point. Exports `activate()`/`deactivate()`. Registers VS Code commands, orchestrates scanning pipeline, and triggers report generation. |
| `utils.ts` | Shared helpers for file traversal, glob/pattern matching, and data transformation used by the scanner. |

## Public API

### `extension.ts`

- **`activate(context: vscode.ExtensionContext): void`** — Called by VS Code on extension activation. Registers all contributed commands from `package.json`.
- **`deactivate(): void`** — Cleanup hook called on extension shutdown.

### `utils.ts`

Utility functions consumed internally by `extension.ts`. Not exported as a public package API — treat as internal helpers.

## How to Build

```bash
npm run compile        # TypeScript compilation
npm run build          # esbuild production bundle (see ../esbuild.js)
npm run watch          # incremental recompilation on save
```

Output is bundled into a single JS file by `esbuild.js`.

## How to Test

```bash
npm test               # runs vitest (config: ../vitest.config.ts)
```

- Unit tests use **Vitest** — see `vitest.config.ts` at the repo root for runner configuration.
- For integration/E2E testing, use the **Extension Host** debug profile in `.vscode/launch.json` (`F5` in VS Code).

## How to Debug

1. Open the repo in VS Code.
2. Press `F5` — launches a sandboxed Extension Development Host window.
3. Run the extension commands from the Command Palette in the new window.
4. Debug launch profiles are defined in [`.vscode/launch.json`](../.vscode/launch.json); build tasks in [`.vscode/tasks.json`](../.vscode/tasks.json).

## Gotchas

- **Single-file bundle** — `esbuild.js` bundles everything into one output file. Don't add side-effectful top-level code in `utils.ts` unless it's gated behind a function call.
- **VS Code API is external** — The `vscode` module is NOT bundled; it's provided at runtime by the host. Never import sub-paths of `vscode`.
- **Activation events** — Commands must be declared in `package.json` under `contributes.commands` AND have matching activation events, or they silently won't register.
- **No workspace assumption** — The scanner must handle the case where no workspace folder is open (`vscode.workspace.workspaceFolders` may be `undefined`).
- **VSIX size** — `.vscodeignore` controls what ships in the package. If you add new runtime assets, ensure they aren't excluded. Conversely, don't ship test files or docs — check `.vscodeignore` before packaging.
- **Node target** — `tsconfig.json` targets the Node.js version embedded in VS Code's Electron. Don't use newer Node APIs without checking compatibility.