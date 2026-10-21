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
npm test             # vitest run (unit + integration)
npm run test:coverage  # vitest run with v8 coverage over src/ (text, HTML, and lcov reports in coverage/)
npm run build         # esbuild bundle to dist/index.js
```

`npm run test:coverage` runs the same suite as `npm test` with coverage
measurement enabled (via `@vitest/coverage-v8`; configured in
`vitest.config.ts` to measure `src/` only). It reports line/branch coverage
per source file in the terminal, and writes HTML and lcov reports to
`coverage/` (gitignored). There is no coverage threshold gate today —
consult the report when touching a file to see whether your change is
exercised by the suite.

Unit and integration tests must never require network access or a real
`stellar-canary` binary by default: they run against
[`tests/fixtures/mock-canary.cjs`](tests/fixtures/mock-canary.cjs), a fake
CLI that simulates every documented result state (`pass`, `warning`,
`fail`, `config-error`, `rpc-error`, `fixture-error`, `internal-error`,
`malformed-json`, `timeout`) via the `MOCK_CANARY_SCENARIO` environment
variable. Real-engine checks run separately: `.github/workflows/weekly-live.yml`
runs on a weekly schedule or manual dispatch against a real Canary build and
live Testnet/Futurenet endpoints (network required);
`.github/workflows/engine-compat.yml` runs only on manual dispatch, builds
real engines from source, and exercises offline scenarios without network
access; `tests/integration/real-engine.test.ts` is skipped unless
`STELLAR_CANARY_BIN` points to a real engine. The `smoke-test` job in
`.github/workflows/release.yml` runs the published Action with a real engine
after a version-tag release or on manual dispatch. None of these real-engine
workflows gates a pull request; `.github/workflows/ci.yml` provides the
required pull-request checks.

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

## Release process

1. Update `CHANGELOG.md`. Link every entry to the pull request that
   introduced it with a trailing `([#123])` reference — e.g.
   "- Add the annotations input ([#42])." — so the diff and discussion
   for a change are one click away. Entries that predate the repository's
   pull-request workflow (everything up to and including `v0.1.1`)
   reference the commit that introduced the change instead, as
   `([0de71ec])`, since no pull request exists for them.
2. Update the supported-versions table in `SECURITY.md`: add the new
   version as supported and mark every previously released version
   unsupported, so the table stays in sync with `CHANGELOG.md`'s
   release history.
3. Tag `vX.Y.Z` on `main` (annotated tag, matching `package.json`'s
   version). `.github/workflows/release.yml` verifies the build and tests
   for that tag and publishes a GitHub Release.
4. The floating major tag (e.g. `v1`) is moved automatically by
   `.github/workflows/release.yml`, in the same job, after the release is
   created. No manual step is required. The workflow only ever moves the
   major tag forward: it is left untouched when the pushed tag is not the
   newest `vX.Y.Z` in that major line (a re-run, or a tag pushed out of
   order), and pre-1.0 releases publish no floating major tag at all.

   If you need to move a major tag by hand for an exceptional case, use an
   annotated tag and force-push it — but never do this for a pre-1.0
   release, and never move a major tag backwards:
   ```bash
   git tag -fa v1 vX.Y.Z -m "Update v1 to vX.Y.Z"
   git push origin v1 --force
   ```
