---
name: dev-build-test
description: "Full development cycle: compile, run tests, check types, and validate the extension is ready for packaging."
---

# Dev: Build, Test & Validate

## Description
Full development cycle: compile, run tests, check types, and validate the extension is ready for packaging.

## Inputs
- `fix_errors`: boolean — if true, attempt to fix TypeScript/lint errors before reporting (default: false)

## Steps
1. **Install dependencies** — Run `npm ci` if `node_modules/` is missing or stale.
2. **TypeScript check** — Run `npx tsc --noEmit`. If errors found and `fix_errors` is true, read the errors, fix the source files, and re-run.
3. **Run tests** — Run `npm test` (vitest). All tests must pass. If failures, read the error output, identify the failing test and the source code, and suggest fixes.
4. **Build bundle** — Run `node esbuild.js`. Verify `dist/extension.js` exists and is > 0 bytes.
5. **Verify test count** — Parse vitest output for total test count. Log it. Current baseline: 568+ tests.

## Outputs
- `ts_errors`: number — TypeScript compilation errors (0 = clean)
- `test_result`: pass | fail — overall test status
- `test_count`: number — total tests run
- `bundle_size`: string — size of dist/extension.js

## Validation
- `npx tsc --noEmit` exits with code 0
- `npm test` exits with code 0
- `dist/extension.js` exists and is > 100KB

## Error Handling
- If `npm ci` fails, check `package-lock.json` is committed and Node version matches `.nvmrc` or `package.json` engines.
- If TypeScript errors, show file:line:column with the error message.
- If tests fail, show the test name, expected vs received, and the source file.
