# Developer Environment Configuration

## Purpose

The `.vscode/` directory provides workspace-level VS Code settings that enable debugging and building the AI Readiness Scanner extension during development. These are shared developer configs committed to the repo — not personal preferences.

## Files

### `launch.json`

Defines debug launch profiles for the VS Code Extension Host.

- **Run Extension** — launches a new VS Code window (`extensionHost`) with the extension loaded from the local build output
- **Extension Tests** — runs the test suite inside an Extension Host context (if configured)

Key behavior:
- Uses `--extensionDevelopmentPath` pointing to the workspace root
- Depends on the `npm: watch` task to ensure compiled output is fresh before launch

### `tasks.json`

Defines build tasks consumed by launch profiles and available via the Command Palette (`Tasks: Run Task`).

- **watch** — runs `npm run watch` to continuously compile TypeScript via esbuild in watch mode
- **compile** — one-shot TypeScript compilation for CI or pre-launch checks

Both tasks use the `npm` task provider built into VS Code.

## Public API (for contributors)

There is no programmatic API. These configs are consumed automatically by VS Code.

| Action | How to trigger |
|---|---|
| Debug the extension | Press `F5` (or **Run → Start Debugging**) |
| Run watch build | `Ctrl+Shift+B` / `Cmd+Shift+B` (default build task) |
| Run tests in debugger | Select **Extension Tests** from the Run & Debug dropdown, press `F5` |

## How to Test

These configs don't have unit tests. Validate them manually:

1. Open the repo root in VS Code.
2. Press `F5` — a new Extension Host window should open with the scanner extension active.
3. Run `AI Readiness Scanner` commands in the new window to confirm activation.
4. Check the **Debug Console** in the original window for output and breakpoints.

To verify `tasks.json`:

```bash
# Should succeed without errors
npm run compile
```

## Gotchas

- **Pre-launch task dependency** — if the `watch` task fails silently, `F5` may launch stale code. Check the Terminal panel for TypeScript or esbuild errors.
- **VSIX files in repo root** — the checked-in `.vsix` files (`ai-readiness-scanner-1.1.*.vsix`) are release artifacts. The debug launch does **not** use them; it loads from `dist/` or `out/` built by esbuild.
- **Node version** — ensure your local Node version matches what `package.json` expects. Run `scripts/install.sh` (Unix) or `scripts/install.ps1` (Windows) to bootstrap.
- **Extensions conflict** — if you have the marketplace version of AI Readiness Scanner installed, disable it before debugging to avoid duplicate registrations.
- **`tsconfig.json` scope** — the compiler options in the root `tsconfig.json` govern what `tasks.json` compiles. Changes there affect the debug build.