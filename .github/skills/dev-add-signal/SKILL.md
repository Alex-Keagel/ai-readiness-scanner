---
name: dev-add-signal
description: "Add a new signal to the scoring system — from definition to scanner logic to tests."
---

# Dev: Add a New Maturity Signal

## Description
Add a new signal to the scoring system — from definition to scanner logic to tests.

## Inputs
- `signal_id`: string — unique kebab-case ID (e.g., `copilot_playbooks`)
- `signal_name`: string — human-readable name
- `level`: 1-6 — maturity level this signal belongs to
- `file_patterns`: string[] — glob patterns to detect (e.g., `['.github/playbooks/**']`)
- `category`: file-presence | content-quality | depth
- `weight`: number — 0-25 importance weight
- `platform`: string — which platform this is for (copilot, cline, cursor, etc.) or 'shared'

## Steps
1. **Add signal definition** — Open `src/scoring/levelSignals.ts`. Add a new entry to the `LEVEL_SIGNALS` array:
   ```typescript
   { id: '${signal_id}', level: ${level}, name: '${signal_name}', description: '...', filePatterns: ${file_patterns}, contentMarkers: [], weight: ${weight}, category: '${category}' },
   ```
2. **Register in platform signal class** — Open `src/scoring/maturityEngine.ts`. Add the signal to `PLATFORM_SIGNAL_CLASS.${platform}` with classification (critical/required/recommended).
3. **Add to platform signal filter** — Open `src/scoring/signalFilter.ts`. Add the signal ID to the relevant platform's signal list and assign its EGDR dimension.
4. **Add scanner logic** (if content-quality) — In `src/scanner/maturityScanner.ts`, add detection logic in the appropriate level scanning method. For file-presence, the existing glob scanner handles it automatically.
5. **Add to AI_TOOLS** — If this signal has file patterns, add them to `AI_TOOLS.${platform}.level${level}Files` in `src/scoring/types.ts`.
6. **Write tests** — Create tests in `src/test/scoring/` verifying:
   - Signal is in LEVEL_SIGNALS with correct properties
   - Signal appears in PlatformSignalFilter for the target platform
   - Signal does NOT appear for other platforms (if platform-specific)
7. **Run validation** — Execute `dev-build-test` skill.

## Outputs
- `src/scoring/levelSignals.ts` — new signal entry
- `src/scoring/maturityEngine.ts` — platform classification
- `src/scoring/signalFilter.ts` — dimension mapping
- Test file(s) with signal presence/absence tests

## Validation
- Signal appears in `getAllSignals()` output
- Signal appears in `PlatformSignalFilter.getSignalIds('${platform}')`
- Signal does NOT appear for unrelated platforms
- All existing tests still pass

## Error Handling
- If signal ID conflicts with existing signal, abort with message showing the conflict.
- If file patterns are invalid globs, test with `vscode.workspace.findFiles` before committing.
