---
name: evaluate-accuracy
description: "Verifies that a SKILL.md file references real paths, valid commands, and accurate technical claims by cross-referencing against the actual repository."
---

# Evaluate Skill Accuracy

## Description
Verifies that a SKILL.md file references real paths, valid commands, and accurate technical claims by cross-referencing against the actual repository.

## Inputs
- `skill_path`: path — Path to the SKILL.md file
- `skill_content`: string — Raw markdown content
- `workspace_uri`: path — Workspace root for disk verification

## Steps
1. **Extract path references** — Find all backtick-wrapped paths and paths after prepositions (`in`, `at`, `see`, `from`, `edit`). Filter out false positives (`try/catch`, `async/await`, `input/output`). Strip leading `./`.
2. **Verify paths on disk** — For each extracted path, check existence via `workspace.fs.stat()`. Count valid vs invalid. Each invalid path: -10 points (max -50).
3. **Extract commands** — Find backtick-wrapped commands starting with `npm`, `npx`, `yarn`, `node`, `python`, `pip`, `go`, `cargo`, `make`, `bash`, `uv`.
4. **Check command placeholders** — Flag commands containing `TODO`, `FIXME`, or `undefined`. Each: -10 points.
5. **LLM cross-reference** (optional) — Send skill content to LLM asking for factual accuracy rating (0-100). Blend: 60% deterministic score + 40% LLM score.

## Outputs
- `score`: number (0-100) — Accuracy score. Base 100 for no path refs, or 30 base + 70 × (valid/total) when paths exist
- `issues`: string[] — Invalid paths and commands found
- `suggestions`: string[] — Recommended corrections

## Validation
- A skill referencing only existing paths must score ≥ 80
- A skill where all paths are invalid must score ≤ 30
- LLM score < 50 adds an issue: "LLM detected potential inaccuracies"

## Error Handling
- If `workspace.fs.stat()` throws, treat path as invalid
- If LLM is unavailable, use deterministic score only (no penalty)
