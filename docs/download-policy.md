# Release download redirect policy (D-11)

This document defines the policy for following HTTP redirects when downloading release artifacts. It is a security decision that must be approved before any code follows redirects.

**Decision to approve (exact wording for D-11):**  
"Allow redirects only for HTTPS hops between api.github.com, github.com, and release-assets.githubusercontent.com with a maximum of 3 hops, reject non-HTTPS schemes/ports/userinfo/IP literals/look-alikes/percent-encoded/relative-protocol-relative tricks, never forward Authorization to non-API hosts, and validate with an explicit allow-list using the WHATWG URL parser."

## Allowed hosts and observations

| Host | Purpose | Observed (date) | Reproduction command |
|---|---|---|---|
| `api.github.com` | GitHub REST API (release metadata, checksum manifests) | 2026-10-18 | `curl -sI https://api.github.com/repos/StellarCanary/Protocol-Canary/releases/tags/v0.2.0 \| head -5` |
| `github.com` | Release asset page/download links | 2026-10-18 | `curl -sI https://github.com/StellarCanary/Protocol-Canary/releases/download/v0.2.0/SHA256SUMS \| head -10` |
| `release-assets.githubusercontent.com` | CDN redirect target for release assets | 2026-10-18 | Observed via redirect from `github.com/.../SHA256SUMS` (returns 302 to this host, which returns 200) |

**Observed behavior (2026-10-18):**
- `https://github.com/StellarCanary/Protocol-Canary/releases/download/v0.2.0/SHA256SUMS` → `302 Found` with `Location` to `https://release-assets.githubusercontent.com/...`
- `https://release-assets.githubusercontent.com/...` → `200 OK`

## Rules

1. **HTTPS only.** Every hop must use `https:`. Redirects from `https` to `http`, `file:`, `data:`, `javascript:`, or any other scheme are rejected.
2. **Bounded redirects.** Maximum of `3` hops. A total time budget must be enforced by callers; the policy exposes the hop limit.
3. **Destination validation.** Each target is parsed with the WHATWG URL parser. Relative Location values are resolved against the current URL before checking. Protocol-relative (`//...`) and absolute URLs are validated.
4. **Explicit allow-list.** Only exact hostnames in `api.github.com`, `github.com`, `release-assets.githubusercontent.com` are allowed. Subdomain wildcards are not used. Look-alike hosts (`github.com.evil.example`, `evilgithub.com`), IP literals (including IPv6), userinfo, non-default ports, trailing-dot hosts, and percent-encoded hosts are rejected.
5. **Credential protection.** An `Authorization` header is attached **only** to requests for exactly `api.github.com`. It is **never** forwarded to `github.com`, never forwarded to `release-assets.githubusercontent.com`, and never forwarded after any host change. Signed download URLs on the CDN must be requested without credentials.
6. **Fail closed.** Any violation results in rejection with a specific reason. Unknown schemes or malformed URLs must not throw unexpectedly.

## Threats addressed

- **Token exfiltration:** Prevents bearer tokens from being sent to CDN or arbitrary hosts on redirect.
- **Open redirect / host spoofing:** Blocks look-alikes, IP literals, and unexpected hosts.
- **Downgrade attacks:** Enforces HTTPS on every hop.
- **Abuse via unusual URL forms:** Rejects userinfo, non-default ports, trailing dots, percent-encoded hostnames.

## Out of scope

- **Signatures/checksums beyond existing policy:** Artifact signature verification is covered by separate decisions (see D-07). This policy only governs redirect following and credential/host safety.
- **Implementing download logic:** This issue only adds the policy module, tests, and documentation. No runtime download paths are changed.
- **Adding new hosts:** Only observed hosts are allowed.
