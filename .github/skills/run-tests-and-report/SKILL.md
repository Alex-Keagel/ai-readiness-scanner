---
name: run-tests-and-report
description: Runs the Vitest test suite with coverage, parses results, and produces a markdown summary report with threshold checks.
---

# Run Tests & Report

## Inputs

- `testFilter`: _(optional)_ glob or test name pattern to filter tests
- `coverageThreshold`: _(optional)_ minimum coverage percentage — default: `80`

## Steps

1. **Verify vitest is available**
   - Check that `vitest.config.ts` exists at project root.
   - Check `node_modules/.bin/vitest` exists. If not, instruct the user to run `npm ci` and stop.

2. **Parse vitest config**
   - Read `vitest.config.ts` to identify test file include/exclude patterns.
   - Note any existing coverage configuration (provider, thresholds, reporters).

3. **Run the test suite**
   - Execute:
     ```shell
     npx vitest run --reporter=json --coverage
     ```
   - If `testFilter` is provided, append `--testNamePattern "<testFilter>"`.
   - Capture stdout as JSON and stderr for error diagnostics.

4. **Parse test results**
   - Extract from JSON output:
     - `total`: number of test cases
     - `passed`: number passed
     - `failed`: number failed
     - `skipped`: number skipped
   - Store as `testSummary`.

5. **Parse coverage summary**
   - Read the coverage JSON summary (typically `coverage/coverage-summary.json`).
   - Extract percentages for: `statements`, `branches`, `functions`, `lines`.
   - Store as `coverageReport`.

6. **Check thresholds**
   - Compare each dimension in `coverageReport` against `coverageThreshold`.
   - Collect any dimension below target into `belowThreshold` list with its actual value.

7. **Format markdown report**
   - Build `markdownReport` containing:
     - **Test Results** table: | Metric | Count | with total, passed, failed, skipped rows.
     - **Coverage** table: | Dimension | Percentage | Status | where Status is ✅ or ❌ vs threshold.
     - **Below Threshold** section listing flagged dimensions (if any).
     - **First Failure Detail** section (if any test failed): include test name, file path, and assertion message from the first failure entry in the JSON output.

## Outputs

- `testSummary`: `{ total, passed, failed, skipped }`
- `coverageReport`: `{ statements, branches, functions, lines }` — each a percentage number
- `belowThreshold`: list of `{ dimension, actual, threshold }` objects for coverage dimensions under target
- `markdownReport`: formatted markdown string containing both tables and any failure details

## Error Handling

- **vitest not installed**: Output message — _"vitest not found. Run `npm ci` to install dependencies before retrying."_ — and stop.
- **Tests fail**: Do NOT stop the skill. Include the first failure's `testName`, `filePath`, and `assertionMessage` in both `markdownReport` and as structured data in outputs.
- **Coverage data missing**: If `coverage/coverage-summary.json` is not generated, warn in `markdownReport` and set all `coverageReport` values to `null`.
- **JSON parse errors**: If vitest JSON output is malformed, include raw stderr in `markdownReport` and set `testSummary` values to `null`.