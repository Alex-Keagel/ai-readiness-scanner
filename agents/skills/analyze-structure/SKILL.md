# Analyze Repository Structure

## Description
Agent-driven structure analysis that generates expected file recommendations based on platform docs, project complexity, and product detection. Also generates dynamic exclusion patterns.

## Inputs
- `tool`: AITool — target platform (copilot, cline, cursor, etc.)
- `workspaceUri`: Uri — workspace root
- `context`: ProjectContext — languages, frameworks, project type
- `docsContent`: string — official platform documentation content
- `complexities`: ComponentComplexity[] — per-component complexity from analyze-complexity skill
- `products`: string[] — confirmed product component paths

## Steps
1. **Generate dynamic exclusion glob** — Scan workspace root dirs. Classify each as project code vs dependency/build/IDE/cache. Check `.gitignore` for patterns. LLM-classify ambiguous dirs. Produce canonical exclude glob.
2. **Extract expected structure from docs** — Send platform docs to Structure Analyzer Agent. Extract expected files with level, description, required/optional.
3. **Adjust expectations by complexity** — For each expected file category:
   - Product components → add: scoped instruction file, agent definition, skill, detailed README
   - Complex support (factor > 0.6) → add: scoped instruction file, README
   - Simple support (factor ≤ 0.6) → add: README only
   - Config/data/test → no additional expectations
4. **Check file existence** — For each expected file, check if it exists on disk using the dynamic exclude glob.
5. **Generate visual tree** — Build tree visualization of expected vs actual structure.
6. **Generate topology metadata** — If complexity data available, produce semantic topology graph data with responsive layout hints.

## Outputs
- `excludeGlob`: string — canonical exclusion pattern for all scanners
- `expected`: ExpectedFile[] — expected files with existence status, level, description
- `completeness`: number — % of expected files present
- `visualTree`: string — formatted tree for display
- `topologyData`: { nodes, edges, layout } — for Semantic Topology Graph

## Validation
- Exclude glob must contain at least `node_modules` and `.git`
- Expected files must include at least the platform's root instruction file
- Completeness must be 0-100%
- No expected file should be inside an excluded directory

## Error Handling
- If docs unavailable, fall back to static expected files from AI_TOOLS config
- If complexity data unavailable, skip complexity-adjusted expectations
- If LLM unavailable, use static exclusion patterns
