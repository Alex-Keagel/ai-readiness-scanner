# AI Readiness Scanner for VS Code

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Install-007ACC?logo=visual-studio-code&logoColor=white)](https://marketplace.visualstudio.com/)
[![Version](https://img.shields.io/badge/version-2.3.5-blue)](https://marketplace.visualstudio.com/)
[![Powered by](https://img.shields.io/badge/Powered%20by-GitHub%20Copilot%20LM%20API-8957e5?logo=github)](https://github.com/features/copilot)
[![Tests](https://img.shields.io/badge/tests-234%20passing-brightgreen)](https://github.com/)

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

Not just "does the file exist" — the scanner **reads and understands** your code:

- **Fan-in analysis** — identifies hub files imported by many others
- **Git velocity** — detects frequently-changed, multi-author files
- **Security patterns** — flags auth, crypto, and API integration code
- **LLM enrichment** — summarizes what each important file actually does
- **TF-IDF vector search** — enables semantic querying of your entire codebase

### 💡 Actionable Insights with One-Click Fix

Every recommendation comes with a **Generate** button that creates the exact file content and opens a diff editor so you can review before applying:

- 🔴 **Critical** — Missing instruction files, broken configs
- 🟡 **Important** — Missing skills, incomplete documentation
- 🔵 **Suggestions** — Workflow playbooks, MCP integrations

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
| `@readiness /scan` | Full scan with LLM analysis |
| `@readiness /quick` | Instant deterministic scan |
| `@readiness /levelup` | Guided progression to next level |
| `@readiness /vibe` | Agentic proficiency assessment |
| `@readiness /guide` | Platform setup guide |
| `@readiness /migrate cline copilot` | Convert configs between platforms |
| `@readiness /graph` | Repository structure visualization |
| `@readiness /live` | Real-time AI tokens-per-minute |

### 📈 Vibe Report

Assess your team's agentic coding proficiency across 5 dimensions: Autonomy, Delegation, Recovery, Depth, and Output quality. Track metrics over time with sparkline charts.

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
| `ai-readiness.selectedTool` | Default AI platform | `ask` (prompts each time) |
| `ai-readiness.enrichmentDepth` | % of files to LLM-enrich (10-100) | `70` |
| `ai-readiness.llmTimeout` | LLM call timeout in seconds | `45` |
| `ai-readiness.enrichmentConcurrency` | Parallel LLM calls | `5` |
| `ai-readiness.enrichmentBatchSize` | Files per LLM batch | `10` |
| `ai-readiness.cacheTTL` | Cache lifetime in days | `7` |

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
| **Type & Environment Strictness** | (annotations/declarations × 80) + strict mode bonus | App/library code only | Can agents use LSP for cross-file navigation? Measured on service/app/library code, not config files. |
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
| `AI Readiness: Scan Workspace` | Run a full scan |
| `AI Readiness: Quick Scan` | Fast deterministic scan |
| `AI Readiness: Show Insights` | Open insights panel |
| `AI Readiness: Show Guide` | Platform configuration guide |
| `AI Readiness: Show Graph` | Repository structure tree |
| `AI Readiness: Vibe Report` | Agentic proficiency report |
| `AI Readiness: Start Live Tracking` | Real-time AIPM dashboard |
| `AI Readiness: Clear History` | Reset scan history |

---

## Logs & Debugging

**View → Output → "AI Readiness Scanner"** for structured logs with phase timing, LLM call tracking, and error details.

---

## Privacy & Data

- **All analysis runs locally** in your VS Code instance
- Code snippets are sent to GitHub Copilot's LM API (same as Copilot Chat) — never to third parties
- Scan results are cached in VS Code's `globalState` — no external storage
- No telemetry is collected

---

## Building from Source

```bash
git clone https://github.com/alex-keagel/vscode-ai-readiness.git
cd vscode-ai-readiness
npm install
npm run build
npm test           # 234 tests
npm run package    # creates .vsix
```

Press `F5` to launch the Extension Development Host for debugging.

---

## Release Notes

### 2.3.5
- Dynamic platform guide generation from official documentation
- Context architecture audit (MCP, skills, hooks, tool security)
- One-click insight fixes with diff editor preview
- Defensive error handling across all components

### 2.2.0
- Smart semantic indexing — fan-in analysis, git velocity, importance ranking
- Configurable enrichment depth and concurrency
- Expert agent personas for all 7 platforms

### 2.1.0
- 10-agent audit with memory leak fixes and scoring accuracy improvements
- Scan performance: 13min → 80s for large monorepos
- Structured logging across all components

### 2.0.0
- Complete rewrite with 6-level maturity ladder
- EGDR scoring model with per-platform profiles
- Semantic RAG engine with TF-IDF vector search
- Tactical Glassbox dark theme
- 7 AI platform support

---

## License

MIT

---

**Built by [Alex Keagel](https://github.com/alex-keagel) · Powered by [GitHub Copilot LM API](https://github.com/features/copilot)**
