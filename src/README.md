# Extension Core (`src/`)

## What It Does

VS Code extension that scans a workspace for **agentic coding readiness**, scores it across multiple dimensions, and generates assessment reports with a unified knowledge graph.

Scoring criteria are defined in `src/scoring/levelSignals.ts` (signal definitions) and `src/scoring/maturityEngine.ts` (scoring pipeline). See the main [README](../README.md) for the full scoring methodology.

## Module Architecture

```
src/
├── extension.ts          Entry point — commands, pipeline orchestration
├── utils.ts              Shared helpers
│
├── scanner/              Workspace scanning & component discovery
│   ├── workspaceScanner  8-phase scan pipeline
│   ├── componentMapper   3-agent LLM component mapping (Structure → Domain → Validator)
│   ├── maturityScanner   Signal detection & L1 codebase metrics
│   └── repoMapper        Directory tree generation
│
├── scoring/              Score computation
│   ├── maturityEngine    6-stage scoring pipeline (signals → gates → blend → penalties)
│   ├── componentScorer   Per-component signal evaluation + parent inheritance
│   ├── contextAudit      MCP health, skill quality, context efficiency (per-component)
│   ├── insightsEngine    LLM-generated insights & skill suggestions
│   └── types             All shared types (ReadinessReport, ComponentScore, etc.)
│
├── semantic/             Semantic code understanding
│   ├── indexer           4-tier indexing (structural → ranked → LLM enriched → heuristic)
│   ├── cache             Per-file semantic cache with reactive invalidation
│   ├── vectorStore       TF-IDF vector search (pure TypeScript, no deps)
│   ├── callGraph         Call graph extraction (regex + import + LLM, 4 edge types)
│   ├── dataFlow          Data flow tracing (source → transformation → sink)
│   └── advancedFeatures  HyDE search, roll-up summaries, edge labels, blast radius,
│                         multi-agent health cards, semantic dead branches
│
├── deep/                 Deep analysis pipeline (15 phases)
│   ├── index             Pipeline orchestrator (instruction → profile → graph → flow →
│   │                     complexity → cross-ref → recommendations → skills → dead code →
│   │                     HyDE → roll-up → edge labels → blast radius → audit → dead branches)
│   ├── instructionAnalyzer  Extracts claims from instruction files
│   ├── codebaseProfiler     Module profiling (fan-in, imports, pipelines)
│   ├── crossRefEngine       Instructions vs codebase cross-reference
│   ├── recommendationSynthesizer  Evidence-backed fix generation
│   ├── complexityAnalyzer   8-factor complexity scoring + product detection
│   ├── skillEvaluator       5-dimension skill quality evaluation
│   └── relevanceAgents      Exclusion, test classification, gap relevance
│
├── graph/                Knowledge graph (the unified data model)
│   ├── types             Node types, edge relations (CALLS, DATA_FLOWS_TO, EXTENDS...)
│   ├── graphBuilder      Builds + enriches graph from scan + deep analysis
│   └── dependencyScanner Import-based dependency detection (hyphen/underscore aware)
│
├── llm/                  LLM integration
│   ├── copilotClient     GitHub Copilot LM API wrapper
│   └── validatedCall     4-tier validation with debate + tiebreaker
│
├── live/                 Real-time monitoring & Vibe Report
│   ├── vibeReport        Agentic proficiency scoring (APS) + session collection
│   ├── sreMetrics        13 SRE reliability metrics
│   ├── sessionPoller     Multi-platform session polling (Copilot/Claude/Cline/Roo)
│   ├── metricsEngine     Live AIPM tracking
│   └── livePanel         Real-time dashboard
│
├── ui/                   Webview panels
│   ├── webviewPanel      Main report with radar chart + structure tree
│   ├── insightsPanel     AI Strategy executive brief
│   ├── recommendationsPanel  Action Center with generate/preview/approve
│   ├── graphPanel        Collapsible component tree
│   ├── sidebarPanel      Sidebar with scan controls + weight sliders
│   └── theme             Tactical Glassbox CSS theme
│
├── agents/               Agent definitions loader
│   └── agentRegistry     Runtime agent definition parser (YAML frontmatter + markdown)
│
├── report/               Report generation
│   └── narrativeGenerator  LLM narrative for platform readiness, tooling health, friction map
│
├── remediation/          Fix generation
│   └── fixPrompts        Platform-specific remediation prompt templates
│
├── storage/              Persistence (all workspaceState)
│   ├── runStorage        Scan history (max 20 runs)
│   └── fixStorage        Fix tracking (approved/declined/pending)
│
├── logging/              Structured logging with phase timing
├── metrics/              Codebase readiness metrics (semantic density, type strictness)
└── test/                 638 tests (Vitest)
```

## How to Build

```bash
npm run compile        # TypeScript compilation
npm run build          # esbuild production bundle (see ../esbuild.js)
npm run watch          # incremental recompilation on save
```

Output is bundled into a single JS file by `esbuild.js`.

## How to Test

```bash
npm test               # runs vitest (config: ../vitest.config.ts)
```

- Unit tests use **Vitest** — see `vitest.config.ts` at the repo root for runner configuration.
- For integration/E2E testing, use the **Extension Host** debug profile in `.vscode/launch.json` (`F5` in VS Code).

## How to Debug

1. Open the repo in VS Code.
2. Press `F5` — launches a sandboxed Extension Development Host window.
3. Run the extension commands from the Command Palette in the new window.
4. Debug launch profiles are defined in [`.vscode/launch.json`](../.vscode/launch.json); build tasks in [`.vscode/tasks.json`](../.vscode/tasks.json).

## Gotchas

- **Single-file bundle** — `esbuild.js` bundles everything into one output file. Don't add side-effectful top-level code in `utils.ts` unless it's gated behind a function call.
- **VS Code API is external** — The `vscode` module is NOT bundled; it's provided at runtime by the host. Never import sub-paths of `vscode`.
- **Activation events** — Commands must be declared in `package.json` under `contributes.commands` AND have matching activation events, or they silently won't register.
- **No workspace assumption** — The scanner must handle the case where no workspace folder is open (`vscode.workspace.workspaceFolders` may be `undefined`).
- **VSIX size** — `.vscodeignore` controls what ships in the package. If you add new runtime assets, ensure they aren't excluded. Conversely, don't ship test files or docs — check `.vscodeignore` before packaging.
- **Node target** — `tsconfig.json` targets the Node.js version embedded in VS Code's Electron. Don't use newer Node APIs without checking compatibility.