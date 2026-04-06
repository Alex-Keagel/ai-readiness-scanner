---
name: dev-debug-extension
description: "Launch the extension in debug mode and diagnose runtime issues."
---

# Dev: Debug Extension in VS Code

## Description
Launch the extension in debug mode and diagnose runtime issues.

## Inputs
- `breakpoint_file`: string — file to set breakpoint in (optional)
- `breakpoint_line`: number — line number for breakpoint (optional)
- `command_to_test`: string — which command to invoke after launch (e.g., 'AI Readiness: Scan Workspace')

## Steps
1. **Open the project** — Open `vscode-ai-readiness` in VS Code.
2. **Set breakpoints** — If `breakpoint_file` provided, open it and click the gutter at `breakpoint_line`. Key breakpoint locations:
   - Scan start: `src/extension.ts` line ~177 (`scanner.scan()`)
   - Component mapping: `src/scanner/componentMapper.ts` line ~469 (`detectComponents`)
   - Signal scoring: `src/scoring/maturityEngine.ts` line ~310 (`calculateLevelScore`)
   - Deep analysis: `src/deep/index.ts` line ~32 (`runDeepAnalysis`)
   - UI rendering: `src/ui/insightsPanel.ts` line ~59 (`getHtml`)
3. **Launch Extension Host** — Press F5. This uses `.vscode/launch.json` "Run Extension" config.
4. **Open a test workspace** — In the Extension Host window, open a repo to scan.
5. **Run the command** — Cmd+Shift+P → type `${command_to_test}` → execute.
6. **Inspect variables** — When breakpoint hits, examine:
   - `report` — the ReadinessReport object
   - `modules` — discovered ModuleProfile array
   - `signals` — detected signal results
   - `recommendations` — generated recommendations
7. **Check Output panel** — In the Extension Host: View → Output → "AI Readiness Scanner" for structured logs.
8. **Hot reload** — After code changes, Ctrl+Shift+F5 to restart the Extension Host without relaunching.

## Outputs
- Diagnosis of the runtime issue
- Source file + line where the bug occurs
- Suggested fix

## Validation
- Extension activates without errors in the Debug Console
- The command executes and produces output
- No unhandled promise rejections in Debug Console

## Error Handling
- If Extension Host crashes, check Debug Console for stack trace.
- If LLM calls timeout, increase `ai-readiness.llmTimeout` in the Extension Host settings.
- If "No model available", ensure GitHub Copilot Chat extension is installed and authenticated in the Extension Host.

## Prerequisites
- VS Code with GitHub Copilot Chat extension
- Node.js 18+
- `npm ci` completed
- `node esbuild.js` compiled successfully
