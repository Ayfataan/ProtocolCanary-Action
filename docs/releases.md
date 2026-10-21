# Release and compatibility verification records

This document records exactly what was run to verify engine compatibility
with the Action — one row per run, every row with its run URL (the run
evidence for issue #439). It is intentionally literal: a combination that
did not pass is listed as failing or as "not verified", never assumed.

## Engine-compatibility runs

| Date (UTC) | Action commit | Engine | Engine source | Fixtures pack | Scenario | Outcome | Run |
|---|---|---|---|---|---|---|---|
| 2026-10-20 | `ba9a8b5` (branch `feat/436-439-batch`) | 0.2.0 (`v0.2.0`, commit `7e1eb63`) | built from source (`cargo build --release --locked`) | `protocol-28` (commit `75ec2c2`) | `tests/integration/real-engine.test.ts` offline suite (the dedicated engine-compat job) | **PASS** | <https://github.com/nemeregiftbrown-byte/ProtocolCanary-Action/actions/runs/39407695231> |
| 2026-10-20 | `ba9a8b5` (branch `feat/436-439-batch`) | 0.1.1 (`v0.1.1`) | built from source (`cargo build --release --locked`) | `protocol-28` (commit `75ec2c2`) | same suite, legacy engine | **PASS** | <https://github.com/nemeregiftbrown-byte/ProtocolCanary-Action/actions/runs/39407695231> |
| 2026-10-20 | `ba9a8b5` (branch `feat/436-439-batch`) | 0.2.0 (`v0.2.0`) | built from source | tiny generated packs (moved into `tests/integration/real-engine-exit-codes.test.ts`) | the new exit-code/skip suite (issue #438): exits 1, 3, 4, two-invalid-pack, and skipped fixtures | **PASS** (5/5 cases) | <https://github.com/nemeregiftbrown-byte/ProtocolCanary-Action/actions/runs/39407695231> |
| 2026-10-20 | `ba9a8b5` (branch `feat/436-439-batch`) | 0.2.0 (`v0.2.0`) | **installed by the Action itself** (`cargo install --git … --tag v0.2.0`) | `protocol-28` (commit `75ec2c2`) | consumer workflow (`uses: ./`) from this branch, offline | **FAIL** — the Action could not be loaded | <https://github.com/nemeregiftbrown-byte/ProtocolCanary-Action/actions/runs/39407695231> |
| 2026-10-20 | `ba9a8b5` (branch `feat/436-439-batch`) | 0.1.1 (`v0.1.1`) | **installed by the Action itself** (`cargo install --git … --tag v0.1.1`) | `protocol-28` (commit `75ec2c2`) | same consumer scenario | **FAIL** — same load failure | <https://github.com/nemeregiftbrown-byte/ProtocolCanary-Action/actions/runs/39407695231> |

An earlier full pass of the same engine-compat job (built from tags,
before the exit-code suite existed) is recorded at
<https://github.com/nemeregiftbrown-byte/ProtocolCanary-Action/actions/runs/39406571511>,
which also contains the first observations of the consumer failure below.

## The consumer failure (reported, not fixed here)

Both consumer runs (the rows above marked FAIL) end at a failure that is
not about engine compatibility at all. The Action fails to load with:

```
##[error]./action.yml (Line: 144, Col: 18): Unrecognized named-value: 'github'.
Located at position 1 within expression: github.token
##[error]Failed to load ./action.yml
```

The `github-token` input in `action.yml` declares
`default: ${{ github.token }}`, but the `github` context is not available
in action-metadata input defaults (only `inputs.*` is), so every
`uses:`-based run of the Action fails before `cargo install` is ever
reached — this is why the install-from-tag chapters of the table are FAIL
rather than PASS. In line with issue #439's technical guidance ("If you
find an Action bug while verifying, report it with the run URL rather than
fixing it in this PR"), the bug is reported here unchanged; the README's
supported-versions table therefore lists no 0.2.0 combination, because no
run has ever demonstrated it end to end (see the negative-testing rule:
"a table row without a run is not acceptable"). The one-line metadata fix
should land in its own PR, after which the consumer rows above can be
re-run and then promoted.

## What was NOT run

- No consumer run has ever reached `cargo install --git … --tag v0.2.0`
  (blocked by the load failure above), and no consumer run has passed for
  any engine version. The engine-compatibility evidence in rows 1–2 comes
  from engines built from source and the Action's own test suite, which is
  exactly what `engine-compat.yml` runs.
- The Fixtures pack tag under test is `protocol-28` (commit `75ec2c2`).
  No other pack tag, protocol, or network scenario was run: the recorded
  scenario is the offline one only.
- The Windows/macOS coverage from issue #436 is process-level (mock
  engine) and does not touch a real engine; it is not recorded here.
