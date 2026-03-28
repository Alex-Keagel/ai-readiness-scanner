# Installation Scripts

## Purpose

Cross-platform installation scripts for setting up the AI Readiness Scanner extension development environment. These scripts bootstrap dependencies and configure the local environment on Windows (`install.ps1`) and Unix/macOS (`install.sh`).

## Scripts

### `install.sh` — Unix/macOS Installer

- **Shell**: Bash
- **Supported platforms**: macOS, Linux
- **Usage**:
  ```bash
  chmod +x scripts/install.sh
  ./scripts/install.sh
  ```
- **What it does**:
  - Verifies Node.js and npm are installed
  - Runs `npm install` to restore dependencies from `package-lock.json`
  - Sets up the development environment for building and testing the extension

### `install.ps1` — Windows Installer

- **Shell**: PowerShell
- **Supported platforms**: Windows
- **Usage**:
  ```powershell
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  .\scripts\install.ps1
  ```
- **What it does**:
  - Verifies Node.js and npm are available on `PATH`
  - Runs `npm install` to restore dependencies
  - Configures the Windows development environment for the extension

## Prerequisites

| Requirement | Minimum Version | Check Command |
|---|---|---|
| Node.js | See `package.json` engines field | `node --version` |
| npm | Bundled with Node.js | `npm --version` |

## Connection to Other Components

| Component | Relationship |
|---|---|
| `package.json` / `package-lock.json` | Scripts run `npm install` against these manifests to restore all dev and runtime dependencies |
| `tsconfig.json` | TypeScript compiler config used after install when building via `npm run compile` |
| `esbuild.js` | Bundler config invoked post-install during `npm run build` to produce the extension bundle |
| `vitest.config.ts` | Test runner config available after dependencies are installed; run tests with `npm test` |
| `src/extension.ts` / `src/utils.ts` | Source files that can be compiled and tested once the install scripts have provisioned the environment |
| `.vscode/tasks.json` | Build tasks that depend on dependencies installed by these scripts |

## Testing the Installation Scripts

### Manual Verification

1. Clone the repository on a clean machine (or in a fresh container).
2. Run the appropriate install script for your platform.
3. Verify success:
   ```bash
   # All dependencies installed
   ls node_modules/.package-lock.json

   # TypeScript compiles
   npx tsc --noEmit

   # Tests pass
   npm test

   # Extension bundles
   node esbuild.js
   ```

### CI Verification

If integrated into a CI pipeline, the install scripts should:
- Exit with code `0` on success
- Exit with a non-zero code and print a diagnostic message if Node.js or npm is missing
- Be idempotent — safe to run multiple times without side effects

## Troubleshooting

| Problem | Solution |
|---|---|
| `node: command not found` | Install Node.js from https://nodejs.org or via a version manager (`nvm`, `fnm`) |
| `npm ERR! ERESOLVE` | Delete `node_modules` and `package-lock.json`, then re-run the install script |
| PowerShell execution policy error | Run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` before executing `install.ps1` |
| Permission denied on `install.sh` | Run `chmod +x scripts/install.sh` first |