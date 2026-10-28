# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- `rpc-timeout-seconds`, `max-concurrency`, `no-cache` and
  `live-cache-ttl-seconds` inputs forward the engine's check options
  (`--rpc-timeout`, `--max-concurrency`, `--no-cache`, `--live-cache-ttl`)
  to Protocol-Canary. None has a default: an omitted input keeps the
  engine's own default, and each flag is only passed when the resolved
  `version` is 0.2.0 or newer — with an older engine the flag is skipped
  and a `core.info` note names the input and the required version, the same
  way `allow-empty` already behaves (the one-off version check is now a
  table where every gated flag declares its first supporting release). The
  numeric inputs are parsed strictly (digits only, no `parseInt` leniency)
  and bounded: `rpc-timeout-seconds` 1–600, `max-concurrency` 1–64,
  `live-cache-ttl-seconds` 1–604800 (7 days); invalid values fail with an
  `InvalidInput` error naming the input. `no-cache: true` together with
  `live-cache-ttl-seconds` is rejected during validation, because the
  engine declares the two flags conflicting (`no-cache: false` with a TTL
  is accepted) ([#413]). The same table now also declares `network-passphrase`,
  `rpc-max-retries` and `rpc-retry-delay-ms` (first engine release 0.3.0) plus
  `fail-on-warning` and `offline` (main's placeholder release, 999999999.0.0),
  so main's separate `engineSupports*` helpers and the `ignoredInputs` warning
  are gone: every input skipped for an older engine is reported by a `core.info`
  note in `buildCheckArgs` naming the input and the required version.

- `coverage-state` output (`full`, `partial`, or `none`) reporting how completely the
  fixture set was exercised: `full` when every discovered fixture ran with nothing
  skipped, `partial` when some ran and others were skipped, `none` when nothing ran
  (an empty run, or an execution failure, where it is always set to `none`). It lets a
  downstream job gate a promotion on coverage rather than on `status` alone — a `pass`
  with `coverage-state: partial` means only part of the fixture set was exercised. The
  state is derived from the report's executed results and its skip signals, and a
  report missing any of those fields classifies as `none` rather than throwing
  ([#333]).
- Stamped releases for the reusable workflow (#457): for every release tag,
  `release.yml` now creates a stamped commit whose `reusable-canary-check.yml`
  refers to the Action at that release's own commit SHA (a literal 40-hex
  value marked `# release-stamp: <tag>` — a `uses:` value cannot contain
  expressions), then moves the release tag and the floating `v1` tag to that
  stamped commit. A caller who pins the workflow to an exact release tag or
  to the stamped commit therefore runs the exact Action code that release
  shipped, instead of whichever commit `v1` happens to point at; pinning to
  `@v1` or a branch still floats, as documented. Stamping is idempotent (an
  already-stamped workflow is skipped), needs no change to the reusable
  workflow's `permissions: contents: read` (only the release job holds
  `contents: write`, for the tag push), and the guarantee itself is written
  down in [docs/reusable-workflow.md](docs/reusable-workflow.md#what-your-pin-guarantees-457).
- `junit-report` input (default `false`) and `junit-report-path` output (#423).
  When enabled, the Action runs the engine's own renderer
  (`stellar-canary report <report.json> --format junit`) on the JSON report it
  just parsed and writes the XML next to it, keeping one definition of the
  format instead of maintaining an XML writer here; the file is included in
  the workflow artifact when `upload-report` is `true`. Auxiliary like the
  artifact and the receipt: an engine release without the command (it is not
  in `0.2.0`; it arrives with Protocol-Canary #434), a non-zero exit, empty
  output, or a missing report file each produce a warning only — `status` and
  the job outcome are untouched, and the output stays unset. With the input
  at its default, no second engine process is started (behaviour unchanged).
- `fixture`, `surface`, and `cache-dir` inputs (#458), each forwarded as a
  single `--flag=value` element in a stable order (a value beginning with `-`
  can never be read as another option; arguments stay an array passed to
  `spawn`). `surface` accepts only `xdr`/`rpc`/`soroban` (lower case);
  `fixture`/`cache-dir` are trimmed, treat empty as unset, and reject control
  characters (C0, DEL, C1) while otherwise leaving ids and paths untouched.
  The three require an engine release whose `check` accepts them:
  `FIXTURE_SURFACE_CACHE_DIR_MIN_VERSION` is `undefined` because no published
  Protocol-Canary release does yet (the flags exist only on the engine's
  `main`, Protocol-Canary PRs #568/#564), so setting any of the three fails
  the run **before** any install or engine process, naming the input, the
  resolved version, and the missing support. This deliberately differs from
  `allow-empty` and the 0.3.0 network inputs, which are ignored with a note:
  a dropped filter would run a different scope than requested. With all three
  unset, arguments and behaviour are unchanged for every engine version.
- Comprehensive regression tests for prebuilt release download, extraction, and discovery failure paths covering redirect limits, stream errors, timeouts, extraction failures, and manifest mismatches in `tests/unit/prebuilt-install-failures.test.ts` (#495).
- Enforce coverage thresholds in CI on Ubuntu runs and report the text coverage
  summary to the workflow job summary (`$GITHUB_STEP_SUMMARY`) inside a fenced
  code block (#410).
- `fixtures-pack-version` and `fixtures-pack-protocol` inputs, validated when
  set: the version must be a published pack release tag (`v1.2.0` or
  `1.2.0`, with an unpinned value such as `latest`/`main` rejected) and the
  protocol a positive integer, so `0` — which the `protocol` input accepts —
  is refused here. Both are currently **not forwarded** to Canary: its
  fixture-loading contract accepts a local path via `--fixtures-dir` and
  defines no other loading mechanism, with remote bundles fetched by version
  explicitly out of scope upstream for now. The Action logs a note naming the
  fixtures directory it actually used, so a set-but-unused input cannot be
  mistaken for a pinned pack ([#337]).
- `allow-empty` input (default `false`). It forwards `--allow-empty` to Protocol-Canary
  `0.2.0` and newer, which fail a run that executes no checks. With an older `version`
  the flag is not forwarded, because those versions already pass an empty run and would
  reject the argument; a note is logged. The default `version` is unchanged (`0.1.1`),
  so existing workflows behave exactly as before.
- `tests/integration/real-engine.test.ts` and the manual workflow `engine-compat.yml`
  run the Action against real Protocol-Canary builds instead of the mock engine.
- `replayed-count` output (#350): how many of the run's results were replayed
  from Protocol Canary's result cache (`source: "cache"`, or an equivalent
  `replayed`/`cached` flag) instead of executed in this run. The job summary
  shows a "Replayed from cache" footnote with the count and percentage when
  any result was replayed; reports from engines without the cache always
  report `0`. Like the other counts, it is explicitly set to `0` on an
  execution failure.

### Fixed

- Each invocation writes its Execution Receipt to its own file under `RUNNER_TEMP`
  (#493). The path was always `stellar-canary-receipt.json`, so a second Action step in the
  same job overwrote the first step's receipt and its `receipt-path` output then pointed at
  the second run's data. The file name now carries a random suffix
  (`stellar-canary-receipt-<32 hex>.json`); `receipt-path` stays absolute, and nothing changes
  with `generate-receipt: false`.
- A rejected `rpc-url` no longer echoes the value it rejected. The error for a
  URL with the wrong scheme now shows the scheme, host, port and path with
  userinfo replaced by `[REDACTED]` and any query string or fragment dropped
  (a recognised token in the path is masked too), and the error for a value
  that cannot be parsed as a URL reports only its length and whether it
  contains whitespace. Previously both messages printed the whole value, so a
  credential in a mistyped endpoint reached the run log and the failure
  annotation (#510).
- Redact recognized secrets, strip control characters, and bound engine diagnostics
  in failure annotations and execution-failure summaries. Sanitize failure reasons
  as well, and redact before selecting or truncating diagnostic text (#499).
- Bound HTTP response bodies to 4 MiB for GitHub API JSON, 1 MiB for checksum
  manifests, and 64 MiB for prebuilt release assets. Reject oversized or incomplete
  bodies and remove failed downloads before using the existing fallback paths (#500).
- Describe engine exit codes according to the engine contract: exit code 2 as configuration error (invocation unusable or no check applied, so no checks ran) and exit code 3 as execution error (a check could not complete: XDR, RPC, or Soroban problem), removing inaccurate regression-gate and crash wording (#502).
- Retain all report artifacts when multiple invocations share an artifact-name differentiator by bounding collisions and retrying with unique suffixes (#494).
- Clean up all temporary directories left behind by the fork-boundary and reusable-workflow conformance tests with cross-platform retry options, ensuring no leftover temporary files in `os.tmpdir()` (#501).
- Execution-failure job summaries no longer break when the raw diagnostic
  (Canary's stderr, a timeout notice) itself contains a ``` sequence, e.g.
  a compiler or panic message quoting a code block: the diagnostic fence is
  now made longer than the longest backtick run the diagnostic contains, so
  the diagnostic still renders as a single well-formed code block instead of
  closing the fence early and spilling broken markdown into the summary
  ([#269]).
- Reports containing duplicate result identities — the same
  `(surface, fixtureId)` pair (`testId` when `fixtureId` is null) appearing
  twice — are now rejected at parse time with `InvalidReportError`, naming
  the exact duplicate identity and surface, per CF-01 section 4; such a
  report can no longer skew derived counts or mask a failure behind a copy
  of a passing result (#349).
- Failure annotations now show the engine's root diagnostic (taken from
  stderr, falling back to the failing result in the report) and classify the
  exit code accurately: exit code 1 as test failures detected, exit code 2
  as the regression gate / invalid configuration, exit code 3 as an
  unexpected runtime crash — never as a regression. The matching
  `describeExitCode` descriptions were corrected the same way (#351).
- The weekly live integration workflow was repaired for Protocol 29 and
  renamed `integration.yml` → `weekly-live.yml`: same weekly cron plus
  manual dispatch, Testnet/Futurenet RPC endpoints with their documented
  network passphrases, and a failure notification that fails safely with a
  clear summary when a remote endpoint is unreachable (#352).
- The weekly live workflow's `ProtocolCanary-Fixtures` checkout is pinned to
  the immutable `protocol-28` pack (the full commit SHA behind the tag) and
  the run summary now records the resolved commit, so a scheduled canary
  changes only when the network or the pinned inputs change — a fixture
  merged into the fixtures repository on Sunday can no longer move Monday's
  result. A new optional `fixtures_ref` `workflow_dispatch` input overrides
  the pin for manual runs; scheduled runs always use it. Both checkouts now
  also set `persist-credentials: false` (#419).

### Documentation

- README's tables now document the `generate-receipt` input and the
  `receipt-path` output — both were declared in `action.yml` and wired
  through the Action but missing from the Inputs/Outputs tables, so the
  documented contract lagged the declared one ([#412]).
- README gains a "Troubleshooting" section mapping the most common
  execution-failure messages (`cargo` not found, `cargo install` exit
  101, timeouts, unparsable reports, unsupported `schemaVersion`, missing
  config file) to concrete next steps, cross-referenced with the bug
  report template's "Which kind of failure?" checklist; the Outputs table
  now shows an example value for every output.
- Quick start now says that `fixtures-dir` defaults to `fixtures` and that
  a fresh checkout has no such directory, pointing at
  `examples/protocol-28.yml` for a complete workflow; CONTRIBUTING.md
  notes that Dependabot opens its own dependency PRs under the same
  review expectations; the pull request template now prompts for an
  `[Unreleased]` entry on user-facing changes.
- README.md gained a Table of Contents linking every top-level section, and
  "How failures appear" now shows the actual rendered job summary for a
  passing run, a run with failures/warnings, and an execution failure,
  instead of describing the format only in prose.
- `action.yml`'s `upload-report` description now states its default value
  (`true`, matching the input's `default` key) and that setting it to
  `false` skips the artifact upload, so the documented contract spells out
  the default instead of leaving it to the `default` key alone.
- CONTRIBUTING.md documents the weekly live workflow's fixtures pin: when it
  moves (only on a new `ProtocolCanary-Fixtures` pack release), who approves
  the move (the CODEOWNERS maintainer), and how to resolve and update the
  SHA (#419).
- README documents the early `fixtures-dir` validation (#400): the input
  must point at an existing directory, relative paths are resolved against
  the job's working directory, invalid directories are detected before
  engine installation, a missing directory fails with a clear error by
  default, `allow-empty: true` allows a missing directory with a warning,
  and a regular file is never a valid fixtures directory. The Quick Start
  note and the Troubleshooting table now point at the new
  `Invalid "fixtures-dir" input` message.

### Added

- Checksum verification: when `StellarCanary/Protocol-Canary` publishes a
  checksum manifest alongside a release, the installed or cached binary is
  verified against it before use, and a mismatch fails the run with an
  `InstallationFailed` error. Until such a manifest exists the check is a
  no-op debug log, so commit/tag pinning is unchanged — see `SECURITY.md`.
- `npm run test:coverage` produces v8 line/branch coverage for `src/`
  (terminal, HTML, and lcov reports; contributor-facing only — no effect
  on the Action's behavior).

### Changed

- The tag lookup that pins installs to an immutable commit now sends a
  `GITHUB_TOKEN` bearer credential when one is available and follows
  pagination across every page of the tags endpoint. A shared runner IP
  hitting the 60/hour unauthenticated limit, or a repository growing past
  100 tags, can no longer silently degrade installation to tag-based
  pinning.
- Third-party actions in `.github/workflows/*.yml` are pinned to full
  commit SHAs (with the human-readable version kept as a trailing comment)
  instead of mutable version tags, closing a supply-chain hole — most
  importantly in `release.yml`, which runs with `contents: write`.
- A `config` input that names a directory is now rejected during input
  validation with an `InvalidInput` error instead of being accepted and
  forwarded to the `stellar-canary` CLI, which failed later with a generic,
  less actionable error. `parseConfig` now requires the resolved path to be
  a regular file (`fs.statSync(...).isFile()`) rather than merely existing.
- Numeric inputs are strictly validated before any process is started:
  `protocol` accepts 1 to 4294967295 inclusive (0 is rejected; the engine
  rejects `--protocol 0` too, so no working configuration changes) and
  `timeout-minutes` accepts 1 to 35791 minutes — 35,791 * 60,000 ms is the
  largest delay below Node's 2,147,483,647 ms `setTimeout` limit, above
  which Node clamps the timer to fire after 1 ms and end the run almost
  immediately. Loosely formatted values such as "1e3", "5 minutes", "1.9",
  or "+5" are now rejected with a message that names the input, quotes the
  value, and states the accepted range, instead of silently becoming a
  different timeout or an invalid engine argument. The superseded behaviors
  (fractional `timeout-minutes` truncation, `protocol` "0") are rejected
  outright; see #456.
- `fixtures-dir` is now validated against the filesystem **before** version
  resolution and engine installation (#400): the path is resolved against
  the working directory and must name an existing directory. A missing
  directory fails the run immediately with an `InvalidInput` error naming
  `fixtures-dir` and the resolved absolute path — previously the Action
  installed the engine first and only then failed with a less actionable
  error — while `allow-empty: true` downgrades the missing-directory case
  to a `core.warning` (naming the input and path) and the run continues.
  A resolved path that exists but is not a directory (e.g. a regular file)
  is always rejected with a distinct "is not a directory" message, even
  with `allow-empty: true`, and a dangling symlink follows the
  missing-path behavior (`statSync` follows links). Invalid paths no longer
  trigger unnecessary version resolution, engine installation, or engine
  execution; the error flows through the existing execution-failure
  annotation, summary, and outputs like any other reason Canary could not
  run. The directory is never created behind the user's back.

### Fixed

- `examples/protocol-28.yml`'s fixtures checkout no longer pins
  `ref: v0.1.0`, a tag that does not exist in
  `StellarCanary/ProtocolCanary-Fixtures` (whose only tag is
  `protocol-28`); copying the documented example verbatim no longer fails
  at the checkout step ([#267]).

### Testing

- Added `tests/unit/contract-sync.test.ts` (#412): a contract test that
  keeps `action.yml`, the `getInputs()` parser, the `setOutput` calls in
  `run()` (success and execution-failure paths), the README Inputs/Outputs
  tables, every `examples/*.yml`, and the reusable workflow in sync —
  asserting the declared inputs are exactly the read inputs, the declared
  outputs exactly the set outputs, README defaults match `action.yml`, and
  no example step passes an undeclared `with:` key. Every failure message
  names the offending input/output/file. Adds `yaml` (pinned dev
  dependency) for parsing the YAML files; the README tables are parsed with
  plain line logic, no Markdown dependency.
- Added a `resolveVersion` test pinning that an explicit whitespace-only
  `token` is treated as "no token" — the tag-lookup request carries no
  `Authorization` header at all, matching the documented empty-secret
  handling ([#262]).
- Added a `resolveVersion` test simulating a timed-out tags-page request
  (a `"timeout"` event from the underlying `https.get` request), pinning
  that the documented "never throws" contract holds for `fetchTagsPage`'s
  timeout handler too: the run resolves with `commitSha: undefined` and
  falls back to tag pinning ([#263]).
- Added a `renderSummaryMarkdown` test pinning that a report whose
  `skipped` field is present but empty (`skipped: []`) renders no
  skipped-fixtures section, closing out the three-way
  undefined/empty/non-empty condition ([#264]).
- Added unit coverage for `parseChecksumManifest`'s documented tolerance
  of the standard `sha256sum` format: `#` comment lines and `*`-prefixed
  binary-mode entries are parsed and enforced during checksum
  verification ([#275]).
- Added unit coverage for the checksum-verification fallback when a published
  checksum manifest exists but names no file matching the runner's platform:
  `ensureCanaryInstalled` still succeeds with a debug log (commit/tag pinning
  stands) and never throws `InstallationFailed` for a manifest that simply
  does not cover this platform ([#259]).
- Added unit coverage for `runCheck`'s `SIGINT`/`SIGTERM` forwarding to the
  child process, for cleanup of those listeners after settling, and for the
  cancellation branch where the child exits with a null code and a signal.
- Added unit coverage for the private install-path helpers in `canary.ts`:
  `cargoBinDir` now has tests pinning both the `CARGO_HOME`-anchored path and
  the `~/.cargo/bin` fallback (observed through the Actions cache paths), and
  `binaryName` has tests pinning `stellar-canary.exe` on `win32` and
  `stellar-canary` elsewhere, with `process.platform` overridden so both
  branches run on any runner OS ([#220], [#224]).
- Added unit coverage that `renderSummaryMarkdown`'s Failures/Warnings
  sections (driven by `notablyList`'s status filter) list only results with
  a requested status: fail and error under Failures, warning under Warnings,
  and no section rendered when no result matches ([#188]).
- Added a `resolveVersion` test pinning the successful parse of a full
  40-character commit SHA for the matching tag from the GitHub tags API,
  including that the SHA comes from the matching entry rather than the first
  one ([#192]).
- Added unit coverage for `canary.ts`'s `cacheKeyFor`: one test pinning that
  the Actions cache key uses `commitSha` even when a `tag` is also present
  (so two commits under a moving tag can never share a cache entry), and one
  pinning the `tag` fallback when no `commitSha` was resolved, observed
  through the keys handed to the cache restore/save calls ([#228]).
- Added unit coverage for `main.ts`'s `run()`: a run whose process is killed
  by a signal (null exit code) is reported as an execution failure naming the
  signal, and a `writeSummary` rejection on the otherwise-successful path
  fails the run without overwriting the already-set pass/fail outputs
  ([#271]).
- Added end-to-end coverage for the `annotations` input's "off" state: a
  fail run and a config-error (execution-failure) run with
  `annotations: false` still fail the job and still write the job summary,
  but emit no error/warning annotations ([#277]).
- Added an end-to-end test that `upload-report: true` actually invokes the
  artifact upload path: the artifact client's upload method is called once
  with the stable name and the exact report file the run produced ([#278]).
- Added an `inputs` test pinning that plain `http://` is rejected for the
  IPv6 loopback `http://[::1]`, documenting the current
  `localhost`/`127.0.0.1`-only exemption as a known contract ([#276]).
- Unit and end-to-end coverage for the early `fixtures-dir` validation
  (#400): an existing directory is accepted and resolves to an absolute
  path; a missing directory is rejected with an error naming `fixtures-dir`
  and the resolved path; a regular file gets the distinct not-a-directory
  rejection (even with `allow-empty: true`); a dangling symlink follows the
  missing-path behavior; relative paths and `..` segments are normalized
  before validation; and `allow-empty: true` warns and continues. The
  essential regression test spies on `resolveVersion`,
  `ensureCanaryInstalled`, and `runCheck` and pins that a missing
  directory (with `allow-empty: false`) fails before any of them run, with
  the error reaching the existing execution-failure summary and annotation
  path, while `allow-empty: true` proceeds to normal resolution and
  installation.

## [0.1.1]

### Changed

- Default `version` input bumped from `0.1.0` to `0.1.1`
  ([0de71ec](https://github.com/StellarCanary/ProtocolCanary-Action/commit/0de71ec578c7520163ab41ef0b32ea25f5dac53b)).
  Protocol-Canary `v0.1.1` adds `ContractExecutable` XDR type support,
  which 2 of the 5 current `ProtocolCanary-Fixtures` Protocol 28 fixtures
  require and `v0.1.0` cannot parse at all. Found and closed during
  three-repository E2E validation.

### Fixed

- `parseReport` no longer rejects a schemaVersion-1 report that omits the
  `counts` field
  ([810a029](https://github.com/StellarCanary/ProtocolCanary-Action/commit/810a029f6a380eee5987a936045d3a51e890de7a)).
  Protocol-Canary's actual tagged `v0.1.0` release (this Action's pinned
  default) predates `counts`, so every check against it — even a fully
  passing one — was previously misreported as an execution failure. Found
  during three-repository E2E validation; `counts` is now derived from
  `results`/`skipped` when absent.

## [0.1.0]

- `stellar-canary check --format json` integration: typed input handling
  ([e71472a](https://github.com/StellarCanary/ProtocolCanary-Action/commit/e71472acd308a236036ddc68ff2166ced795bc0e)),
  pinned-commit installation via `cargo install --git`
  ([90d6ff4](https://github.com/StellarCanary/ProtocolCanary-Action/commit/90d6ff45f918a4d40ed571b9b4d2cbc27fadef3f))
  (no prebuilt release binaries exist upstream yet), safe subprocess
  execution with a configurable timeout and signal forwarding
  ([e3ecd2e](https://github.com/StellarCanary/ProtocolCanary-Action/commit/e3ecd2e791e525dc98edbfab49ef8e3a11b4e27e)).
- GitHub job summary
  ([ac55978](https://github.com/StellarCanary/ProtocolCanary-Action/commit/ac5597810244c97c32498636a62d2bd25ceec0c2))
  and annotations
  ([3c86513](https://github.com/StellarCanary/ProtocolCanary-Action/commit/3c86513e95ef088ced42cbaf17ddceac754c0a77))
  rendered from the CLI's own JSON report — never a second invocation,
  never a reinterpreted result.
- Optional upload of the JSON report as a `stellar-protocol-canary-report`
  workflow artifact
  ([223c108](https://github.com/StellarCanary/ProtocolCanary-Action/commit/223c108a4f86d61691f8dd84fcfd7c961979249f));
  upload failure never changes the underlying compatibility result.
- Full exit-code contract support (0 pass, 1 compatibility failure, 2
  configuration error, 3 execution/RPC error, 4 invalid fixture, 5
  internal error)
  ([4bd2f83](https://github.com/StellarCanary/ProtocolCanary-Action/commit/4bd2f839974e127c25bc04585254e0ddfc499fef)),
  with a clear distinction between an execution failure (Canary could not
  run) and a compatibility failure (it ran and found a real problem).
- Unit and integration test suite against a mock Canary binary covering
  every documented result state
  ([e3ecd2e](https://github.com/StellarCanary/ProtocolCanary-Action/commit/e3ecd2e791e525dc98edbfab49ef8e3a11b4e27e));
  a separate, non-gating live workflow against a real build and Stellar
  Testnet
  ([0fce241](https://github.com/StellarCanary/ProtocolCanary-Action/commit/0fce2411d4bb2d2fc4c4d24ed8d8b454434763c2)).

### Known gaps

- `Protocol-Canary` does not yet publish signed/checksummed release
  binaries, so this Action builds it from a pinned source commit instead
  of downloading a verified artifact — see `SECURITY.md`
  ([87c5270](https://github.com/StellarCanary/ProtocolCanary-Action/commit/87c5270e242a6ddabee7a18ad4dced2becb69975)).
- Only Protocol 28 has fixtures published upstream at this time
  ([87c5270](https://github.com/StellarCanary/ProtocolCanary-Action/commit/87c5270e242a6ddabee7a18ad4dced2becb69975)).
