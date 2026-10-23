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

Pin the `uses:` ref to a tag (`@v1`), an exact release tag (`@v1.2.3`),
or a commit SHA. A reusable workflow
cannot be called with `uses: ./...` from another repository, and a caller's
`permissions` can only narrow, never widen, the workflow's own
`contents: read`.

### What your pin guarantees (#457)

The Action reference *inside* `reusable-canary-check.yml` is fixed text — a
`uses:` value cannot contain an expression — so on `main` it reads
`uses: StellarCanary/ProtocolCanary-Action@v1`, the **stamp template**. The
release workflow stamps it: for every release tag it creates a **stamped
commit** whose workflow file refers to the Action at that release's own
commit SHA (a literal 40-hex value, marked `# release-stamp: <tag>`), then
moves the release tag — and the floating `v1` tag — to that stamped commit.

| You call the workflow at | The Action that runs |
|---|---|
| an exact release tag (`@v1.2.3`) | the commit that release shipped: the stamped workflow file contains that release's SHA as literal text, so the guarantee is readable off the ref you pinned |
| the stamped commit's own SHA | the same, read directly from the workflow file at that SHA |
| `@v1` (floating) | whatever release `v1` points at when the job runs — reproducible only if you pin to an exact tag or SHA |
| a branch (`main`) | the `@v1` template: the Action floats with `v1` |

Notes on the model:

- Nothing in any `uses:` value is computed from a context, and no local
  `uses: ./...` path is used without checking out this repository at a known
  ref.
- The stamped commit is not on `main`'s branch history — only the release
  tags point at it. The workflow file changes there and nothing else, so the
  stamped commit runs the exact code the release verified.
- Re-running a release is idempotent: a workflow already carrying its
  `# release-stamp:` marker is never stamped again, so moving the tag cannot
  loop.
- Stamping happens only in the release job, which holds `contents: write`
  for exactly that tag push. The reusable workflow itself — and every caller
  of it — keeps `permissions: contents: read`.

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
| `baseline-report` | string | `""` | Path to a previous report. The Action validates that the file exists and is a schemaVersion 1 report for the same target protocol; the engine's diff command is not released, so a supplied baseline leaves `diff-verdict` as `unavailable` and the run is not compared. |

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

- `baseline-report` is validated by the Action (existence, report shape, and
  target protocol), but the current engine release has no `diff` command, so
  no regression verdict is produced. `fixtures-version` is validated but has
  no fixture-pack command to forward to. The workflow warns rather than
  silently pretending they applied.
- `project-root` currently scopes configuration and fixture discovery only;
  the Action has no `working-directory` input yet (issue #348). A project
  whose `.stellar-canary.toml` and fixtures live outside those paths needs
  the single-step Action until that lands.
- The report artifact is uploaded as
  `stellar-protocol-canary-report`, the Action's stable artifact name. A
  caller running the workflow twice in one workflow run gets the Action's
  documented suffixed fallback name for the second artifact.

## Matrix checks

One verdict per protocol version, in a single job. Matrix legs of a reusable
workflow call are independent, so pin `fail-fast: false` to collect every
verdict instead of stopping at the first failure.

```yaml
name: Protocol matrix
on:
  pull_request:
permissions:
  contents: read
jobs:
  canary:
    strategy:
      fail-fast: false
      matrix:
        protocol: [27, 28]
    uses: StellarCanary/ProtocolCanary-Action/.github/workflows/reusable-canary-check.yml@v1
    with:
      protocol: ${{ matrix.protocol }}
```

A matrix fans the call out into one job per combination, so its outputs are
addressed per leg and cannot be consumed through a plain `needs:` reference.
Gate on the matrix result with job-level status checks, and reserve the
output-consuming pattern below for a single (non-matrix) call.

## Monorepo configurations

`project-root` scopes configuration and fixture discovery to one package, so a
monorepo can check every package that owns a `.stellar-canary.toml` with the
same declared contract. Listing the packages explicitly in the matrix keeps
the set reviewable; a generated `matrix.include` from a path-detection job
works the same way.

```yaml
name: Monorepo compatibility
on:
  pull_request:
permissions:
  contents: read
jobs:
  canary:
    strategy:
      fail-fast: false
      matrix:
        project:
          - packages/core
          - services/ledger
    uses: StellarCanary/ProtocolCanary-Action/.github/workflows/reusable-canary-check.yml@v1
    with:
      project-root: ${{ matrix.project }}
      protocol: 28
```

## PR gating patterns

The `exit-code` output survives a failed job, so a downstream job can react
without duplicating the verdict logic — the reusable workflow is called once
and the gate is expressed in plain job dependencies:

```yaml
name: Compatibility gate
on:
  pull_request:
  merge_group:
permissions:
  contents: read
jobs:
  canary:
    uses: StellarCanary/ProtocolCanary-Action/.github/workflows/reusable-canary-check.yml@v1
    with:
      fail-on-warning: true
  require-green:
    needs: canary
    runs-on: ubuntu-latest
    if: needs.canary.outputs.exit-code == '0'
    steps:
      - run: echo "Protocol Canary passed; the change is safe to merge."
```

For required status checks, pin the check to the `canary` job's name
(`Protocol Canary (28)`) rather than to the downstream job; `fail-on-warning`
already converts a `warning` verdict into a failed job, and the downstream
pattern is for reactions beyond blocking (summaries, notifications).

When a baseline comparison is requested (`baseline-report`), gate on
`diff-verdict` as well: while the engine's diff command is unreleased the
output is `unavailable`, and a policy that "the diff must show no regressions"
must not silently pass on that value.
