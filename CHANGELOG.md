# Changelog

## [1.2.3] — 2026-03-31

- docs: clean changelog for v1.0.0 public release

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-03-31

### 🎉 Initial Release

**AI Readiness Scanner** — VS Code extension that evaluates codebases for AI coding agent readiness.

#### Core Features
- **One-click scan** with GitHub Copilot LM API integration
- **7 AI platforms** supported: Copilot, Cline, Cursor, Claude Code, Roo, Windsurf, Aider
- **6-level maturity ladder**: Prompt-Only → Instruction-Guided → Skill-Equipped → Playbook-Driven → Self-Improving → Autonomous Orchestration
- **100-point scoring** with weighted formula across 4 dimensions (Presence, Quality, Operability, Breadth)
- **Deterministic component discovery** — manifest-based tree (no LLM dependency for structure)

#### Deep Analysis (15-Phase Pipeline)
- Call graph extraction (direct, cross-module, callback, event calls)
- Data flow tracing (source → transformation → sink)
- Instruction-vs-code cross-reference engine
- Skill quality evaluation (5 dimensions: completeness, accuracy, actionability, relevance, security)
- Complexity-weighted scoring per component
- Type hierarchy extraction (extends/implements)
- HyDE search, blast radius analysis, roll-up summaries, semantic dead code detection

#### SRE Reliability Metrics (Vibe Report)
- 13 SRE metrics: Hallucination, Laziness, First-Try Success, Flow, Context Rot, Loop Detection, Session Health, Prompt Effectiveness, Regression Detection, DORA, Activity Heatmap, Code Churn, Cost Per Outcome
- Multi-platform session collection: Copilot CLI, Claude Code, Cline, Roo

#### UI Panels
- **AI Strategy** — executive brief, component health, path to next level
- **Action Center** — tactical fixes with generate, preview, approve/decline
- **Repository Structure** — collapsible component tree with dependencies
- **Vibe Report** — SRE gauges, heatmap, DORA cards, cost breakdown
- **Platform Guide** — auto-generated setup guide per AI tool
- **Chat Interface** (`@readiness`) — natural language commands

#### Quality
- 681 tests (Vitest)
- Centralized insight dedup + noise filtering
- Validated LLM calls with confidence scoring
- workspaceState isolation (no cross-repo contamination)
