```markdown
---
name: generate-readiness-report
description: Scans a workspace for agentic coding readiness, generates a structured assessment report, validates it against the canonical spec, and returns scores with improvement recommendations.
---

# Generate Readiness Report

Scan a codebase for agentic coding readiness and produce a validated assessment report.

## Inputs

- `workspacePath` — Path to the workspace to scan. Default: current workspace root.
- `outputPath` — Where to write the report. Default: `generated-insight-improvement-Component-.md`.
- `dimensions` — Optional list of specific dimensions to assess. Default: all dimensions from `docs/AGENTIC_CODING_ASSESSMENT_SPEC.md`.

## Steps

1. **Verify build output exists**
   - Check that the bundled extension JS exists (output defined in `esbuild.js`).
   - If missing, run `npm run compile` or invoke the `build-bundle-validate` skill.
   - Confirm no TypeScript errors by checking against `tsconfig.json` settings.

2. **Locate the scanner entry point**
   - Open `src/extension.ts` and identify the registered VS Code command that triggers the readiness assessment.
   - Note the command ID declared in `package.json` under `contributes.commands`.

3. **Execute the scanner**
   - Option A: Launch the Extension Host using the debug profile in `.vscode/launch.json` and invoke the scan command.
   - Option B: Programmatically call the scanning logic exported from `src/extension.ts`, passing `workspacePath` as the target.
   - If `dimensions` input is provided, filter assessment to only those dimensions.

4. **Capture the report**
   - Wait for the scanner to write output to `outputPath`.
   - If `outputPath` is not specified, look for `generated-insight-improvement-Component-.md` in the workspace root.

5. **Validate report against spec**
   - Parse all dimension names and scoring criteria from `docs/AGENTIC_CODING_ASSESSMENT_SPEC.md`.
   - For each dimension in the spec, verify the report contains a corresponding section with a numeric score.
   - Collect any dimensions present in the spec but missing from the report into `missingDimensions`.

6. **Flag missing dimensions**
   - If `missingDimensions` is non-empty, list each missing dimension with its expected description from the spec.
   - Suggest re-running the scan or checking `src/utils.ts` for file traversal patterns that may have excluded relevant files.

7. **Produce summary**
   - Calculate `overallScore` as the aggregate of all dimension scores.
   - Rank dimensions by score ascending and extract the bottom 3 as `topRecommendations`.
   - Format recommendations with the dimension name, current score, and a concrete next action.

## Outputs

- `reportPath` — Absolute path to the generated report file.
- `overallScore` — Aggregate readiness score across all assessed dimensions.
- `missingDimensions` — List of dimensions defined in `docs/AGENTIC_CODING_ASSESSMENT_SPEC.md` but absent from the report.
- `topRecommendations` — Top 3 lowest-scoring dimensions with actionable improvement suggestions.

## Error Handling

- **Extension fails to activate**
  - Check `package.json` `activationEvents` array for correct event triggers.
  - Verify all dependencies are installed (`npm ci` using `package-lock.json`).
  - Review `.vscode/tasks.json` for pre-launch build task failures.

- **Report is empty or not generated**
  - Verify `workspacePath` contains scannable files by checking glob patterns in `src/utils.ts`.
  - Ensure the workspace is not excluded by `.gitignore` or `.vscodeignore` rules.
  - Check the VS Code Output pane for extension runtime errors.

- **Build fails**
  - Run `npm run compile` and inspect TypeScript errors against `tsconfig.json`.
  - Verify `esbuild.js` configuration resolves all entry points correctly.
  - Run `npm ci` to ensure deterministic dependency resolution from `package-lock.json`.

- **Dimension score validation fails**
  - Confirm the spec at `docs/AGENTIC_CODING_ASSESSMENT_SPEC.md` has not been modified without updating the scanner logic in `src/extension.ts`.
  - Cross-reference dimension IDs between spec and scanner source code.
```