---
applyTo: "src/**/*.ts"
---

# VS Code Extension API Patterns

## Extension Lifecycle

- Entry point: `src/extension.ts` exports `activate(context: vscode.ExtensionContext)`
- All disposables **must** be pushed to `context.subscriptions` for cleanup
- Activation event: `onStartupFinished` (declared in `package.json`)
- Extension depends on `github.copilot-chat` (declared in `extensionDependencies`)

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand('ai-readiness.fullScan', async () => { /* ... */ })
);
```

## Commands

- Register with `vscode.commands.registerCommand(id, handler)` inside `activate()`
- Command IDs use `ai-readiness.` prefix matching `package.json` contributes.commands
- Always return the disposable to `context.subscriptions`
- Use `vscode.commands.executeCommand('setContext', key, value)` for conditional UI

## Webview Panels

- Create: `vscode.window.createWebviewPanel(viewType, title, column, options)`
- Enable scripts: `{ enableScripts: true, localResourceRoots: [...] }`
- Generate HTML with `getWebviewContent()` method returning full HTML document
- Bidirectional communication:
  - Extension → Webview: `panel.webview.postMessage({ type, data })`
  - Webview → Extension: `panel.webview.onDidReceiveMessage(msg => { ... })`
- Dispose pattern: track active panel, set to `undefined` on `onDidDispose`

```typescript
panel.webview.onDidReceiveMessage(
  (message) => {
    switch (message.type) {
      case 'approve': handleApprove(message.data); break;
      case 'skip': handleSkip(message.data); break;
    }
  },
  undefined,
  context.subscriptions
);
```

## Chat Participant

- Register: `vscode.chat.createChatParticipant(id, handler)` — see `src/chat/participant.ts`
- Handler signature: `(request, chatContext, stream, token) => Promise<void>`
- Slash commands defined in `package.json` under `chatParticipants[].commands`
- Stream responses: `stream.markdown()` for text, `stream.progress()` for status
- Access user input: `request.prompt`, command: `request.command`

## Tree Views

- Implement `vscode.TreeDataProvider<T>` with `getTreeItem()` and `getChildren()`
- Register: `vscode.window.createTreeView(viewId, { treeDataProvider })`
- Fire updates: `this._onDidChangeTreeData.fire()` — use `vscode.EventEmitter`
- Tree items: `vscode.TreeItem` with `collapsibleState`, `iconPath`, `contextValue`
- See `src/ui/treeView.ts` for `ReadinessTreeProvider` implementation

## Storage

- **Global state**: `context.globalState.get/update(key, value)` — persists across sessions
- **Workspace state**: `context.workspaceState.get/update(key, value)` — workspace-scoped
- `RunStorage` in `src/storage/runStorage.ts` wraps `globalState` for scan history
- Always use `JSON.parse/stringify` for complex objects in state

## Status Bar

- Create: `vscode.window.createStatusBarItem(alignment, priority)`
- Update: set `.text`, `.tooltip`, `.command` properties
- Show/hide: `.show()` / `.hide()`
- See `src/ui/statusBar.ts` for the readiness score display pattern

## File System Operations

- Read: `vscode.workspace.fs.readFile(uri)` → `Buffer`, decode with `new TextDecoder().decode()`
- Write: `vscode.workspace.fs.writeFile(uri, Buffer.from(content))`
- Find: `vscode.workspace.findFiles(include, exclude, maxResults)`
- Watch: `vscode.workspace.onDidChangeTextDocument`, `onDidCreateFiles`, `onDidDeleteFiles`
- Paths: always use `vscode.Uri.joinPath(base, ...segments)` — never string concatenation

## LLM API (Copilot Language Model)

- Select models: `vscode.lm.selectChatModels({ vendor: 'copilot' })` → `LanguageModelChat[]`
- Create messages: `vscode.LanguageModelChatMessage.User(prompt)`
- Send request: `model.sendRequest(messages, {}, token)` → `LanguageModelChatResponse`
- Stream response: `for await (const chunk of response.text) { ... }`
- See `src/llm/copilotClient.ts` for model selection and retry logic

## Progress Reporting

- Use `vscode.window.withProgress()` for long operations (scans, fixes)
- Location options: `Notification` (toast), `SourceControl`, `Window` (status bar)
- Report: `progress.report({ message, increment })` — increment is percentage points
- Always support cancellation via the `token` parameter
