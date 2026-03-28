---
name: update-assessment-spec
description: Detects drift between the agentic coding assessment spec and the scanner implementation, optionally generating fixes.
---

# Update Assessment Spec

## Inputs

- `driftCheck`: boolean — if `true`, only report drift; if `false`, also generate fixes

## Steps

1. **Parse the spec**
   - Read `docs/AGENTIC_CODING_ASSESSMENT_SPEC.md`
   - Extract every dimension name, its scoring criteria (thresholds, ranges), assigned weight, and any referenced file glob patterns
   - Build a structured list: `specDimensions[]` with fields `{name, criteria, weight, patterns}`

2. **Parse the implementation**
   - Read `src/extension.ts` and `src/utils.ts`
   - Identify every dimension the scanner actually evaluates (look for scoring functions, dimension string literals, enum values, or config objects)
   - Extract implemented scoring logic: threshold values, weight multipliers, and glob patterns used for file discovery
   - Build a structured list: `implDimensions[]` with fields `{name, criteria, weight, patterns}`

3. **Compare and identify drift**
   - Dimensions present in `specDimensions` but missing from `implDimensions` → **Spec-only (unimplemented)**
   - Dimensions present in `implDimensions` but missing from `specDimensions` → **Impl-only (undocumented)**
   - Dimensions in both but with differing `criteria` thresholds → **Scoring mismatch**
   - Dimensions in both but with differing `weight` values → **Weight mismatch**
   - Dimensions in both but with differing `patterns` → **Pattern mismatch**

4. **Generate drift report**
   - Output a Markdown summary with sections:
     - `## Spec-Only Dimensions` — table of dimensions in spec but not implemented
     - `## Undocumented Dimensions` — table of dimensions implemented but not in spec
     - `## Scoring Mismatches` — table showing spec value vs implementation value
     - `## Weight Mismatches` — table showing spec weight vs implementation weight
     - `## Pattern Mismatches` — table showing spec patterns vs implementation patterns
     - `## Summary` — total discrepancy count and pass/fail verdict

5. **Generate fixes (only when `driftCheck` is `false`)**
   - For spec-only dimensions: add TODO comments and code stubs in `src/extension.ts` marking the unimplemented dimension
   - For undocumented dimensions: generate Markdown additions for `docs/AGENTIC_CODING_ASSESSMENT_SPEC.md` documenting the dimension, its criteria, weight, and patterns
   - For scoring/weight/pattern mismatches: generate patch suggestions showing the spec line to update or the source line to update, preferring spec-as-source-of-truth unless the implementation is clearly more correct
   - If any high-level capability descriptions in `docs/README.md` are affected (new dimensions added or removed), update `docs/README.md` accordingly

6. **Apply patches**
   - Write updated `docs/AGENTIC_CODING_ASSESSMENT_SPEC.md` if changes were generated
   - Write updated `docs/README.md` if changes were generated
   - Insert TODO stubs in `src/extension.ts` if unimplemented dimensions exist

## Outputs

- **Drift report**: Markdown summary of all discrepancies (always produced)
- **Patched files** (when `driftCheck` is `false`):
  - `docs/AGENTIC_CODING_ASSESSMENT_SPEC.md` with added/corrected dimension entries
  - `docs/README.md` with updated capability descriptions
  - `src/extension.ts` with TODO stubs for unimplemented dimensions

## Validation

- Re-run steps 1–4 after applying patches
- Confirm the drift report shows **zero discrepancies** across all categories
- If discrepancies remain, repeat step 5 targeting only the remaining items