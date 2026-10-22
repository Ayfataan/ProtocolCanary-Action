import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

import {
  CanaryExecutionFailedError,
  CanaryNotFoundError,
  InstallationFailedError,
  InvalidInputError,
  TimeoutError,
} from "./errors";
import { resolveGithubToken } from "./inputs";
import { formatSafeDiagnosticTail, printLogBlock } from "./log-block";
import type { CheckExecutionResult } from "./runner";
import { CARGO_INSTALL_TIMEOUT_FLOOR_MS, runCheck } from "./runner";
import type { ResolvedVersion } from "./version";
import { CANARY_API_REPO_URL, CANARY_REPO_URL } from "./version";

/**
 * Describes a Canary binary that has been located or restored and verified
 * ready for the Action to execute.
 *
 * The reported version is read from the binary itself and has been checked
 * against the resolved requested version; it is not merely the requested
 * input value.
 */
export interface InstalledCanary {
  /** Absolute path to the verified executable on the runner. */
  readonly binaryPath: string;
  /** Version reported by the executable after verification. */
  readonly version: string;
}

function cargoBinDir(): string {
  const cargoHome = process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo");
  return path.join(cargoHome, "bin");
}

function binaryName(): string {
  return process.platform === "win32" ? "stellar-canary.exe" : "stellar-canary";
}

/**
 * Maps Node's `process.platform`/`process.arch` names to the Rust target
 * triples Protocol-Canary builds its prebuilt release binaries for (issue
 * #359). Keys are `${platform}-${arch}`; only the platforms the engine
 * actually ships (Linux x86_64/aarch64, macOS x86_64/aarch64, and Windows
 * x86_64) have an entry.
 */
export const PREBUILT_TARGET_TRIPLES: Readonly<Record<string, string>> = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
};

/** Returns the release target triple for a runner platform/arch pair, or
 * throws an {@link InstallationFailedError} naming the unsupported pair and
 * the supported set when no prebuilt binary exists for it. */
export function prebuiltTargetTriple(platform: string, arch: string): string {
  const key = `${platform}-${arch}`;
  const triple = PREBUILT_TARGET_TRIPLES[key];
  if (triple === undefined) {
    const supported = Object.entries(PREBUILT_TARGET_TRIPLES)
      .map(([pair, target]) => `${pair} (${target})`)
      .join(", ");
    throw new InstallationFailedError(
      `Unsupported platform ${key} for prebuilt Protocol-Canary releases: this Action installs ` +
        `prebuilt binaries only for ${supported}.`,
    );
  }
  return triple;
}

/** Name the Protocol-Canary release uses for its prebuilt archive for a
 * target triple: `stellar-canary-${version}-${target}.tar.gz`, with a `.zip`
 * variant accepted for Windows where release tooling commonly emits one. */
function prebuiltAssetName(version: string, triple: string): string {
  return `stellar-canary-${version}-${triple}.tar.gz`;
}

/** Root under which prebuilt binaries are kept, mirroring the runner's
 * tool-cache when `RUNNER_TOOL_CACHE` is set and falling back to a stable
 * per-user cache directory on local runs. */
function toolCacheRoot(): string {
  const configured = (process.env["RUNNER_TOOL_CACHE"] ?? "").trim();
  return configured !== "" ? configured : path.join(os.homedir(), ".cache", "protocolcanary-tool-cache");
}

/** Time bound for one prebuilt-asset download request, and the number of
 * redirects GitHub's asset CDN is allowed before the download is abandoned. */
const PREBUILT_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_REDIRECTS = 5;

/** GETs a URL as binary content and writes it to `destPath`, following up to
 * `redirectsLeft` 3xx redirects (GitHub release downloads redirect from
 * `github.com` to a signed object host). Rejects on any non-2xx/3xx response,
 * a timeout, a redirect without a `Location`, or a write failure. */
function httpsGetFile(url: string, destPath: string, redirectsLeft: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const succeed = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const request = https.get(url, { headers: { "User-Agent": "ProtocolCanary-Action" }, timeout: PREBUILT_DOWNLOAD_TIMEOUT_MS }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        const location = response.headers.location;
        response.resume();
        if (typeof location !== "string" || location === "" || redirectsLeft <= 0) {
          fail(new Error(`prebuilt asset download from ${url} returned status ${String(status)} with no followable Location header`));
          return;
        }
        let next: string;
        try {
          next = new URL(location, url).toString();
        } catch {
          fail(new Error(`prebuilt asset download from ${url} returned an invalid redirect target ${location}`));
          return;
        }
        httpsGetFile(next, destPath, redirectsLeft - 1).then(succeed, fail);
        return;
      }
      if (status !== 200) {
        response.resume();
        fail(new Error(`GitHub returned status ${String(status)} for ${url}`));
        return;
      }
      // Chunks are written manually (the same event style as
      // `httpsGetText`) rather than via `pipe`, keeping the download
      // handler symmetric with the text getter's mocked response surface.
      const file = fs.createWriteStream(destPath);
      file.on("error", fail);
      response.on("data", (chunk: Buffer | string) => {
        file.write(chunk);
      });
      response.on("error", (error: Error) => {
        file.destroy();
        fail(error);
      });
      response.on("end", () => {
        file.end();
      });
      file.on("finish", succeed);
    });
    request.on("timeout", () => {
      request.destroy(new Error(`timed out downloading ${url}`));
    });
    request.on("error", fail);
  });
}

