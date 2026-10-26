import * as core from "@actions/core";

import { InvalidInputError } from "./errors";
import { MAX_API_RESPONSE_BYTES } from "./http-response";
import { GitHubRequestError, githubFetch } from "./github";
import { resolveGithubToken } from "./inputs";

/**
 * Single point of control for where this Action installs Protocol-Canary from.
 *
 * These constants are shared between the `cargo install --git` target
 * (`CANARY_REPO_URL` in `src/canary.ts`) and the GitHub REST API tag lookup
 * (`CANARY_REPO_OWNER`/`CANARY_REPO_NAME` in `resolveTagCommit`, this file).
 * Changing them (e.g. to point at a fork) affects both the install source
 * and the tag-resolution API calls, so keep them in sync.
 */
export const CANARY_REPO_OWNER = "StellarCanary";
export const CANARY_REPO_NAME = "Protocol-Canary";
export const CANARY_REPO_URL = `https://github.com/${CANARY_REPO_OWNER}/${CANARY_REPO_NAME}.git`;

/** The API base for the Canary repository, shared by every REST call here. */
export const CANARY_API_REPO_URL = `https://api.github.com/repos/${CANARY_REPO_OWNER}/${CANARY_REPO_NAME}`;

/**
 * Engine release compatibility policy (issue #374).
 *
 * Supported range: `>= 0.1.1` on the current `0.x` release line. `0.1.1` is
 * the Action's default and is fully supported, so it must never warn. `0.1.0`
 * sits just below the supported range but has no approved deprecation
 * decision, so it is reported as unsupported *without* a deprecation warning;
 * only releases strictly older than `0.1.0` warn. A future major release
 * (`>= 1.0.0`) also warns: this Action has not been validated against it, and
 * no deprecation decision covers it either.
 */
export const MIN_SUPPORTED_ENGINE_VERSION = "0.1.1";
/** Legacy releases strictly older than this emit a deprecation warning. */
export const DEPRECATED_BELOW_ENGINE_VERSION = "0.1.0";
/** The newest engine release this Action is validated against. */
export const LATEST_VALIDATED_ENGINE_VERSION = "0.1.1";

export interface EngineVersionCompatibility {
  /** The version as assessed, trimmed. */
  readonly version: string;
  /** Whether the version is inside the supported `>= 0.1.1`, `0.x` range. */
  readonly supported: boolean;
  /**
   * A human-readable warning to emit as a GitHub annotation, or `undefined`
   * when the version needs no warning (including the default `0.1.1`).
   */
  readonly warning: string | undefined;
}

interface ParsedEngineVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const ENGINE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parses a strict `x.y.z` engine version. Unlike the `version` input's
 * parser this does not accept a leading `v`: by the time a version reaches
 * here it has already been normalised. Invalid strings throw
 * {@link InvalidInputError} rather than being treated as "old" or "new". */
function parseEngineVersion(version: string): ParsedEngineVersion {
  const value = version.trim();
  const match = ENGINE_VERSION_PATTERN.exec(value);
  if (match === null) {
    throw new InvalidInputError(
      `Invalid engine version: ${JSON.stringify(version)}. Expected a semantic version, e.g. "${LATEST_VALIDATED_ENGINE_VERSION}".`,
    );
  }
  return {
    major: Number.parseInt(match[1] ?? "0", 10),
    minor: Number.parseInt(match[2] ?? "0", 10),
    patch: Number.parseInt(match[3] ?? "0", 10),
  };
}

function compareEngineVersions(left: ParsedEngineVersion, right: ParsedEngineVersion): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

/**
 * Assesses a requested engine version against the supported release range
 * and returns any warning the caller should emit. The default `0.1.1` is
 * fully supported and produces no warning; a version strictly older than
 * `0.1.0` warns as deprecated, as does an unvalidated future major release.
 *
 * Throws {@link InvalidInputError} for a value that is not `x.y.z`, so a
 * mistyped version fails clearly instead of being misclassified by a
 * best-effort comparison.
 */
export function assessEngineVersion(version: string): EngineVersionCompatibility {
  const parsed = parseEngineVersion(version);
  const supported =
    parsed.major === 0 &&
    compareEngineVersions(parsed, parseEngineVersion(MIN_SUPPORTED_ENGINE_VERSION)) >= 0;

  let warning: string | undefined;
  if (compareEngineVersions(parsed, parseEngineVersion(DEPRECATED_BELOW_ENGINE_VERSION)) < 0) {
    warning =
      `Protocol-Canary ${version.trim()} is older than ${DEPRECATED_BELOW_ENGINE_VERSION} and is no longer supported by this Action. ` +
      `Upgrade the \`version\` input to ${LATEST_VALIDATED_ENGINE_VERSION} or newer.`;
  } else if (parsed.major > 0) {
    warning =
      `Protocol-Canary ${version.trim()} is newer than the supported 0.x release line ` +
      `(latest validated: ${LATEST_VALIDATED_ENGINE_VERSION}); compatibility with this engine release is not verified.`;
  }

  return { version: version.trim(), supported, warning };
}

/** GitHub's maximum page size for list endpoints such as `tags`. */
const TAGS_PER_PAGE = 100;

/**
 * A hard ceiling on how many tag pages we will follow. The `Link` header is
 * authoritative and GitHub always terminates the chain, but a cap means a
 * malformed or hostile header can never spin this loop forever.
 */
const MAX_TAG_PAGES = 50;

