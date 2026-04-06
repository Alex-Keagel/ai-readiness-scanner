---
name: evaluate-relevance
description: "Evaluates whether a SKILL.md is still relevant to the project's current state by comparing referenced tools, commands, and paths against actual configuration."
---

# Evaluate Skill Relevance

## Description
Evaluates whether a SKILL.md is still relevant to the project's current state by comparing referenced tools, commands, and paths against the actual project configuration.

## Inputs
- `skills`: SkillFile[] — Array of skill files to evaluate
- `workspace_uri`: path — Workspace root for reading project config
- `max_batch`: number — Maximum skills per LLM call (default: 15)

## Steps
1. **Read project context** — Load `package.json` (extract scripts), `pyproject.toml` (extract scripts/tools), or `Makefile` (extract targets) from workspace root.
2. **Prepare batch** — Take up to `max_batch` skills, extract first 800 chars of each.
3. **Send to LLM** — Prompt the LLM to compare each skill against the project context. Check for:
   - Skills referencing tools the project doesn't use (e.g., Docker when no Dockerfile exists)
   - Skills so generic they could apply to any project (no project-specific details)
   - Skills referencing deprecated or removed modules
   - Skills duplicating functionality handled by CI/CD pipelines
   - Skills perfectly tailored to this specific project
4. **Parse LLM response** — Extract per-skill scores (0-100), issues (outdated reasons), and suggestions (update ideas).
5. **Match results to skills** — Fuzzy-match skill names. Unmatched default to score 50.

## Outputs
- `scores`: DimensionScore[] — One per skill: score (0-100), issues[], suggestions[]

## Validation
- A skill that references real `package.json` scripts and existing files must score ≥ 70
- A generic "run tests" skill with no project-specific content must score ≤ 50
- If project config can't be read, all skills default to score 50

## Error Handling
- If `package.json` fails to parse, use fallback context "package.json exists but could not be parsed"
- If LLM call fails, return default score 50 for all skills
- If workspace has no manifest files, note "No package.json found" in context