/** Asset names a Protocol-Canary release is expected to use for its
 * checksum manifest (for example `SHA256SUMS` or `checksums.txt`). */
const CHECKSUM_ASSET_PATTERN = /(sha-?256|sha-?512|checksums?|shasums?)/i;
const CHECKSUM_REQUEST_TIMEOUT_MS = 10_000;

interface ReleaseAsset {
  readonly name?: unknown;
  readonly browser_download_url?: unknown;
}

/** GETs a URL as text, authenticating when a token is available and the host is api.github.com.
 * Rejects on any non-200 response, timeout, or transport error. */
function httpsGetText(url: string, token: string | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const headers: Record<string, string> = {
      "User-Agent": "ProtocolCanary-Action",
      Accept: "application/vnd.github+json",
    };
    if (token !== undefined && hostname === "api.github.com") {
      headers.Authorization = `Bearer ${token}`;
    }

    const request = https.get(url, { headers, timeout: CHECKSUM_REQUEST_TIMEOUT_MS }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GitHub returned status ${String(response.statusCode)} for ${url}`));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve(body);
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`timed out fetching ${url}`));
    });
    request.on("error", reject);
  });
}

/** Parses a `sha256sum`-style manifest (`<hex digest>  <filename>` lines,
 * with `*` binary-mode markers and `#` comments tolerated) into a map of
 * file base name to lower-case hex digest. */
function parseChecksumManifest(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    const digest = match?.[1];
    const file = match?.[2];
    if (digest === undefined || file === undefined) {
      continue;
    }
    entries.set(path.basename(file.trim()), digest.toLowerCase());
  }
  return entries;
}

/**
 * Looks up the checksum manifest Protocol-Canary publishes alongside a
 * release, if any. Returns `undefined` — never throws — when no release,
 * no checksum asset, or no parseable manifest is available, so callers can
 * fall back to commit/tag pinning exactly as before.
 */
async function lookupPublishedChecksums(version: string, explicitToken?: string): Promise<Map<string, string> | undefined> {
  const token = resolveGithubToken(explicitToken);
  try {
    const releaseBody = await httpsGetText(`${CANARY_API_REPO_URL}/releases/tags/v${version}`, token);
    const parsed = JSON.parse(releaseBody) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const assets = (parsed as { assets?: unknown }).assets;
    if (!Array.isArray(assets)) {
      return undefined;
    }
    const checksumAsset = (assets as ReleaseAsset[]).find(
      (asset) =>
        typeof asset.name === "string" &&
        CHECKSUM_ASSET_PATTERN.test(asset.name) &&
        typeof asset.browser_download_url === "string",
    );
    if (checksumAsset === undefined) {
      return undefined;
    }
    const manifest = await httpsGetText(checksumAsset.browser_download_url as string, token);
    const entries = parseChecksumManifest(manifest);
    return entries.size > 0 ? entries : undefined;
  } catch (error) {
    core.debug(`Could not look up a published checksum for Protocol-Canary ${version}: ${String(error)}`);
    return undefined;
  }
}

/** Chooses the manifest entry that corresponds to the binary this runner
 * will execute, preferring an exact file-name match and falling back to a
 * platform match when the manifest names per-target artifacts. */
function selectExpectedChecksum(entries: Map<string, string>, binary: string): string | undefined {
  const exact = entries.get(binary);
  if (exact !== undefined) {
    return exact;
  }
  const candidates = [...entries.entries()].filter(([name]) => name.includes("stellar-canary"));
  const platformAndArch = candidates.find(
    ([name]) => name.includes(process.platform) && name.includes(process.arch),
  );
  if (platformAndArch !== undefined) {
    return platformAndArch[1];
  }
  const platformOnly = candidates.find(([name]) => name.includes(process.platform));
  if (platformOnly !== undefined) {
    return platformOnly[1];
  }
  const only = candidates[0];
  return candidates.length === 1 && only !== undefined ? only[1] : undefined;
}

/** The `GITHUB_TOKEN` value used to authenticate the GitHub REST calls made
 * during installation, normalized the same way as the checksum lookup: a
 * blank or whitespace-only value counts as "no token". */
function installApiToken(): string | undefined {
  const candidate = (process.env.GITHUB_TOKEN ?? "").trim();
  return candidate === "" ? undefined : candidate;
}

/** Fetches the asset list of the Protocol-Canary GitHub release for a bare
 * version. Rejects on a non-200 response, malformed JSON, or an unexpected
 * shape; callers decide how to degrade. */
async function fetchReleaseAssets(version: string): Promise<ReleaseAsset[]> {
  const releaseBody = await httpsGetText(`${CANARY_API_REPO_URL}/releases/tags/v${version}`, installApiToken());
  const parsed = JSON.parse(releaseBody) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`unexpected release response shape for v${version}`);
  }
  const assets = (parsed as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) {
    throw new Error(`release v${version} carries no asset list`);
  }
  return assets as ReleaseAsset[];
}

/** Finds the prebuilt archive asset for a target triple in a release's asset
 * list: the canonical `stellar-canary-${version}-${target}.tar.gz` name
 * first, then any `stellar-canary-`-prefixed archive that embeds the triple
 * (release tooling occasionally emits `.zip` for Windows). */
