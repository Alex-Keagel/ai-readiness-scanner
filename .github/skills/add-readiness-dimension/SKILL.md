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

1. **Update the assessment spec**
   - Open `docs/AGENTIC_CODING_ASSESSMENT_SPEC.md`.
   - Add a new section for `${dimensionName}` with:
     - Definition and rationale.
     - Scoring rubric row (0 = not detected, 1 = minimal, 2 = moderate, 3 = comprehensive).
     - Suggested weight relative to existing dimensions.
   - Keep formatting consistent with existing dimension entries.

2. **Add scanner logic in `src/`**
   - Create a new scanner function (or extend an existing module) that evaluates `${dimensionName}`.
   - Use helpers from `src/utils.ts` for file traversal and glob/pattern matching against `${filePatterns}`.
   - The function must return a score (0–3) and an array of findings (file paths, matched evidence).
   - Follow the same function signature pattern used by existing scanner functions in `src/`.

3. **Register in the scoring pipeline**
   - In `src/extension.ts`, import the new scanner function.
   - Add it to the dimension registry / scoring aggregation pipeline so it contributes to the overall readiness score.
   - Apply the weight defined in step 1.

4. **Update the Markdown report template**
   - In `src/extension.ts` (or wherever the report string is assembled), add a section for `${dimensionName}`.
   - Include the dimension's score, weight, and itemized findings.

5. **Add unit tests**
   - Create or extend test files under the Vitest suite.
   - Cover at minimum:
     - Dimension fully present (score 3).
     - Dimension completely absent (score 0).
     - Partial detection (score 1 or 2).
     - Edge case: workspace with no files.
   - Mock file system inputs using patterns from existing tests.

6. **Update documentation**
   - In `docs/README.md`, add `${dimensionName}` to the list of assessed dimensions.
   - Briefly describe what the dimension measures and which `${filePatterns}` trigger detection.

## Outputs

- `docs/AGENTIC_CODING_ASSESSMENT_SPEC.md` — new dimension definition and scoring rubric row
- `src/` — new or modified scanner function for the dimension
- `src/extension.ts` — dimension registered in scoring pipeline and report template
- Test file(s) — Vitest unit tests covering score 0/1/2/3 and edge cases
- `docs/README.md` — updated component documentation

## Validation

- Run `npx vitest` and confirm all tests pass (zero failures).
- Run `npm run compile` and confirm no TypeScript errors.
- Launch the Extension Host (`F5` using `.vscode/launch.json` "Run Extension" profile) and trigger the scan command — verify `${dimensionName}` appears in the generated Markdown report with a valid score.