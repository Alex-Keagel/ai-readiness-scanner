# AI Readiness Scanner — Copilot Instructions

## What This Extension Does

VS Code extension that evaluates codebases for AI coding agent readiness. Scans for agent config files across 7 platforms (Copilot, Cline, Cursor, Claude Code, Roo, Windsurf, Aider), scores on a 6-level maturity ladder, and generates fixes via multi-model consensus using Copilot models via the VS Code LM API with a unified knowledge graph.

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `src/extension.ts` | Entry point — commands, pipeline orchestration, state management |
| `src/scoring/` | EGDR maturity engine, level signals, component scorer, context audit, insights |
| `src/scanner/` | 3-agent component mapping, workspace scanner (8 phases), maturity signals |
| `src/semantic/` | Indexer (4-tier), vector store (TF-IDF), call graph, data flow, advanced features (HyDE, roll-up, blast radius, health cards, edge labels, dead branches) |
| `src/deep/` | 15-phase deep analysis pipeline — instruction analysis, profiling, cross-ref, complexity, recommendations, skill evaluation, dead code |
| `src/graph/` | Knowledge graph builder + enrichment, dependency scanner |
| `src/llm/` | CopilotClient, validated calls (4-tier with debate + tiebreaker) |
| `src/live/` | Vibe Report, 13 SRE metrics, session polling (4 platforms), live AIPM |
| `src/ui/` | Webview panels — report, AI strategy, action center, graph, sidebar |
| `src/agents/` | Agent definition loader (YAML frontmatter + markdown body) |
| `src/chat/` | Chat participant (`@readiness`) with slash commands |
| `src/remediation/` | Fix generation — auto-fix, guided-fix, platform-specific prompts |
| `src/report/` | Narrative generator (platform readiness, tooling health, friction map) |
| `src/storage/` | RunStorage + FixStorage — workspaceState persistence (per-workspace) |
| `src/metrics/` | Codebase readiness metrics (semantic density, type strictness) |
| `src/logging/` | Structured logging with phase timing |

## Build & Development

```bash
npm run build      # esbuild bundling → dist/extension.js
npm run test       # vitest (638 tests)
npm run package    # create .vsix (runs build first via prepackage)
npm run release    # build + test + bump + package
```

Press `F5` in VS Code to launch the Extension Development Host.

## Version Management

**Before every version bump**, ensure:
1. Update `README.md` version badge to match new version
2. Update `src/README.md` if module architecture changed
3. Run `npm test` to confirm all tests pass
4. Commit all changes before bumping

```bash
npm run bump           # auto-detect from conventional commits
npm run bump:patch     # 1.0.2 → 1.0.3
npm run bump:minor     # 1.0.2 → 1.1.0
npm run bump:major     # 1.0.2 → 2.0.0
```

The bump script (`scripts/bump-version.js`) updates package.json, package-lock.json, and CHANGELOG.md.

**Conventional commit prefixes** (from `.versionrc.json`):
- `feat:` → minor bump
- `fix:` / `perf:` / `refactor:` / `docs:` / `chore:` → patch bump
- `BREAKING CHANGE:` → major bump

## LLM API — Critical Rules

- **ONLY** use `vscode.lm.selectChatModels()` and `vscode.LanguageModelChat` — the VS Code Copilot LM API
- **NEVER** import or call external LLM APIs (OpenAI SDK, Anthropic SDK, etc.)
- Model selection: `CopilotClient.selectBestModel()` picks from available Copilot models
- Validated calls: `validatedAnalyze()` in `src/llm/validatedCall.ts` — 4 tiers (critical/important/standard/display) with debate + tiebreaker
- Always pass `CancellationToken` to LLM calls

## Coding Conventions

- **TypeScript strict mode** — all types explicit, no implicit `any`
- **async/await** with `try/catch` — never `.catch()` chains
- **PascalCase** for classes/interfaces, **camelCase** for functions/variables
- Every command registered in `activate()` must be added to `context.subscriptions`
- Use `vscode.workspace.findFiles()` for glob search, `vscode.Uri` for all paths
- **workspaceState only** — never use `globalState` (causes cross-repo contamination)
- Error handling: `vscode.window.showErrorMessage()` for user-facing; silent catch for optional features

## Key Types (src/scoring/types.ts)

- `AITool` — union of 7 platform identifiers
- `ReadinessReport` — full scan output (levels, components, scores, knowledgeGraph)
- `ComponentScore` — per-component maturity with `isGenerated`, `parentPath`, `children`
- `ComponentInfo` — component metadata from mapper with `isGenerated` flag
- `SignalResult` — evaluated signal with score, confidence, reality checks

## Architecture Notes

- Full scan runs entire pipeline: signals → insights → deep analysis (15 phases) → narrative
- Scoring: 6-stage pipeline (signals → reality checks → EGDR blend → anti-patterns → gates → component weighting)
- Component mapping uses 3-agent pipeline: Structure Analyst → Domain Architect → Completeness Validator
- Knowledge graph is the unified data model — enriched with call graph, data flow, edge labels after deep analysis
- Lock mechanism (`isBusy` flag) prevents concurrent scan/generate operations
- All storage uses `workspaceState` — isolated per workspace folder

## Adding New Features

- **New signal**: Add to `LEVEL_SIGNALS` in `src/scoring/levelSignals.ts`
- **New command**: Register in `extension.ts`, add to `package.json` contributes.commands
- **New deep analysis phase**: Add to `src/deep/index.ts` pipeline, update `DeepAnalysisResult` interface
- **New semantic feature**: Add to `src/semantic/advancedFeatures.ts`, wire in `deep/index.ts`
- **New graph edge type**: Add to `GraphEdge.relation` union in `src/graph/types.ts`, handle in `graphBuilder.ts`
