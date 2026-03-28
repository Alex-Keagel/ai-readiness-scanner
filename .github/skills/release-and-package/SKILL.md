---
name: release-and-package
description: Bumps version, builds, tests, packages the AI Readiness Scanner VS Code extension into a .vsix, and validates the artifact.
---

# Release and Package Extension

## Inputs

- `versionBump`: `patch` | `minor` | `major` — semver bump level
- `changelogEntry`: one-line summary of changes for this release

## Steps

1. **Bump version**
   - Run `npm version <versionBump>` in the repo root
   - This updates `package.json` version and creates a git tag

2. **Verify TypeScript compilation**
   - Run `npx tsc --noEmit`
   - Fix any type errors before proceeding

3. **Run tests**
   - Run `npx vitest run` (config at `vitest.config.ts`)
   - All tests must pass — do not continue on failure

4. **Bundle with esbuild**
   - Run `node esbuild.js --production`
   - Confirm the bundled output is generated without errors

5. **Package the extension**
   - Run `npx @vscode/vsce package`
   - Output: a `.vsix` file in the repo root (e.g., `ai-readiness-scanner-x.y.z.vsix`)

6. **Validate the `.vsix` artifact**
   - Confirm `media/icon.png` is included in the package
   - Confirm activation events in `package.json` are correct
   - Check bundle size is reasonable (compare to previous `.vsix` files in repo root)
   - Ensure no dev-only files leak into the package (respect `.vscodeignore`)

7. **Update changelog / release notes**
   - Add `changelogEntry` to the changelog under the new version heading
   - Update `README.md` if the release includes user-facing feature changes

8. **Verify ring rollout configs (if applicable)**
   - Check `.release-manifestRollout/` pipeline YAML files reference the new version
   - Check `.release-fpa/` configs if credential rotation is part of this release

## Outputs

- Versioned `.vsix` file in repo root (e.g., `ai-readiness-scanner-1.4.0.vsix`)
- Git tag matching the new version (e.g., `v1.4.0`)
- Updated changelog with `changelogEntry`

## Validation

- Install locally: `code --install-extension ai-readiness-scanner-<version>.vsix`
- Open a workspace and run the scan command from the command palette
- Confirm the Markdown assessment report is generated without errors
- Verify the extension icon appears correctly in the sidebar and extensions panel