# Compatibility Matrix

This document describes the classification system used by the scheduled compatibility matrix workflow (`.github/workflows/compat-matrix.yml`).

## Overview

The compatibility matrix tests combinations of:
- **Engine refs**: Protocol-Canary releases (e.g., `v0.1.1`, `v0.2.0`) and potentially `main`
- **Pack refs**: ProtocolCanary-Fixtures releases (e.g., `protocol-28`, `main`)

Each cell in the matrix is classified into exactly one of six categories. The workflow runs weekly and on dispatch, and fails only when a cell is classified as `unexpected-failure` or `unexpected-pass`.

## Classifications

### ✅ `supported`
The combination ran successfully and all compatibility checks passed.
- **Criteria**: Build succeeded, Action status is `pass`, at least one check executed (`total > 0`).
- **Meaning**: This engine/pack combination is compatible.
- **Job impact**: Does not fail the job.

### ⚠️ `expected-incompatible`
The combination failed, but this failure is documented in `docs/compat-expectations.json`.
- **Criteria**: Build succeeded, Action status matches an expectation entry (`fail`, `error`, or `execution-failed`), and the first diagnostic line contains the expected failure signature.
- **Meaning**: This is a known incompatibility with a documented reason. The combination is not supported, but the failure is understood and tracked.
- **Job impact**: Does not fail the job.

### 🔧 `infrastructure`
The combination could not be evaluated due to an environmental problem.
- **Criteria**: Build/checkout failed, timed out, or was cancelled.
- **Meaning**: The failure says nothing about compatibility — it's a CI infrastructure issue (network, runner, GitHub API, etc.).
- **Job impact**: Does not fail the job.

### ⏭️ `skipped`
The combination ran but executed zero compatibility checks.
- **Criteria**: Build succeeded, but `total === 0` (no applicable fixtures for the protocol, or fixture set empty).
- **Meaning**: No compatibility assertion was tested. This is not a pass.
- **Job impact**: Does not fail the job.

### ❌ `unexpected-failure`
The combination failed in a way that is not documented in expectations.
- **Criteria**: Build succeeded, Action status is `fail`, `error`, `execution-failed`, or `warning`, and no matching expectation exists.
- **Meaning**: A new, undocumented incompatibility or regression. **This fails the job.**
- **Job impact**: **Fails the job** — requires investigation.

### 🔄 `unexpected-pass`
The combination passed, but an expectation says it should fail.
- **Criteria**: Build succeeded, Action status is `pass`, but an expectation entry exists for this engine/pack pair.
- **Meaning**: A previously known incompatibility has been resolved (engine fix, fixture update, or expectation was wrong). The expectation must be updated/removed. **This fails the job.**
- **Job impact**: **Fails the job** — requires expectation update.

## Expectations Registry (`docs/compat-expectations.json`)

Expectations are **evidence-only**: an entry may only be added when it records:
1. The exact engine ref and pack ref
2. The observed failure status (`fail`, `error`, or `execution-failed`)
3. The first line of the diagnostic (failure signature) from the actual run
4. The URL of the GitHub Actions run that produced this evidence
5. The date the entry was added (ISO 8601)
6. A human-readable reason for the expected incompatibility

### Schema

```json
[
  {
    "engineRef": "v0.1.1",
    "packRef": "protocol-28",
    "expectedStatus": "fail",
    "failureSignature": "CAP-83 mismatch in transaction envelope",
    "runUrl": "https://github.com/StellarCanary/ProtocolCanary-Action/actions/runs/123456789",
    "dateAdded": "2026-01-15",
    "reason": "CAP-83 not implemented in engine v0.1.1"
  }
]
```

### Adding an Expectation

1. Run the matrix workflow (or a single cell) and observe the failure
2. Copy the run URL and the first line of the diagnostic from the job log
3. Add an entry to `docs/compat-expectations.json` with all required fields
4. Commit the change — the next matrix run will classify the cell as `expected-incompatible`

### Removing an Expectation

If a previously failing cell now passes (classified as `unexpected-pass`):
1. Verify the fix is genuine (engine update, fixture correction, etc.)
2. Remove the corresponding entry from `docs/compat-expectations.json`
3. Commit the change

## Matrix Output

The workflow produces two artifacts:
1. **Job Summary**: A markdown table with one row per cell showing classification, reason, and evidence (run URL)
2. **`compat-matrix.json`**: Machine-readable array of classified cells for programmatic consumption

### Example Summary Table

| Engine | Pack | Classification | Reason | Evidence |
|---|---|---|---|---|
| v0.1.1 | protocol-28 | ✅ supported | Compatibility checks passed | https://github.com/.../runs/123 |
| v0.2.0 | protocol-28 | ⚠️ expected-incompatible | Known incompatibility: CAP-85 not implemented | Expectation from: https://.../runs/456 \| This run: https://.../runs/789 |
| main | main | 🔧 infrastructure | Build/checkout failure: unable to evaluate compatibility | https://github.com/.../runs/999 |

## Workflow Configuration

The workflow is configured in `.github/workflows/compat-matrix.yml` with:
- **Schedule**: Weekly on Monday 03:00 UTC
- **Dispatch**: Manual trigger with optional `engine-refs` and `pack-refs` inputs
- **Permissions**: `contents: read` only (no secrets)
- **Actions**: Pinned to commit SHAs for supply chain security
- **Fail-fast**: `false` (all cells run independently)
- **Timeouts**: Explicit step timeouts to distinguish infrastructure from compatibility failures

## Interpreting Results

| Classification | Action Required |
|---|---|
| `supported` | None — combination works |
| `expected-incompatible` | None — known limitation tracked |
| `infrastructure` | Re-run if persistent; check runner/network health |
| `skipped` | Verify fixture pack has fixtures for the protocol |
| `unexpected-failure` | **Investigate** — new regression or undocumented incompatibility |
| `unexpected-pass` | **Update expectations** — previously known issue resolved |

## Related Workflows

- `engine-compat.yml`: Manual testing of engine refs against fixed packs (predecessor to this matrix)
- `weekly-live.yml`: Single live combination test
- `ci.yml`: Main CI for the Action itself

## Future Extensions

- Add OS matrix (Linux/macOS/Windows) per issue #417
- Test engine `main` branch against released packs per issue #419
- Differential testing against engine's published JSON Schema