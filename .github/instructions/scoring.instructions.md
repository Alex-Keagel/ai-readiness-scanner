---
applyTo: "src/scoring/**/*.ts"
---

# EGDR Scoring Model

## Overview

EGDR (Evidence-Gated Dimensional Readiness) scores codebases across a 6-level maturity ladder. The engine lives in `src/scoring/maturityEngine.ts`. Each level is scored independently, then gated to determine the highest qualified level.

## 4 Dimensions

Every signal maps to one of 4 readiness dimensions, weighted differently per AI platform:

| Dimension | What It Measures | Copilot Weight | Cline Weight |
|-----------|-----------------|:-:|:-:|
| **Presence** | Are expected files/configs present? | 20% | 15% |
| **Quality** | Is content specific, accurate, actionable? | 40% | 30% |
| **Operability** | Can the agent safely execute? | 15% | 30% |
| **Breadth** | How broad is coverage across components? | 25% | 25% |

Weights defined in `PLATFORM_DIMENSION_WEIGHTS` in `maturityEngine.ts`. Dimension mapping:
- Category `file-presence` → Presence
- Category `content-quality` → Quality
- Category `depth` → Breadth
- Signals in `OPERABILITY_SIGNALS` set → Operability (overrides category)

## Scoring Pipeline

### Stage 1: Effective Score
Each signal gets: `raw_score × confidence_multiplier × accuracy_multiplier`
- Confidence: high=1.0, medium=0.85, low=0.65
- Accuracy: based on reality check pass rate — penalizes invalid path refs and broken commands

### Stage 2: Quality Gates
Critical signals below 50% → gate multiplier drops to 0.65. Missing critical signals → 0.55. Required signals averaging below 25 → 0.6. Heavy invalid reality checks (≥3) → 0.7. Gate multiplier compounds (takes minimum).

### Stage 3: Dimension Scoring
Per-dimension weighted average using signal classification weights:
- `critical` = 3.0×, `required` = 2.0×, `recommended` = 1.0×
- Classification defined in `PLATFORM_SIGNAL_CLASS` per platform

### Stage 4: Harmonic Blend
`0.65 × weighted_arithmetic_mean + 0.35 × weighted_harmonic_mean`
- Arithmetic-dominant, but harmonic catches weak dimensions that drag score down
- Harmonic floor of 10 prevents near-zero blowup

### Stage 5: Anti-Pattern Deductions (capped at 12 points)
- `stale_content` (-5): ≥2 invalid reality checks on a detected signal
- `generic_boilerplate` (-3): detected signal with score <20 but high confidence
- `contradictory_content` (-8): business findings with ❌ prefix

### Final Score
`raw_score = max(0, min(100, round((blended - antiPatternPenalty) × gateMultiplier)))`

## Level Qualification

Levels are gated sequentially — `calculateReport()` in `MaturityEngine`:
1. Level 1 always qualifies
2. Each level N requires: own score ≥ threshold AND previous level score ≥ previous threshold AND previous level qualified
3. Thresholds defined in `PLATFORM_THRESHOLDS` — vary by platform

## EGDR Depth

Within the qualified level: `depth = primaryLevelScore + nextLevelBonus - stabilityPenalty`
- **nextLevelBonus**: up to 10 points if next level shows partial progress
- **stabilityPenalty**: up to 12 points for large arithmetic-harmonic gap (uneven signals)

Overall score: `((primaryLevel - 1 + depth/100) / 6) × 100`

## Signal Definitions

Defined in `LEVEL_SIGNALS` array in `src/scoring/levelSignals.ts`. Each `LevelSignal`:

```typescript
interface LevelSignal {
  id: string;           // unique identifier, used in PLATFORM_SIGNAL_CLASS
  level: MaturityLevel; // 2-6 (level 1 = baseline, always qualifies)
  name: string;
  description: string;
  filePatterns: string[];     // glob patterns to detect
  contentMarkers: string[];   // regex patterns for content validation
  weight: number;             // relative importance within level
  category: 'file-presence' | 'content-quality' | 'depth';
}
```

## Adding a New Signal

1. Add entry to `LEVEL_SIGNALS` in `src/scoring/levelSignals.ts` with appropriate level, filePatterns, and contentMarkers
2. If platform-specific, add to `PLATFORM_SIGNAL_CLASS` in `src/scoring/maturityEngine.ts` with classification (critical/required/recommended)
3. If the signal should map to operability, add its ID to `OPERABILITY_SIGNALS` set
4. Add signal ID to the relevant platform's `signalIds` array in `AI_TOOLS` (`src/scoring/types.ts`)
5. The scanner (`src/scanner/maturityScanner.ts`) automatically picks up new signals via `LEVEL_SIGNALS`

## Component Scoring

`ComponentScorer` in `src/scoring/componentScorer.ts`:
- Each workspace component gets its own maturity assessment
- Components discovered by `ComponentMapper` (AST + directory analysis)
- Language-aware: components scored by language coverage (KQL ≠ Python ≠ TypeScript)
- Single-project repos treat root as one component
