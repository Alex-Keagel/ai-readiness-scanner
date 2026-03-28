---
applyTo: "**/*.ts"
---

# TypeScript Conventions

## Strict Mode

- `tsconfig.json` has `"strict": true` — all types must be explicit
- Target: `ES2022`, Module: `Node16`
- Never use `any` unless casting a VS Code API return that lacks proper types
- Prefer `unknown` over `any` for untyped external data, then narrow with type guards

## Types & Interfaces

- Use `interface` over `type` for object shapes — interfaces are extendable and produce better error messages
- Use `type` only for unions, intersections, and mapped types
- Export types from `types.ts` in each module; re-export via `index.ts` barrel files
- Prefix type-only exports with `type` keyword: `export type { SignalResult }`

## Async Patterns

- Always use `async/await` with `try/catch` blocks — never `.catch()` chains
- Pass `vscode.CancellationToken` through async call chains for cancellation support
- Check `token.isCancellationRequested` before expensive operations
- Use `Promise.all()` for parallel work (e.g., `SpecialistAgent` runs per language)

```typescript
// ✅ Correct
async function analyze(token: vscode.CancellationToken): Promise<Result> {
  try {
    if (token.isCancellationRequested) { return emptyResult(); }
    const data = await fetchData();
    return process(data);
  } catch (err) {
    vscode.window.showErrorMessage(`Analysis failed: ${err}`);
    return emptyResult();
  }
}

// ❌ Wrong — no try/catch, uses .catch()
function analyze() {
  return fetchData().then(process).catch(console.error);
}
```

## VS Code API Patterns

- File search: `vscode.workspace.findFiles(include, exclude)` — returns `Uri[]`
- Path handling: always use `vscode.Uri.joinPath()`, never string concatenation
- Read files: `vscode.workspace.fs.readFile(uri)` → decode with `TextDecoder`
- Workspace root: `vscode.workspace.workspaceFolders?.[0]?.uri`

## Imports

- Use barrel exports from `index.ts` files: `import { SemanticCache, WorkspaceIndexer } from './semantic'`
- Group imports: vscode → external packages → internal modules
- Use `import type` for type-only imports to avoid runtime overhead

## Naming

- **PascalCase**: classes (`MaturityEngine`), interfaces (`DimensionWeights`), enums, type aliases
- **camelCase**: functions (`calculateReport`), variables, parameters, properties
- **UPPER_SNAKE_CASE**: constants (`LEVEL_SIGNALS`, `PLATFORM_THRESHOLDS`, `ANTI_PATTERNS`)
- Prefix private methods/properties: no underscore — use TypeScript `private` keyword

## Error Handling

- User-facing errors: `vscode.window.showErrorMessage('descriptive message')`
- User-facing warnings: `vscode.window.showWarningMessage()`
- Optional features (LLM unavailable, model not found): catch silently, log to console, degrade gracefully
- Never throw from event handlers or disposables — always wrap in try/catch

## String Formatting

- Use template literals for string interpolation
- Use tagged template literals sparingly — prefer simple `${}` interpolation
- Multi-line HTML for webviews: use template literals with proper indentation
