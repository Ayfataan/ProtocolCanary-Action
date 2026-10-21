# Plan: Protocol-Canary 0.2.0 and this Action

Status: proposal for maintainer review. Nothing in this plan has been applied.
The Action's `version` default stays `0.1.1`, the floating `v1` tag is untouched,
and no Action release is proposed by this document.

## Why this needs a plan

Protocol-Canary 0.2.0 (prepared, not yet published) changes the outcome of
invocations that worked before:

- `check` exits `2` and prints no report when no fixture applies, instead of
  passing. `--allow-empty` restores the old exit code.
- Fixture directories containing symbolic links, junctions or unsafe payload
  paths are rejected (exit `4`).
- `.stellar-canary.toml` with an unknown section or key is rejected (exit `2`).
- `check` keeps a result cache in `.stellar-canary-cache/` and JSON results gain
  an optional `source` field.

Because `@v1` is a floating tag and `version` has a default, changing the default
engine silently switches every `@v1` user to this behavior. This plan avoids that.

## What was verified (2026-10-09)

Run locally, with this repository's `dist/index.js` at `def0e8a` and an engine
built from the 0.2.0 release-preparation branch, installed in a temporary
`CARGO_HOME` so the Action's "use the installed matching binary" path ran. No
network access beyond the Action's own GitHub API call, no credentials.

| Case | Result |
|---|---|
| `version: 0.2.0`, Protocol 28 pack, offline config | job passes, `status=pass`, 4 checks passed, report path output set |
| `version: 0.2.0`, `protocol: 29` against the Protocol 28 pack | job fails as an execution failure; summary contains the engine's `no checks ran: ...` text |
| Same case, annotation text | reads "Canary configuration is invalid. (exit code 2)" and omits the engine's reason (tracked as an issue draft) |
| `version` input accepts `0.2.0` | yes, no Action change is needed to opt in |

Not verified: an install through `cargo install --git ... --tag v0.2.0`, because
the tag does not exist. That check belongs after publication.

## Update after publication (2026-10-20)

The tags now exist and the post-publication check has been attempted and
recorded in [`docs/releases.md`](releases.md) (issue #439). Summary of
what changed in that record, with no plan decision edited:

- The verification now covered by runs, all evidence in `docs/releases.md`:
  engines built from source at `v0.2.0` and `v0.1.1` pass this repository's
  real-engine suite (the pinned engine-compat job), and the new
  exit-code/skip suite (issue #438) passes against a real 0.2.0 engine.
- The **install through `cargo install ... --tag v0.2.0` step of sequence
  step 2 is still NOT recorded as passing**, and 0.2.0 is therefore NOT
  added to the README compatibility table: every consumer-style run
  (`uses: ./`) fails to load the Action itself before any install is
  attempted, because the `github-token` input in `action.yml` uses
  `${{ github.token }}`, an expression context action-metadata input
  defaults do not allow. Run URLs and the exact runner errors are in
  `docs/releases.md`; the one-line metadata fix belongs in its own PR,
  after which those runs should be repeated and the table updated together
  (never a first-row claim without a recorded passing run).
- Step 3 items are unaffected. Step 4 remains a separate maintainer decision.

## Proposed sequence

1. **Do nothing to defaults.** Users who want 0.2.0 set `version: 0.2.0`. Add a
   row to the compatibility table only after step 2 has passed.
2. **After the engine release is published,** run the Action from `main` with
   `version: 0.2.0` through `cargo install --git ... --tag v0.2.0 --locked`
   against the Fixtures `protocol-28` tag (offline job) in a scratch repository
   or a dispatched workflow. Record the run URL. Also run it with `0.1.1` to
   confirm nothing regressed.
3. **Small Action changes that make 0.2.0 usable** (separate pull requests, each
   tested with the mock engine): show the engine's reason in the failure
   annotation and fix the exit-2 description; an `allow-empty` input accepted
   only when the resolved engine is 0.2.0 or newer; display replayed-result
   counts.
4. **Decide the default separately.** Moving the default to 0.2.0 turns
   previously passing `@v1` runs into failures. Recommended: do it only in a new
   major tag (`v2`) with a migration note, leaving `v1` on `0.1.1`. This is a
   maintainer decision; it is not made here.
5. **Update the compatibility table** in the README and `docs/releases.md` with
   exactly the combinations that were run in step 2, and nothing else.

## Risks to watch

- The weekly live integration job (formerly `integration.yml`, now
  `weekly-live.yml`) has failed since Testnet moved to protocol 29
  (issue #352, repaired there). It will
  also fail for 0.2.0 against Protocol 28 identity fixtures. That is expected under
  decision D-09 and is not a reason to change engine behavior.
- Anyone running a "no fixtures" step on purpose (for example to test their
  workflow wiring) needs `--allow-empty`, which the Action cannot pass today.
- A checksum published beside an engine asset protects against corruption, not
  against a compromised release; this Action does not verify signatures because
  none exist.
