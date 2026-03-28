---
name: build-bundle-validate
description: Restore dependencies, compile TypeScript, bundle with esbuild, and validate VSIX packaging for the ai-readiness-scanner extension.
---

# Build, Bundle & Validate

## Inputs

- `sourceDir`: path to TypeScript source (default: `src`)

## Steps

1. **Restore dependencies**
   - Run `npm ci` to install deterministic dependencies from `package-lock.json`
   - Fail immediately if `npm ci` exits non-zero

2. **TypeScript compilation check**
   - Run `npx tsc --noEmit` against `tsconfig.json`
   - Capture all diagnostic output (errors and warnings)
   - If compilation fails, extract the first 10 errors with file paths and line numbers and include them in `diagnostics`

3. **Bundle with esbuild**
   - Run `node esbuild.js`
   - If esbuild fails, capture full stderr and include in `diagnostics`
   - If esbuild succeeds, note the exit code

4. **Verify bundle output**
   - Read the `main` field from `package.json` (expected: `./dist/extension.js`)
   - Confirm the file exists at that path
   - Measure the file size in KB and record as `bundleSizeKB`

5. **Validate VSIX packaging**
   - Run `npx @vscode/vsce ls` to simulate packaging
   - Compare listed files against `.vscodeignore` exclusion rules
   - Flag any unexpected files that should be excluded or required files that are missing
   - Record warnings in `diagnostics`

6. **Report results**
   - Set `buildStatus` to `success` if steps 1–5 all pass, otherwise `failure`
   - Output `bundleSizeKB` as a number
   - Output `diagnostics` as a list of compiler errors, bundle errors, and packaging warnings

## Outputs

- `buildStatus`: `success` | `failure`
- `bundleSizeKB`: number — size of the bundled output file in kilobytes
- `diagnostics`: list of compiler/packaging warnings and errors

## Error Handling

- If `npm ci` fails, abort and set `buildStatus: failure` with the npm error output
- If `tsc` fails, surface the first 10 errors with file paths and line numbers; continue to bundle step
- If `node esbuild.js` fails, include full stderr in `diagnostics` and set `buildStatus: failure`
- If the bundle output file (from `package.json` `main` field) does not exist after esbuild, set `buildStatus: failure`
- If `npx @vscode/vsce ls` reports missing or extraneous files, include them as warnings but do not fail the build