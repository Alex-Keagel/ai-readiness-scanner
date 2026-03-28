# FPA Release Pipelines

## Purpose

First-Party Application (FPA) release pipelines manage the deployment lifecycle of Azure first-party application registrations and credentials used by ZTS services for authentication and authorization within Microsoft's internal ecosystem.

## Pipeline Files

| File | Description |
|------|-------------|
| `release.fpa.yml` | Primary FPA release pipeline — registers and updates first-party app credentials |
| `release.fpa.v2.yml` | V2 FPA release pipeline — updated deployment flow with newer Ev2 service model integration |

## What FPA Release Does

- Provisions and rotates Azure AD first-party application registrations for ZTS services
- Deploys FPA credential configurations across target environments (canary, production rings)
- Integrates with Ev2 (Express V2) deployment framework for safe, staged rollouts
- Ensures ZTS services have valid service principal credentials for cross-service authentication

## Connection to Other Components

### Upstream Dependencies

- **`deploy/Ev2Compiler.tproj`** — Compiles Ev2 service model artifacts consumed by FPA pipelines
- **`deploy/Add-AzCanaryCloud.ps1`** — Registers canary cloud environments before FPA deployment
- **`.pipelines/shared.variables.yml`** — Shared variable definitions (subscription IDs, tenant IDs, environment names)

### Sibling Release Pipelines

- **`.release/release.official.yml`** — Official service release; depends on FPA apps being registered first
- **`.release/release.nonofficial.yml`** — Dev/test release; uses separate FPA registrations
- **`.release/release.cluster.core.yml`** — Cluster-level deployment; consumes FPA credentials at runtime
- **`.release-manifestRollout/`** — Manifest-based rollouts that reference FPA-provisioned identities

### Downstream Consumers

- **`src/`** — ZTS services authenticate using credentials provisioned by these pipelines
- **`src/globalsettings.Development.json`** — Local dev settings reference FPA app IDs for local testing

## Release Variables

FPA pipelines consume variables from:

- `.release/release.variables.yml` — Shared release variables and version promotion
- `.pipelines/shared.variables.yml` — Cross-pipeline shared variables
- Pipeline-specific variable groups configured in Azure DevOps

## How to Test

### Validate Pipeline Syntax

```bash
# Validate YAML syntax locally
python -c "import yaml; yaml.safe_load(open('.release-fpa/release.fpa.yml'))"
python -c "import yaml; yaml.safe_load(open('.release-fpa/release.fpa.v2.yml'))"
```

### Dry Run via Non-Official Pipeline

1. Push changes to a feature branch
2. Trigger `.release/release.nonofficial.yml` which exercises FPA registration in a test tenant
3. Verify app registrations appear in the target Azure AD tenant

### Verify Ev2 Artifacts

```powershell
# Build the Ev2 service model to ensure FPA configs compile
dotnet build deploy/Ev2Compiler.tproj
```

### Post-Deployment Validation

- Confirm FPA app registrations exist in the target tenant via Azure Portal → App registrations
- Verify credential expiration dates are set correctly
- Check that downstream ZTS services can authenticate using the provisioned credentials

## Version Promotion

FPA releases follow the same version promotion flow as core releases:

1. `.release/promote_version.ps1` bumps the version
2. FPA pipeline picks up the new version from release variables
3. Staged rollout proceeds through canary → production rings

## Ownership

See `.clinerules/owners.txt` and `.github/owners.txt` for pipeline and deployment ownership.