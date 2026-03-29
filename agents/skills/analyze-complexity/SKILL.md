# Analyze Component Complexity

## Description
Multi-agent pipeline that computes a complexity factor (0.0-1.0) for each component, identifies all product cores, and produces data for the Semantic Topology Graph.

## Inputs
- `components`: ComponentInfo[] — discovered components from componentMapper
- `modules`: ModuleProfile[] — profiled modules from codebaseProfiler (with fan-in, exports, role)
- `importGraph`: Map<string, string[]> — file-level import graph
- `copilotClient`: CopilotClient — for LLM analysis

## Steps
1. **Static metrics** — For each component, compute: total lines, max fan-in, total exports, cyclomatic heuristic, role. Apply the raw factor formula (size 25%, centrality 25%, API surface 20%, branching 15%, role 15%).
2. **Always-critical overrides** — Mark security-sensitive components (auth, crypto, secrets) → factor 1.0. Mark entry points → factor ≥ 0.8. Mark high fan-in (≥5) → factor ≥ 0.7.
3. **Business logic analysis (LLM)** — Send code samples (first 100 lines + exports) from non-trivial components to the Business Logic Analyst. Extract: isProduct, businessLogicDensity, domainClassification, securitySensitive, stateComplexity.
4. **Interconnection analysis (LLM, different model)** — Send import graph summary + module list to the Interconnection Analyst. Extract: interconnectionScore, bridgeComponents, pipelinePositions, confirmed products.
5. **Validate + debate** — Compare Agent 2 and Agent 3 product lists. If they disagree on which components are products, run debate via validatedCall at critical tier. Tiebreaker resolves with 3rd model.
6. **Compute final factors** — Blend: 40% static metrics + 30% business logic density + 30% interconnection score. Apply overrides: all confirmed products → min factor 0.85. Apply always-critical overrides.
7. **Generate topology metadata** — Produce graph nodes (component, factor, role, isProduct, coverageHeat) and edges (import relationships).

## Outputs
- `complexities`: ComponentComplexity[] — one per component with factor, reasons, isProduct
- `products`: string[] — paths of all confirmed product components
- `topology`: { nodes: TopologyNode[], edges: TopologyEdge[] } — for graph rendering

## Validation
- Every component must have a factor between 0.0 and 1.0
- At least 1 product must be identified (every repo has a purpose)
- Product factors must all be ≥ 0.85
- Static metrics should agree within 20 points of LLM assessment (flag otherwise)

## Error Handling
- If LLM unavailable, use static metrics only (no product detection, all factors from formula)
- If debate is unresolved, use union of both agents' product lists (err on the side of inclusion)
- If import graph is empty, skip interconnection analysis
