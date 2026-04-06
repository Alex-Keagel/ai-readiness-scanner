---
name: dev-package-release
description: "Package the extension as a VSIX, bump version, and commit a release."
---

# Dev: Package & Release

## Description
Package the extension as a VSIX, bump version, and commit a release.

## Inputs
- `bump_type`: patch | minor | major — semver bump type (default: patch)
- `commit`: boolean — whether to git commit after packaging (default: true)

## Steps
1. **Run full validation** — Execute the `dev-build-test` skill first. All checks must pass.
2. **Clean old VSIX files** — `rm -f *.vsix`
3. **Bump version** — Run `npm version ${bump_type} --no-git-tag-version`. Read the new version from output.
4. **Update README badge** — In `README.md`, find the version badge `version-X.Y.Z` and update to the new version.
5. **Update README test count** — In `README.md`, find `tests-NNN%20passing` and update with actual test count from step 1.
6. **Rebuild** — Run `node esbuild.js` (version is baked into package.json which esbuild reads).
7. **Package VSIX** — Run `npx vsce package --no-dependencies`. Verify `.vsix` file created and > 500KB.
8. **Git commit** — If `commit` is true:
   ```
   git add -A
   git commit -m "v{version}: {description}

   Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
   ```

## Outputs
- `version`: string — new semver version
- `vsix_path`: string — path to the .vsix file
- `vsix_size`: string — file size

## Validation
- VSIX file exists and is > 500KB
- `package.json` version matches the bumped version
- README badges are updated
- Git working tree is clean after commit

## Error Handling
- If `vsce package` fails, check that `publisher` is set in package.json.
- If VSIX is unexpectedly small, check `.vscodeignore` isn't excluding needed files.
