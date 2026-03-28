---
name: scaffold-scanner-tests
description: Scaffolds Vitest test files for exported functions in AI Readiness Scanner source modules with happy-path, edge-case, and error-case skeletons.
---

# Scaffold Scanner Tests

## Inputs

- `targetModule`: Path to the source file to test (e.g., `src/utils.ts`, `src/extension.ts`)
- `functionNames`: Comma-separated list of exported functions to generate tests for

## Steps

1. **Read the target module** at `${targetModule}` and extract all exported function signatures.
   - Capture function name, parameter names/types, and return type.
   - If `functionNames` is provided, filter to only those functions.

2. **Determine the test file path.**
   - Strip `src/` prefix and `.ts` extension from `targetModule` to get `<moduleName>`.
   - Create the test file at `src/__tests__/<moduleName>.test.ts`.
   - If the directory `src/__tests__/` does not exist, create it.

3. **Generate the test file scaffold.**
   - Add top-level imports:
     ```typescript
     import { describe, it, expect } from 'vitest';
     import { <functionNames> } from '../<moduleName>';
     ```
   - If any test needs file-system helpers or mock data, import from `../utils` as needed.
   - For **each function**, generate a `describe('<functionName>', () => { ... })` block containing:
     - `it('should return expected output for valid input')` — happy path with representative arguments.
     - `it('should handle empty input')` — pass empty string, empty array, or undefined where applicable.
     - `it('should handle malformed or missing data')` — pass invalid structures, missing file paths.
     - `it('should throw or return fallback on error')` — wrap in `expect(() => ...).toThrow()` or assert graceful fallback value.
   - Mark generated test bodies with `// TODO: fill in assertions` so they compile but flag as incomplete.

4. **Use `describe`/`it` block style** consistent with Vitest and the project's `vitest.config.ts` configuration.

5. **Verify the scaffold compiles and runs:**
   - Run `npx vitest run --reporter=verbose` in the workspace root.
   - Confirm the new test file appears in the output with no syntax errors.
   - Failing assertions (from TODO stubs) are expected at this stage.

## Outputs

- New file: `src/__tests__/<moduleName>.test.ts` with structured `describe`/`it` test skeletons for each targeted function.

## Validation

- `npx vitest run` executes without syntax or import errors.
- New `describe` blocks for each function appear in the verbose test output.
- Each function has at minimum 3 test cases: happy path, edge case, error case.