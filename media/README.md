# Extension Assets & Media

## Purpose

This directory contains visual assets used for the AI Readiness Scanner VS Code extension — marketplace listing, activity bar icon, and in-extension UI branding.

## Contents

| File | Format | Usage |
|------|--------|-------|
| `icon.svg` | SVG | Source vector icon — used as the canonical brand asset |
| `icon.png` | PNG | Rasterized icon referenced by `package.json` → `"icon": "media/icon.png"` for VS Code Marketplace and extension sidebar |

## How Assets Are Referenced

- **Marketplace listing**: `package.json` field `"icon"` points to `media/icon.png`. VS Code requires a PNG (128×128 minimum, 256×256 recommended).
- **Extension views**: If the extension registers tree views or webview panels, assets in this directory can be referenced via `vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg')`.
- **Bundling**: `.vscodeignore` in the repo root controls which media files are included in the `.vsix` package. Verify new assets are **not** excluded.

## Public API

This component has no code API — it is a static asset directory. Other components consume these files by path reference only.

## Adding or Updating Assets

1. Edit `icon.svg` as the source of truth.
2. Export a PNG at **256×256 px** minimum, save as `icon.png` in this directory.
3. Verify the `package.json` `"icon"` field still points to `media/icon.png`.
4. Rebuild and inspect the `.vsix` to confirm the new asset is packaged:
   ```bash
   npx @vscode/vsce ls
   ```
5. Check the marketplace preview:
   ```bash
   npx @vscode/vsce package --out test.vsix
   ```

## Testing

No automated tests target static assets directly. Manual verification checklist:

- [ ] `icon.png` renders correctly in the Extensions sidebar (run the extension via `F5` → Debug Launch Profile).
- [ ] `icon.svg` displays without artifacts when opened in a browser.
- [ ] After `npx @vscode/vsce package`, run `npx @vscode/vsce ls` and confirm both `media/icon.png` and `media/icon.svg` appear in the bundle.

## Gotchas

- **PNG is required for Marketplace** — VS Code Marketplace rejects extensions with only SVG icons. Always keep `icon.png` in sync with `icon.svg`.
- **File size matters** — Marketplace recommends icons under 100 KB. Optimize PNGs with `pngquant` or similar before committing.
- **Path casing** — VS Code on Linux is case-sensitive. Always reference `media/icon.png` exactly as it appears on disk.
- **`.vscodeignore` can silently exclude assets** — If you add new files here, check that `.vscodeignore` patterns (e.g., `**/*.svg`) don't accidentally strip them from the package.
- **Do not delete `icon.png`** — The `package.json` manifest directly references it. A missing icon will cause `vsce package` to fail.