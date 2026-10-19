/**
 * Best-effort secret redaction for diagnostic log tails (CF-08 §3.5, D-10).
 *
 * Diagnostic artifacts are downloadable by anyone who can read the repository,
 * so every line that leaves the runner must go through {@link redact} first.
 * Redaction is deliberately **best effort**: it recognises known credential
 * shapes (GitHub tokens, Stellar secret seeds, URL userinfo/query strings, and
 * values of environment variables whose names look sensitive) and masks them
 * with {@link REDACTED}. A secret that matches none of those shapes can still
 * slip through, which is exactly why the diagnostics artifact is opt-in.
 *
 * The process environment is never dumped into a diagnostic tail; only the
 * values of variables whose *names* look sensitive are used as search
 * patterns. Nothing here reads, logs, or serializes `process.env` itself.
 */

/** Placeholder that replaces every recognised secret. */
export const REDACTED = "[REDACTED]";

/**
 * GitHub token prefixes: `ghp_` (personal), `gho_` (OAuth), `ghu_` (user),
 * `ghs_` (server-to-server) and `ghr_` (refresh), plus the fine-grained
 * `github_pat_` form. GitHub's own docs treat all of these as secret-bearing
 * opaque strings.
 */
const GITHUB_TOKEN_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
];

/**
 * A Stellar secret seed is a StrKey `S...` value: 56 base32 characters in
 * total (a leading `S` followed by 55 characters from A-Z and 2-7). Public
 * account addresses (`G...`) and contract IDs (`C...`) share the same shape
 * but are not secrets, so they are deliberately left untouched.
 */
const STELLAR_SEED_PATTERN = /\bS[A-Z2-7]{55}\b/g;

/**
 * Environment variable names whose *values* must never appear in a
 * diagnostic tail. Matching is case-insensitive and intentionally broad: a
 * false positive only hides a harmless string, while a false negative leaks a
 * credential.
 */
const SENSITIVE_ENV_NAME = /(TOKEN|SECRET|KEY|PASSWORD)/i;

/** Values shorter than this are skipped: masking a two-character value would
 * mangle unrelated text without protecting a realistic secret. */
const MIN_ENV_VALUE_LENGTH = 8;

/** Matches an absolute http(s) URL, stopping at whitespace, quotes, or the
 * backtick that often wraps a URL in a log line. */
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>`]+/gi;

/** Escapes a literal string so it can be embedded in a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Masks the values of environment variables whose names contain `TOKEN`,
 * `SECRET`, `KEY` or `PASSWORD`. Empty and very short values are ignored so a
 * trivially common string cannot rewrite the whole log. This reads the values
 * only to build search patterns; it never includes the ambient environment in
 * the returned text.
 */
function redactSensitiveEnvironmentValues(text: string): string {
  let redacted = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV_NAME.test(name) || value === undefined) {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length < MIN_ENV_VALUE_LENGTH || trimmed === REDACTED) {
      continue;
    }
    redacted = redacted.replace(new RegExp(escapeRegExp(trimmed), "g"), REDACTED);
    // Also mask the untrimmed value when surrounding whitespace makes it a
    // different (but still copyable) string.
    if (trimmed !== value) {
      redacted = redacted.replace(new RegExp(escapeRegExp(value), "g"), REDACTED);
    }
  }
  return redacted;
}

/**
 * Removes credentials embedded in URLs: userinfo (`user:password@host`) and
 * any query string or fragment (which routinely carry `?token=...`). The
 * scheme, host, and path are preserved so the log still says which endpoint
 * was called.
 */
function redactUrlCredentials(text: string): string {
  return text.replace(URL_PATTERN, (raw) => {
    const schemeEnd = raw.indexOf("://") + 3;
    if (schemeEnd === 3) {
      return raw;
    }
    const remainder = raw.slice(schemeEnd);
    const cut = remainder.search(/[?#]/);
    const beforeSuffix = cut === -1 ? remainder : remainder.slice(0, cut);
    const hadSuffix = cut !== -1;

    const pathStart = beforeSuffix.indexOf("/");
    const authorityEnd = pathStart === -1 ? beforeSuffix.length : pathStart;
    const authority = beforeSuffix.slice(0, authorityEnd);
    const path = beforeSuffix.slice(authorityEnd);

    const at = authority.lastIndexOf("@");
    const safeAuthority = at === -1 ? authority : `${REDACTED}@${authority.slice(at + 1)}`;

    return `${raw.slice(0, schemeEnd)}${safeAuthority}${path}${hadSuffix ? `?${REDACTED}` : ""}`;
  });
}

/**
 * Rewrites GitHub Actions workflow-command sequences (`::`) and backticks so
 * a log line can never be interpreted as a command or break out of a Markdown
 * code fence in the job summary. Escaping is applied last, after every secret
 * has been replaced, so a redaction cannot itself introduce a command.
 */
export function escapeWorkflowCommands(text: string): string {
  return text.replace(/::/g, "\\:\\:").replace(/`/g, "\\`");
}

/**
 * Redacts known credential shapes from a diagnostic string without escaping.
 * Prefer {@link redact}, which also neutralises workflow commands.
 */
export function redactSecrets(text: string): string {
  let redacted = redactSensitiveEnvironmentValues(text);
  for (const pattern of GITHUB_TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  redacted = redacted.replace(STELLAR_SEED_PATTERN, REDACTED);
  return redactUrlCredentials(redacted);
}

/**
 * Prepares a diagnostic string for a log tail or artifact: masks recognised
 * secrets and escapes workflow-command sequences and backticks.
 *
 * **Best effort only.** Redaction recognises the credential shapes listed in
 * `src/redact.ts`; it cannot guarantee that every possible secret is caught,
 * which is why diagnostics remain opt-in (CF-08 §3.5, D-10). The process
 * environment is never included in the output.
 */
export function redact(text: string): string {
  return escapeWorkflowCommands(redactSecrets(text));
}
