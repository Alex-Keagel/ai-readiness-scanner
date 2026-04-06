---
name: dev-fix-scan-bug
description: "Diagnose and fix a bug in the scanning/scoring pipeline when scan results don't match expectations."
---

# Dev: Fix a Scan Bug

## Description
Diagnose and fix a bug in the scanning/scoring pipeline when scan results don't match expectations.

## Inputs
- `symptom`: string — what's wrong (e.g., "component X shows wrong score", "signal Y not detected")
- `expected`: string — what should happen
- `actual`: string — what actually happens
- `repo_name`: string — which repo was being scanned (optional)

## Steps
1. **Reproduce** — Open the repo in VS Code Extension Development Host (F5). Run a scan. Verify the symptom.
2. **Check Output panel** — View → Output → "AI Readiness Scanner". Look for errors, warnings, or unexpected values in the log. Search for the component/signal name.
3. **Trace the data flow** — Based on the symptom, identify which module is likely wrong:
   - Wrong component list → `src/scanner/componentMapper.ts`
   - Wrong signal detection → `src/scanner/maturityScanner.ts`
   - Wrong score calculation → `src/scoring/maturityEngine.ts`
   - Wrong recommendations → `src/deep/recommendationSynthesizer.ts` or `src/ui/recommendationsPanel.ts`
   - Wrong UI display → `src/ui/` panel files
   - Cross-repo contamination → `src/storage/runStorage.ts` or `src/extension.ts` (currentReport)
   - Wrong file exclusion → `src/deep/relevanceAgents.ts` or `src/scanner/componentMapper.ts` EXCLUDED_DIRS
4. **Add logging** — Add `logger.info()` calls at the suspected location to trace values.
5. **Fix** — Make the code change. Keep it surgical — don't refactor unrelated code.
6. **Test** — Write a test that would have caught this bug. Run `dev-build-test`.
7. **Verify** — Rerun the scan in Extension Host. Confirm the symptom is resolved.

## Outputs
- Fixed source file(s)
- New test(s) covering the bug
- All tests passing

## Validation
- The original symptom no longer occurs
- No existing tests broken
- TypeScript compiles with 0 errors

## Error Handling
- If the bug is in LLM output (hallucinated paths, wrong classification), check if the `OutputValidator` or `RecommendationValidator` should catch it.
- If the bug is cross-repo, verify all storage uses `workspaceState` not `globalState`.
