# Migrating to Protocol Canary Action v2

Action v2 changes the default Protocol-Canary engine from `0.1.1` to `0.2.0`.
The Action's own major version is separate from the engine version: keep using
`@v1` to remain on the v1 line, or opt into the v2 line only after its major
release is published. The floating `v1` tag must remain on a v1 release.

Protocol-Canary `0.2.0` is a minor engine release, but it intentionally tightens
several behaviors. Review these changes before moving a workflow from the v1
Action line. Each behavior below is documented in the engine's
[0.2.0 changelog](https://github.com/StellarCanary/Protocol-Canary/blob/v0.2.0/CHANGELOG.md#upgrade-notes).
The Action's real-engine evidence and its limits are listed in
[`docs/releases.md`](releases.md); that record does not claim a passing
consumer-style run yet.

## Behavior changes

### Empty checks fail instead of passing

**Before:** Engine `0.1.1` could report success when no fixture ran, including
when the fixture directory was empty or every fixture was skipped.

**With `0.2.0`:** `check` exits with code `2` and emits no report when it runs
zero fixtures. Use the Action's `allow-empty` input only when an empty run is
intentional. Prefer correcting a missing or mismatched fixture path instead.

```yaml
- uses: StellarCanary/ProtocolCanary-Action@v2
  with:
    fixtures-dir: tests/fixtures/protocol-28
    allow-empty: "false"
```

The `allow-empty` flag is supported by `0.2.0` and newer. The Action forwards
it only to those engines; older versions already allow empty runs and reject
the flag.

### Fixture paths are validated strictly

**Before:** Fixture directories could rely on symbolic links, junctions, or
relative payload paths that escape their directory.

**With `0.2.0`:** Links and junctions anywhere below `fixtures-dir` are
rejected. `input_file` and `expected_file` paths must be relative, use `/`, and
must not contain empty, `.` or `..` path segments. An unsafe or malformed
fixture fails with exit code `4`. Keep fixture payloads as ordinary files
inside the fixture tree and use canonical relative paths.

### Configuration and fixture schemas reject unknown fields

**Before:** An unknown config key or section could be ignored, and a malformed
fixture body could run without the intended assertions.

**With `0.2.0`:** Unknown `.stellar-canary.toml` sections and keys are
configuration errors (exit code `2`). Unknown fixture keys, an RPC fixture
without assertions, or a misspelled assertion table make the fixture invalid
(exit code `4`). Correct spelling and remove fields not in the documented
schemas before migrating.

### `check` creates a local result cache

**Before:** `check` did not replay results from the cache.

**With `0.2.0`:** `check` creates `.stellar-canary-cache/` in the project root.
Offline XDR results can be replayed by default; RPC and Soroban results are
replayed only when `--live-cache-ttl` is configured. Add the cache directory
to `.gitignore`, or disable it with the engine's `--no-cache` option when
appropriate.

### JSON results may include a source field

**Before:** A result did not identify whether it was computed during this run
or replayed from cache.

**With `0.2.0`:** A result may include `source: "live"` or `source: "cache"`.
The report remains `schemaVersion: 1`; consumers should ignore optional,
unknown fields so additive report changes remain compatible.

### Network identity mismatches are enforced

**Before:** The Action's documented `network` and `rpc-url` inputs were
forwarded, but engine `0.1.1` did not enforce all endpoint identity checks.

**With `0.2.0`:** When `getNetwork` succeeds, a passphrase mismatch is a
configuration error (exit code `2`); a target/observed protocol mismatch is a
warning and the run continues. This prevents results from being attributed to
the wrong network while retaining protocol-upgrade rehearsal behavior.
Protocol `0.2.0` has no CLI option for a custom passphrase; use the v2
`network-passphrase` input only with an engine version that supports that flag
(`0.3.0` or newer).

## Workflow changes

To keep the v1 engine behavior while using the v1 Action, pin it explicitly:

```yaml
- uses: StellarCanary/ProtocolCanary-Action@v1
  with:
    version: "0.1.1"
```

To opt into the v2 engine behavior, use the v2 Action line or pin
`version: "0.2.0"` explicitly. An explicit engine pin continues to take
precedence over the Action's default. A job that intentionally checks an empty
fixture set must set `allow-empty: "true"` when using `0.2.0` or newer.

## Verification status

The tagged engine changelog documents the behavior changes above. This Action's
2026-10-20 offline real-engine suites passed with both engine versions, as
recorded in [`docs/releases.md`](releases.md). The consumer-style workflows
for both `0.1.1` and `0.2.0` failed before installation because the Action could
not load its metadata. The invalid `github.token` metadata default has been
removed here; those consumer checks must be rerun before v2 is published or
`0.2.0` is listed as end-to-end supported. No unrun compatibility result is
claimed by this guide.