function findPrebuiltAsset(assets: ReleaseAsset[], version: string, triple: string): ReleaseAsset | undefined {
  const canonical = prebuiltAssetName(version, triple);
  const isDownloadable = (asset: ReleaseAsset): boolean =>
    typeof asset.name === "string" && typeof asset.browser_download_url === "string";
  const exact = assets.find((asset) => isDownloadable(asset) && asset.name === canonical);
  if (exact !== undefined) {
    return exact;
  }
  return assets.find(
    (asset) =>
      isDownloadable(asset) &&
      typeof asset.name === "string" &&
      asset.name.startsWith(`stellar-canary-${version}-`) &&
      asset.name.includes(triple) &&
      (asset.name.endsWith(".tar.gz") || asset.name.endsWith(".zip")),
  );
}

/** Hashes a file with SHA-256, streaming so a large binary never has to be
 * read into memory all at once. Exported for the Provenance & Trust summary
 * section (issue #373), which reports the digest of the binary this run
 * actually executed; decision D-07 bounds what that digest may be claimed
 * to prove (data integrity, not authorship). */
export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

/**
 * Verifies an installed or cached binary against the checksum published with
 * its release, when one exists. When Protocol-Canary has not published a
 * checksum (or none applies to this platform) this degrades to a debug log
 * and the existing commit/tag pinning stands — see SECURITY.md. A mismatch
 * always throws, so a tampered binary is never trusted.
 *
 * With `strictIntegrity` (issue #372) the degrades are themselves fatal: the
 * run fails closed whenever integrity cannot be *proven*, not only when it
 * is disproven. Redirected and unencrypted manifest lookups surface through
 * {@link lookupPublishedChecksums} as "no manifest", so the strict branches
 * below also implement the D-11 boundary: no redirect is ever followed.
>
 *
 * The *absence* of a verification opportunity is the fail-closed trigger in
 * strict mode; the presence of a mismatch aborts in both modes. The digest
 * itself surfaces in the job summary through the Provenance & Trust section
 * (issue #373), which hashes the executed binary directly.
 */
async function verifyInstalledBinary(
  binaryPath: string,
  resolved: ResolvedVersion,
  token: string | undefined,
  strictIntegrity: boolean,
): Promise<void> {
  const checksums = await lookupPublishedChecksums(resolved.version, token);
  if (checksums === undefined) {
    if (strictIntegrity) {
      throw new InstallationFailedError(
        `strict-integrity is enabled, but there is no published checksum manifest for ` +
          `Protocol-Canary ${resolved.version} (or its lookup could not complete over an ` +
          "authenticated HTTPS channel). Integrity cannot be proven, so the run fails closed.",
      );
    }
    core.debug(
      `No published checksum manifest for Protocol-Canary ${resolved.version}; ` +
        "relying on commit/tag pinning only (see SECURITY.md).",
    );
    return;
  }
  const expected = selectExpectedChecksum(checksums, binaryName());
  if (expected === undefined) {
    if (strictIntegrity) {
      throw new InstallationFailedError(
        `strict-integrity is enabled, but the published checksum manifest for ` +
          `Protocol-Canary ${resolved.version} has no entry for this platform. ` +
          "Integrity cannot be proven, so the run fails closed.",
      );
    }
    core.debug(
      `Published checksum manifest for Protocol-Canary ${resolved.version} has no entry for this platform; ` +
        "relying on commit/tag pinning only.",
    );
    return;
  }
  const actual = await sha256File(binaryPath);
  if (actual !== expected) {
    throw new InstallationFailedError(
      `Checksum verification failed for stellar-canary ${resolved.version}: expected SHA-256 ${expected}, ` +
        `but the binary at ${binaryPath} hashes to ${actual}. Refusing to use it (see SECURITY.md).`,
    );
  }
  core.info(`Verified stellar-canary ${resolved.version} against the published SHA-256 checksum.`);
}

/**
 * Runs `<binaryPath> version` and extracts the reported version string.
 * This is the single source of truth for every "does an existing or cached
 * binary actually match the request?" decision in the install chain.
 * Returns `undefined` when the binary cannot be executed or exits non-zero,
 * which callers treat as "not usable" and fall through to the next step.
 */
async function getInstalledVersion(binaryPath: string): Promise<string | undefined> {
  try {
    let stdout = "";
    const result = await exec.exec(binaryPath, ["version"], {
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString();
        },
      },
    });
    if (result !== 0) {
      return undefined;
    }
    // "stellar-canary 0.1.0"
    const match = /stellar-canary\s+(\S+)/.exec(stdout);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Looks for an already-installed binary in the cargo bin directory. Only an
 * exact version match counts: a binary reporting any other version returns
 * `undefined` so the caller falls through to the cache/install steps rather
 * than running the wrong Canary.
 */
async function findExisting(resolved: ResolvedVersion): Promise<InstalledCanary | undefined> {
  const candidatePath = path.join(cargoBinDir(), binaryName());
  if (!fs.existsSync(candidatePath)) {
    return undefined;
  }
  const version = await getInstalledVersion(candidatePath);
  if (version === resolved.version) {
    core.info(`Found stellar-canary ${version} already installed at ${candidatePath}.`);
    return { binaryPath: candidatePath, version };
  }
  return undefined;
}

