# Security Policy

## Scope

This policy covers `StellarCanary/ProtocolCanary-Action`, the GitHub
Actions integration layer. It does not cover the separate
`StellarCanary/Protocol-Canary` (the compatibility engine) or
`StellarCanary/ProtocolCanary-Fixtures` (the fixture corpus) repositories,
which have their own security policies.

## What this Action never does

- **No private keys, seed phrases, or signing authority.** This Action
  never asks for, stores, or transmits one. Neither does the CLI it
  wraps — see `Protocol-Canary`'s own `SECURITY.md`.
- **No transaction submission.** Only read operations and Soroban
  *simulation* happen anywhere in this pipeline.
- **No Docker, no paid infrastructure, no database, no hosted backend.**
  The Action runs entirely inside the GitHub Actions runner.

## Minimum GitHub permissions

Ordinary compatibility testing needs only:

```yaml
permissions:
  contents: read
```

The Action does not call the GitHub API on your repository at all for its
core function. It does call the public GitHub REST API for
`StellarCanary/Protocol-Canary` itself — to resolve a release tag to a
commit and to look for a published checksum manifest (see
[Installation integrity](#installation-integrity)). When the workflow makes
`secrets.GITHUB_TOKEN` available in the environment, those reads are
authenticated with it, which only raises the GitHub API rate limit (60 to
1,000+ requests/hour, important because GitHub-hosted runners share source
IPs); when no token is available they fall back to unauthenticated reads.
No token is required for the core function, and this Action never reads or
writes *your* repository through the API. Future features that need PR
comments or check runs will document their own, separately scoped,
permission requirements rather than making write access a default
requirement.

## Installation integrity

`Protocol-Canary` does not yet publish signed release binaries or
checksums. This Action installs it from source with `cargo install --git`,
which:

- always uses HTTPS to reach GitHub;
- installs into an Action-owned directory under `RUNNER_TEMP` and does not
  modify the runner's shared Cargo bin directory or `PATH`;
- pins the exact requested version (the `version` input) — never `main`,
  never an unpinned "latest";
- resolves that version's tag to the immutable commit it pointed to at run
  time via the GitHub REST API, and pins `cargo install --rev` to that
  commit — stronger than pinning the (mutable) tag alone;
- falls back to pinning the tag directly, with a visible warning, only if
  that resolution fails (for example, a transient GitHub API error) —
  this Action never silently falls back to an unpinned or different
  version;
- uses `--locked`, so the exact dependency versions in `Protocol-Canary`'s
  own committed `Cargo.lock` are used rather than whatever the latest
  compatible versions happen to be at build time;
- never executes a downloaded script — the toolchain performing the build
  is `cargo`, already present on the runner, not something this Action
  fetches and runs;
- verifies the installed or cached binary against the checksum manifest
  published with the release, when one exists, and refuses to use a binary
  that does not match (see [Checksum verification](#checksum-verification));
- extracts prebuilt archives into a fresh temporary directory, validating that
  exactly one regular `stellar-canary` binary exists and rejecting symlinks,
  path escapes, or duplicate binaries before atomic placement into the tool cache.

### Checksum verification

When the requested `Protocol-Canary` release publishes a checksum manifest
(for example `SHA256SUMS`) as a release asset, this Action downloads it,
hashes the binary it is about to run, and compares the two. A mismatch
throws an `InstallationFailed` error and the binary is never executed.

`Protocol-Canary` does not publish checksums yet, so the lookup normally
finds nothing and this step is a no-op that logs a debug line. That
fallback to commit/tag pinning is deliberate and is the documented,
unchanged behavior: the checksum step only ever *adds* a guarantee when a
manifest exists, and its absence never weakens the existing pinning.
A compiled-from-a-pinned-commit build is still a weaker integrity story
than a checksum published by the artifact's own maintainers, so making
checksum-verified installs the primary path remains the goal.

The full integrity model — trust boundaries, the optional
`strict-integrity` fail-closed policy, the D-07 (checksums are data
integrity, not author authenticity) and D-11 (redirect policy unresolved,
so no redirect is followed) decision boundaries, and the threat model — is
documented in [`docs/integrity-model.md`](docs/integrity-model.md).

## Subprocess isolation

Pull request source code is treated as untrusted. This Action:

- never executes a shell string built from fixture data, repository
  configuration, PR body/title, issue text, or commit messages;
- always passes arguments to the Canary process as an array
  (`child_process.spawn(binary, [...args])`), never through a shell —
  see `src/runner.ts`;
- enforces a configurable timeout and forwards workflow cancellation
  signals to the child process, so a hung or malicious process cannot
  outlive the job;
- decodes child process streams statefully as UTF-8, bounding stdout to
  64 MiB (terminating the process if exceeded) and stderr capture to 1 MiB
  (retaining the tail with a notice).

## External diagnostics and output safety

Diagnostics printed by external tools (`cargo install` build errors and
`stellar-canary check` engine stderr) are untrusted text: they can quote
arbitrary text from dependency source, environment variables, or third-party
fixtures. Before external text is printed in job logs, annotations, or the
execution-failure summary:

- **Redacted:** Passed through `redact` from `src/redact.ts`. Recognised secrets
  (GitHub tokens like `ghp_` or `github_pat_`, Stellar secret seeds like `S...`,
  sensitive environment variable values, and URLs with embedded credentials) are
  masked with `[REDACTED]`.
- **ANSI & Control Character Stripping:** ANSI escape sequences and colors are
  removed. ASCII control characters other than newline (`\n`) and tab (`\t`) are
  stripped (including `\r`).
- **Command-safe log blocks:** To prevent workflow command injection (a line
  beginning with `::` being parsed by the GitHub Actions runner as a workflow
  command such as `::add-mask::` or `::set-env::`), external logs are wrapped in
  collapsed log groups (`core.startGroup` / `core.endGroup`) preceded by
  `::stop-commands::<token>` and closed by `::<token>::`, using a fresh 128-bit
  cryptographically random token generated per block. In annotations and error
  messages, `::` sequences are escaped to `\:\:`.
- **Bounded:** Error message diagnostics are capped at 40 lines and 8 KiB. Log
  blocks are capped at 200 lines and 64 KiB, with explicit truncation notices
  shown when either limit is hit.

## Secret handling

This Action never dumps the process environment and never prints secrets to
logs. The `github-token` input (default `${{ github.token }}`) is registered
with `core.setSecret` upon receipt so that the GitHub Actions runner will mask
any accidental appearance.

The token is used strictly as a bearer credential for read-only requests to the
GitHub REST API at `api.github.com` (for version resolution and checksum
manifest lookup) to raise API rate limits. It is:

- strictly restricted to `api.github.com` — the `Authorization` header is never
  sent to arbitrary hosts or to release asset download URLs (such as `github.com`);
- never forwarded to child processes or echoed to logs, outputs, or summaries;
- operable with minimal read-only permissions (`contents: read`), making it safe
  for pull requests from forks without granting write access.

The Action registers non-empty userinfo credentials, query parameter values, and fragments using `core.setSecret()`. The complete URL is also registered when sensitive components exist. GitHub Actions runner masking is best effort: very short values may not be masked because of runner masking limitations. Values may still be exposed through transformations or outputs outside the runner's masking coverage. Engine output is not guaranteed to be fully sanitized by this mechanism. Users should continue using GitHub Actions secrets for RPC credentials. Users should avoid intentionally printing sensitive values.

Credential-bearing RPC URLs are now protected: the Action registers non-empty userinfo credentials (`user:password@host`), query parameter values, and URL fragments using `core.setSecret()`. The complete credential-bearing URL is also registered when any sensitive component is present. GitHub Actions runner masking is best effort — very short values may not be masked due to runner limitations. Values may still be exposed through transformations or outputs outside the runner's masking coverage. Engine output is not guaranteed to be fully sanitized by this mechanism. Users should continue using GitHub Actions secrets for RPC credentials. Users should avoid intentionally printing sensitive values.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.1 | Yes |
| 0.1.0 | No |

Only the latest released `0.x` version of this Action receives security
fixes while it is pre-1.0; fixes are not backported to older releases.
The table above enumerates every released version from `CHANGELOG.md`,
so support status never has to be re-derived from the release history.

## Audit status

No formal third-party security audit has been performed on this
repository. Confidence in the claims above comes from the implementation
(argument-array subprocess execution, no shell interpolation, pinned
commit installation) and its test suite, not from an external review.

## Reporting a vulnerability

Please open a private report via GitHub's "Report a vulnerability" feature
on this repository, or contact the maintainers directly, rather than
filing a public issue. Include:

- a description of the issue and its impact;
- steps to reproduce;
- the affected version or commit.

We aim to acknowledge new reports within **5 business days**. After
acknowledging a report, we will work with you on a fix and disclosure
timeline before any public write-up.

This is a single-maintainer, pre-1.0 project, so the 5-business-day target
is for the initial acknowledgement only, not for a fix: a fix and its
release depend on the severity and complexity of the issue. If you have
not received an acknowledgement within 5 business days, please follow up
on your existing private report thread rather than opening a public issue,
so the report is not lost or unintentionally disclosed.


### Experimental pull request comment security

The opt-in `pr-comment` feature requests `pull-requests: write` only when consumers explicitly configure it. Do not use `pull_request_target` or run untrusted fork code with a write token. Fork PRs are skipped. The comment is based on the existing escaped job-summary renderer, bounded to 60,000 characters, and attempts to update only bot-authored comments with the matching workflow/job marker. API permission errors are warnings. This implementation is provisional until a maintainer-approved permission model is recorded in the engine contract decisions.
