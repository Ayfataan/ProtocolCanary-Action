# Security model: fork PR trust boundaries

This document describes how callers of
[the maintained reusable workflow](reusable-workflow.md) and of the Action
itself are protected when a pull request comes from an untrusted fork. It is
the verification target of `.github/workflows/test-fork-boundary.yml`; the
baseline `permissions: contents: read` hardening inside the reusable workflow
is specified by that workflow's implementation (issue #366) and is **audited
here, not duplicated**.

## Threat model

A fork pull request contributes attacker-controlled code (workflow YAML,
source, fixtures) that GitHub executes on **public-repository runners** with
an ephemeral `GITHUB_TOKEN`. The classic escalation path is a workflow
triggered by `pull_request_target`, `workflow_run`, or `repository_dispatch`:
those events run the **base branch's** workflow code but hand it a token with
write permissions, so any step that touches PR-controlled files (checkout of
the merge ref, artifact copies, comment bodies fed into `eval`) turns a
read-only contributor into a repository writer. Credential exfiltration
usually does not need a bug — a persisted OAuth header in `.git/config` or a
secret wired into a job that also runs fork code is enough.

## The boundary this repository holds

1. **Event surface.** Every workflow that executes contributor-controlled
   content — the Action's code, PR-sourced fixtures, or the report JSON —
   triggers on `pull_request` (never the elevated events above). On fork PRs
   GitHub gives that context a read-only, short-lived token with no access to
   repository secrets.
2. **Token scopes are pinned to `contents: read`.** The reusable workflow and
   its conformance suite declare `permissions: contents: read` at workflow and
   job level; a calling workflow can narrow them further but never widen them,
   because `workflow_call` permissions are intersected with the caller grant.
   No `actions: write`, `pull-requests: write`, or `security-events: write`
   scope exists on the canary path.
3. **No credentials survive a step.** Every `actions/checkout` on the canary
   path sets `persist-credentials: false`, so the token is never written into
   the workspace's `.git/config` where a later step running fork code could
   read it. The Action forwards `GITHUB_TOKEN` to the CLI **only** as a rate
   -limit bearer for anonymous read APIs and never logs it.
4. **Secrets do not cross the boundary.** Fork PR runs receive no repository
   secrets. The reusable workflow declares exactly one optional secret bridge,
   `github-token`, which callers use to pass their own ephemeral token for a
   higher API rate limit — it is not a channel for long-lived credentials:

   ```yaml
   jobs:
     canary:
       uses: StellarCanary/ProtocolCanary-Action/.github/workflows/reusable-canary-check.yml@v1
       secrets:
         github-token: ${{ github.token }}
   ```

   Any other secret reference appearing in a workflow behind this boundary is
   treated as a violation by the automated audit, regardless of whether the
   value would resolve.

## Positive and negative verification

`.github/workflows/test-fork-boundary.yml` runs two shipped bash scripts
(they are extracted and executed against fixture workflows by
`tests/unit/fork-boundary.test.ts`, so the tested logic is the shipped logic):

- **`fork-boundary-audit`** fails the job when any audited workflow uses an
  elevated event trigger, requests a token scope other than read, ships a
  checkout step without `persist-credentials: false`, or forwards a secret
  beyond the declared `github-token` bridge. Absence of a hardening is a
  violation — the audit fails closed.
- **`token-boundary-probe`** performs a real write-scoped API call
  (`POST …/actions/workflows/<none>/dispatches`) with the run's own token and
  fails the job unless the API refuses it with HTTP 401/403. A 404 is also
  rejected: it would mean the token was allowed past authorization.

A caller integrating the reusable workflow inherits the same guarantees:

```yaml
name: Compatibility gate
on:
  pull_request:
permissions:
  contents: read
jobs:
  canary:
    uses: StellarCanary/ProtocolCanary-Action/.github/workflows/reusable-canary-check.yml@v1
    with:
      protocol: 28
```

## Known limits

- Read-only tokens still allow **artifact and log reads** by anyone with repo
  read access; reports must not embed secrets or internal paths. The Action's
  redaction step strips credential-shaped values before upload (see
  `src/redact.ts` tests).
- `workflow_dispatch` and scheduled runs execute with the default token of
  whoever triggers them; keep scheduled canary runs on schedules, not on
  inputs that select fork code.
- Self-hosted runners used for canary checks keep their `GITHUB_TOKEN` and any
  mounted workspace between jobs; the boundary above assumes GitHub-hosted
  ephemeral runners.
