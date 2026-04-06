---
name: validate-component-names
description: "Validates that LLM-enriched component names are anchored to actual filesystem directory names. Prevents fabricated business names."
---

# Validate Component Names

## Description
Validates that LLM-enriched component names are anchored to actual filesystem directory names. Prevents fabricated business names that mislead developers.

## Steps
1. Receive component list with `path` and `name` fields
2. For each component, extract the actual directory name from `path`
3. Classify directory name as GENERIC or NON-GENERIC
4. If NON-GENERIC and name differs significantly from directory: reset to directory name
5. If GENERIC: allow LLM name but append `(dirName/)` suffix
6. Return validated component list with audit trail

## Inputs
- `components`: Array of `{ path: string, name: string, language: string }`
- `workspaceUri`: Root workspace path for filesystem verification

## Outputs
- `validatedComponents`: Array with corrected names
- `changes`: Array of `{ path, before, after, reason }`

## Quality Criteria
- Zero fabricated names that don't reference the real directory
- All generic directories have enriched + anchored names
- All non-generic directories preserve their original name
- Names are ≤60 characters
