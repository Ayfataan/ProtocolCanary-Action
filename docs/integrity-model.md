# Integrity Model, Guarantees, and Trust Boundaries

This document describes the complete security model of the Stellar Protocol
Canary Action: the trust boundaries code actually enforces today, the
integrity guarantees it does and does not make, and the two open decisions
(D-07 and D-11) that bound those guarantees. It complements
[`SECURITY.md`](../SECURITY.md), which states the policy; this document
explains the model behind it and where each claim lives in the
implementation. The fork-PR *threat* model authored alongside it
(permissions scoping and boundary conformance, issue #369) will be
maintained by the sibling document `docs/security-model.md` (currently on
open PR #461) — these two documents cover different axes and are meant to
be read together.

## Trust boundaries

A "trust boundary" is a point where data or control crosses from a less
trusted context to a more trusted one. This Action has five:

| # | Boundary | Crosses | Enforced by |
|---|---|---|---|
| 1 | Workflow author → Action | Action inputs (`action.yml`) | `src/inputs.ts` validation: strict boolean literals, integer formats, `https://`-only `rpc-url` (localhost exempt), `config` must be an existing regular file resolved before forwarding |
| 2 | GitHub REST API → Action | Release tag/commit resolution, checksum manifests | `src/canary.ts` + `src/version.ts`: HTTPS-only requests, no redirect following, non-200 is an error, malformed JSON/manifests are "unverifiable", never "verified" |
| 3 | Source build → executed binary | `cargo install --git --locked --rev <commit>` output | Commit pinning (never a mutable tag, never `main`), published-checksum verification when a manifest exists, strict-integrity fail-closed policy (see below) |
| 4 | Engine output → reporting layer | Canary stdout JSON, stderr | `src/output.ts` schema-validated parsing; `src/summary.ts` fences external diagnostics against markdown injection; `src/redact.ts` neutralises workflow-command sequences |
| 5 | Action → runner OS | Every process launch | `src/runner.ts`: argument arrays only, never a shell string; bounded timeout; SIGTERM/SIGKILL escalation |

Pull-request source code is untrusted at every boundary; nothing in fixture
data, PR text, or engine output is ever interpolated into a shell command
(`runs-on` workflows see [`docs/reusable-workflow.md`](reusable-workflow.md)
for the least-privilege consumption pattern).

## Integrity guarantees — and their honest limits

**What is guaranteed today:**

- The engine version is pinned to an immutable commit resolved from the
  requested release tag wherever possible.
- A checksum *mismatch* against a published manifest always aborts
  (`InstallationFailed`), before the binary runs and before anything is
  saved to the shared Actions cache.
- The published-checksum lookup never follows a redirect: a 3xx (to any
  domain, allowlisted or not — including `evil.com`-style spoof targets)
  is a failed lookup, and no second request is issued to the `Location`
  value. Plain `http://` manifest targets can never complete: all lookups
  go through Node's TLS client.
- No Authorization header can leak to a third party, because redirects —
  the only path by which the request identity could change target — are
  never followed.

**What is deliberately *not* guaranteed (decision D-07, deferred):**
checksums and commit pins are data-integrity mechanisms — they detect
accidental corruption and post-publication substitution of an artifact.
They are not proof of the release author's identity, authenticity, or
endorsement, because `Protocol-Canary` publishes no signatures (no GPG or
minisign identities, no Sigstore bundles). A checksum manifest published
*by GitHub alongside a release* is only as trusted as the release itself.
Any digest shown in the job summary's "Provenance & Trust" section carries
this caveat inline; it must never be quoted as authorship proof.

**Decision D-11 (unresolved, blocked):** the download-redirect policy —
which redirect hosts would be allowlisted, up to how many hops, and with
what header stripping — remains **blocked until verified against real
release hosts** (GitHub's asset CDN rotates `objects.githubusercontent.com`
endpoints, and a wrong allowlist is a security feature that silently
becomes a bypass). Until D-11 is resolved, the implemented policy is
maximally strict: **redirects are not followed at all** (0 hops), which is
the boundary `tests/unit/integrity.test.ts` pins. No code in this
repository currently claims an allowlist; if you read one anywhere, it is
stale.

## The strict-integrity fail-closed policy (issue #372)

The optional `strict-integrity` input (default `false`, so existing
pipelines keep today's behaviour) changes verification from "abort when
integrity is *disproven*" to "abort unless integrity is *proven*". With
`strict-integrity: true` the run fails closed — an `InstallationFailed`
abort before the binary executes — when:

1. no published checksum manifest exists for the resolved release (or the
   lookup could not complete over an authenticated HTTPS channel, which
   includes a redirected or unencrypted response);
2. a manifest exists but has no entry for this platform/architecture;
3. the manifest's digest does not match the binary (already fatal in both
   modes).

| Condition | `strict-integrity: false` (default) | `strict-integrity: true` |
|---|---|---|
| Manifest matches binary | proceed, digest in summary | proceed, digest in summary |
| Checksum mismatch | abort | abort |
| No manifest published | proceed on commit/tag pinning (debug note) | **abort — fail closed** |
| No manifest entry for this platform | proceed on commit/tag pinning (debug note) | **abort — fail closed** |
| Manifest lookup redirected / non-HTTPS | proceed on commit/tag pinning (debug note) | **abort — fail closed** |

Strict mode raises the integrity bar only as high as D-07 allows: it
proves the artifact matches what its release published, not who published
it.

## Provenance & Trust summary section (issue #373)

`src/summary.ts` renders a per-run table with the executed engine's
version, the SHA-256 of the binary as observed by published-checksum
verification, and the fixture-pack digest once the download pipeline
(#338) produces one. Metadata a run does not actually have is rendered as
explicitly *unverified*, never omitted and never fabricated, and the
section always carries the D-07/D-11 caveat so a summary screenshot cannot
be read out of context.

## Least-privilege permissions and the fork PR trust boundary (issue #369)

The Action's core function needs `permissions: contents: read` and
nothing else — no write token scope is ever required, `GITHUB_TOKEN` is
used only opportunistically for rate limiting, and the reusable workflow
([`docs/reusable-workflow.md`](reusable-workflow.md)) documents the
`pull_request` target model in which fork PRs run with a read-only token
and no secrets. The detailed fork-PR threat analysis and the conformance
tests live with the sibling `docs/security-model.md` line of work (#461);
this document owns the integrity axis: what the Action trusts about the
binary it runs and the channels it verifies it over.

## Threat model

| Threat | Vector | Status in this Action |
|---|---|---|
| Tampered release artifact | Substituted binary after publication | Checksum mismatch aborts before execution and before cache save (`src/canary.ts`) |
| Cache poisoning | Malicious entry under a predictable Actions cache key | Cache key embeds platform, arch, and the immutable commit (`stellar-canary-<platform>-<arch>-<sha>`); restored binaries are re-verified; a verification failure never saves |
| Redirect to attacker host | 3xx response during release/manifest lookup | Never followed (D-11 strictest reading); lookup degrades or, under strict-integrity, aborts |
| Downgrade to plaintext | `http://` asset URL | Unconditionally rejected — TLS client only, no second request |
| Shell injection via inputs or engine output | Argument interpolation, fixture/PR text | Array-spawn only, no shell; inputs validated at boundary 1 |
| Markdown / workflow-command injection via engine stderr | Diagnostic text in summary or logs | Fenced with CommonMark-longer fences (`src/summary.ts`) and neutralised (`src/redact.ts`) |
| Compromised release author account | Attacker with repo publish rights edits tag/assets | **Open residual risk (D-07):** no signatures exist; commit pinning narrows but does not close this; tag re-pointing is resisted by commit resolution |
| Moving-reference tracking | `latest`/`main` pinning | Rejected at input validation for both engine and pack version inputs |

## Open items

- D-07: release signing deferred upstream; until then nothing in this
  repository may present a checksum as authenticity.
- D-11: redirect allowlist / hop budget / header-stripping policy blocked
  pending verification against real release hosts.
- #338: fixture-pack download with redirect and size limits — the pack
  digest row in the summary stays "unverified" until this lands.
- #360: execution receipt serialization (open PR) will feed additional
  per-run provenance into the same summary section.

## References

- [`SECURITY.md`](../SECURITY.md) — policy statements this model implements.
- [`action.yml`](../action.yml) — the `strict-integrity` input contract.
- [`docs/contracts.md`](contracts.md) — cross-repository contracts,
  including CF-06 (fixture releases).
- [`docs/reusable-workflow.md`](reusable-workflow.md) — least-privilege
  consumption of the maintained reusable workflow.
- `tests/unit/integrity.test.ts`, `tests/unit/strict-integrity.test.ts` —
  executable statements of these boundaries.