/**
 * Derives the cache key for a resolved version. The immutable commit SHA is
 * preferred over the tag so a re-pointed tag can never alias a cached build
 * produced from a different commit.
 */
function cacheKeyFor(resolved: ResolvedVersion): string {
  const pin = resolved.commitSha ?? resolved.tag;
  return `stellar-canary-${process.platform}-${process.arch}-${pin}`;
}

/**
 * Attempts to restore a previously built binary from the Actions cache.
 * Returns `undefined` — always falling through to a fresh install — when the
 * cache is unavailable, there is no hit, the restored binary's version does
 * not match, or the restore throws. Caching is a pure optimization, so a
 * failure here is never surfaced as an error.
 */
async function restoreFromCache(resolved: ResolvedVersion): Promise<InstalledCanary | undefined> {
  if (!cache.isFeatureAvailable()) {
    return undefined;
  }
  const binaryPath = path.join(cargoBinDir(), binaryName());
  const key = cacheKeyFor(resolved);
  try {
    const hit = await cache.restoreCache([binaryPath], key);
    if (hit === undefined) {
      return undefined;
    }
    const version = await getInstalledVersion(binaryPath);
    if (version !== resolved.version) {
      core.debug(`Cache hit for ${key} did not produce a matching stellar-canary version; ignoring.`);
      return undefined;
    }
    core.info(`Restored stellar-canary ${resolved.version} from cache (key: ${key}).`);
    return { binaryPath, version };
  } catch (error) {
    core.debug(`Cache restore failed, continuing without it: ${String(error)}`);
    return undefined;
  }
}

/**
 * Saves a freshly built `stellar-canary` binary to the Actions cache so a
 * later run pinned to the same commit (or tag) can skip `cargo install`.
 *
 * The cache key comes from {@link cacheKeyFor}, which embeds the platform,
 * architecture and immutable pin. This is strictly a performance
 * optimization and is deliberately silent about failure: every error —
 * including `@actions/cache` throwing when a save conflicts with an existing
 * entry — is swallowed after a `core.debug` log, so a cache outage never
 * turns a successful install into a failed run. Restored binaries are still
 * re-verified by {@link verifyInstalledBinary} in
 * {@link restoreFromCache}'s caller, so a bad cache entry cannot be trusted.
 *
 * No-ops when {@link cache.isFeatureAvailable} reports the cache service is
 * not reachable from this workflow (for example a fork PR without a
 * `GITHUB_TOKEN` with cache access).
 *
 * @param resolved - The version pin the binary was installed for; used to
 * derive the cache key.
 * @param binaryPath - Absolute path to the verified `stellar-canary` binary
 * to store.
 */
async function saveToCache(resolved: ResolvedVersion, binaryPath: string): Promise<void> {
  if (!cache.isFeatureAvailable()) {
    return;
  }
  try {
    await cache.saveCache([binaryPath], cacheKeyFor(resolved));
  } catch (error) {
    // Caching is a pure optimization; correctness never depends on it.
    core.debug(`Cache save failed, ignoring: ${String(error)}`);
  }
}

/** Canonical fixture-pack digest format (`sha256:` + 64 lowercase hex). */
const PACK_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Provenance marker written inside a cached pack directory. */
const PACK_MARKER_FILE = ".stellar-canary-pack.json";

export interface PackMarker {
  readonly protocol: number;
  readonly packDigest: string;
}

/**
 * Deterministic Actions-cache key for a verified fixture pack (#345). The
 * protocol number scopes the key and the canonical digest makes it
 * content-addressed, so a republished or mutated pack can never alias a
 * cached one.
 *
 * @throws {InvalidInputError} When `protocol` is not a non-negative integer
 * or `packDigest` is not a `sha256:<64 lowercase hex>` digest.
 */
export function packCacheKey(protocol: number, packDigest: string): string {
  if (!Number.isInteger(protocol) || protocol < 0) {
    throw new InvalidInputError(
      `Invalid fixture-pack protocol ${String(protocol)}: expected a non-negative integer.`,
    );
  }
  if (!PACK_DIGEST_PATTERN.test(packDigest)) {
    throw new InvalidInputError(
      `Invalid fixture-pack digest ${JSON.stringify(packDigest)}: expected the canonical form ` +
        '"sha256:<64 lowercase hex characters>".',
    );
  }
  return `stellar-canary-pack-${String(protocol)}-${packDigest}`;
}

/** Reads the provenance marker from a restored pack directory, if any. */
function readPackMarker(directory: string): PackMarker | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, PACK_MARKER_FILE), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const marker = parsed as Partial<PackMarker>;
    if (typeof marker.protocol !== "number" || typeof marker.packDigest !== "string") {
      return undefined;
    }
    return { protocol: marker.protocol, packDigest: marker.packDigest };
  } catch {
    return undefined;
  }
}

/** Writes the provenance marker that makes a cached pack self-describing. */
function writePackMarker(directory: string, protocol: number, packDigest: string): void {
  // Deterministic serialization: a fixed key order and no insignificant
  // whitespace, so a cached marker is byte-identical for the same pack.
  fs.writeFileSync(
    path.join(directory, PACK_MARKER_FILE),
    `${JSON.stringify({ protocol, packDigest })}\n`,
    "utf8",
  );
}

