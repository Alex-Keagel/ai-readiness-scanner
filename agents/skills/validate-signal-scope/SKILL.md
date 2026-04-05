# Validate Signal Scope

## Description
Validates that detected AI readiness signals are correctly scoped to root level in monorepos. Filters out sub-project signals that would inflate root-level maturity scores.

## Steps
1. Receive signal results and sub-project boundary paths
2. For each signal with `detected: true`, classify evidence files as root or sub-project
3. If ALL files are in sub-projects: set `detected: false` for root scoring
4. Normalize synthetic signal IDs to canonical platform classes
5. Guard against empty-files hallucinations
6. Return scoped signal results with audit trail

## Inputs
- `signals`: Array of `{ signalId, detected, files, score, finding }`
- `subProjectPaths`: Array of sub-project directory prefixes
- `projectType`: 'monorepo' | 'app' | 'library' | etc.

## Outputs
- `scopedSignals`: Array with corrected detection status
- `filtered`: Array of `{ signalId, reason, originalFiles, removedFiles }`

## Quality Criteria
- Zero sub-project signal leakage to root level
- Root signals with root-level files are preserved
- Non-monorepo projects pass through unchanged
- Synthetic IDs correctly mapped to critical/required/recommended
