---
name: add-readiness-dimension
description: Adds a new agentic coding readiness dimension to the AI Readiness Scanner — updates the spec, scanner logic, scoring pipeline, report template, tests, and documentation.
---

# Add Readiness Dimension

Scaffold and wire a new readiness dimension end-to-end in the AI Readiness Scanner extension.

## Inputs

- `dimensionName`: Name of the new dimension (e.g., "Security Posture")
- `scoringCriteria`: Description of how scores 0–3 are assigned for this dimension
- `filePatterns`: Glob patterns or heuristics used to detect this dimension in a workspace

## Steps

1. **Add signal definition**
   - Open `src/scoring/levelSignals.ts`.
   - Add a new `LevelSignal` entry for `${dimensionName}` with:
     - Unique signal ID, maturity level, file patterns, content markers, weight, category.
   - Keep formatting consistent with existing signal entries.

2. **Add scanner logic in `src/`**
   - Create a new scanner function (or extend an existing module) that evaluates `${dimensionName}`.
   - Use helpers from `src/utils.ts` for file traversal and glob/pattern matching against `${filePatterns}`.
   - The function must return a score (0–100) and findings (file paths, matched evidence).
   - Follow the same function signature pattern used by existing scanner functions in `src/scanner/`.

3. **Register in the scoring pipeline**
   - In `src/scoring/maturityEngine.ts`, add the signal to `PLATFORM_SIGNAL_CLASS` for relevant platforms.
   - Ensure the signal contributes to the correct dimension (presence/quality/operability/breadth).

4. **Update the Markdown report template**
   - In `src/report/markdownGenerator.ts`, add the dimension to the report output if applicable.

5. **Add unit tests**
   - Create or extend test files under the Vitest suite.
   - Cover at minimum:
     - Signal fully detected (score 100).
     - Signal absent (score 0).
     - Partial detection.
     - Edge case: workspace with no files.
   - Mock file system inputs using patterns from existing tests.

6. **Update documentation**
   - In `README.md`, add `${dimensionName}` to the scoring section if user-facing.

## Outputs

- `src/scoring/levelSignals.ts` — new signal definition
- `src/scoring/maturityEngine.ts` — signal registered in platform classification
- `src/scanner/` — new or modified scanner function
- Test file(s) — Vitest unit tests
- `README.md` — updated if user-facing dimension

## Validation

- Run `npx vitest` and confirm all tests pass (zero failures).
- Run `npm run compile` and confirm no TypeScript errors.
- Launch the Extension Host (`F5` using `.vscode/launch.json` "Run Extension" profile) and trigger the scan command — verify `${dimensionName}` appears in the generated Markdown report with a valid score.