export interface ResolvedVersion {
  /** The bare semantic version, e.g. "0.1.0". */
  readonly version: string;
  /** The git tag this version corresponds to, e.g. "v0.1.0". */
  readonly tag: string;
  /**
   * The commit the tag pointed to at resolution time, when it could be
   * resolved. Protocol-Canary does not (yet) publish signed release
   * artifacts or checksums, so pinning `cargo install` to this immutable
   * commit — rather than the mutable tag — is this Action's integrity
   * mechanism (see SECURITY.md). `undefined` if resolution failed, in
   * which case the caller falls back to installing from the tag directly.
   */
  readonly commitSha: string | undefined;
}

export interface ResolveVersionOptions {
  /**
   * GitHub token used to authenticate the tag lookup. When omitted, the
   * `GITHUB_TOKEN` environment variable is used if it is set. Passing a
   * token raises the GitHub REST rate limit from 60 to 1,000+ requests per
   * hour per source IP, which matters because GitHub-hosted runners share
   * IP ranges across many concurrent jobs.
   */
  readonly token?: string | undefined;
}

/** Resolves a bare version (e.g. "0.1.0") to its upstream tag and, if
 * possible, the immutable commit it currently points to. Never throws:
 * every tag-lookup failure — non-200 responses, malformed JSON, valid JSON
 * of an unexpected shape, or a missing tag — degrades to
 * `commitSha: undefined`. Missing tags are surfaced as warnings; other
 * lookup failures are debug-logged. Installation failures proper are reported separately, as
 * `InstallationFailedError` thrown from `src/canary.ts`. */
export async function resolveVersion(
  version: string,
  options: ResolveVersionOptions = {},
): Promise<ResolvedVersion> {
  const tag = `v${version}`;
  const commitSha = await resolveTagCommit(tag, options.token).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(`tag ${tag} not found in ${CANARY_REPO_OWNER}/${CANARY_REPO_NAME} tags`)) {
      core.warning(
        `Could not find upstream tag ${tag}. This usually means the requested version ${version} is mistyped or not yet published; falling back to tag-only pinning.`,
      );
      return undefined;
    }

    if (error instanceof GitHubRequestError && error.kind === "rate-limit") {
      const resetMessage =
        error.resetAt === undefined
          ? "The reset time is unavailable."
          : `The rate limit resets at ${error.resetAt.toISOString()}.`;
      core.warning(
        `GitHub API rate limit prevented resolving ${tag}. ${resetMessage} Falling back to tag-only pinning.`,
      );
      return undefined;
    }

    if (error instanceof GitHubRequestError && error.kind === "server" && message.includes("failed after retries")) {
      core.warning(`GitHub API lookup for ${tag} failed after retries; falling back to tag-only pinning: ${message}`);
      return undefined;
    }

    core.debug(`Could not resolve ${tag} to a commit sha, falling back to tag pinning: ${String(error)}`);
    return undefined;
  });
  return { version, tag, commitSha };
}

interface GitHubTag {
  readonly name?: unknown;
  readonly commit?: { readonly sha?: unknown };
}

interface TagsPage {
  readonly tags: GitHubTag[];
  readonly next: string | undefined;
}

/** Normalizes a token candidate using the shared precedence rules. */
function resolveToken(explicitToken: string | undefined): string | undefined {
  return resolveGithubToken(explicitToken);
}

/**
 * Extracts the `rel="next"` URL from a GitHub `Link` header, if present.
 * The header looks like:
 *
 *   <https://api.github.com/...&page=2>; rel="next", <...&page=5>; rel="last"
 */
function parseNextLink(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (value === undefined || value === "") {
    return undefined;
  }
  for (const part of value.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match !== null) {
      return match[1];
    }
  }
  return undefined;
}

/** Fetches and parses a single bounded page of the `tags` list endpoint. */
async function fetchTagsPage(url: string, token: string | undefined): Promise<TagsPage> {
  const { body, headers } = await githubFetch(url, token, MAX_API_RESPONSE_BYTES);
  const parsed = JSON.parse(body) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("unexpected response shape from GitHub API");
  }
  return { tags: parsed as GitHubTag[], next: parseNextLink(headers.link) };
}

/**
 * Resolves a tag to the commit it points to, using the `tags` list endpoint
 * (which GitHub already peels to a commit sha for both lightweight and
 * annotated tags) rather than `git/refs/tags/{tag}` (which returns a tag
 * *object* sha for annotated tags and would need a second peeling call).
 *
 * Every page is walked, following the `Link: rel="next"` header, until the
 * tag is found or the list is exhausted — so a repository with more than
 * 100 tags still resolves correctly. When `token` (or `GITHUB_TOKEN`) is
 * available the request is authenticated, raising the rate limit from 60 to
 * 1,000+ requests/hour so a shared runner IP cannot silently degrade the
 * lookup to tag-based pinning.
 */
async function resolveTagCommit(tag: string, explicitToken: string | undefined): Promise<string | undefined> {
  const token = resolveToken(explicitToken);
  let url: string | undefined = `${CANARY_API_REPO_URL}/tags?per_page=${String(TAGS_PER_PAGE)}`;

  for (let page = 0; page < MAX_TAG_PAGES && url !== undefined; page++) {
    const { tags, next } = await fetchTagsPage(url, token);
    const match = tags.find((entry) => entry.name === tag);
    const sha = match?.commit?.sha;
    if (typeof sha === "string" && sha.length > 0) {
      return sha;
    }
    url = next;
  }

  throw new Error(`tag ${tag} not found in ${CANARY_REPO_OWNER}/${CANARY_REPO_NAME} tags`);
}
