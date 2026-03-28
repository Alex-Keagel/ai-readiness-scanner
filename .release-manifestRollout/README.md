# Manifest Rollout Release Pipelines

## Purpose

Manifest-based rollout pipelines for the ZTS platform that deploy service artifacts through progressive deployment rings: **core → private → public**. These pipelines use Azure Ev2 (Express v2) manifest-driven deployments to ensure safe, staged rollouts across Azure environments.

## Pipeline Files

| File | Ring | Description |
|------|------|-------------|
| `release.core.manifestRollout.yml` | Core | Deploys to core infrastructure rings first (internal/canary) |
| `release.private.manifestRollout.yml` | Private | Deploys to private preview environments |
| `release.public.manifestRollout.yml` | Public | Deploys to public/GA production environments |
| `release.variables.manifestRollout.yml` | — | Shared variables consumed by all three ring pipelines |

## Deployment Ring Progression

```
Core (canary/internal) → Private (limited customers) → Public (GA)
```

- Each ring pipeline gates on the successful completion of the previous ring.
- Ev2 manifest files define the service model, rollout spec, and scope bindings for each ring.

## Shared Variables

`release.variables.manifestRollout.yml` defines:
- Service group and service identifiers
- Ev2 service model paths
- Rollout parameters (batch size, wait duration)
- Environment-specific overrides

These variables are also related to the shared pipeline variables in `.pipelines/shared.variables.yml`.

## Connection to Other Components

| Component | Relationship |
|-----------|-------------|
| `.release/` | Core release pipelines; manifest rollout is an alternative deployment strategy to the standard release flow |
| `.release/release.variables.yml` | Shared version promotion logic via `promote_version.ps1` feeds artifact versions into manifest rollout |
| `deploy/Ev2Compiler.tproj` | Compiles the Ev2 service model artifacts that these pipelines consume |
| `deploy/Add-AzCanaryCloud.ps1` | Registers canary cloud environments targeted by the core ring |
| `src/` | Source services (C# and Python) whose build artifacts are deployed by these pipelines |
| `.build/package.ps1` | Packages build output into deployable artifacts referenced by the Ev2 manifests |
| `es-metadata.yml` | Engineering system metadata for service tree registration consumed during deployment |

## How to Test

### Validate Pipeline Syntax

```bash
# Use Azure DevOps CLI to validate YAML
az pipelines run --name "manifest-rollout-core" --branch <your-branch> --parameters validate=true
```

### Dry Run (Non-Official)

1. Push changes to a feature branch.
2. Trigger `release.core.manifestRollout.yml` against a non-production environment.
3. Verify Ev2 manifest compilation succeeds via `deploy/Ev2Compiler.tproj`.
4. Confirm rollout spec targets the correct scope bindings for the test environment.

### Verify Shared Variables

- Ensure `release.variables.manifestRollout.yml` values align with `.pipelines/shared.variables.yml` and `.release/release.variables.yml`.
- Check that artifact version references match the output of `.release/promote_version.ps1`.

### Post-Deployment Validation

- Monitor service health via dashboards defined in `misc/Dashboard/`.
- Confirm deployment reached the expected ring by checking Ev2 rollout status.

## Key Constraints

- **Ring ordering is mandatory** — never skip core → private → public progression.
- **Ev2 artifacts must be precompiled** — run `deploy/Ev2Compiler.tproj` before triggering rollout.
- **Variables file must stay in sync** — changes to shared variables require updates across all three ring pipelines.
- **Do not modify these pipelines without coordinating with release engineering** — see `.clinerules/owners.txt` and `.github/owners.txt` for ownership.