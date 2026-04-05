# Evaluate Skill Security

## Description
Reviews SKILL.md files for security risks using deterministic pattern matching and optional LLM review. Flags dangerous commands, missing confirmation steps, secret exposure, and permission escalation.

## Inputs
- `skills`: SkillFile[] — Array of skill files to evaluate
- `max_batch`: number — Maximum skills for LLM security review (default: 10)

## Steps
1. **Deterministic pattern scan** — For each skill, check content against dangerous patterns:
   - `rm -rf /` or `rm -rf ~`: unrestricted recursive deletion → -15 points
   - `curl ... | bash` or `wget ... | sh`: pipe-to-shell injection risk → -15 points
   - `eval(`: dynamic code execution → -15 points
   - `chmod 777`: world-writable permissions → -15 points
   - `--force` or `--no-verify`: bypassing safety checks → -15 points
   - `$PASSWORD`, `$SECRET`, `$TOKEN` references: check for secure handling → -15 points
2. **Check deployment safety** — If skill contains `npm publish`, `git push`, `docker push`, verify it also mentions `confirm`, `approval`, `review`, or `dry-run`. Missing: -10 points.
3. **Check error handling** — If skill content has no mention of `error`, `fail`, `exception`, `catch`, `rollback`, or `abort`: -5 points with suggestion.
4. **LLM security review** (optional) — Send batch of up to `max_batch` skills (800 chars each) to LLM as a security auditor. The LLM checks for real security issues (not hypothetical). Each real issue: -5 to -30 score adjustment.
5. **Merge scores** — Combine deterministic and LLM scores per skill.

## Outputs
- `scores`: DimensionScore[] — One per skill: score (0-100, starting from 100 with penalties), issues[], suggestions[]

## Validation
- A skill with no commands at all must score 100 (nothing to exploit)
- A skill with `curl | bash` must score ≤ 85
- A skill with `rm -rf /` must score ≤ 85
- Deterministic checks always run; LLM review is optional enhancement

## Error Handling
- If LLM security review fails, use deterministic scores only (no penalty)
- Only apply LLM adjustments when the LLM finds real issues with specific evidence
- Clamp final score to 0-100 range
