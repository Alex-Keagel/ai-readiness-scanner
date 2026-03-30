# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-03-30

### 🎉 Initial Release

**AI Readiness Scanner** — VS Code extension that evaluates codebases for AI coding agent readiness.

#### Core Features
- **One-click scan** with GitHub Copilot LM API integration
- **7 AI platforms** supported: Copilot, Cline, Cursor, Claude Code, Roo, Windsurf, Aider
- **6-level maturity ladder**: Prompt-Only → Instruction-Guided → Skill-Equipped → Playbook-Driven → Self-Improving → Autonomous Orchestration
- **100-point scoring** with weighted formula across 4 dimensions (Presence, Quality, Operability, Breadth)

#### Semantic Engine (9-Phase Deep Analysis)
- Call graph extraction (direct, cross-module, callback, event calls)
- Data flow tracing (source → transformation → sink)
- Complexity-weighted scoring per component
- Type hierarchy extraction (extends/implements)
- Module role classification (entry-point, core-logic, utility, test, generated)
- Dead code detection (exported but never imported)
- Generated code detection (KQL backups, protobuf stubs)
- Domain-oriented component grouping via LLM

#### Advanced Semantic Features
- HyDE (Hypothetical Document Embeddings) for intent-based search
- Semantic edge labeling on call graph (intent descriptions)
- Blast radius / what-if analysis (downstream impact prediction)
- Hierarchical roll-up summarization (file → directory → architecture)
- Multi-agent code auditing (Explainer + Red Teamer + Critic)
- Semantic dead code detection (feature-flagged/unreachable paths)

#### SRE Reliability Metrics (Vibe Report)
- 13 SRE metrics: Hallucination, Laziness, First-Try Success, Flow, Context Rot, Loop Detection, Session Health, Prompt Effectiveness, Regression Detection, DORA, Activity Heatmap, Code Churn, Cost Per Outcome
- Multi-platform support: Copilot CLI, Claude Code, Cline, Roo
- Per-platform and cross-platform comparison

#### Scoring Accuracy
- Language-aware type strictness (C# 85+, Python 45+, config excluded)
- Per-component Context Efficiency (specific=100, scoped=80, global=40)
- Instruction/Reality Sync (60% coverage + 40% path accuracy)
- Cross-platform instruction credit
- MCP server count auditing (>5 flagged)

#### UI Panels
- **AI Strategy** — executive brief, action items, component health, path to next level
- **Action Center** — tactical fixes with generate, preview, approve/decline/regenerate
- **Repository Structure** — collapsible component tree with dependencies
- **Vibe Report** — SRE gauges, heatmap, DORA cards, cost breakdown
- **Platform Guide** — auto-generated setup guide per AI tool
- **Chat Interface** (`@readiness`) — natural language commands

#### Quality
- 638 tests passing (Vitest)
- Validated LLM calls with 4-tier debate system
- Confidence scores on all recommendations
- workspaceState isolation (no cross-repo contamination)
