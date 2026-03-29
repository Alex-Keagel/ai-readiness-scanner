# AI Readiness Scanner — Copilot Instructions

## What This Extension Does

VS Code extension that evaluates codebases for AI coding agent readiness. Scans for agent config files (Copilot, Cline, Cursor, Claude Code, Roo, Windsurf, Aider), scores them on a 6-level maturity ladder using the EGDR scoring model, and generates missing files via multi-LLM consensus.

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `src/extension.ts` | Entry point — all command registrations, state management, disposables |
| `src/scoring/` | EGDR maturity engine, level signals, component scorer, insights |
| `src/scanner/` | Workspace analysis — file inventory, reality checker, structure analyzer |
| `src/agents/` | Multi-agent orchestrator — Mapper, Specialist, Auditor pipeline |
| `src/llm/` | LLM integration — `CopilotClient`, `MultiModelClient`, caching |
| `src/remediation/` | Fix generation — auto-fix, guided-fix, recommendations, migration |
| `src/chat/` | Chat participant (`@readiness`) with slash commands |
| `src/ui/` | Webview panels, tree view, status bar, recommendations panel |
| `src/live/` | Live AIPM tracker — session polling, metrics engine, vibe reports |
| `src/semantic/` | AST-based code chunking, content-hash cache, MCP provider |
| `src/security/` | Blast radius risk analysis per component |
| `src/graph/` | Dependency scanning, knowledge graph builder |
| `src/simulation/` | Micro-simulations — sandboxed LLM tasks per component |
| `src/storage/` | `RunStorage` + `FixStorage` — persists scan results and fix states via `context.workspaceState` (workspace-scoped, not shared across windows) |
| `src/report/` | Markdown report generator |

## Build & Development

```bash
npm run build      # esbuild bundling → dist/extension.js
npm run watch      # rebuild on file changes
npm run lint       # ESLint
npm run package    # create .vsix (runs build first)
```

Press `F5` in VS Code to launch the Extension Development Host for testing.

## LLM API — Critical Rules

- **ONLY** use `vscode.lm.selectChatModels()` and `vscode.LanguageModelChat` — the VS Code Copilot LM API
- **NEVER** import or call external LLM APIs (OpenAI SDK, Anthropic SDK, etc.)
- Model selection: `CopilotClient.selectBestModel()` picks from available Copilot models by preference (Opus → Gemini Pro → GPT-5.4 → Sonnet → fallback)
- Multi-model: `MultiModelClient` runs 3 models in parallel for consensus recommendations
- Always pass `CancellationToken` to LLM calls for user cancellation support

## Coding Conventions

- **TypeScript strict mode** — all types explicit, no implicit `any`
- Use `any` ONLY when casting VS Code API returns that lack proper types
- **async/await** with `try/catch` — never `.catch()` chains
- **Barrel exports** via `index.ts` in each module directory
- **PascalCase** for classes/interfaces, **camelCase** for functions/variables
- Every command registered in `activate()` must be added to `context.subscriptions`
- Use `vscode.workspace.findFiles()` for glob search, `vscode.Uri` for all paths
- Error handling: `vscode.window.showErrorMessage()` for user-facing errors; silent catch for optional features (LLM unavailable, etc.)

## Key Types

Core types are in `src/scoring/types.ts`:
- `AITool` — union of 7 platform identifiers
- `ReadinessReport` — full scan output (levels, components, scores)
- `LevelSignal` — signal definition (id, level, filePatterns, contentMarkers)
- `SignalResult` — evaluated signal with score, confidence, reality checks
- `ComponentScore` — per-component maturity assessment

## Architecture Notes

- The scan pipeline runs 8 phases (see `WorkspaceScanner.scan()`)
- Quick scan = deterministic only (phases 1–2); Full scan = all 8 phases with LLM
- Scoring uses 4 dimensions (Presence, Quality, Operability, Breadth) weighted per platform
- Chat participant registered via `vscode.chat.createChatParticipant()` with 13 slash commands
- Webview panels use `createWebviewPanel()` with HTML generation and `onDidReceiveMessage` for bidirectional comms
- **Do not** reference "tests" as a readiness signal — removed by design

## Adding New Features

- **New signal**: Add to `LEVEL_SIGNALS` array in `src/scoring/levelSignals.ts`, update `PLATFORM_SIGNAL_CLASS` in `src/scoring/maturityEngine.ts` if platform-specific
- **New command**: Register in `src/extension.ts` `activate()`, add to `package.json` contributes.commands
- **New chat command**: Add case to `ChatParticipant.handleRequest()` in `src/chat/participant.ts`, register in `package.json` chatParticipants commands
- **New webview panel**: Follow pattern in `src/ui/` — extend panel class, use `getWebviewContent()` for HTML
