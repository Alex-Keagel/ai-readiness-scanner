---
name: evaluate-completeness
description: "Evaluates a SKILL.md file for structural completeness — checks required sections, numbered steps, typed inputs, defined outputs, and validation criteria."
---

# Evaluate Skill Completeness

## Description
Evaluates a SKILL.md file for structural completeness — checks required sections, numbered steps, typed inputs, defined outputs, and validation criteria.

## Inputs
- `skill_path`: path — Path to the SKILL.md file to evaluate
- `skill_content`: string — Raw markdown content of the skill file

## Steps
1. **Check required sections** — Verify presence of `## Steps`, `## Inputs`, `## Outputs`, `## Validation`. Each missing section: -20 points.
2. **Check recommended sections** — Check for `## Prerequisites`, `## Error Handling`, `## Examples`. Each missing: -5 points.
3. **Validate step numbering** — Steps section must contain numbered items (`1.`, `2.`, `3.`). Unnumbered steps: -15 points. Fewer than 3 steps: -5 points.
4. **Check input type annotations** — Inputs should have type annotations (`: string`, `: path`, `: number`). If < 50% have types: -5 points.
5. **Check output definitions** — Outputs section must contain named items with backtick identifiers. Empty outputs section: -10 points.
6. **Check content length** — File must be ≥ 200 characters. Shorter content: -15 points (too vague for agents).

## Outputs
- `score`: number (0-100) — Completeness score starting from 100, penalties subtracted
- `issues`: string[] — List of critical missing elements
- `suggestions`: string[] — List of recommended improvements

## Validation
- Score must be between 0 and 100 (clamped)
- A file with all 4 required sections, numbered steps, and ≥ 200 chars must score ≥ 80
- An empty file must score ≤ 20
