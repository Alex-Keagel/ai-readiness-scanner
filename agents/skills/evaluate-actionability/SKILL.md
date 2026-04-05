# Evaluate Skill Actionability

## Description
Evaluates whether an AI agent can execute a SKILL.md's steps end-to-end without human clarification. Flags ambiguous instructions, missing prerequisites, and unclear outputs.

## Inputs
- `skills`: SkillFile[] — Array of skill files to evaluate (name, path, content)
- `max_batch`: number — Maximum skills to evaluate in one LLM call (default: 15)

## Steps
1. **Prepare batch** — Take up to `max_batch` skills, extract first 1500 chars of each.
2. **Send to LLM** — Prompt the LLM to simulate executing each skill as an agent with file read/write, terminal, and search tools (no internet, no GUI, no human confirmation).
3. **Evaluate per-skill** — For each skill, the LLM checks:
   - Are steps concrete actions or vague guidance? ("run `npm test`" vs "ensure quality")
   - Are prerequisites explicitly listed? (tools, env vars, permissions)
   - Is the output format clear? (file path, JSON schema, stdout)
   - Are error paths defined? (what happens when step 3 fails?)
   - Do any steps require human judgment? ("determine the best approach")
4. **Parse LLM response** — Extract per-skill scores (0-100), issues, and suggestions from JSON response.
5. **Match results to skills** — Fuzzy-match skill names from response to input skills. Unmatched skills default to score 50.

## Outputs
- `scores`: DimensionScore[] — One per skill: score (0-100), issues[], suggestions[]

## Validation
- A skill with all concrete, numbered steps and clear outputs must score ≥ 70
- A skill that says "review and fix as needed" must score ≤ 40
- If LLM is unavailable, return score 50 with issue "LLM unavailable — actionability not evaluated"

## Error Handling
- If LLM call fails, return default score 50 for all skills
- If JSON parsing fails, return default scores
- If a skill name isn't found in LLM response, default to score 50
