# Contributing

## Development setup

Node 24. The root [`.nvmrc`](.nvmrc) pins it (`nvm use`), matching the
`node24` Actions runtime the Action declares in `action.yml` and the
`node-version: 24` CI uses. `package.json` keeps a looser floor
(`engines.node >= 20`); any supported Node 20+ can run the tests, but new
code and local setup should target 24. npm is the package manager; the
lockfile (`package-lock.json`) is committed and authoritative.

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

All four must pass before a change is considered done — this is exactly
what `.github/workflows/ci.yml` runs, plus a check that the committed
`dist/` matches a fresh build (see [Build](#build) below).

## Repository structure

| Path | Responsibility |
|---|---|
| `.nvmrc` | Pins the local Node version to the `node24` runtime CI and `action.yml` use. |
| `src/main.ts` | Orchestrates a run; the only file with `if (require.main === module)`. |
| `src/inputs.ts` | Reads and validates every Action input. |
| `src/canary.ts` | Resolves/installs the `stellar-canary` binary. |
| `src/runner.ts` | Builds CLI args; spawns and supervises the Canary process. |
| `src/output.ts` | The JSON report type and exit-code table (the CLI's documented contract). |
| `src/summary.ts` | Renders the GitHub job summary. |
| `src/annotations.ts` | Converts results into GitHub annotations. |
| `src/artifact.ts` | Uploads the JSON report as a workflow artifact. |
| `src/errors.ts` | Typed internal error classes. |
| `src/version.ts` | Resolves a requested version to a pinned commit. |
| `tests/unit/` | Vitest unit tests, generally one `*.test.ts` per `src/` module (matched by name), exercising it in isolation with `child_process`, `@actions/*`, and network calls stubbed. |
| `tests/integration/` | End-to-end tests that run the whole Action (`src/main.ts`) against the mock CLI and assert the outputs, summary, annotations, and pass/fail behavior. |
| `tests/fixtures/mock-canary.cjs` | The fake `stellar-canary` CLI every test runs in place of the real binary; it selects a result state via `MOCK_CANARY_SCENARIO` (see [Test commands](#test-commands)). |

Each file has one responsibility; `main.ts` is the only place that wires
them together and decides pass/fail. `vitest.config.ts` collects both
`tests/unit/**/*.test.ts` and `tests/integration/**/*.test.ts`, so new tests
belong in one of those two directories. See [`docs/` in
`Protocol-Canary`](https://github.com/StellarCanary/Protocol-Canary/tree/main/docs)
for the CLI/JSON contract this Action consumes — that document, not this
repository, is the source of truth for the CLI's behavior.

## Test commands

```bash
npm run typecheck    # tsc --noEmit, strict mode
npm run lint         # eslint
npm test             # vitest run (unit + integration, includes workflow-policy.test.ts)
npm run test:coverage  # vitest run with v8 coverage over src/ (text, HTML, and lcov reports in coverage/)
npm run build         # esbuild bundle to dist/index.js
actionlint           # static analysis of .github/workflows/
zizmor .github/workflows # security audit of .github/workflows/
```

### Trying the Action locally without GitHub

To see what a change does end to end without pushing a branch, run the
committed bundle the way a workflow run would:

```bash
npm run build
node scripts/run-local.mjs \
  --engine "$HOME/.cargo/bin/stellar-canary" \
  --fixtures-dir ./my-fixtures \
  --protocol 28 \
  --input version=0.1.1 \
  --input allow-empty=true
```

`scripts/run-local.mjs` builds the runner environment the Action reads
(`INPUT_*` from `--input name=value`, plus `GITHUB_OUTPUT`,
`GITHUB_STEP_SUMMARY`, `GITHUB_ENV`, `RUNNER_TEMP` and a temporary
`CARGO_HOME` holding the engine given by `--engine`) in a temporary
directory, runs `dist/index.js`, and prints the outputs the Action wrote,
the rendered job summary, the `::`-annotation lines it emitted, and the exit
code — then exits with that code and removes the temporary directory. It
never installs an engine (`--engine` is required) and never talks to the
network. `--help` documents every option; see `tests/unit/run-local.test.ts`
for the exact contract.

`npm run test:coverage` runs the same suite as `npm test` with coverage
measurement enabled (via `@vitest/coverage-v8`; configured in
`vitest.config.ts` to measure `src/` only). It reports line/branch coverage
per source file in the terminal, and writes HTML and lcov reports to
`coverage/` (gitignored).

CI enforces coverage thresholds on Ubuntu pull requests and main pushes. New
code must not lower test coverage below these minimums:

- Statements: 91%
- Branches: 84%
- Functions: 95%
- Lines: 91%

These thresholds live in `vitest.config.ts` under `test.coverage.thresholds`
and are set slightly below current baseline measurements to accommodate
refactoring while preventing regressions. As test coverage increases across
the codebase, these thresholds are ratcheted upward. Run `npm run test:coverage`
locally to verify your changes satisfy the coverage gate.

Unit and integration tests must never require network access or a real
`stellar-canary` binary: they run against
[`tests/fixtures/mock-canary.cjs`](tests/fixtures/mock-canary.cjs), a fake
CLI that simulates every documented result state (`pass`, `warning`,
`fail`, `config-error`, `rpc-error`, `fixture-error`, `internal-error`,
`malformed-json`, `timeout`) via the `MOCK_CANARY_SCENARIO` environment
variable. `.github/workflows/integration.yml` is the only place this
repository talks to a real Canary build and a real Testnet endpoint, and it
never gates a pull request.

For tests that need to observe what the Action reports through
`@actions/core`, use the partial-mock convention described in [Mocking
`@actions/core`](#mocking-actionscore) below rather than mocking the module
your own way.

### Mocking `@actions/core`

When a test needs to assert on `core.error`, `core.warning`, or
`core.setFailed`, spread the real module and override only the exports that
test observes. Never replace `@actions/core` wholesale with a hand-written
object: unrelated exports such as `core.summary`, `core.getInput`, and
`core.setOutput` must keep working through the real implementation, and the
suite relies on that (for example, `core.summary` writes
`GITHUB_STEP_SUMMARY`). This is the pattern used by
`tests/unit/annotations.test.ts` and `tests/integration/end-to-end.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above the imports, so the mock functions must be too.
const { errorMock } = vi.hoisted(() => ({ errorMock: vi.fn() }));

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actions/core")>();
  return { ...actual, error: errorMock };
});

import { emitAnnotations } from "../../src/annotations";

afterEach(() => {
  errorMock.mockReset();
});
```

Key points:

- declare the spies with `vi.hoisted` so the hoisted `vi.mock` factory can
  reference them;
- take `importOriginal<typeof import("@actions/core")>()` and spread
  `...actual`, overriding only the functions under test;
- reset the mocks in `afterEach` (`mockReset()`) so assertions in one test
  do not see calls from another.

Only add a mock for an export the test actually asserts on; leaving the
rest real is what keeps these tests interoperable with the rest of the
suite.

## Build

`dist/index.js` is a committed, bundled artifact — consumers of this
Action never run `npm install`/`npm run build` themselves. Never hand-edit
it; always regenerate it with `npm run build` and commit the result. CI
fails if `dist/` doesn't match a fresh build from the current source.

This project bundles with **esbuild**, not `@vercel/ncc`: the pinned
`@actions/*` packages (`core` 3.x, `artifact` 6.x) ship as ESM-only, which
`ncc`'s webpack-based bundler cannot resolve into a CommonJS
`runs.using: node24` action. See `scripts/build.mjs` for the exact
settings.

## Mutation testing (StrykerJS)

Line coverage says little about whether the tests would notice a behavioural
change, so this repository has an on-demand mutation testing workflow:

- `.github/workflows/mutation.yml` — runs only on `workflow_dispatch`, so it
  never gates a pull request. It uses `npx` with pinned (but not saved)
  `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` versions,
  mutates `src/`, runs the unit suite against each mutant, and publishes the
  per-file mutation score and the top surviving mutants to the job summary
  and as a `mutation-report` artifact.
- `stryker.config.json` — the StrykerJS configuration: mutates `src/**/*.ts`,
  uses the Vitest runner against `tests/unit`, and emits JSON, Markdown, and
  HTML reports.

To run it locally:

```bash
# Install the Vitest runner once, without saving it to package.json or
# package-lock.json.
npm install --no-save @stryker-mutator/vitest-runner@7.7.4
npx --yes @stryker-mutator/core@7.7.4 stryker run
```

Reports are written to `reports/mutation/` (gitignored). Mutation survivors
point at assertions that are too weak to catch a real change: treat a
surviving mutant as a signal to strengthen the test, not as a reason to
lower the threshold. A deliberately weakened assertion in a scratch copy
shows up as a surviving mutant.

## Coding standards

- Strict TypeScript (`strict: true`); avoid `any`.
- Command execution: always an argument array to `child_process.spawn`
  (via `@actions/exec` or directly) — never a shell string built from an
  input. This is the one rule with no exceptions in this repository; see
  `SECURITY.md`.
- No duplicated compatibility logic. If you find yourself writing
  `if (protocol === 28) { ... }` or anything that encodes what a CAP
  means, that belongs in `Protocol-Canary` or `ProtocolCanary-Fixtures`,
  not here.
- Prefer the typed `CanaryActionError` subclasses in `src/errors.ts` over
  throwing a plain `Error`, so a caller can distinguish, for example, an
  installation failure from an invalid report.
- Workflow files in `.github/workflows/` must follow repository security policy:
  every workflow must explicitly declare a top-level `permissions:` block
  (least privilege), and every external `uses:` action reference must be pinned
  to a full 40-character commit SHA (with the single documented exception of the
  reusable workflow calling the action's own `@v1` release tag).

## Workflow linting and security checks

Workflow files are analyzed in CI using `actionlint` and `zizmor`, as well as
the vitest suite `tests/unit/workflow-policy.test.ts`.

To run these checks locally:

1. **Policy unit tests**:
   ```bash
   npm test
   # or run the policy test specifically:
   npx vitest run tests/unit/workflow-policy.test.ts
   ```
2. **actionlint** (checks syntax, expression schemas, and runner compatibility):
   ```bash
   actionlint .github/workflows/*.yml
   ```
   (Install via `go install github.com/rhysd/actionlint/cmd/actionlint@latest` or package manager).
3. **zizmor** (checks for credential persistence, injection risks, and unpinned actions):
   ```bash
   zizmor .github/workflows
   ```
   (Install via `pip install zizmor` or `cargo install zizmor`).

Prefer fixing findings directly over suppressing them. Any necessary suppression
must include an explicit `# zizmor: ignore[rule-name]` comment with a clear,
justified explanation on the affected line.

## Commit style

Use Conventional Commits, one logical change per commit:

```text
feat(action): add canary installation
fix(runner): forward SIGTERM to the child process
test(annotations): cover the warning-only case
docs: document the fixtures-dir input
```

## Updating dependencies

Update explicitly (`chore(deps): update @actions/core`), never silently as
a side effect of another change. Re-run the full test/lint/build sequence
after any dependency bump, and run `npm audit` — fix or explicitly justify
any new advisory before merging.

Dependabot also opens automated update PRs for the npm and
`github-actions` ecosystems on a weekly schedule (see
`.github/dependabot.yml`), so some dependency updates arrive without
anyone hand-writing a `chore(deps):` commit. Those PRs are held to the
same review expectations as any other change: re-run the full
test/lint/build sequence and `npm audit` before merging one, and either
fix or explicitly justify any new advisory in the PR.

## Updating Canary compatibility

If `Protocol-Canary` changes its CLI interface, JSON report schema, or
exit-code contract:

1. re-read its current `docs/json-report-contract.md`,
   `docs/fixture-contract.md`, and `crates/canary-cli/src/cli.rs` —
   never assume the previous contract still holds;
2. update `src/output.ts`'s `CanaryReport` type and
   `SUPPORTED_SCHEMA_VERSION` (a `schemaVersion` bump is a breaking
   change: this Action should reject an unrecognized version clearly
   rather than silently misparse it — see `parseReport`);
3. update the supported-version table in `README.md`;
4. add a `MOCK_CANARY_SCENARIO` case exercising the new behavior in
   `tests/fixtures/mock-canary.cjs` before wiring the Action to it.

## Running real-engine compatibility tests

The compatibility workflow (`.github/workflows/engine-compat.yml`) tests the
Action against real builds of `Protocol-Canary` across all supported
operating systems (`ubuntu-latest`, `windows-latest`, and `macos-latest`).
Unlike the mock-based integration suite used during standard CI, this workflow
exercises the actual engine binary, verifying platform-specific behavior such
as binary naming (`stellar-canary.exe`), path handling, process spawning, and
timeouts in `src/runner.ts`.

### Running the workflow manually

The workflow runs on `workflow_dispatch` (manual trigger) and is not part of
required pull request checks because compiling the engine from source across
all platforms is resource-intensive.

To trigger the workflow manually:

1. **Via the GitHub web interface:** navigate to **Actions** &rarr;
   **Engine compatibility**, click **Run workflow**, choose the branch, and
   provide:
   - `engine_ref`: the Protocol-Canary tag, branch, or commit to test
     (for example `v0.2.0` or `main`).
   - `legacy_ref`: an older Protocol-Canary release (e.g. `v0.1.1`) to ensure
     backward compatibility.
2. **Via the GitHub CLI:**
   ```bash
   gh workflow run engine-compat.yml -f engine_ref=v0.2.0 -f legacy_ref=v0.1.1
   ```

To run `tests/integration/real-engine.test.ts` locally, point
`STELLAR_CANARY_BIN` (and optionally `STELLAR_CANARY_LEGACY_BIN`) to compiled
engine binaries. When these environment variables are absent, the test suite
skips cleanly with an informative message rather than failing, keeping
`npm test` fast for routine local development.

### Understanding platform-specific failures

The matrix is configured with `fail-fast: false`, ensuring a failure on one
operating system does not cancel execution on the others.

When a compatibility test fails on a specific platform (e.g., Windows or
macOS) while passing on Linux, it points to platform-specific code in the
Action rather than an engine logic defect:

- **Executable name and resolution:** Windows binaries require the `.exe`
  extension (`stellar-canary.exe`). If the binary lookup fails on Windows,
  verify `binaryName()` in `src/canary.ts` and path resolution logic.
- **Path separators and argument escaping:** Windows uses backslashes (`\`)
  and drive letters (`C:\...`), while POSIX platforms use forward slashes (`/`).
  Arguments passed to `child_process.spawn` must never assume POSIX path
  conventions or shell expansion.
- **Line endings:** Outputs and summaries generated on Windows runners can use
  CRLF (`\r\n`) line endings. Any parsing logic must handle both CRLF and LF.
- **Process spawning and signal forwarding:** Windows does not support POSIX
  process signals like `SIGTERM` or `SIGINT` in the same manner as Unix.
  Timeout handling and process termination in `src/runner.ts` must account for
  these differences.

## Pinning the fixtures pack (weekly live workflow)

`.github/workflows/weekly-live.yml` checks out
`StellarCanary/ProtocolCanary-Fixtures` at a recorded immutable commit —
the full commit SHA behind the `protocol-28` tag, written on the
"Checkout ProtocolCanary-Fixtures" step — so a scheduled canary changes
only when the network or the pinned inputs change. A fixture merged into
the fixtures repository's default branch between runs has no effect on
Monday's result, and every run prints the commit it actually tested in the
step summary ("Fixtures pack under test"). This is the same reason the
repository publishes immutable pack tags in the first place.

**When the pin moves:** only when `ProtocolCanary-Fixtures` publishes a new
pack release (a new immutable tag — a future `protocol-29`, for example)
*and* this repository decides to start testing that pack. It never moves
because something landed on the fixtures default branch, because a network
changed, or as a side effect of an unrelated pull request here. Each pin
move is its own pull request.

**Who approves it:** the repository maintainer
([@Hollujay](https://github.com/Hollujay), the [CODEOWNERS](.github/CODEOWNERS)
owner), recorded as the approving reviewer on that pull request.

**How to move it:**

1. resolve the new tag to its full (dereferenced) commit SHA:

   ```bash
   git ls-remote https://github.com/StellarCanary/ProtocolCanary-Fixtures.git refs/tags/<tag>
   ```

   For an annotated tag take the SHA of the `^{}` (peeled) line — that is
   the commit, not the tag object.
2. in `.github/workflows/weekly-live.yml`, replace the SHA in `ref:` on the
   "Checkout ProtocolCanary-Fixtures" step and update that step's comment
   (tag name and both SHAs) in the same commit, so the pin stays recorded
   in exactly one place.
3. if the new pack lives in a different directory, update `fixtures-dir:`
   (and the workflow name/header comment) in the same commit.
4. link the fixtures pack release (and its tracking issue, if any) in the
   pull request description.
5. run `actionlint .github/workflows/weekly-live.yml` before requesting
   review.

Manual dispatch runs may override the pin temporarily with the
`fixtures_ref` input — any tag, branch, or commit, for example to
candidate-test a pack before moving the pin. Scheduled runs ignore the
input and always use the recorded SHA. A `fixtures_ref` that does not
exist fails the job at checkout with the checkout step's own error; that
is expected and leaves the pin untouched.

## Tracking weekly live failures

A repeated scheduled failure should not open a new issue every Monday. The
`track-failure` job in `.github/workflows/weekly-live.yml` keeps exactly one
tracking issue per failure episode, labelled **`weekly-live`**:

- on the **first failing run** it opens a new issue titled
  "Weekly live canary is failing (Protocol 29)";
- while the canary stays red it **comments** on that same issue (it never
  opens a second one, even if several runs fail in a row);
- once a run goes **fully green** it comments on the open issue and closes
  it with `--reason completed`; a later failure reopens the cycle by
  creating a fresh issue.

The label `weekly-live` must exist in the repository. The job checks for it
with `gh label list` and fails loudly (`::error::`) if it is missing, rather
than silently skipping the notification. Create the label once when setting
up the repository:

```bash
gh label create weekly-live --description "Single open tracking issue for scheduled weekly live failures"
```

The `track-failure` job is the only job in the workflow granted
`issues: write`, and it is scoped to that job; every other job stays at the
workflow default of `contents: read`.

## Release process

Before creating a release, ensure all metadata values agree. `.github/workflows/release.yml`
runs `node scripts/verify-release-tag.mjs "$RELEASE_TAG"` before any installation or build
steps to enforce that the pushed tag matches `package.json` and `CHANGELOG.md`.

Release checklist:

1. **Update `package.json`**: Bump `"version": "X.Y.Z"` to match the intended release.
2. **Update `CHANGELOG.md`**:
   - Ensure `CHANGELOG.md` has a heading matching `## [X.Y.Z]` or `## [X.Y.Z] - YYYY-MM-DD`.
   - Ensure the release date (`YYYY-MM-DD`) is filled in before tagging.
   - Move relevant items from `## [Unreleased]` under the new version heading.
   - Link every entry to the pull request that introduced it with a trailing `([#123])` reference — e.g.
     "- Add the annotations input ([#42])." — so the diff and discussion
     for a change are one click away. Entries that predate the repository's
     pull-request workflow (everything up to and including `v0.1.1`)
     reference the commit that introduced the change instead, as
     `([0de71ec])`, since no pull request exists for them.
3. **Update `SECURITY.md`**: Update the supported-versions table by adding the new
   version as supported and marking previously released versions
   unsupported, keeping the table in sync with `CHANGELOG.md`'s
   release history.
4. **Tag `vX.Y.Z` on `main`**: Create an annotated tag whose name strictly matches
   `vX.Y.Z` (matching `package.json`'s version with a leading `v`). Pre-release
   suffixes (such as `-rc.1`) and unpinned or non-semver tags are rejected.
   `.github/workflows/release.yml` verifies that the tag, `package.json`, and
   `CHANGELOG.md` match before running tests and publishing a GitHub Release.
5. **Floating major tag**: The floating major tag (e.g. `v1`) is moved automatically by
   `.github/workflows/release.yml`, in the same job, after the release is
   created. No manual step is required. The workflow only ever moves the
   major tag forward: it is left untouched when the pushed tag is not the
   newest `vX.Y.Z` in that major line (a re-run, or a tag pushed out of
   order), and pre-1.0 releases publish no floating major tag at all.

5. A post-release smoke test (`smoke-test` job in `.github/workflows/release.yml`)
   runs immediately after the release is published. It invokes the Action by
   its published tag against an offline fixture project to exercise the real
   release artifact the way a consumer does, verifying `status`, check counts,
   and JSON report generation.

   To re-run the smoke test manually for an existing published release tag
   without re-publishing:
   ```bash
   gh workflow run release.yml -f release_tag=v0.1.1
   ```
   or trigger the **Release** workflow from the Actions tab in GitHub and enter
   the target tag in the `release_tag` input field.

