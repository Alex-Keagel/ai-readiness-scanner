---
name: onboard-developer-environment
description: Bootstraps a developer environment for the AI Readiness Scanner VS Code extension, verifying prerequisites, running installers, and confirming build/test readiness.
---

# Onboard Developer Environment

## Inputs

- `platform`: `'unix'` | `'windows'` | `'auto-detect'`

## Steps

1. **Detect OS** (if `platform` is `auto-detect`)
   - Check for `/bin/bash` → unix/macOS
   - Check for `powershell.exe` or `$env:OS -eq 'Windows_NT'` → windows

2. **Run the platform installer**
   - Unix/macOS: `bash scripts/install.sh`
   - Windows: `powershell -ExecutionPolicy Bypass -File scripts/install.ps1`
   - Capture stdout/stderr for the status report

3. **Verify prerequisites**
   - Run `node --version` — confirm Node.js is installed and meets any `engines` constraint in `package.json`
   - Run `npm --version` — confirm npm is available
   - Run `code --version` — confirm VS Code CLI is on PATH
   - If any check fails, report the exact missing tool and required version

4. **Confirm dependencies installed**
   - Verify `node_modules/` directory exists and is non-empty
   - Verify `package-lock.json` is present (already committed)
   - If missing, re-run `npm install` and check again

5. **TypeScript compilation check**
   - Run `npx tsc --noEmit`
   - Confirm exit code 0 with zero errors
   - If errors, capture and include diagnostics in the report

6. **Run test suite**
   - Run `npx vitest run` (configured via `vitest.config.ts`)
   - Confirm all tests pass
   - If failures, capture test names and error output

7. **Validate debug launch profiles**
   - Read `.vscode/launch.json` — extract every `preLaunchTask` value
   - Read `.vscode/tasks.json` — extract every task `label`
   - Confirm each `preLaunchTask` matches a defined task label
   - Flag any orphaned references

8. **Generate onboarding status summary**
   - Produce a Markdown table with columns: Check, Status (✅ / ❌), Details
   - Checks: OS Detection, Installer, Node.js, npm, VS Code CLI, node_modules, TypeScript Compilation, Test Suite, Launch Profile Validation
   - If all pass → "Environment ready — press F5 to launch Extension Host"
   - If any fail → include actionable fix instructions per failed check

## Outputs

- Onboarding status report as Markdown with pass/fail for each check
- On full success: developer can press F5 in VS Code and the Extension Host launches via `.vscode/launch.json`

## Validation

- All 9 checks show ✅
- `npx tsc --noEmit` exits with code 0
- `npx vitest run` reports zero failures
- F5 launches the Extension Development Host without errors