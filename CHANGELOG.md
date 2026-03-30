# Changelog

## [1.1.4] — 2026-03-30

- fix: 2 recommendation accuracy bugs from audit

## [1.1.3] — 2026-03-30

- feat: LLM enrichment renames containers + adds business descriptions
- fix: virtual parents for orphan children + standalone dir discovery

## [1.1.2] — 2026-03-30

- feat: recursive sub-grouping for large parent directories
- feat: improved grouping — tests consolidated, scripts under infra, noise filtered

## [1.1.1] — 2026-03-30

- feat: intelligent component grouping — merge configs, infra, remove noise

## [1.1.0] — 2026-03-30

- feat: replace LLM structure discovery with deterministic manifest-based tree

## [1.0.7] — 2026-03-30

- fix: batch explosion + rate limiting — merge orphans, limit concurrency, retry

## [1.0.6] — 2026-03-30

- feat: graph-based community chunking for large repo batching
- feat: graph-first component grouping — semantic data feeds Domain Architect

## [1.0.5] — 2026-03-30

- feat: fully dynamic scan — no hardcoded depth/pattern limits
- fix: root cause of missing components — tree depth was 2, now 4

## [1.0.4] — 2026-03-30

- fix: deep analysis stored regardless of recommendation count

## [1.0.3] — 2026-03-30

- feat: parallel batched Domain Architect for large repos
- fix: Domain Architect anti-collapse for large repos
- docs: update copilot-instructions.md + auto-sync README version badge

## [1.0.2] — 2026-03-30

- fix: deeper component discovery + graph export + ground truth reports
- docs: update README with unified knowledge graph, 3-agent pipeline, advanced features

## [1.0.1] — 2026-03-30

- feat: v1.0.0 — initial release
- feat: domain-oriented component grouping via LLM prompt
- fix: Python dependency detection — hyphen/underscore normalization
- feat: dead code detection + README overhaul for v1.7.15
- feat: v1.7.14 — SRE metrics, unified pipeline, scoring accuracy overhaul
- feat: add 6 dev workflow skills for GitHub Copilot CLI
- chore: remove globalState migration fallback — clean workspaceState only
- fix: migrate ALL storage from globalState to workspaceState
- fix: cross-repo contamination — validate report matches workspace
- fix: 4 scan result bugs from ZTS analysis

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
