/**
 * Policy for following redirects when downloading release artifacts.
 * This module is pure (no network, no side effects) and must not be
 * imported by runtime download paths until approved; see tests.
 */

import { URL } from "node:url";

export const MAX_REDIRECT_HOPS = 3;

export const ALLOWED_REDIRECT_HOSTS = Object.freeze([
  "api.github.com",
  "github.com",
  "release-assets.githubusercontent.com",
] as const);

export type AllowedRedirectHost = (typeof ALLOWED_REDIRECT_HOSTS)[number];

export interface RedirectHopEvaluation {
  allowed: boolean;
  reason: string;
}

export interface HeadersForUrlOptions {
  token?: string | undefined;
}

/**
 * Detects a percent-encoded host (authority) in the raw URL string. The
 * WHATWG URL parser decodes percent escapes in the hostname, which would let
 * `%67ithub.com` slip through an allow-list as `github.com`; this checks the
 * raw authority instead. Only the authority portion is inspected so percent
 * escapes in a path or query (which are legitimate) are not rejected.
 */
function hasPercentEncodedAuthority(rawUrl: string): boolean {
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(rawUrl);
  if (schemeMatch === null) {
    return false;
  }
  const rest = rawUrl.slice(schemeMatch[0].length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  return authority.includes("%");
}

function isAllowedHost(hostname: string): hostname is AllowedRedirectHost {
  if (hostname.includes("..")) {
    return false;
  }
  if (hostname.includes("@")) {
    return false;
  }
  // Reject trailing dot
  if (hostname.endsWith(".")) {
    return false;
  }
  return (ALLOWED_REDIRECT_HOSTS as readonly string[]).includes(hostname.toLowerCase());
}

/**
 * Evaluate a single redirect hop from `from` to `to`.
 * Returns { allowed: false } with a specific reason on rejection.
 */
export function evaluateRedirectHop(
  from: string,
  to: string,
  hopIndex: number,
): RedirectHopEvaluation {
  if (hopIndex < 0) {
    return { allowed: false, reason: "hop index must be >= 0" };
  }
  if (hopIndex >= MAX_REDIRECT_HOPS) {
    return { allowed: false, reason: `exceeded maximum redirects (${MAX_REDIRECT_HOPS})` };
  }

  // Reject percent-encoded hostnames before parsing: the WHATWG URL parser
  // decodes percent escapes in the host, so `%67ithub.com` would otherwise
  // normalize to `github.com` and pass the allow-list. Inspect the raw
  // authority for a `%` character (after resolving a relative target).
  if (hasPercentEncodedAuthority(to) || hasPercentEncodedAuthority(from)) {
    return { allowed: false, reason: "percent-encoded host not allowed" };
  }

  let fromUrl: URL;
  let toUrl: URL;
  try {
    fromUrl = new URL(from);
  } catch {
    return { allowed: false, reason: "invalid source URL" };
  }
  try {
    toUrl = new URL(to, fromUrl);
  } catch {
    return { allowed: false, reason: "invalid redirect target URL" };
  }

  // Credentials in URL are rejected
  if (fromUrl.username || fromUrl.password || toUrl.username || toUrl.password) {
    return { allowed: false, reason: "userinfo not allowed in redirect URLs" };
  }

  // Only HTTPS
  if (fromUrl.protocol !== "https:") {
    return { allowed: false, reason: "source must use https" };
  }
  if (toUrl.protocol !== "https:") {
    return { allowed: false, reason: "redirect target must use https" };
  }

  // No non-default ports (443 for https is default but we reject if explicitly different)
  if (toUrl.port && toUrl.port !== "443") {
    return { allowed: false, reason: "non-default port not allowed" };
  }
  if (fromUrl.port && fromUrl.port !== "443") {
    return { allowed: false, reason: "source non-default port not allowed" };
  }

  // Reject IP literals
  const host = toUrl.hostname;
  // IPv6
  if (host.includes(":")) {
    return { allowed: false, reason: "IP literals not allowed" };
  }
  // IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return { allowed: false, reason: "IP literals not allowed" };
  }

  if (!isAllowedHost(host)) {
    return { allowed: false, reason: "host not in allow-list" };
  }

  // Look-alike protection - must be exact match in allow-list (case insensitive handled)
  const normalized = host.toLowerCase();
  if (!(ALLOWED_REDIRECT_HOSTS as readonly string[]).includes(normalized)) {
    return { allowed: false, reason: "host not in allow-list" };
  }

  return { allowed: true, reason: "allowed" };
}

/**
 * Return headers allowed for a request to the given URL with an optional token.
 * Authorization is ONLY attached for exactly api.github.com and is NEVER
 * forwarded to other hosts.
 */
export function getHeadersForUrl(url: string, options: HeadersForUrlOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "ProtocolCanary-Action",
    Accept: "application/vnd.github+json",
  };
  try {
    const u = new URL(url);
    if ((options.token !== undefined && options.token !== "") && u.hostname.toLowerCase() === "api.github.com") {
      headers.Authorization = `Bearer ${options.token}`;
    }
    // Never attach Authorization to github.com or CDN hosts
  } catch {
    // If URL is invalid, return safe headers without credentials
  }
  return headers;
}
