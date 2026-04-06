---
name: generate-readiness-report
description: "Scans a workspace for agentic coding readiness, generates a structured assessment report, validates it against the canonical spec, and returns scores with improvement recommendations."
---

# Generate Readiness Report

Scan a codebase for agentic coding readiness and produce a validated assessment report.

## Inputs

- `workspacePath` — Path to the workspace to scan. Default: current workspace root.
- `outputPath` — Where to write the report. Default: opens in VS Code editor.
- `dimensions` — Optional list of specific dimensions to assess. Default: all signals from `src/scoring/levelSignals.ts`.

## Steps

1. **Verify build output exists**
   - Check that the bundled extension JS exists (output defined in `esbuild.js`).
   - If missing, run `npm run compile` or invoke the `build-bundle-validate` skill.

2. **Execute the scanner**
   - Launch the Extension Host using the debug profile in `.vscode/launch.json`.
   - Invoke `AI Readiness: Scan Workspace` command (ID: `ai-readiness.fullScan`).
   - Select the target AI platform when prompted.

3. **Capture the report**
   - The scanner generates a ReadinessReport with scores per level, component scores, and insights.
   - Report opens automatically in a webview panel.

4. **Validate report completeness**
   - Check that all 6 maturity levels have signal results.
   - Verify component scores exist for discovered components.
   - Check that insights were generated (LLM analysis section).

5. **Produce summary**
   - Extract `overallScore` from the report.
   - Rank components by score ascending — bottom 3 are top recommendations.
   - Format recommendations with component name, score, and actionable next steps.

## Outputs

- `reportPath` — Path to the generated report (if exported to file).
- `overallScore` — Aggregate readiness score (0-100).
- `topRecommendations` — Top 3 lowest-scoring components with improvement suggestions.

## Error Handling

- **Extension fails to activate** — Check `package.json` `activationEvents`, run `npm ci`.
- **Report is empty** — Verify workspace has scannable files, check Output pane for errors.
- **Build fails** — Run `npm run compile`, inspect TypeScript errors, run `npm ci`.