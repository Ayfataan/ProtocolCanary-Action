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
npm run audit
npm run check:licenses
npm run typecheck
npm run lint
npm test
npm run build
```

All must pass before a change is considered done — this is exactly
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
npm run audit        # npm audit --omit=dev --audit-level=high
npm run check:licenses # license allow-list verification for production dependencies
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
after any dependency bump, run `npm run audit`, and run `npm run check:licenses` —
fix or explicitly justify any new advisory before merging.

Dependabot also opens automated update PRs for the npm and
`github-actions` ecosystems on a weekly schedule (see
`.github/dependabot.yml`), so some dependency updates arrive without
anyone hand-writing a `chore(deps):` commit. Those PRs are held to the
same review expectations as any other change: re-run the full
test/lint/build sequence, `npm run audit`, and `npm run check:licenses`
before merging one, and either fix or explicitly justify any new advisory in the PR.

### Dependency audit and vulnerability handling

CI runs `npm run audit` (`npm audit --omit=dev --audit-level=high`) on every
pull request and on a weekly schedule to detect high or critical advisories in
the production dependency tree that bundles into `dist/index.js`.

- **Report only in CI**: Do **not** use `npm audit fix` in CI. Vulnerabilities must
  be explicitly reviewed and resolved or triaged by maintainers.
- **When an audit reports a finding with a fix available**: Update the affected
  direct or transitive dependency (e.g. via `npm update <package>` or explicit
  package bump), re-run `npm run build`, and commit both `package-lock.json` and
  updated `dist/`.
- **When an audit reports a finding with NO fix available yet**:
  1. **Assess reachability and impact**: Determine whether the vulnerable code path
     in the transitive dependency is reachable in the context of this Action's bundle
     and execution model.
  2. **Check for upstream workarounds**: Check if an override in `package.json`
     (`overrides` field) can safely pin a patched transitive version without breaking
     runtime behavior.
  3. **Document and track**: If no upstream fix or safe override is available and the
     vulnerability is deemed unexploitable or low risk in the Action's context, open
     an issue or record the justification in the pull request review referencing the
     upstream advisory tracking issue. Temporary audit exceptions must be reviewed
     and approved by repository maintainers.

### License compliance checks

Production dependencies are verified against an allow-list located in
[`.licenses-allowlist.json`](.licenses-allowlist.json).

- Run `npm run check:licenses` locally to verify production dependencies.
- Allowed licenses include standard permissive licenses (`MIT`, `Apache-2.0`,
  `ISC`, `BSD-2-Clause`, `BSD-3-Clause`, `0BSD`, `BlueOak-1.0.0`, etc.).
- If a legitimate new production dependency or package with dual/custom licensing
  is added, propose updating `.licenses-allowlist.json` in the same pull request
  with maintainer review.

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