/**
 * Attempts to restore a previously verified fixture pack from the Actions
 * cache. Returns `true` only when the restored directory carries a provenance
 * marker matching the requested protocol and digest; a missing marker, a
 * mismatched one, a cache miss, an unavailable cache service, or a restore
 * error all return `false` (and remove a corrupt restored directory) so the
 * caller downloads a fresh, verified pack.
 *
 * Caching is a pure optimization: no failure here is ever surfaced as an
 * error.
 */
export async function restoreVerifiedPack(
  protocol: number,
  packDigest: string,
  directory: string,
): Promise<boolean> {
  const key = packCacheKey(protocol, packDigest);
  if (!cache.isFeatureAvailable()) {
    return false;
  }
  let hit: string | undefined;
  try {
    hit = await cache.restoreCache([directory], key);
  } catch (error) {
    core.debug(`Fixture-pack cache restore failed, continuing without it: ${String(error)}`);
    return false;
  }
  if (hit === undefined) {
    return false;
  }

  const marker = readPackMarker(directory);
  if (marker === undefined || marker.protocol !== protocol || marker.packDigest !== packDigest) {
    core.debug(
      `Cached fixture pack at ${directory} (key: ${key}) failed provenance validation; ` +
        "discarding it and downloading a fresh copy.",
    );
    fs.rmSync(directory, { recursive: true, force: true });
    return false;
  }

  core.info(`Restored verified fixture pack for protocol ${String(protocol)} from cache (key: ${key}).`);
  return true;
}

/**
 * Saves a verified fixture pack directory to the Actions cache, writing the
 * provenance marker first. Failures are swallowed after a `core.debug` log:
 * a cache outage must never fail a run that already has a verified pack.
 */
export async function saveVerifiedPack(
  protocol: number,
  packDigest: string,
  directory: string,
): Promise<void> {
  const key = packCacheKey(protocol, packDigest);
  try {
    writePackMarker(directory, protocol, packDigest);
  } catch (error) {
    core.debug(`Could not write the fixture-pack provenance marker, skipping cache save: ${String(error)}`);
    return;
  }
  if (!cache.isFeatureAvailable()) {
    return;
  }
  try {
    await cache.saveCache([directory], key);
  } catch (error) {
    // A cache save conflict or service outage is not a run failure.
    core.debug(`Fixture-pack cache save failed, ignoring: ${String(error)}`);
  }
}

export type PackCacheOutcome = "cache-hit" | "downloaded";

export interface VerifiedPackRequest {
  /** Protocol version the pack is pinned to. */
  readonly protocol: number;
  /** Canonical `sha256:<64 hex>` digest of the verified pack. */
  readonly packDigest: string;
  /** Directory the caller owns; it is restored into or downloaded into. */
  readonly directory: string;
  /** Downloads, verifies, and extracts the pack into `directory`. */
  readonly download: (directory: string) => Promise<void>;
}

/**
 * Makes a verified fixture pack available in `request.directory`, restoring
 * it from the Actions cache when a valid entry exists and otherwise invoking
 * `request.download` (the checksum/digest-verifying downloader) and saving
 * the result for later runs.
 *
 * A cache hit skips both download and extraction entirely. A cache miss,
 * restore failure, or cached entry whose provenance marker does not match the
 * requested protocol/digest all fall through to a fresh download.
 */
export async function ensureVerifiedPack(request: VerifiedPackRequest): Promise<PackCacheOutcome> {
  if (await restoreVerifiedPack(request.protocol, request.packDigest, request.directory)) {
    return "cache-hit";
  }

  // Start from a clean directory: a restore that was rejected (or a partial
  // one) must not leave stale fixtures mixed into the fresh download.
  fs.rmSync(request.directory, { recursive: true, force: true });
  fs.mkdirSync(request.directory, { recursive: true });
  await request.download(request.directory);
  await saveVerifiedPack(request.protocol, request.packDigest, request.directory);
  return "downloaded";
}

/**
 * Extracts a prebuilt archive into `destDir` with the runner's system `tar`
 * (GNU tar on Linux; bsdtar on macOS and Windows runners, which also handles
 * `.zip`). Throws {@link InstallationFailedError} when `tar` cannot start or
 * exits non-zero.
 */
async function extractPrebuiltArchive(archivePath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  let exitCode: number;
  try {
    exitCode = await exec.exec("tar", ["-xf", archivePath, "-C", destDir], { silent: true, ignoreReturnCode: true });
  } catch (error) {
    throw new InstallationFailedError(
      `Failed to start \`tar\` while extracting the prebuilt Protocol-Canary archive ` +
        `${path.basename(archivePath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (exitCode !== 0) {
    throw new InstallationFailedError(
      `\`tar -xf\` exited with code ${String(exitCode)} while extracting ${archivePath} into ${destDir}.`,
    );
  }
}

interface DiscoveryResult {
  binaryPath?: string;
  errorReason?: string;
}

/**
 * Discovers the target executable inside an extracted directory. Accepts
 * exactly one regular file matching `targetName`. Rejects symlinks,
 * directories, path escapes, missing binaries, and duplicate binaries.
 */
