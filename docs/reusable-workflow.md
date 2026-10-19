# Reusable Protocol Canary workflow

`.github/workflows/reusable-canary-check.yml` wraps
[`StellarCanary/ProtocolCanary-Action`](../action.yml) in a maintained
reusable workflow, so a repository can standardise its compatibility check
with a single `uses:` declaration instead of repeating the checkout, input
mapping and verdict logic in every workflow.

The workflow is read-only by contract: `permissions: contents: read` is
declared at the top level and on the job, so a caller can never grant it
write access through inputs. It is not configurable, and no step pushes,
comments, or modifies the caller's repository.

## Usage

```yaml
name: Stellar Compatibility

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  canary:
    uses: StellarCanary/ProtocolCanary-Action/.github/workflows/reusable-canary-check.yml@v1
    with:
      protocol: 28
      fixtures-version: v1.2.0
```

Pin the `uses:` ref to a tag (`@v1`) or commit SHA. A reusable workflow
cannot be called with `uses: ./...` from another repository, and a caller's
`permissions` can only narrow, never widen, the workflow's own
`contents: read`.

Reusable workflows do not accept `runs-on`, `environment`, or job-level
`timeout-minutes` overrides from the caller. The job runs on
`ubuntu-latest` and relies on the runner's Cargo toolchain, exactly like the
single-step Action (see the README's
[Installation & integrity](../README.md#installation--integrity) section).

## Inputs

| Input | Type | Default | Meaning |
|---|---|---|---|
| `project-root` | string | `.` | Project root relative to the caller's workspace. The workflow looks for `<project-root>/.stellar-canary.toml` and uses `<project-root>/fixtures` as `fixtures-dir`. |
| `protocol` | number | `28` | Target Stellar protocol version, forwarded as the Action's `protocol` input. |
| `fixtures-version` | string | `""` | Fixture-pack release tag, e.g. `v1.2.0`. Validated by the Action, but **not forwarded to the engine**: `stellar-canary` has no fixture-pack flag, so the run still reads `<project-root>/fixtures`. Check that pack out into `fixtures-dir` to pin it. |
| `fail-on-warning` | boolean | `false` | Promote a `warning` result to a failed calling job. |
| `baseline-report` | string | `""` | Path to a previous report. Accepted for forward compatibility; the engine's diff command is not released, so a supplied baseline leaves `diff-verdict` as `unavailable` and the run is not compared. |

`config` is not an input: the workflow passes `<project-root>/.stellar-canary.toml`
only when that file exists, so a project without a configuration file keeps
the CLI's default lookup instead of failing an input validation check.

## Outputs

| Output | Meaning |
|---|---|
| `report-path` | Absolute path to the generated JSON report, or empty when the Action could not produce one (`status: execution-failed`). |
| `diff-verdict` | `not-requested` when `baseline-report` is empty, `unavailable` when a baseline was supplied (diffing is not available yet). |
| `exit-code` | `0` for a successful run after `fail-on-warning` is applied, `1` when the Action step failed or warnings were promoted to a failure. |

Outputs are available even when the job fails, so a downstream job can react
with `needs.canary.outputs.exit-code`.

```yaml
jobs:
  canary:
    uses: StellarCanary/ProtocolCanary-Action/.github/workflows/reusable-canary-check.yml@v1
    with:
      fail-on-warning: true
```

## Secrets

| Secret | Required | Meaning |
|---|---|---|
| `github-token` | no | Used only to raise the GitHub REST rate limit while resolving the engine tag's commit. Defaults to the caller's `github.token`; the workflow never logs it. |

```yaml
jobs:
  canary:
    uses: StellarCanary/ProtocolCanary-Action/.github/workflows/reusable-canary-check.yml@v1
    secrets:
      github-token: ${{ secrets.CANARY_GITHUB_TOKEN }}
```

## Limitations

- `baseline-report` and `fixtures-version` are declared and validated, but
  the current engine release has no `diff` or fixture-pack command to forward
  them to. The workflow warns rather than silently pretending they applied.
- `project-root` currently scopes configuration and fixture discovery only;
  the Action has no `working-directory` input yet (issue #348). A project
  whose `.stellar-canary.toml` and fixtures live outside those paths needs
  the single-step Action until that lands.
- The report artifact is uploaded as
  `stellar-protocol-canary-report`, the Action's stable artifact name. A
  caller running the workflow twice in one workflow run gets the Action's
  documented suffixed fallback name for the second artifact.
