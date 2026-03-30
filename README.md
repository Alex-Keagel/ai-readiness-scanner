# AI Readiness Scanner for VS Code

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Install-007ACC?logo=visual-studio-code&logoColor=white)](https://marketplace.visualstudio.com/)
[![Version](https://img.shields.io/badge/version-1.2.1-blue)](https://marketplace.visualstudio.com/)
[![Powered by](https://img.shields.io/badge/Powered%20by-GitHub%20Copilot%20LM%20API-8957e5?logo=github)](https://github.com/features/copilot)
[![Tests](https://img.shields.io/badge/tests-638%20passing-brightgreen)](https://github.com/)

> **Is your codebase ready for AI coding agents?** Find out in 60 seconds.

AI agents like Copilot, Cline, Cursor, and Claude Code work **dramatically better** on some codebases than others. The difference isn't the agent — it's the **environment**. This extension scans your workspace, scores it on a 100-point scale across a **6-Level Maturity Ladder**, and generates the exact files you need to level up.

---

## ✨ Key Features

### 🔍 One-Click Scan — Score Your Repo in 60 Seconds

Click **Scan** in the sidebar, pick your AI platform, and get an instant readiness score. The scanner uses GitHub Copilot's LM API to deeply understand your code — not just check if files exist.

### 🌐 7 AI Platforms Supported

Each platform has its own scoring profile, file expectations, and expert analysis:

| Platform | Key Files |
|----------|-----------|
| **GitHub Copilot** | `copilot-instructions.md`, `*.agent.md`, `SKILL.md` |
| **Cline** | `.clinerules/`, `memory-bank/`, `safe-commands` |
| **Cursor** | `.cursor/rules/`, `.cursorrules` |
| **Claude Code** | `CLAUDE.md`, `.claude/rules/` |
| **Roo Code** | `.roo/rules/`, `.roomodes` |
| **Windsurf** | `.windsurf/rules/`, `.windsurf/skills/` |
| **Aider** | `.aider.conf.yml`, `.aiderignore` |

### 🏗️ 6-Level AI Maturity Ladder

| Level | Name | Description |
|:-----:|------|-------------|
| **L1** | Prompt-Only | No agent config. Copy-paste into ChatGPT. |
| **L2** | Instruction-Guided | Custom instructions shape agent behavior. |
| **L3** | Skill-Equipped | Reusable skills, agents, MCP tools. |
| **L4** | Playbook-Driven | End-to-end workflows agents follow autonomously. |
| **L5** | Self-Improving | Memory banks, evals, feedback loops. |
| **L6** | Autonomous Orchestration | Multi-agent coordination across repos. |

Your current level shows in the status bar: `🏆 L3: Skill-Equipped (72%)`

### 🧠 Semantic Code Understanding

Not just "does the file exist" — the scanner **reads, maps, and reasons** about your code:

**Architecture Discovery**
- **Call graph extraction** — maps function calls across modules (direct, cross-module, callback, event-driven)
- **Data flow tracing** — traces data from source → transformation → sink across your pipeline
- **Type hierarchy** — extracts class inheritance and interface implementations (extends/implements)
- **Import graph separation** — distinguishes project imports from package imports for accurate fan-in

**Intelligence Layer**
- **Module role classification** — auto-classifies every file as entry-point, core-logic, utility, UI, config, test, or generated
- **Complexity factor** — per-component score (0-1.0) based on size, fan-in, exports, call graph centrality, and pipeline involvement
- **Product detection** — LLM identifies which components are customer-facing products vs internal support
- **Generated code detection** — flags backup files, protobuf stubs, and exported code (scored differently)
- **Dead code detection** — finds exported symbols never imported by other modules

**Semantic Search**
- **LLM enrichment** — summarizes what each important file actually does using GitHub Copilot
- **TF-IDF vector search** — enables semantic querying across your entire codebase
- **Fan-in analysis** — identifies hub files imported by many others (high-impact change targets)

**Language-Aware Analysis**
- **Type strictness scoring** — C#/Java get inherent credit (statically typed), Python scores based on hint coverage, config files excluded
- **Semantic density** — measures documentation-to-code ratio per module (docstrings, comments, descriptive names)
- **KQL/SQL awareness** — query languages scored as data components, not penalized for missing type hints

### 💡 Actionable Insights with One-Click Fix

Every recommendation comes with a **Generate** button that creates the exact file content and opens a diff editor so you can review before applying:

- 🔴 **Critical** — Missing instruction files, broken configs
- 🟡 **Important** — Missing skills, incomplete documentation
- 🔵 **Suggestions** — Workflow playbooks, MCP integrations

### 💡 AI Strategy — Executive Brief

The **AI Strategy** panel gives you the big picture at a glance:

- **Readiness Overview** — Score, maturity level, signals needed for the next level
- **Action Items** — Total critical/important/suggestion counts (matching the Action Center)
- **🎯 What Matters Most** — Auto-generated strategic bullets (missing foundational signals, low-scoring components, quality gaps)
- **🧠 LLM Analysis** — Each AI-generated insight as a card with recommendation, category, affected component, and estimated impact
- **Path Flow Graph** — Visual roadmap from current level to the next
- **Best Setup** — Ideal file combination for your platform, in build order
- **Component Health** — Lowest-scoring components that drag your overall score

### 🔧 Action Center — Tactical Fixes

The **Action Center** surfaces every actionable fix across three sources:

- **Signal-based** — Missing and low-quality signals with auto-fix generation
- **Insight-based** — LLM-identified issues converted to actionable cards
- **Component-based** — Undocumented or low-scoring components needing README/docs
- **Fix state tracking** — Approve, decline, or re-generate each fix (persisted across sessions)
- **Multi-file generation** — Batch generate and apply fixes with confirmation
- **Source file protection** — Existing non-`.md` files get `.suggestions.md` advisory instead of overwrite

### 🧪 Deep Recommendation Engine

Goes beyond surface-level checks to cross-reference your instructions against the actual codebase:

- **Instruction Analyzer** — Extracts claims from instruction files (regex + LLM semantic extraction)
- **Codebase Profiler** — Maps modules, fan-in, import graphs, and execution pipelines
- **Cross-Reference Engine** — Finds coverage gaps, path drift, structural drift, and semantic drift
- **Recommendation Synthesizer** — Generates evidence-backed fixes with exact file content
- **Output Validator** — Validates all LLM-generated content (deterministic + LLM checks, auto-fix, retry)

### 🕸️ Unified Knowledge Graph

All analysis flows into a single **Knowledge Graph** — the central data structure connecting every piece of understanding:

- **Component nodes** with complexity factors, health cards, and roll-up summaries
- **DEPENDS_ON** edges from import analysis (Python hyphen/underscore aware)
- **CALLS** edges from call graph with intent labels ("passes sanitized payload to billing webhook")
- **DATA_FLOWS_TO** edges tracing data pipelines (source → transform → sink)
- **EXTENDS / IMPLEMENTS** edges from type hierarchy
- **Domain grouping** via 3-agent pipeline: Structure Analyst → Domain Architect → Completeness Validator

The Repository Structure view renders this graph as an interactive collapsible tree.

### 🤖 3-Agent Component Mapping Pipeline

Component discovery uses three specialized expert agents:

| Agent | Role | Guarantee |
|-------|------|-----------|
| **Structure Analyst** | Maps every directory to a flat micro-component | Orphan injection — zero path drops |
| **Domain Architect** | Groups micro-components into business + technical domains | Mandatory taxonomy enforced |
| **Completeness Validator** | Checks for dropped paths, self-corrects | Deterministic safety net |

### 🔬 Advanced Semantic Features (15-Phase Deep Analysis)

| Phase | Feature | Description |
|-------|---------|-------------|
| 1-9 | Core analysis | Instructions, profiling, call graph, data flow, complexity, cross-ref, recommendations, skills, dead code |
| 10 | **HyDE Search** | Generates hypothetical search queries per module for intent-based matching |
| 11 | **Roll-Up Summaries** | File → directory → architecture summaries (zoomable understanding) |
| 12 | **Edge Labels** | Top 20 call graph edges get LLM intent descriptions |
| 13 | **Blast Radius** | Entry points analyzed for downstream impact with LLM warnings |
| 14 | **Health Cards** | Top 3 critical components audited by Explainer + Red Teamer + Critic |
| 15 | **Dead Branches** | Config files scanned for feature flags making code unreachable |

### 📊 Codebase Readiness Metrics

A radar chart visualizes 5 dimensions of AI readiness:

- **Semantic Density** — Comments, docstrings & descriptive names vs raw logic
- **Type Strictness** — Explicit type annotations & interfaces
- **Context Fragmentation** — How self-contained your modules are
- **Overall Score** — Weighted composite
- **Depth** — How deeply the scanner analyzed your code

### 📚 Dynamic Platform Guides

Auto-generated guides pulled from official documentation, showing:
- Required file structure and naming conventions
- Anti-patterns to avoid
- Quality criteria for each config file
- Best practices with examples

### 💬 Chat Interface (`@readiness`)

Use natural language in Copilot Chat:

| Command | What It Does |
|---------|-------------|
| `@readiness /scan` | Full scan with deep analysis |
| `@readiness /levelup` | Guided progression to next level |
| `@readiness /vibe` | Agentic proficiency + SRE assessment |
| `@readiness /guide` | Platform setup guide |
| `@readiness /migrate cline copilot` | Convert configs between platforms |
| `@readiness /graph` | Repository structure visualization |
| `@readiness /live` | Real-time AI tokens-per-minute |

### 📈 Vibe Report & SRE Metrics

Assess your team's agentic coding proficiency with two layers of analysis:

**Agentic Proficiency Score (APS)** — 5 dimensions: Autonomy, Delegation, Recovery, Depth, Output quality. Track growth over time with sparkline charts.

**SRE Reliability Metrics** — 13 metrics computed from actual conversation content:

| Metric | What It Measures |
|--------|-----------------|
| Hallucination Index | How often the agent gets corrected |
| Laziness Index | Short responses, refusals, placeholder code |
| First-Try Success | % of sessions with zero corrections |
| Flow Score | Productive momentum without friction |
| Context Rot | Quality degradation as sessions get longer |
| Loop Detection | Stuck correction cycles (3+ rounds) |
| Session Health | Clean / Bumpy / Troubled classification |
| Prompt Effectiveness | Success rate by category (fix, test, create, etc.) |
| Regression Detection | Quality decline alerts (recent vs earlier) |
| DORA Metrics | Deploy frequency, lead time, change failure rate, MTTR |
| Activity Heatmap | When you're most productive (day × hour) |
| Code Churn | Files re-edited across commits (instability signal) |
| Cost Per Outcome | Estimated spend per session, message, and tool call |

Supports **all 4 platforms**: Copilot CLI, Claude Code, Cline, Roo Code. Per-platform AND cross-platform comparison.

### 🎨 Tactical Glassbox Theme

All panels use a purpose-built dark theme with glass-morphism cards, glow borders, and noise texture — designed for readability during long analysis sessions.

---

## Requirements

- **VS Code** ≥ 1.90.0
- **GitHub Copilot Chat** extension (provides the LM API)
- An active GitHub Copilot subscription

---

## Getting Started

1. Install the extension
2. Open any workspace
3. Click **🔍 Scan** in the AI Readiness sidebar (left activity bar)
4. Select your AI platform
5. Review your score, insights, and recommendations
6. Click **Generate** on any recommendation to create the fix

---

## Extension Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `selectedTool` | Default AI platform | `ask` (prompts each time) |
| `enrichmentDepth` | % of files to LLM-enrich (10-100) | `70` |
| `llmTimeout` | LLM call timeout in seconds | `45` |
| `enrichmentConcurrency` | Parallel LLM calls | `5` |
| `enrichmentBatchSize` | Files per LLM batch | `10` |
| `cacheTTL` | Cache lifetime in days | `1` |
| `dimensionWeights` | EGDR dimension weights (presence/quality/operability/breadth) | `{P:0.2, Q:0.4, O:0.15, B:0.25}` |
| `componentTypeWeights` | Importance multiplier per component type | `{service:1, app:1, library:0.9, ...}` |
| `scoringMode` | Harmonic blend ratio: `lenient`, `balanced`, `strict` | `balanced` |
| `signalWeights` | Per-signal weight overrides (0.25-3.0) | `{}` |
| `contextBudgets` | Context window budget per platform (tokens) | `{copilot:200K, cline:200K, ...}` |

All settings are accessible from the sidebar settings panel.

---

## How Scoring Works

### The 6-Stage Scoring Pipeline

Every scan flows through 6 stages to produce your score:

```
① Signal Detection → ② Reality Checks → ③ Dimension Aggregation
    → ④ Harmonic Blend → ⑤ Anti-Pattern Penalties → ⑥ Component Weighting → Final Score
```

### Stage ①: Signal Detection

Each level has specific **signals** — file-presence checks, content-quality evaluations, and depth measurements. Each signal produces a raw score (0-100), then gets multiplied by a confidence factor:

| Confidence | Multiplier | When |
|-----------|-----------|------|
| High | ×1.00 | Deterministic file check or high-confidence LLM analysis |
| Medium | ×0.85 | LLM analysis with some uncertainty |
| Low | ×0.65 | Heuristic match or low-confidence LLM |

### Stage ②: Reality Checks

The scanner verifies every file path, command, and tech-stack claim in your instruction files against the actual repo. Failed checks reduce the accuracy multiplier on affected signals.

### Stage ③: EGDR Dimension Aggregation

Signals are grouped into 4 dimensions with per-platform weights:

| Dimension | What It Measures | Copilot | Cline | Claude |
|-----------|-----------------|:-------:|:-----:|:------:|
| **Presence** | Are expected config files present? | 20% | 15% | 15% |
| **Quality** | Is content accurate & actionable? | 40% | 30% | 50% |
| **Operability** | Can the agent safely execute? | 15% | 30% | 10% |
| **Breadth** | How thorough is coverage? | 25% | 25% | 25% |

Within each dimension, signals are weighted by classification:
- **Critical** signals: ×3 weight
- **Required** signals: ×2 weight
- **Recommended** signals: ×1 weight

### Stage ④: Harmonic Blend

The 4 dimension scores are combined using a blend of arithmetic and harmonic means:

```
blended = α × arithmetic_mean(dimensions) + (1-α) × harmonic_mean(dimensions)
```

| Scoring Mode | α | Effect |
|-------------|---|--------|
| 🟢 Lenient | 80% arithmetic / 20% harmonic | Score reflects your strengths |
| 🟡 Balanced | 65% / 35% | Weak areas drag score noticeably (default) |
| 🔴 Strict | 50% / 50% | Score reflects your weakest area |

**Why harmonic?** Arithmetic mean hides weak areas. Harmonic mean penalizes them. Example: dimensions [80, 80, 10, 80] → arithmetic=62, harmonic=28. With Balanced mode → score=50. A single weak dimension drags everything down.

### Stage ⑤: Anti-Pattern Penalties (Level-Specific, Multiplier-Based)

Anti-patterns are detected per-level and reduce the score proportionally. They stack via product (compound), floored at ×0.70:

| Anti-Pattern | Multiplier | Levels | Cascade | Trigger |
|-------------|-----------|--------|---------|---------|
| **No Type Hints** | ×0.95 | L1 | — | Type strictness < 10 in app code |
| **Stale Content** | ×0.93 | L2-L3 | ×0.97 at L4-L5 | ≥2 invalid reality checks |
| **Generic Boilerplate** | ×0.96 | L2-L3 | — | File exists but score < 20 with high confidence |
| **Contradictory Content** | ×0.89 | L3-L5 | ×0.89 at L6 | Business logic found ❌ contradictions |
| **Unsafe Workflows** | ×0.92 | L4-L5 | ×0.92 at L6 | Workflows without safe-command guardrails |

**Stacking**: `stale (×0.93) + contradictory (×0.89) = ×0.83` — both problems compound.

**Combined with gates**: `final = blended × gateMultiplier × antiPatternMultiplier`, with a combined floor of ×0.40 to prevent score annihilation.

### Stage ⑥: Component Type Weighting

Components are weighted by type when aggregating the overall score:

| Type | Weight | Rationale |
|------|--------|-----------|
| `service` / `app` | 100% | Core business logic — full weight |
| `library` | 90% | Shared code — changes ripple across consumers |
| `infra` | 60% | Infrastructure-as-code — often declarative |
| `script` | 50% | Build/deploy scripts — agents rarely modify deeply |
| `config` | 40% | Configuration — typically static/auto-generated |
| `data` | 30% | Data files — often managed by pipelines |

Overall = 70% signal-based score + 30% weighted component average.

### Platform Readiness Metrics (Radar Chart)

The report shows 5 diagnostic metrics on a radar chart. Each is **platform-aware** and **component-filtered** — they only measure what's relevant to the selected AI tool and your application code.

| Metric | Formula | Scope | What It Means for Agents |
|--------|---------|-------|-------------------------|
| **Business Logic Alignment** | avg(signal.score) for LLM-validated signals | App/library components only | Do your instructions accurately describe the actual application code? Infra/config signals excluded. |
| **Type & Environment Strictness** | Language-aware: base score per language (C#=85, Python=45+hints) + annotation bonus. Config/data files excluded. | App/library code only | Can agents use LSP for cross-file navigation? Statically typed langs get inherent credit. |
| **Semantic Density** | documentedProcedures / totalProcedures × 100 | App/library code only | What % of functions and classes have a docstring or comment? Binary per procedure — verbose inline comments don't count, only documented APIs. |
| **Instruction/Reality Sync** | validChecks / totalChecks × 100 | Selected platform only | Are file paths and commands in YOUR platform's instruction files real? Copilot scan only checks `.github/` paths, not `.clinerules/`. |
| **Context Efficiency** | 60% component coverage + 40% budget efficiency | Selected platform only | Per-component: do instructions cover each important component? Budget: is token usage in the sweet spot (1-8%) for the platform's context window? |

**Platform-specific context budgets** (configurable via `ai-readiness.contextBudgets`):

| Platform | Default Budget |
|----------|---------------|
| Copilot | 200K tokens |
| Cline | 200K tokens |
| Claude | 200K tokens |
| Roo | 200K tokens |
| Cursor | 128K tokens |
| Windsurf | 128K tokens |
| Aider | 128K tokens |

### L1 Codebase Quality Signals

Level 1 measures your codebase's intrinsic AI readiness — before any instruction files:

| Signal | What It Measures | App-Layer Only |
|--------|-----------------|:-:|
| `codebase_type_strictness` | Type annotations in service/app/library code | ✅ |
| `codebase_semantic_density` | Documented functions & classes in service/app/library code | ✅ |
| `codebase_context_efficiency` | Per-component instruction coverage + token budget usage | Platform-filtered |

These exclude `infra`, `config`, `script`, and `data` components — a repo full of Bicep templates won't be penalized for lacking Python type hints.

### Quality Gates

Before final scoring, quality gates can reduce the score via multipliers:

| Gate | Multiplier | Trigger |
|------|-----------|---------|
| Critical signal low | ×0.65 | A critical signal scores below 50 |
| Critical signal missing | ×0.55 | A critical signal is not detected at all |
| Required signals floor | ×0.60 | Average of required signals < 25 |
| Accuracy gate | ×0.70 | ≥3 invalid reality checks on any signal |

Gates stack via `min()` — only the worst gate applies.

---

## Commands

Access via Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Description |
|---------|-------------|
| `AI Readiness: Full Scan` | Run a complete scan with LLM deep analysis |
| `AI Readiness: Show Insights` | Open AI Strategy panel |
| `AI Readiness: Action Center` | Tactical fixes with one-click generation |
| `AI Readiness: Show Guide` | Platform configuration guide |
| `AI Readiness: Show Graph` | Repository structure tree |
| `AI Readiness: Show Report` | Open last scan report |
| `AI Readiness: Compare Scans` | Side-by-side run comparison |
| `AI Readiness: Vibe Report` | Agentic proficiency + SRE metrics |
| `AI Readiness: Start Live Tracking` | Real-time AIPM dashboard |
| `AI Readiness: Migrate` | Convert configs between platforms |
| `AI Readiness: Clear History` | Reset scan history |

---

## Logs & Debugging

**View → Output → "AI Readiness Scanner"** for structured logs with phase timing, LLM call tracking, and error details.

---

## Privacy & Data

- **All analysis runs locally** in your VS Code instance
- Code snippets are sent to GitHub Copilot's LM API (same as Copilot Chat) — never to third parties
- Scan results are cached in VS Code's `workspaceState` — isolated per workspace, no external storage
- No telemetry is collected

---

## Building from Source

```bash
git clone https://github.com/alex-keagel/vscode-ai-readiness.git
cd vscode-ai-readiness
npm install
npm run build
npm test           
npm run package    
```

Press `F5` to launch the Extension Development Host for debugging.

---

## Release Notes


---

**Built by [Alex Keagel](https://github.com/alex-keagel) · Powered by [GitHub Copilot LM API](https://github.com/features/copilot)**