function discoverExtractedBinary(extractDir: string, targetName: string): DiscoveryResult {
  const canonicalExtractDir = path.resolve(extractDir);
  const foundBinaries: string[] = [];
  let hasUnsafeEntry = false;

  function traverse(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      hasUnsafeEntry = true;
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const resolvedPath = path.resolve(fullPath);

      if (!resolvedPath.startsWith(canonicalExtractDir + path.sep) && resolvedPath !== canonicalExtractDir) {
        hasUnsafeEntry = true;
        continue;
      }

      let lstat: fs.Stats;
      try {
        lstat = fs.lstatSync(fullPath);
      } catch {
        hasUnsafeEntry = true;
        continue;
      }

      if (lstat.isSymbolicLink()) {
        hasUnsafeEntry = true;
        continue;
      }

      if (lstat.isDirectory()) {
        if (entry.name === targetName) {
          hasUnsafeEntry = true;
        } else {
          traverse(fullPath);
        }
      } else if (lstat.isFile()) {
        if (entry.name === targetName) {
          foundBinaries.push(fullPath);
        }
      } else if (entry.name === targetName) {
        hasUnsafeEntry = true;
      }
    }
  }

  traverse(extractDir);

  if (hasUnsafeEntry) {
    return {
      errorReason: "contains invalid or unsafe entries (symlinks, directories, or path escapes)",
    };
  }
  if (foundBinaries.length === 0) {
    return {
      errorReason: `contains no ${targetName} executable`,
    };
  }
  if (foundBinaries.length > 1) {
    return {
      errorReason: `contains multiple ${targetName} executables`,
    };
  }

  return { binaryPath: foundBinaries[0] };
}

/**
 * Installs `stellar-canary` from the official prebuilt release asset for this
 * runner's platform/arch (issue #359), which turns startup from a minutes-
 * long `cargo install` compile into a seconds-long download.
 *
 * Returns `undefined` — never failing the run — whenever the prebuilt path
 * is not usable on this runner: an unsupported platform/arch (e.g. armv7), a
 * missing release or asset, no published checksum manifest, or any download,
 * extraction, or version-probe problem. Every such skip is logged so the
 * fallback source build is explainable. The single hard failure is a
 * checksum mismatch: a release asset that hashes wrong is treated as a
 * tampering signal and throws {@link InstallationFailedError} rather than
 * being silently replaced (the same posture {@link verifyInstalledBinary}
 * takes, see SECURITY.md).
 *
 * On success the archive is extracted under {@link toolCacheRoot}, the
 * extracted directory is prepended to PATH with `core.addPath`, and the
 * binary's own reported version must equal the requested one.
 */
