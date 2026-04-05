# Validate Narrative Facts

## Description
Cross-references LLM-generated narrative text against verified structural signals. Detects and corrects factual contradictions before they reach the user.

## Steps
1. Receive narrative sections and structural signal detection results
2. Extract factual claims from each narrative (file presence, score assertions, percentages)
3. Cross-reference claims against signal results and filesystem facts
4. Detect contradictions using 15+ regex patterns per claim type
5. Replace contradicting sentences with factually correct alternatives
6. Score narrative factual confidence (0.0-1.0)
7. Return validated narrative with corrections log

## Inputs
- `narrativeSections`: The LLM-generated narrative object
- `signals`: Array of structural signal detection results
- `projectContext`: Verified project metadata (languages, frameworks, type)

## Outputs
- `validatedNarrative`: Corrected narrative sections
- `corrections`: Array of `{ dimension, original, corrected, reason }`
- `factualConfidence`: Number 0.0-1.0

## Quality Criteria
- Zero factual contradictions in output narrative
- Valid narratives are NOT incorrectly flagged (no false positives)
- Corrections use score-appropriate language (strong/moderate/limited)
- Catches ≥95% of LLM absence/presence claim variants
