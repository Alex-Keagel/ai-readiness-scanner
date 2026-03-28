# Agentic Coding Assessment — Complete Specification

> Measures developer proficiency with AI coding agents — not how much they use them,
> but how *well* they use them.

**Module**: `src/assessment/`  
**Integrates with**: existing `live/sessionPoller.ts`, `live/vibeReport.ts`, `scoring/types.ts`  
**Data sources**: Copilot CLI, Claude Code, Cline, Roo Code session telemetry  

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Data Model — Extended Session](#2-data-model--extended-session)
3. [Assessment Dimensions (6 Axes)](#3-assessment-dimensions-6-axes)
4. [Derived Metrics — Turning Raw Data into Signals](#4-derived-metrics--turning-raw-data-into-signals)
5. [Quality Signals — Detecting Good Without Reading Prompts](#5-quality-signals--detecting-good-without-reading-prompts)
6. [Scoring Model](#6-scoring-model)
7. [Developer Archetypes](#7-developer-archetypes)
8. [Growth Tracking](#8-growth-tracking)
9. [Implementation Plan](#9-implementation-plan)
10. [TypeScript Interfaces](#10-typescript-interfaces)
11. [Webview Dashboard Spec](#11-webview-dashboard-spec)
12. [Edge Cases & Calibration](#12-edge-cases--calibration)

---

## 1. Design Philosophy

### The Core Problem

A developer who sends 5 detailed prompts that each produce 500 lines of working code is
**objectively better** at using AI agents than one who sends 100 vague prompts and fights
with the agent for hours. But today's metrics (session count, message count, token count)
can't tell them apart. They reward volume, not skill.

### Design Principles

1. **Measure effects, not inputs** — We can't read prompts, but we CAN measure what they produce.
   A great prompt causes the agent to generate lots of code, use tools effectively, and
   require few corrections. A bad prompt causes short, confused responses and immediate follow-ups.

2. **Ratios over absolutes** — Raw counts are meaningless. Someone with 1000 sessions could be
   worse than someone with 50. Every metric is normalized per-session, per-prompt, or per-unit.

3. **Multi-dimensional, not single-score** — A single number (0-100) loses the signal.
   A developer who's great at delegation but bad at error recovery needs different advice
   than one who's the opposite. We use a 6-axis radar chart as the primary view.

4. **Growth over snapshot** — Where you are today matters less than whether you're improving.
   The assessment tracks trajectory, not just position.

5. **Fun, not judgmental** — Archetypes are personality descriptions, not rankings.
   "The Architect" isn't better than "The Explorer" — they're different styles.

---

## 2. Data Model — Extended Session

### What we already have (from `sessionPoller.ts`)

```
AIEvent {
  type: user | assistant | tool_start | tool_complete | subagent_start | subagent_complete
  timestamp, sessionId, platform, outputTokens, contentChars
  toolName?, agentName?, model?
}
```

### What we enrich it into

Each session gets hydrated into an `EnrichedSession` by replaying the event stream:

```typescript
interface EnrichedSession {
  // ─── Identity ───
  id: string;
  platform: 'copilot' | 'claude' | 'cline' | 'roo';
  project: string;
  startTime: number;          // epoch ms
  endTime: number;            // epoch ms
  durationMinutes: number;

  // ─── Raw Counts ───
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  outputTokens: number;
  inputTokens: number;        // where available (Claude)

  // ─── Derived from Event Replay ───
  toolBreakdown: Record<string, number>;  // toolName → count
  uniqueToolTypes: number;
  subagentLaunches: number;
  peakConcurrentAgents: number;

  // ─── Temporal Patterns (computed from timestamp diffs) ───
  userMessageTimestamps: number[];    // for cadence analysis
  assistantResponseTimestamps: number[];
  toolStartTimestamps: number[];
  
  // ─── Interaction Sequences ───
  turns: TurnSequence[];  // ordered user→assistant→tool chains
}

interface TurnSequence {
  userTimestamp: number;
  userContentChars: number;       // proxy for prompt length/detail
  assistantOutputTokens: number;  // how much the agent produced
  toolCallsInTurn: number;        // tools invoked in response
  toolNames: string[];            // which tools
  timeToNextUser: number | null;  // ms until human speaks again (null = last turn)
  wasFollowUp: boolean;           // true if timeToNextUser < CORRECTION_THRESHOLD
}
```

### Turn Reconstruction Algorithm

Events arrive as a flat stream. We reconstruct "turns" — a unit of human→agent interaction:

```
1. Walk events chronologically
2. A "turn" starts at each `user` event
3. Collect all `assistant`, `tool_start`, `tool_complete`, `subagent_*` events until next `user`
4. The gap between this turn's user event and the next user event = timeToNextUser
5. If timeToNextUser < CORRECTION_THRESHOLD (15 seconds), mark wasFollowUp = true
```

**Why this matters**: A turn where `wasFollowUp = false` likely means the agent succeeded —
the human didn't need to immediately correct it. A turn where `wasFollowUp = true` suggests
the human saw the output and immediately needed to intervene.

---

## 3. Assessment Dimensions (6 Axes)

Each dimension scores 0–100 and maps to a segment on a radar chart.

### Axis 1: Specification Quality (🎯)

> "Do they give the agent enough to work with?"

**What it detects**: Developers who write detailed, well-scoped prompts that produce large,
correct outputs — vs. those who write "fix the bug" and watch the agent flounder.

**Proxy signals** (we can't read prompts, but we can measure their effects):

| Signal | Formula | Why It Works |
|--------|---------|-------------|
| **Output Density** | `outputTokens / userMessages` | Good prompts produce big outputs |
| **First-Turn Success** | `% turns where wasFollowUp = false` | Good specs don't need immediate correction |
| **Prompt Investment** | `avg(userContentChars) for first turn of session` | Long first message = detailed spec |
| **Agent Confidence** | `avg(assistantOutputTokens) for non-followup turns` | Confident agents write more |
| **Tool Engagement** | `avg(toolCallsInTurn) for non-followup turns` | Good specs trigger multi-step tool use |

**Scoring formula**:
```
specQuality = (
  normalize(outputDensity, p25=500, p75=3000)      * 0.30 +
  normalize(firstTurnSuccess, p25=0.4, p75=0.8)    * 0.25 +
  normalize(promptInvestment, p25=100, p75=800)     * 0.20 +
  normalize(agentConfidence, p25=200, p75=2000)     * 0.15 +
  normalize(toolEngagement, p25=1, p75=5)           * 0.10
) * 100
```

### Axis 2: Autonomy Delegation (🤖)

> "Do they let the agent work, or do they micromanage?"

**What it detects**: The sweet spot between over-controlling (sending a message every 10 seconds)
and under-specifying (dumping a vague request and hoping).

| Signal | Formula | Why It Works |
|--------|---------|-------------|
| **Autonomy Ratio** | `(assistantMsgs + toolCalls) / userMessages` | Core leverage metric |
| **Uninterrupted Stretches** | `max consecutive assistant+tool events without user` | Long stretches = trust |
| **Correction Rate** | `% of turns marked wasFollowUp` | Low = letting agent work |
| **Session Efficiency** | `outputTokens / durationMinutes` | High = agent running, not waiting for human |
| **Delegation Depth** | `avg(toolCallsInTurn)` for longest turns | Complex delegated work |

**Scoring formula**:
```
autonomy = (
  normalize(autonomyRatio, p25=2, p75=8)            * 0.30 +
  normalize(maxUninterruptedStretch, p25=3, p75=10)  * 0.20 +
  normalize(1 - correctionRate, p25=0.3, p75=0.7)   * 0.20 +
  normalize(sessionEfficiency, p25=100, p75=1000)    * 0.15 +
  normalize(delegationDepth, p25=2, p75=8)           * 0.15
) * 100
```

### Axis 3: Error Recovery (🔧)

> "When the agent makes a mistake, how fast and effective is the recovery?"

**What it detects**: The ability to recognize agent failures and course-correct efficiently,
rather than getting stuck in loops or abandoning the session.

| Signal | Formula | Why It Works |
|--------|---------|-------------|
| **Recovery Speed** | `avg time between followUp turns` | Fast corrections = knows what went wrong |
| **Correction Efficiency** | `outputDensity of turns AFTER a followUp turn` | Good recoveries produce more output |
| **Loop Avoidance** | `1 - (maxConsecutiveFollowUps / totalTurns)` | Doesn't repeat same mistake |
| **Session Completion** | `sessions with outputTokens > P25 / total sessions` | Doesn't abandon broken sessions |
| **Post-Recovery Stretch** | `avg uninterrupted stretch AFTER a correction` | Recovery leads to productive flow |

**Scoring formula**:
```
errorRecovery = (
  normalize(recoverySpeed, p25=10s, p75=3s, inverted) * 0.25 +
  normalize(correctionEfficiency, p25=500, p75=2000)   * 0.25 +
  normalize(loopAvoidance, p25=0.5, p75=0.9)           * 0.20 +
  normalize(sessionCompletion, p25=0.5, p75=0.9)       * 0.15 +
  normalize(postRecoveryStretch, p25=2, p75=6)         * 0.15
) * 100
```

### Axis 4: Task Complexity (🏔️)

> "Are they doing hard things or trivial things?"

**What it detects**: Whether the developer tackles complex, multi-step tasks that require
the agent to use many tools and produce substantial output — or sticks to simple one-liners.

| Signal | Formula | Why It Works |
|--------|---------|-------------|
| **Session Scale** | `avg(outputTokens) per session` | Big sessions = complex tasks |
| **Tool Variety per Session** | `avg(uniqueToolTypes) per session` | Complex tasks need many tool types |
| **Multi-File Scope** | `avg(editCalls) per session` | Complex tasks touch many files |
| **Session Duration** | `avg(durationMinutes)` for productive sessions | Complex work takes longer |
| **Depth-to-Breadth** | `avg(sessionDepth) * avg(uniqueToolTypes)` | Deep AND diverse = truly complex |

**Scoring formula**:
```
taskComplexity = (
  normalize(sessionScale, p25=5000, p75=50000)       * 0.25 +
  normalize(toolVariety, p25=2, p75=5)                * 0.25 +
  normalize(multiFileScope, p25=3, p75=15)            * 0.20 +
  normalize(sessionDuration, p25=5, p75=30)           * 0.15 +
  normalize(depthBreadth, p25=10, p75=50)             * 0.15
) * 100
```

### Axis 5: Multi-Agent Coordination (🎭)

> "Do they orchestrate multiple agents, or stay single-threaded?"

**What it detects**: Usage of parallel agents, sub-agent delegation (Copilot CLI task tool),
and cross-platform workflows. This is the highest-skill dimension.

| Signal | Formula | Why It Works |
|--------|---------|-------------|
| **Peak Concurrency** | `max(concurrentAgents)` across all sessions | Runs multiple agents |
| **Subagent Usage** | `subagentLaunches / totalSessions` | Delegates to specialized agents |
| **Platform Diversity** | `uniquePlatformsUsed` | Uses multiple AI tools |
| **Parallel Efficiency** | `outputTokens in multi-agent sessions / single-agent sessions` | Multi-agent produces more |
| **Orchestration Depth** | `max(subagentLaunches) in a single session` | Complex multi-agent workflows |

**Scoring formula**:
```
multiAgent = (
  normalize(peakConcurrency, p25=1, p75=4)            * 0.25 +
  normalize(subagentUsage, p25=0, p75=2)               * 0.25 +
  normalize(platformDiversity, p25=1, p75=3)           * 0.15 +
  normalize(parallelEfficiency, p25=1.0, p75=3.0)     * 0.20 +
  normalize(orchestrationDepth, p25=1, p75=5)          * 0.15
) * 100
```

### Axis 6: Tool Mastery (🛠️)

> "Do they use the full range of agent capabilities?"

**What it detects**: Whether the developer leverages search, browse, edit, shell, file reads,
and advanced features — or just uses basic chat.

| Signal | Formula | Why It Works |
|--------|---------|-------------|
| **Tool Diversity Index** | `uniqueToolTypes / max(expectedToolTypes)` | Uses the full toolkit |
| **Search-Before-Edit** | `% of edit sequences preceded by search/read` | Research before acting |
| **Shell Usage** | `shellCalls / totalToolCalls` | Uses shell for validation/testing |
| **Read-Write Ratio** | `readCalls / (readCalls + editCalls)` | Balanced exploration vs action |
| **Advanced Feature Usage** | `(browserCalls + subagentCalls) / totalToolCalls` | Uses advanced capabilities |

**Scoring formula**:
```
toolMastery = (
  normalize(toolDiversityIndex, p25=0.3, p75=0.8)   * 0.30 +
  normalize(searchBeforeEdit, p25=0.2, p75=0.6)     * 0.25 +
  normalize(shellUsage, p25=0.05, p75=0.2)           * 0.15 +
  normalize(readWriteRatio, p25=0.2, p75=0.5)       * 0.15 +
  normalize(advancedFeatureUsage, p25=0, p75=0.1)   * 0.15
) * 100
```

---

## 4. Derived Metrics — Turning Raw Data into Signals

### Normalization Function

All signals use percentile-based normalization for robustness:

```typescript
function normalize(value: number, p25: number, p75: number, inverted = false): number {
  // Clamp to [0, 1] using percentile anchors
  // p25 maps to 0.25, p75 maps to 0.75, linear interpolation + clamp
  const range = p75 - p25;
  if (range === 0) return 0.5;
  
  let normalized: number;
  if (inverted) {
    // Lower is better (e.g., recovery speed)
    normalized = 1 - ((value - p25) / (range * 2));
  } else {
    normalized = 0.25 + ((value - p25) / (range * 2));
  }
  
  return Math.max(0, Math.min(1, normalized));
}
```

**Why percentile anchors, not z-scores**: We don't have population statistics. The p25/p75
values are hand-tuned defaults based on observed Copilot CLI / Claude Code usage patterns.
They SHOULD be updated with real data — see [Calibration](#12-edge-cases--calibration).

### Tool Classification Map

Since `toolName` varies by platform, we normalize into categories:

```typescript
const TOOL_CATEGORIES: Record<string, string> = {
  // File operations
  'view': 'read', 'read_file': 'read', 'cat': 'read',
  'edit': 'edit', 'create': 'edit', 'write_to_file': 'edit',
  'replace_in_file': 'edit', 'insert_code_block': 'edit',
  
  // Search operations
  'grep': 'search', 'glob': 'search', 'find': 'search',
  'search_files': 'search', 'list_files': 'search',
  'ripgrep': 'search', 'regex_search': 'search',
  
  // Shell operations
  'bash': 'shell', 'execute_command': 'shell',
  'run_terminal_command': 'shell', 'terminal': 'shell',
  
  // Browser/web operations
  'web_fetch': 'browser', 'browser_action': 'browser',
  'url_screenshot': 'browser', 'fetch': 'browser',
  
  // Agent operations
  'task': 'agent', 'subagent': 'agent',
  'new_task': 'agent', 'switch_mode': 'agent',
  
  // Memory/context operations  
  'sql': 'memory', 'store_memory': 'memory',
  'read_agent': 'memory', 'write_agent': 'memory',
};

const EXPECTED_TOOL_CATEGORIES = ['read', 'edit', 'search', 'shell', 'browser', 'agent', 'memory'];
```

### Correction Detection

The `CORRECTION_THRESHOLD` determines when a follow-up user message is a "correction"
vs. a natural continuation:

```typescript
const CORRECTION_THRESHOLD_MS = 15_000;  // 15 seconds

// Calibration note: This should be adjusted per platform.
// Copilot CLI users tend to be faster (terminal); Claude Code users may be slower.
const PLATFORM_CORRECTION_THRESHOLDS: Record<string, number> = {
  copilot: 12_000,   // Terminal users are faster
  claude:  18_000,    // May review more before responding
  cline:   15_000,    // IDE integrated, moderate
  roo:     15_000,    // IDE integrated, moderate
};
```

---

## 5. Quality Signals — Detecting Good Without Reading Prompts

### The Proxy Metric Framework

We never read prompt content. Instead, we observe **downstream effects**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    PROMPT QUALITY PROXY MODEL                    │
│                                                                 │
│  Observable Effect         →  What It Means                     │
│  ───────────────────────     ──────────────────────────          │
│  High outputTokens/prompt  →  Agent understood; produced a lot  │
│  Low correction rate       →  Output was right first time       │
│  Many tool calls/turn      →  Agent planned multi-step work     │
│  Long uninterrupted runs   →  Human trusted the output          │
│  High tool diversity       →  Complex, well-scoped request      │
│  Short time-to-next-user   →  Likely a correction (bad signal)  │
│  Long first-message chars  →  Detailed specification upfront    │
│                                                                 │
│  Combined into: EFFECTIVE_PROMPT_SCORE                           │
│                                                                 │
│  effectivePromptScore = weighted_average(                        │
│    outputDensity_normalized     * 0.35,                         │
│    firstTurnSuccessRate         * 0.30,                         │
│    avgToolCallsPerSuccessTurn   * 0.20,                         │
│    avgPromptLength_normalized   * 0.15                          │
│  )                                                              │
└─────────────────────────────────────────────────────────────────┘
```

### Success Session Detection

A session is "successful" if it meets AT LEAST 2 of these criteria:

```typescript
function isSuccessfulSession(session: EnrichedSession): boolean {
  let signals = 0;
  
  // Signal 1: Substantial output produced
  if (session.outputTokens > 2000) signals++;
  
  // Signal 2: Agent was engaged (multiple tool calls)
  if (session.toolCalls > 3) signals++;
  
  // Signal 3: Low correction rate (< 40% follow-ups)
  const correctionRate = session.turns.filter(t => t.wasFollowUp).length / session.turns.length;
  if (correctionRate < 0.4) signals++;
  
  // Signal 4: Session ran to natural completion (last turn wasn't a correction)
  const lastTurn = session.turns[session.turns.length - 1];
  if (lastTurn && !lastTurn.wasFollowUp) signals++;
  
  // Signal 5: Reasonable depth (not a one-liner)
  if (session.turns.length >= 3) signals++;
  
  return signals >= 2;
}
```

### Anti-Gaming Measures

The scoring system is designed to resist gaming:

| Gaming Attempt | Why It Doesn't Work |
|---|---|
| Send lots of sessions | We use ratios, not counts |
| Send long prompts with copy-pasted text | We measure output effects, not input volume alone |
| Let agent run forever without checking | Correction rate rewards EFFICIENT correction, not zero correction |
| Use only one tool type | Tool diversity actively penalizes this |
| Create fake sessions | No outputTokens → no score contribution |

---

## 6. Scoring Model

### Primary Output: 6-Axis Radar Chart

Each axis is 0–100. **There is no single composite score by default** — the radar chart IS
the assessment. However, we provide an optional "Proficiency Level" for quick communication.

### Proficiency Level (derived)

```typescript
type ProficiencyLevel = 
  | 'Novice'        // avg of axes < 25
  | 'Apprentice'    // avg 25-40 AND no axis below 15
  | 'Practitioner'  // avg 40-55 AND no axis below 25
  | 'Expert'        // avg 55-70 AND no axis below 35
  | 'Master'        // avg 70-85 AND no axis below 45
  | 'Grandmaster';  // avg > 85 AND no axis below 55

function computeProficiencyLevel(scores: DimensionScores): ProficiencyLevel {
  const avg = Object.values(scores).reduce((a, b) => a + b, 0) / 6;
  const min = Math.min(...Object.values(scores));
  
  if (avg >= 85 && min >= 55) return 'Grandmaster';
  if (avg >= 70 && min >= 45) return 'Master';
  if (avg >= 55 && min >= 35) return 'Expert';
  if (avg >= 40 && min >= 25) return 'Practitioner';
  if (avg >= 25 && min >= 15) return 'Apprentice';
  return 'Novice';
}
```

**The "no axis below X" gate is critical** — it prevents someone who only does one thing
well from reaching high levels. A "Master" must be at least decent at everything.

### Dimension Weights (for optional composite)

When a single number IS needed (leaderboards, status bar), use weighted average:

```typescript
const DIMENSION_WEIGHTS = {
  specQuality:      0.25,  // Most important — root cause of everything else
  autonomy:         0.20,  // Core leverage metric
  errorRecovery:    0.15,  // How you handle failure
  taskComplexity:   0.15,  // What you attempt
  multiAgent:       0.10,  // Advanced skill, lower weight (most people don't use it yet)
  toolMastery:      0.15,  // Breadth of capability usage
};

function compositeScore(scores: DimensionScores): number {
  return Math.round(
    scores.specQuality   * DIMENSION_WEIGHTS.specQuality +
    scores.autonomy      * DIMENSION_WEIGHTS.autonomy +
    scores.errorRecovery * DIMENSION_WEIGHTS.errorRecovery +
    scores.taskComplexity * DIMENSION_WEIGHTS.taskComplexity +
    scores.multiAgent    * DIMENSION_WEIGHTS.multiAgent +
    scores.toolMastery   * DIMENSION_WEIGHTS.toolMastery
  );
}
```

### Minimum Data Requirements

Assessment is unreliable with too little data. Show confidence levels:

| Sessions | Assessment | Confidence |
|----------|-----------|-----------|
| 0–2 | Not assessed | — |
| 3–9 | Preliminary | ⚠️ Low — "Based on limited data" |
| 10–24 | Standard | ✅ Moderate — "Solid assessment" |
| 25–49 | Detailed | ✅ High — "Reliable assessment" |
| 50+ | Comprehensive | ✅ Very High — "Statistically robust" |

---

## 7. Developer Archetypes

### Detection Algorithm

Archetypes are determined by the **shape** of the radar chart — which axes are highest
relative to others. Each archetype has a "signature" — a pattern of relative dimension strengths.

```typescript
interface ArchetypeSignature {
  id: string;
  name: string;
  emoji: string;
  tagline: string;
  description: string;
  color: string;
  // Each key: 'high' (top 2 axes), 'mid' (middle), 'low' (bottom 2), 'any' (doesn't matter)
  pattern: Record<keyof DimensionScores, 'high' | 'mid' | 'low' | 'any'>;
  minScoreForMatch: number;  // min composite to qualify
}
```

### The 8 Archetypes

#### 1. 🏗️ The Architect
**Tagline**: *"Build it right the first time"*  
**Pattern**: High spec quality + high task complexity, moderate-to-low correction rate  
**Detection**:
- `specQuality` in top 2 axes
- `taskComplexity` in top 3 axes
- `errorRecovery` above median

**Description**: You write prompts like blueprints. Detailed, precise, and comprehensive.
Your agents rarely need corrections because you give them everything upfront. You prefer
to spend 5 minutes on the prompt over 20 minutes on corrections.

**Growth advice**: Try delegating more — your specs are good enough to let the agent run longer.

---

#### 2. 🎭 The Orchestrator
**Tagline**: *"Why use one agent when you can use five?"*  
**Pattern**: High multi-agent + high autonomy, any tool mastery  
**Detection**:
- `multiAgent` is THE top axis (and > 60)
- `autonomy` in top 3 axes

**Description**: You're the conductor, not the instrumentalist. You launch parallel agents,
delegate to specialized sub-agents, and coordinate multi-tool workflows. You think in terms
of agent teams, not individual prompts.

**Growth advice**: Make sure your specifications are strong — orchestrating bad prompts at
scale just multiplies the problems.

---

#### 3. 🧪 The Explorer
**Tagline**: *"I wonder what happens if..."*  
**Pattern**: High tool mastery + moderate complexity, lower spec quality  
**Detection**:
- `toolMastery` in top 2 axes
- `specQuality` in bottom 3 axes
- `taskComplexity` above 40

**Description**: You use every tool in the box — search, browse, shell, agents, memory. You
explore codebases thoroughly before acting. You might not always know exactly what you want,
but you're great at discovering it through the agent's capabilities.

**Growth advice**: Invest more upfront in your specifications. Your tool skills are strong;
pair them with clearer intent and you'll be unstoppable.

---

#### 4. ⚡ The Speedrunner
**Tagline**: *"Maximum output, minimum keystrokes"*  
**Pattern**: High spec quality + high autonomy + high efficiency, lower complexity  
**Detection**:
- `specQuality` and `autonomy` both in top 3
- `outputDensity` in top 10% of all users
- `taskComplexity` below median

**Description**: You're brutally efficient. Short sessions, high output, minimal corrections.
You've mastered the art of the perfect one-liner prompt that produces exactly what you need.
You might not tackle the hardest problems, but you demolish the ones you choose.

**Growth advice**: Push into harder tasks. Your efficiency skills will translate — you're
ready for bigger challenges.

---

#### 5. 🔧 The Mechanic
**Tagline**: *"Break it? I'll fix it. Fast."*  
**Pattern**: High error recovery + moderate autonomy, any complexity  
**Detection**:
- `errorRecovery` is THE top axis (and > 60)
- `autonomy` above 40

**Description**: You're not afraid of agent mistakes because you know exactly how to fix them.
Your correction prompts are precise and effective — one correction, back on track. You've
probably debugged more agent failures than anyone and you're better for it.

**Growth advice**: Try to prevent errors upfront with more detailed specs. Your recovery is
great, but the fastest recovery is never needing one.

---

#### 6. 🤝 The Pair Programmer
**Tagline**: *"We're in this together"*  
**Pattern**: Balanced across all axes (no outliers), moderate scores  
**Detection**:
- Standard deviation of axis scores < 15
- All axes between 30-70
- No single axis dominates

**Description**: You work WITH the agent as an equal partner. Not too much delegation,
not too much control. You review output, provide feedback, and iterate naturally. This is
the most common style and it's effective — just not extreme in any direction.

**Growth advice**: Pick a dimension to specialize in. You have a solid foundation; now
push one axis to excellence.

---

#### 7. 🎓 The Professor
**Tagline**: *"Let me explain what I need in great detail"*  
**Pattern**: Very high spec quality + low autonomy, high complexity  
**Detection**:
- `specQuality` > 70
- `autonomy` < 40
- `taskComplexity` > 50

**Description**: Your prompts are incredibly detailed and your agents produce great work,
but you review every line and intervene frequently. You write documentation-quality specs
and treat the agent more like a student than a tool. Your output quality is probably excellent.

**Growth advice**: Trust the agent more. Your specs are good enough to let it run — try
delegating longer stretches without checking in.

---

#### 8. 🌊 The Surfer
**Tagline**: *"Ride the wave, see where it goes"*  
**Pattern**: High autonomy + low spec quality + low error recovery  
**Detection**:
- `autonomy` > 60
- `specQuality` < 35
- `errorRecovery` < 40

**Description**: You send quick, casual prompts and let the agent run wild. Sometimes it
produces amazing things; sometimes it goes off the rails and you start over. You're optimistic
about AI capabilities and prefer speed over precision.

**Growth advice**: Invest a few extra sentences in your prompts. Even 30 seconds of spec
writing can save 10 minutes of agent wandering.

---

### Archetype Assignment Algorithm

```typescript
function detectArchetype(scores: DimensionScores): ArchetypeResult {
  const axes = Object.entries(scores) as [keyof DimensionScores, number][];
  const sorted = [...axes].sort((a, b) => b[1] - a[1]);
  const top2 = new Set(sorted.slice(0, 2).map(([k]) => k));
  const bottom2 = new Set(sorted.slice(-2).map(([k]) => k));
  const stdDev = standardDeviation(Object.values(scores));
  const avg = mean(Object.values(scores));
  
  // Check each archetype pattern in priority order
  // 1. Orchestrator (requires multi-agent data)
  if (scores.multiAgent > 60 && top2.has('multiAgent')) {
    return { archetype: 'orchestrator', confidence: scores.multiAgent / 100 };
  }
  
  // 2. Speedrunner (extreme efficiency)
  if (scores.specQuality > 65 && scores.autonomy > 60 && scores.taskComplexity < avg) {
    return { archetype: 'speedrunner', confidence: (scores.specQuality + scores.autonomy) / 200 };
  }
  
  // 3. Architect (spec-driven complexity)
  if (top2.has('specQuality') && scores.taskComplexity > avg) {
    return { archetype: 'architect', confidence: scores.specQuality / 100 };
  }
  
  // 4. Mechanic (recovery specialist)
  if (scores.errorRecovery > 60 && sorted[0][0] === 'errorRecovery') {
    return { archetype: 'mechanic', confidence: scores.errorRecovery / 100 };
  }
  
  // 5. Professor (great specs, tight control)
  if (scores.specQuality > 70 && scores.autonomy < 40 && scores.taskComplexity > 50) {
    return { archetype: 'professor', confidence: scores.specQuality / 100 };
  }
  
  // 6. Explorer (tool diversity)
  if (top2.has('toolMastery') && scores.specQuality < avg) {
    return { archetype: 'explorer', confidence: scores.toolMastery / 100 };
  }
  
  // 7. Surfer (high autonomy, low spec)
  if (scores.autonomy > 60 && scores.specQuality < 35) {
    return { archetype: 'surfer', confidence: scores.autonomy / 100 };
  }
  
  // 8. Default: Pair Programmer (balanced)
  return { archetype: 'pairProgrammer', confidence: 1 - (stdDev / 50) };
}
```

---

## 8. Growth Tracking

### Temporal Segmentation

Split all sessions into 4 chronological quartiles:

```typescript
interface GrowthAnalysis {
  // Quartile scores (Q1 = earliest 25% of sessions, Q4 = most recent)
  q1Scores: DimensionScores;
  q2Scores: DimensionScores;
  q3Scores: DimensionScores;
  q4Scores: DimensionScores;
  
  // Trend per dimension: slope of linear regression across quartiles
  trends: Record<keyof DimensionScores, GrowthTrend>;
  
  // Overall growth narrative
  narrative: string;
  growthLevel: 'declining' | 'plateau' | 'growing' | 'accelerating';
}

interface GrowthTrend {
  slope: number;           // positive = improving
  direction: 'up' | 'flat' | 'down';
  magnitude: 'strong' | 'moderate' | 'slight' | 'none';
  q1Score: number;
  q4Score: number;
  changePercent: number;   // (q4 - q1) / q1 * 100
}
```

### Growth Classification

```typescript
function classifyGrowth(trends: Record<string, GrowthTrend>): string {
  const improvements = Object.values(trends).filter(t => t.direction === 'up').length;
  const declines = Object.values(trends).filter(t => t.direction === 'down').length;
  const strongImprovements = Object.values(trends).filter(
    t => t.direction === 'up' && t.magnitude === 'strong'
  ).length;
  
  if (strongImprovements >= 3) return 'accelerating';
  if (improvements >= 4 && declines === 0) return 'growing';
  if (improvements >= 2 && declines <= 1) return 'growing';
  if (declines >= 3) return 'declining';
  return 'plateau';
}
```

### What SHOULD Improve Over Time

These metrics are expected to trend upward for a developing user:

| Metric | Expected Trend | Why |
|--------|---------------|-----|
| specQuality | 📈 Steady increase | Learn what makes good prompts |
| autonomyRatio | 📈 Increase then plateau | Learn to trust the agent, then stabilize |
| outputDensity | 📈 Steady increase | Better prompts → more output |
| firstTurnSuccess | 📈 Steady increase | Fewer corrections over time |
| toolDiversity | 📈 Increase then plateau | Discover tools, then use what works |
| correctionRate | 📉 Steady decrease | Less need to fix agent output |
| sessionCompletion | 📈 Steady increase | Fewer abandoned sessions |

### Growth Visualization

**Mini sparklines** per dimension showing Q1→Q4 trajectory:

```
Spec Quality    ▁▃▅▇  +47%  📈 Strong Growth
Autonomy        ▃▄▅▆  +23%  📈 Growing
Error Recovery  ▅▅▅▅   +2%  ➡️ Plateau
Task Complexity ▃▃▅▇  +38%  📈 Strong Growth
Multi-Agent     ▁▁▁▃  +15%  📈 Starting
Tool Mastery    ▅▆▆▇  +12%  📈 Growing
```

---

## 9. Implementation Plan

### File Structure

```
src/assessment/
├── types.ts                    # All interfaces and type definitions
├── assessmentEngine.ts         # Main orchestrator — computes all 6 dimensions
├── sessionEnricher.ts          # AIEvent[] → EnrichedSession (turn reconstruction)
├── dimensions/
│   ├── specQuality.ts          # Axis 1: Specification Quality scorer
│   ├── autonomy.ts             # Axis 2: Autonomy Delegation scorer
│   ├── errorRecovery.ts        # Axis 3: Error Recovery scorer
│   ├── taskComplexity.ts       # Axis 4: Task Complexity scorer
│   ├── multiAgent.ts           # Axis 5: Multi-Agent Coordination scorer
│   └── toolMastery.ts          # Axis 6: Tool Mastery scorer
├── archetypeDetector.ts        # Pattern matching for 8 archetypes
├── growthTracker.ts            # Temporal analysis and trend detection
├── qualitySignals.ts           # Success detection, anti-gaming, proxy metrics
├── normalize.ts                # Normalization and statistical utilities
├── calibration.ts              # Percentile anchors and tuning constants
└── ui/
    ├── assessmentPanel.ts      # Webview: radar chart + archetype + growth
    └── assessmentStatusBar.ts  # Status bar: proficiency level badge
```

### Integration Points

```typescript
// In extension.ts — new commands:
'ai-readiness.assessment'       // Generate full assessment
'ai-readiness.assessmentPanel'  // Show assessment webview
'ai-readiness.assessmentGrowth' // Show growth tracking

// In chat/commands.ts — new subcommand:
'@readiness /assess'            // Chat command for assessment

// Data flow:
// SessionPoller (existing) → sessionEnricher → assessmentEngine → assessmentPanel
//                                                                → assessmentStatusBar
```

### Build Order

| Phase | What | Depends On | LOE |
|-------|------|-----------|-----|
| 1 | `types.ts` + `normalize.ts` + `calibration.ts` | Nothing | 1 day |
| 2 | `sessionEnricher.ts` (turn reconstruction) | Phase 1, existing `sessionPoller.ts` | 2 days |
| 3 | `dimensions/*.ts` (all 6 scorers) | Phase 1, 2 | 3 days |
| 4 | `qualitySignals.ts` | Phase 2 | 1 day |
| 5 | `assessmentEngine.ts` (orchestrator) | Phase 3, 4 | 1 day |
| 6 | `archetypeDetector.ts` | Phase 5 | 1 day |
| 7 | `growthTracker.ts` | Phase 5 | 1 day |
| 8 | `ui/assessmentPanel.ts` (radar chart + full dashboard) | Phase 5, 6, 7 | 3 days |
| 9 | `ui/assessmentStatusBar.ts` + command registration | Phase 5 | 1 day |
| 10 | Integration, testing, calibration | All phases | 2 days |

**Total estimate: ~16 days** for a senior dev, or ~10 days with AI agent assistance.

---

## 10. TypeScript Interfaces

```typescript
// ─── src/assessment/types.ts ───

export interface DimensionScores {
  specQuality: number;      // 0-100
  autonomy: number;         // 0-100
  errorRecovery: number;    // 0-100
  taskComplexity: number;   // 0-100
  multiAgent: number;       // 0-100
  toolMastery: number;      // 0-100
}

export type ProficiencyLevel = 
  'Novice' | 'Apprentice' | 'Practitioner' | 'Expert' | 'Master' | 'Grandmaster';

export type ArchetypeId = 
  'architect' | 'orchestrator' | 'explorer' | 'speedrunner' | 
  'mechanic' | 'pairProgrammer' | 'professor' | 'surfer';

export interface AssessmentResult {
  // Core scores
  dimensions: DimensionScores;
  proficiencyLevel: ProficiencyLevel;
  compositeScore: number;           // 0-100 weighted average
  
  // Archetype
  archetype: ArchetypeResult;
  
  // Growth
  growth: GrowthAnalysis;
  
  // Quality metrics
  qualitySignals: QualitySignals;
  
  // Data quality
  confidence: 'low' | 'moderate' | 'high' | 'very_high';
  sessionCount: number;
  dateRange: { first: Date; last: Date };
  
  // Per-dimension detail (for drill-down)
  dimensionDetails: Record<keyof DimensionScores, DimensionDetail>;
}

export interface DimensionDetail {
  score: number;
  signals: Array<{
    name: string;
    rawValue: number;
    normalizedValue: number;     // 0-1
    weight: number;
    description: string;
  }>;
  topStrength: string;
  topWeakness: string;
  advice: string;
}

export interface ArchetypeResult {
  archetype: ArchetypeId;
  confidence: number;              // 0-1
  name: string;
  emoji: string;
  tagline: string;
  description: string;
  color: string;
  growthAdvice: string;
  secondaryArchetype?: ArchetypeId;  // runner-up
}

export interface QualitySignals {
  effectivePromptScore: number;    // 0-100
  successfulSessionRate: number;   // 0-1
  avgOutputPerPrompt: number;      // tokens
  avgToolCallsPerSuccessTurn: number;
  correctionRate: number;          // 0-1
  sessionCompletionRate: number;   // 0-1
}

export interface GrowthAnalysis {
  q1Scores: DimensionScores;
  q2Scores: DimensionScores;
  q3Scores: DimensionScores;
  q4Scores: DimensionScores;
  trends: Record<keyof DimensionScores, GrowthTrend>;
  narrative: string;
  growthLevel: 'declining' | 'plateau' | 'growing' | 'accelerating';
}

export interface GrowthTrend {
  slope: number;
  direction: 'up' | 'flat' | 'down';
  magnitude: 'strong' | 'moderate' | 'slight' | 'none';
  q1Score: number;
  q4Score: number;
  changePercent: number;
}

// ─── Calibration constants ───

export interface CalibrationProfile {
  name: string;
  percentiles: Record<string, { p25: number; p75: number }>;
}

export const DEFAULT_CALIBRATION: CalibrationProfile = {
  name: 'default-2025',
  percentiles: {
    // Spec Quality signals
    'outputDensity':        { p25: 500,   p75: 3000  },
    'firstTurnSuccess':     { p25: 0.4,   p75: 0.8   },
    'promptInvestment':     { p25: 100,   p75: 800   },
    'agentConfidence':      { p25: 200,   p75: 2000  },
    'toolEngagement':       { p25: 1,     p75: 5     },
    
    // Autonomy signals
    'autonomyRatio':        { p25: 2,     p75: 8     },
    'maxUninterrupted':     { p25: 3,     p75: 10    },
    'correctionRate':       { p25: 0.3,   p75: 0.7   },
    'sessionEfficiency':    { p25: 100,   p75: 1000  },
    'delegationDepth':      { p25: 2,     p75: 8     },
    
    // Error Recovery signals
    'recoverySpeed':        { p25: 10000, p75: 3000  },  // inverted
    'correctionEfficiency': { p25: 500,   p75: 2000  },
    'loopAvoidance':        { p25: 0.5,   p75: 0.9   },
    'sessionCompletion':    { p25: 0.5,   p75: 0.9   },
    'postRecoveryStretch':  { p25: 2,     p75: 6     },
    
    // Task Complexity signals
    'sessionScale':         { p25: 5000,  p75: 50000 },
    'toolVariety':          { p25: 2,     p75: 5     },
    'multiFileScope':       { p25: 3,     p75: 15    },
    'sessionDuration':      { p25: 5,     p75: 30    },
    'depthBreadth':         { p25: 10,    p75: 50    },
    
    // Multi-Agent signals
    'peakConcurrency':      { p25: 1,     p75: 4     },
    'subagentUsage':        { p25: 0,     p75: 2     },
    'platformDiversity':    { p25: 1,     p75: 3     },
    'parallelEfficiency':   { p25: 1.0,   p75: 3.0   },
    'orchestrationDepth':   { p25: 1,     p75: 5     },
    
    // Tool Mastery signals
    'toolDiversityIndex':   { p25: 0.3,   p75: 0.8   },
    'searchBeforeEdit':     { p25: 0.2,   p75: 0.6   },
    'shellUsage':           { p25: 0.05,  p75: 0.2   },
    'readWriteRatio':       { p25: 0.2,   p75: 0.5   },
    'advancedFeatures':     { p25: 0,     p75: 0.1   },
  },
};
```

---

## 11. Webview Dashboard Spec

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│                     🏆 Agentic Coding Assessment                │
│                     Alex's Proficiency Report                    │
│                     📅 Jan 2025 — Jun 2025                      │
│                     📊 47 sessions analyzed                      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌──────────────────────┐    ┌──────────────────────────────┐  │
│  │                      │    │                              │  │
│  │    [RADAR CHART]     │    │  🏗️ The Architect            │  │
│  │                      │    │  "Build it right the first   │  │
│  │    6-axis radar      │    │   time"                      │  │
│  │    with gradient     │    │                              │  │
│  │    fill              │    │  Confidence: 87%             │  │
│  │                      │    │  Level: Expert               │  │
│  │                      │    │  Score: 68/100               │  │
│  └──────────────────────┘    │                              │  │
│                               │  You write prompts like     │  │
│                               │  blueprints...              │  │
│                               └──────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  📊 Dimension Breakdown                                         │
│                                                                 │
│  🎯 Spec Quality     ████████████████████░░░░░  78  📈 +23%   │
│  🤖 Autonomy         ██████████████████░░░░░░░  72  📈 +15%   │
│  🔧 Error Recovery   ████████████░░░░░░░░░░░░░  52  ➡️  +3%   │
│  🏔️ Task Complexity  ██████████████████████░░░  82  📈 +31%   │
│  🎭 Multi-Agent      ██████░░░░░░░░░░░░░░░░░░░  28  📈 +18%   │
│  🛠️ Tool Mastery     █████████████████░░░░░░░░  68  📈 +11%   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  📈 Growth Trajectory                                           │
│                                                                 │
│  [SPARKLINE CHART: Q1 → Q4 per dimension]                      │
│                                                                 │
│  Verdict: 🚀 Accelerating Growth                                │
│  "Strong improvement in 4 of 6 dimensions. Your specification  │
│   quality has grown 23% — your biggest win. Focus on multi-     │
│   agent coordination to unlock the next level."                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  🎯 Quality Signals                                             │
│                                                                 │
│  Effective Prompt Score: 74/100                                 │
│  Successful Sessions: 38/47 (81%)                               │
│  Avg Output per Prompt: 2,340 tokens                            │
│  Correction Rate: 22%                                           │
│  Session Completion: 91%                                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Radar Chart Implementation

Use `<canvas>` with raw Canvas 2D API (no external dependencies — VS Code webview constraint):

```typescript
function drawRadarChart(ctx: CanvasRenderingContext2D, scores: DimensionScores): void {
  const labels = [
    { key: 'specQuality', label: '🎯 Spec', angle: -Math.PI / 2 },
    { key: 'autonomy', label: '🤖 Autonomy', angle: -Math.PI / 2 + Math.PI / 3 },
    { key: 'toolMastery', label: '🛠️ Tools', angle: -Math.PI / 2 + 2 * Math.PI / 3 },
    { key: 'taskComplexity', label: '🏔️ Complexity', angle: Math.PI / 2 },
    { key: 'errorRecovery', label: '🔧 Recovery', angle: Math.PI / 2 + Math.PI / 3 },
    { key: 'multiAgent', label: '🎭 Multi-Agent', angle: Math.PI / 2 + 2 * Math.PI / 3 },
  ];
  
  // Draw concentric hexagons at 25%, 50%, 75%, 100%
  // Fill scored area with gradient
  // Animate fill on load (0 → actual values over 800ms)
}
```

### Color System

```typescript
const PROFICIENCY_COLORS = {
  Novice:       { bg: '#1a1a2e', accent: '#6b7280', gradient: 'from-gray-600 to-gray-500' },
  Apprentice:   { bg: '#1a1a2e', accent: '#eab308', gradient: 'from-yellow-600 to-yellow-400' },
  Practitioner: { bg: '#1a1a2e', accent: '#22c55e', gradient: 'from-green-600 to-green-400' },
  Expert:       { bg: '#1a1a2e', accent: '#3b82f6', gradient: 'from-blue-600 to-blue-400' },
  Master:       { bg: '#1a1a2e', accent: '#8b5cf6', gradient: 'from-purple-600 to-purple-400' },
  Grandmaster:  { bg: '#1a1a2e', accent: '#f59e0b', gradient: 'from-amber-500 to-yellow-300' },
};

const ARCHETYPE_COLORS: Record<ArchetypeId, string> = {
  architect:      '#3b82f6',
  orchestrator:   '#8b5cf6',
  explorer:       '#22c55e',
  speedrunner:    '#ef4444',
  mechanic:       '#f59e0b',
  pairProgrammer: '#06b6d4',
  professor:      '#6366f1',
  surfer:         '#14b8a6',
};
```

---

## 12. Edge Cases & Calibration

### Platform-Specific Gaps

| Platform | What's Missing | Mitigation |
|----------|---------------|-----------|
| **Copilot CLI** | Full data: events.jsonl has everything | None needed — gold standard |
| **Claude Code** | No explicit tool call events in JSONL | Infer from content blocks with `type: 'tool_use'` |
| **Cline** | No outputTokens in older versions | Fall back to estimating from content length |
| **Roo Code** | Minimal data (tokensOut, no message breakdown) | Score only available dimensions; reduce confidence |

### Cross-Platform Normalization

Different platforms produce different token counts for the same work. Normalize:

```typescript
const PLATFORM_TOKEN_MULTIPLIERS: Record<string, number> = {
  copilot: 1.0,    // Baseline
  claude:  0.85,   // Claude tends to be more verbose
  cline:   1.0,    // Similar to Copilot
  roo:     1.0,    // Similar to Copilot
};
```

### Minimum Session Filtering

Exclude noise sessions:

```typescript
function isValidSession(session: EnrichedSession): boolean {
  return (
    session.userMessages >= 1 &&           // At least one human message
    session.assistantMessages >= 1 &&      // Agent responded
    session.outputTokens > 50 &&           // Meaningful output
    session.durationMinutes > 0.5 &&       // Not a misclick
    session.durationMinutes < 480          // Not a forgotten session (8h)
  );
}
```

### Calibration Strategy

The p25/p75 percentile anchors in `calibration.ts` are initial estimates. To tune them:

1. **Phase 1 (Launch)**: Use the hardcoded defaults from this spec.
2. **Phase 2 (After 100 users)**: Compute actual p25/p75 from anonymized aggregate data.
3. **Phase 3 (Ongoing)**: Allow user override via settings for team-specific calibration.

```typescript
// Settings contribution:
'ai-readiness.assessment.calibrationProfile': 'default' | 'custom'
'ai-readiness.assessment.customCalibration': {
  // User can override any percentile anchor
  'outputDensity.p75': 5000  // Team that does big code gen
}
```

### When Data Is Sparse

If a dimension can't be scored due to missing data (e.g., no multi-agent data):

```typescript
function scoreDimensionSafe(
  rawSignals: number[], 
  weights: number[],
  minSignalsRequired: number
): { score: number; confidence: 'full' | 'partial' | 'insufficient' } {
  const availableSignals = rawSignals.filter(s => !isNaN(s) && s !== null);
  
  if (availableSignals.length < minSignalsRequired) {
    return { score: 0, confidence: 'insufficient' };
  }
  
  if (availableSignals.length < rawSignals.length) {
    // Re-weight available signals proportionally
    return { score: computeWithAvailableSignals(availableSignals, weights), confidence: 'partial' };
  }
  
  return { score: computeFullScore(rawSignals, weights), confidence: 'full' };
}
```

When confidence is 'insufficient', show the axis as grayed out on the radar chart with a
"Not enough data" tooltip.

---

## Appendix A: Backward Compatibility with Existing Vibe Report

The new assessment **replaces and extends** the existing vibe report (`vibeReport.ts`).

| Current Vibe Report | New Assessment |
|---------------------|---------------|
| Single autonomyRatio metric | 6-axis radar chart |
| 5 archetypes (Manual Coder → Orchestrator) on 1 axis | 8 archetypes on 6 axes |
| No growth tracking | Q1→Q4 temporal analysis |
| No quality signals | Effective prompt score, success rate, correction rate |
| Basic hero stats | Dimension drill-down with per-signal detail |
| No confidence indicator | Low/Moderate/High/Very High confidence |

The `@readiness /vibe` command should invoke the new assessment panel. The old HTML generation
in `vibeReport.ts` can be deprecated once the new panel is live.

---

## Appendix B: Status Bar Integration

The assessment module adds a compact status bar item:

```
🏗️ Architect • Expert (68) | 📈 +23%
```

Format: `{archetype_emoji} {archetype_name} • {level} ({score}) | {growth_emoji} {growth%}`

Click → opens full assessment panel.

---

## Appendix C: Example Scoring Walkthrough

**Developer A**: 30 sessions over 2 months, Copilot CLI

| Raw Data | Value |
|----------|-------|
| Total user messages | 127 |
| Total assistant messages | 412 |
| Total tool calls | 893 |
| Total output tokens | 1.2M |
| Avg tools per session | 29.8 |
| Unique tool types | 6 of 7 |
| Subagent launches | 18 |
| Avg correction rate | 18% |
| Avg first-message chars | 623 |

**Dimension Scores**:
- Spec Quality: 78 (high output density, low corrections, detailed prompts)
- Autonomy: 72 (good ratio, long uninterrupted stretches)
- Error Recovery: 52 (decent but not outstanding — corrections take a while)
- Task Complexity: 82 (lots of tools, big sessions, many files)
- Multi-Agent: 28 (some subagent use but not frequent)
- Tool Mastery: 68 (uses 6/7 categories, good search-before-edit)

**Result**:
- Archetype: 🏗️ The Architect (high spec + high complexity)
- Level: Expert (avg 63.3, min 28 — min gate keeps from Master)
- Growth: 📈 Growing (+23% spec, +15% autonomy since Q1)
- Key advice: "Push into multi-agent coordination — you're ready"