export async function installPrebuiltRelease(resolved: ResolvedVersion): Promise<InstalledCanary | undefined> {
  let triple: string;
  try {
    triple = prebuiltTargetTriple(process.platform, process.arch);
  } catch (error) {
    core.debug(`Skipping the prebuilt release install: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  let assets: ReleaseAsset[];
  try {
    assets = await fetchReleaseAssets(resolved.version);
  } catch (error) {
    core.debug(
      `Could not look up prebuilt release assets for Protocol-Canary ${resolved.version}: ${String(error)}`,
    );
    return undefined;
  }

  const binaryAsset = findPrebuiltAsset(assets, resolved.version, triple);
  if (binaryAsset === undefined || typeof binaryAsset.name !== "string" || typeof binaryAsset.browser_download_url !== "string") {
    core.debug(
      `Release v${resolved.version} publishes no prebuilt stellar-canary asset for target ${triple}; ` +
        "falling back to a source install.",
    );
    return undefined;
  }
  const assetName = binaryAsset.name;
  const downloadUrl = binaryAsset.browser_download_url;

  const checksumAsset = assets.find(
    (asset) =>
      typeof asset.name === "string" &&
      CHECKSUM_ASSET_PATTERN.test(asset.name) &&
      typeof asset.browser_download_url === "string",
  );
  if (checksumAsset === undefined) {
    core.warning(
      `The prebuilt release asset ${assetName} has no published checksum manifest; falling back to a ` +
        "source install so commit/tag pinning stays the integrity mechanism (see SECURITY.md).",
    );
    return undefined;
  }
  let expectedChecksum: string | undefined;
  try {
    const manifest = await httpsGetText(checksumAsset.browser_download_url as string, installApiToken());
    expectedChecksum = parseChecksumManifest(manifest).get(assetName);
  } catch (error) {
    core.debug(`Could not fetch the checksum manifest for ${assetName}: ${String(error)}`);
    return undefined;
  }
  if (expectedChecksum === undefined) {
    core.warning(
      `The published checksum manifest for v${resolved.version} has no entry for ${assetName}; ` +
        "falling back to a source install.",
    );
    return undefined;
  }

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "protocolcanary-prebuilt-"));
  const archivePath = path.join(stagingDir, assetName);
  const installDir = path.join(toolCacheRoot(), "stellar-canary", resolved.version, process.arch);
  const parentDir = path.dirname(installDir);
  fs.mkdirSync(parentDir, { recursive: true });
  const extractTmpDir = fs.mkdtempSync(path.join(parentDir, ".tmp-extract-"));

  try {
    try {
      await httpsGetFile(downloadUrl, archivePath, MAX_DOWNLOAD_REDIRECTS);
    } catch (error) {
      core.warning(
        `Failed to download the prebuilt Protocol-Canary asset ${assetName}: ${String(error)}; ` +
          "falling back to a source install.",
      );
      return undefined;
    }

    let actualChecksum: string;
    try {
      actualChecksum = await sha256File(archivePath);
    } catch (error) {
      core.warning(`Could not hash the downloaded asset ${assetName}: ${String(error)}; falling back to a source install.`);
      return undefined;
    }
    if (actualChecksum !== expectedChecksum) {
      throw new InstallationFailedError(
        `Checksum verification failed for the prebuilt ${assetName} of Protocol-Canary ${resolved.version}: ` +
          `expected SHA-256 ${expectedChecksum}, but the download hashes to ${actualChecksum}. ` +
          "Refusing to install it (see SECURITY.md).",
      );
    }

    try {
      await extractPrebuiltArchive(archivePath, extractTmpDir);
    } catch (error) {
      core.warning(
        `Could not extract the prebuilt Protocol-Canary asset ${assetName}: ` +
          `${error instanceof Error ? error.message : String(error)}; falling back to a source install.`,
      );
      return undefined;
    }

    const discovery = discoverExtractedBinary(extractTmpDir, binaryName());
    if (discovery.binaryPath === undefined) {
      core.warning(
        `The extracted prebuilt archive ${assetName} ${discovery.errorReason ?? "is invalid"}; ` +
          "falling back to a source install.",
      );
      return undefined;
    }
    const extracted = discovery.binaryPath;

    if (process.platform !== "win32") {
      try {
        fs.chmodSync(extracted, 0o755);
      } catch {
        core.warning(`Could not set executable permissions on ${extracted}; falling back to a source install.`);
        return undefined;
      }
    }

    const version = await getInstalledVersion(extracted);
    if (version !== resolved.version) {
      core.warning(
        `The prebuilt stellar-canary asset ${assetName} reports version ${String(version)}, but ` +
          `${resolved.version} was requested; falling back to a source install.`,
      );
      return undefined;
    }

    const relativeBinaryPath = path.relative(extractTmpDir, extracted);

    try {
      fs.rmSync(installDir, { recursive: true, force: true });
      fs.renameSync(extractTmpDir, installDir);
    } catch (error) {
      core.warning(
        `Failed to move extracted prebuilt asset into ${installDir}: ` +
          `${error instanceof Error ? error.message : String(error)}; falling back to a source install.`,
      );
      return undefined;
    }

    const finalBinaryPath = path.join(installDir, relativeBinaryPath);
    core.addPath(path.dirname(finalBinaryPath));
    core.info(`Installed stellar-canary ${version} from the prebuilt release asset ${assetName} into ${installDir}.`);
    return { binaryPath: finalBinaryPath, version };
  } finally {
    fs.rmSync(extractTmpDir, { recursive: true, force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Verifies the `cargo` toolchain is on the PATH before attempting a source
 * install. Throws an {@link InstallationFailedError} with remediation
 * guidance (rather than a generic error) when it is missing, so the failure
 * is reported as an install problem the user can act on.
 */
async function ensureCargoAvailable(): Promise<void> {
  try {
    await exec.exec("cargo", ["--version"], { silent: true });
  } catch (error) {
    throw new InstallationFailedError(
      "The `cargo` command was not found on this runner. This Action installs a prebuilt " +
        "Protocol-Canary release binary when one exists for this platform and version, and falls " +
        "back to building from source with `cargo install` otherwise; this run had no usable " +
        "prebuilt asset and no Rust toolchain. " +
        "GitHub-hosted Ubuntu runners include a Rust toolchain by default; on a self-hosted or " +
        "non-Ubuntu runner, install one first (for example with `dtolnay/rust-toolchain`).\n" +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Builds the `cargo install` argument array for the resolved version. */
function buildInstallArgs(resolved: ResolvedVersion): string[] {
  const args = ["install", "--git", CANARY_REPO_URL, "--locked"];
  if (resolved.commitSha !== undefined) {
    args.push("--rev", resolved.commitSha);
  } else {
    core.warning(
      `Could not resolve tag ${resolved.tag} to an immutable commit; installing from the tag directly. ` +
        "This is weaker integrity pinning than usual (see SECURITY.md).",
    );
    args.push("--tag", resolved.tag);
  }
  args.push("canary-cli");
  return args;
}

/** Maps a `runCheck` rejection onto the install-failure error taxonomy. */
function describeInstallFailure(error: unknown, timeoutMs: number, resolved: ResolvedVersion): Error {
  if (error instanceof TimeoutError) {
    if (error.stdout.trim() !== "") {
      printLogBlock("Cargo stdout", error.stdout);
    }
    if (error.stderr.trim() !== "") {
      printLogBlock("Cargo stderr", error.stderr);
    }
    const diagnosticTail = formatSafeDiagnosticTail(error.stderr, 40, 8 * 1024);
    const baseMessage =
      `\`cargo install\` for Protocol-Canary ${resolved.version} timed out after ` +
      `${String(Math.round(timeoutMs / 1000))}s and was terminated. ` +
      "This is usually a stalled network connection or an extremely slow build on the runner. " +
      "Re-run the job, or raise the Action's `timeout-minutes` input if a build of this size " +
      "legitimately needs longer.";
    const message = diagnosticTail !== "" ? `${baseMessage}\n\n${diagnosticTail}` : baseMessage;
    return new InstallationFailedError(message, diagnosticTail !== "" ? diagnosticTail : undefined);
  }
  if (error instanceof CanaryExecutionFailedError) {
    return new InstallationFailedError(
      `Failed to start \`cargo install\` for Protocol-Canary ${resolved.version}: ${error.message}`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Time bound for the `cargo install` process: the Action's own
 * `timeout-minutes` input, floored at one minute so a check-only timeout
 * set below it cannot break installation. `cargo install` clones a git
 * repository and builds it from source, so a hung network fetch or a stuck
 * build must be terminated by this Action's own timeout path (which
 * reports a clear, Canary-specific error) rather than burning runner
 * minutes until GitHub's much longer job-level timeout steps in.
 */
export function cargoInstallTimeoutMs(timeoutMinutes: number): number {
  return Math.max(timeoutMinutes * 60_000, CARGO_INSTALL_TIMEOUT_FLOOR_MS);
}

/**
 * Installs Canary from source with `cargo install --git --locked`, pinned to
 * the resolved commit when available and otherwise to the tag (with a
 * visible warning about the weaker integrity pinning). The process is
 * bounded by `timeoutMs` so a hung clone or build is terminated instead of
 * blocking the job. Throws an {@link InstallationFailedError} on a non-zero
 * exit code, a timeout, or a `cargo` that cannot be started.
 */
async function cargoInstall(resolved: ResolvedVersion, timeoutMs: number): Promise<void> {
  const args = buildInstallArgs(resolved);

  core.info(`Installing stellar-canary ${resolved.version} with: cargo ${args.join(" ")}`);
  // The install is executed through the same bounded runner as
  // `stellar-canary check` so it can never hang indefinitely: the timeout
  // terminates a hung process (SIGTERM, then SIGKILL after the grace
  // period) instead of leaving the job blocked until GitHub's job-level
  // timeout (see issue #65).
  let execution: CheckExecutionResult;
  try {
    execution = await runCheck("cargo", args, timeoutMs);
  } catch (error) {
    throw describeInstallFailure(error, timeoutMs, resolved);
  }
  if (execution.exitCode !== 0) {
    if (execution.stdout.trim() !== "") {
      printLogBlock("Cargo stdout", execution.stdout);
    }
    if (execution.stderr.trim() !== "") {
      printLogBlock("Cargo stderr", execution.stderr);
    }
    const diagnosticTail = formatSafeDiagnosticTail(execution.stderr, 40, 8 * 1024);
    const baseMessage =
      `\`cargo install\` exited with code ${String(execution.exitCode)} while installing ` +
      `Protocol-Canary ${resolved.version}.`;
    const message = diagnosticTail !== "" ? `${baseMessage}\n\n${diagnosticTail}` : baseMessage;
    throw new InstallationFailedError(message, diagnosticTail !== "" ? diagnosticTail : undefined);
  }
}

/**
 * Ensures a `stellar-canary` binary matching `resolved.version` is
 * available, in order: an already-installed matching binary, a cached
 * build, an official prebuilt release asset downloaded and checksum-verified
 * into the tool cache (issue #359), or — only when none of those produced a
 * usable binary — a fresh `cargo install` pinned to the resolved commit
 * (falling back to the tag if the commit could not be resolved). Never
 * silently falls back to a different version.
 *
 * The install step is bounded by `installTimeoutMs` and terminated when it
 * exceeds it.
 *
 * `strictIntegrity` (issue #372, default `false`) makes any inability to
 * prove binary integrity against a published checksum fatal instead of a
 * debug-logged degrade; see {@link verifyInstalledBinary}.
 */
export async function ensureCanaryInstalled(
  resolved: ResolvedVersion,
  installTimeoutMs: number = cargoInstallTimeoutMs(15),
  token?: string,
  strictIntegrity = false,
): Promise<InstalledCanary> {
  const existing = await findExisting(resolved);
  if (existing !== undefined) {
    await verifyInstalledBinary(existing.binaryPath, resolved, token, strictIntegrity);
    return existing;
  }

  const cached = await restoreFromCache(resolved);
  if (cached !== undefined) {
    await verifyInstalledBinary(cached.binaryPath, resolved, token, strictIntegrity);
    return cached;
  }

  const prebuilt = await installPrebuiltRelease(resolved);
  if (prebuilt !== undefined) {
    return prebuilt;
  }

  await ensureCargoAvailable();
  await cargoInstall(resolved, installTimeoutMs);

  const binaryPath = path.join(cargoBinDir(), binaryName());
  const version = await getInstalledVersion(binaryPath);
  if (version === undefined) {
    throw new CanaryNotFoundError(
      `cargo install reported success, but no working stellar-canary binary was found at ${binaryPath}.`,
    );
  }
  if (version !== resolved.version) {
    throw new InstallationFailedError(
      `Installed stellar-canary reports version ${version}, but ${resolved.version} was requested.`,
    );
  }

  await verifyInstalledBinary(binaryPath, resolved, token, strictIntegrity);
  await saveToCache(resolved, binaryPath);
  return { binaryPath, version };
}
