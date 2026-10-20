import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as https from "node:https";
import type { IncomingMessage } from "node:http";
import { githubGetText } from "./github";

import {
  CanaryExecutionFailedError,
  CanaryNotFoundError,
  InstallationFailedError,
  TimeoutError,
} from "./errors";
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

function installRoot(): string {
  const runnerTemp = process.env.RUNNER_TEMP?.trim();
  return path.join(runnerTemp === undefined || runnerTemp === "" ? os.tmpdir() : runnerTemp, "stellar-canary-action");
}

function installedBinaryPath(root = installRoot()): string {
  return path.join(root, "bin", binaryName());
}

function digestSidecarPath(binaryPath: string): string {
  return path.join(path.dirname(binaryPath), "stellar-canary.sha256");
}

function ensureInstallRoot(): string {
  const root = installRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  } catch (error) {
    throw new InstallationFailedError(
      `Could not create the Action-owned Protocol-Canary install root at ${root}: ${String(error)}`,
    );
  }
  return root;
}

function binaryName(): string {
  return process.platform === "win32" ? "stellar-canary.exe" : "stellar-canary";
}

/** Asset names a Protocol-Canary release is expected to use for its
 * checksum manifest (for example `SHA256SUMS` or `checksums.txt`). */
const CHECKSUM_ASSET_PATTERN = /(sha-?256|sha-?512|checksums?|shasums?)/i;

/** Target triples for which prebuilt Protocol-Canary releases are published. */
export const PREBUILT_TARGET_TRIPLES: Readonly<Record<string, string>> = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
};

/** Returns the release target triple for a runner platform/arch pair. */
export function prebuiltTargetTriple(platform: string, arch: string): string {
  const key = `${platform}-${arch}`;
  const triple = PREBUILT_TARGET_TRIPLES[key];
  if (triple !== undefined) {
    return triple;
  }
  const supported = Object.entries(PREBUILT_TARGET_TRIPLES)
    .map(([pair, target]) => `${pair} (${target})`)
    .join(", ");
  throw new InstallationFailedError(
    `Unsupported platform ${key} for prebuilt Protocol-Canary releases: this Action installs ` +
      `prebuilt binaries only for ${supported}.`,
  );
}

/** Name the Protocol-Canary release uses for its prebuilt archive for a
 * target triple: `stellar-canary-${version}-${target}.tar.gz`, with a `.zip`
 * variant accepted for Windows where release tooling commonly emits one. */
function prebuiltAssetName(version: string, triple: string): string {
  return `stellar-canary-${version}-${triple}.tar.gz`;
}

/** Time bound for one prebuilt-asset download request, and the number of
 * redirects GitHub's asset CDN is allowed before the download is abandoned. */
const PREBUILT_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_REDIRECTS = 5;

/** GETs binary content from a URL and writes it to `destPath`, following
 * redirects, with a timeout and error handling suitable for prebuilt asset
 * downloads. */
async function httpsGetFile(
  url: string,
  destPath: string,
  _maxRedirects: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "User-Agent": "ProtocolCanary-Action",
      Accept: "application/octet-stream",
    };
    const request = https.get(url, { headers, timeout: PREBUILT_DOWNLOAD_TIMEOUT_MS }, (response: IncomingMessage) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GitHub returned status ${String(response.statusCode)} for ${url}`));
        return;
      }
      const _received = 0;
      const fileStream = fs.createWriteStream(destPath);
      response.on("data", (chunk: string) => {
        received += chunk.length;
        fileStream.write(chunk);
      });
      response.on("end", () => {
        fileStream.end();
        resolve();
      });
      response.on("error", (error: Error) => {
        fileStream.end();
        reject(error);
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`timed out fetching ${url}`));
    });
    request.on("error", reject);
  });
}

/** Finds the prebuilt archive asset for a target triple in a release's assets. */
function findPrebuiltAsset(
  assets: ReleaseAsset[],
  version: string,
  triple: string,
): ReleaseAsset | undefined {
  const assetName = prebuiltAssetName(version, triple);
  return assets.find(
    (asset) =>
      typeof asset.name === "string" &&
      asset.name === assetName &&
      typeof asset.browser_download_url === "string",
  );
}

/** Downloads and installs a prebuilt Protocol-Canary release asset for the
 * resolved version and target triple. Returns `undefined` when no prebuilt
 * asset is available for this platform, allowing the caller to fall back to
 * a source install.
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
    const manifest = await githubGetText(checksumAsset.browser_download_url as string, resolved.commitSha ?? undefined);
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
  const binaryNameStr = binaryName();
  try {
    await httpsGetFile(downloadUrl, archivePath, MAX_DOWNLOAD_REDIRECTS);
  } catch (error) {
    core.warning(
      `Failed to download the prebuilt release asset ${assetName}: ${String(error)}. ` +
        "Falling back to a source install.",
    );
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return undefined;
  }

  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "protocolcanary-extract-"));
  try {
    // Use tar to extract the archive
    await exec.exec("tar", ["xzf", archivePath, "-C", extractedDir]);
  } catch (error) {
    core.warning(
      `Failed to extract the prebuilt release archive ${assetName}: ${String(error)}. ` +
        "Falling back to a source install.",
    );
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.rmSync(extractedDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return undefined;
  }

  // Find the extracted binary
  const entries = await fs.promises.readdir(extractedDir);
  const binaryFile = entries.find((e) => e === binaryNameStr || e.endsWith(`${binaryNameStr}.exe`));
  if (!binaryFile) {
    core.warning(
      `Could not find the stellar-canary binary in the extracted prebuilt archive. ` +
        "Falling back to a source install.",
    );
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.rmSync(extractedDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return undefined;
  }

  const binaryPath = path.join(extractedDir, binaryFile);
  const versionFromBinary = await getInstalledVersion(binaryPath);
  if (versionFromBinary !== resolved.version) {
    core.warning(
      `The prebuilt stellar-canary reports version ${versionFromBinary}, but ${resolved.version} was requested. ` +
        "Falling back to a source install.",
    );
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.rmSync(extractedDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return undefined;
  }

  // Verify checksum
  const actualDigest = await sha256File(binaryPath);
  if (actualDigest !== expectedChecksum) {
    core.warning(
      `Checksum verification failed for the prebuilt stellar-canary ${assetName}: expected ${expectedChecksum}, ` +
        `but got ${actualDigest}. Falling back to a source install.`,
    );
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.rmSync(extractedDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return undefined;
  }

  // Install the verified binary into the action-owned install root
  const root = ensureInstallRoot();
  const targetBinaryPath = installedBinaryPath(root);
  try {
    fs.copyFileSync(binaryPath, targetBinaryPath);
    // Write the SHA-256 sidecar
    const digestSidecarPathStr = digestSidecarPath(targetBinaryPath);
    try {
      await sha256File(targetBinaryPath);
      // Note: we already have the digest from the check above; re-hash for the sidecar
      const d = await sha256File(targetBinaryPath);
      fs.writeFileSync(digestSidecarPathStr, `${d}\n`, { mode: 0o600 });
    } catch {
      /* sidecar write failure does not invalidate the install */
    }
  } catch (error) {
    core.warning(
      `Failed to copy the prebuilt binary to the action-owned install root: ${String(error)}. ` +
        "Falling back to a source install.",
    );
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.rmSync(extractedDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return undefined;
  }

  // Clean up temp files
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(extractedDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const installedVersion = await getInstalledVersion(targetBinaryPath);
  if (installedVersion === undefined) {
    core.warning(
      "Prebuilt binary installed but version could not be read back. " +
        "Falling back to a source install.",
    );
    try {
      fs.rmSync(targetBinaryPath, { force: true });
      fs.rmSync(digestSidecarPath(targetBinaryPath), { force: true });
    } catch {
      /* ignore */
    }
    return undefined;
  }

  core.info(`Installed stellar-canary ${installedVersion} from prebuilt release asset.`);
  return { binaryPath: targetBinaryPath, version: installedVersion };
}

/** Fetches the assets page for a given Protocol-Canary release version. */
async function fetchReleaseAssets(version: string): Promise<ReleaseAsset[]> {
  const releaseBody = await githubGetText(`${CANARY_API_REPO_URL}/releases/tags/v${version}`);
  const parsed = JSON.parse(releaseBody) as unknown;
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as unknown).assets)) {
    throw new Error("unexpected response shape from GitHub API");
  }
  return (parsed as unknown).assets as ReleaseAsset[];
}

interface ReleaseAsset {
  readonly name?: unknown;
  readonly browser_download_url?: unknown;
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
async function lookupPublishedChecksums(version: string): Promise<Map<string, string> | undefined> {
  const token = (process.env.GITHUB_TOKEN ?? "").trim() === "" ? undefined : process.env.GITHUB_TOKEN?.trim();
  try {
    const releaseBody = await githubGetText(`${CANARY_API_REPO_URL}/releases/tags/v${version}`, token);
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
    const manifest = await githubGetText(checksumAsset.browser_download_url as string, token);
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

/** Hashes a file with SHA-256, streaming so a large binary never has to be
 * read into memory all at once. */
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
 */
async function verifyInstalledBinary(
  binaryPath: string,
  resolved: ResolvedVersion,
  githubToken?: string,
  strictIntegrity: boolean = false,
): Promise<void> {
  const checksums = await lookupPublishedChecksums(resolved.version, githubToken);
  if (checksums === undefined) {
    if (strictIntegrity) {
      throw new InstallationFailedError(
        `No published checksum manifest for Protocol-Canary ${resolved.version}; ` +
          "strict integrity mode enabled and no checksums were published.",
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
  const binaryPath = installedBinaryPath();
  const sidecarPath = digestSidecarPath(binaryPath);
  const key = cacheKeyFor(resolved);
  try {
    const hit = await cache.restoreCache([binaryPath, sidecarPath], key);
    if (hit === undefined) {
      return undefined;
    }
    let expectedDigest = "<missing>";
    try {
      expectedDigest = fs.readFileSync(sidecarPath, "utf8").trim() || "<empty>";
    } catch {
      // A pre-sidecar cache entry is not trusted.
    }
    let actualDigest = "<unavailable>";
    try {
      actualDigest = await sha256File(binaryPath);
    } catch {
      // Report the missing/unreadable binary as a cache integrity failure.
    }
    if (!/^[0-9a-fA-F]{64}$/.test(expectedDigest) || actualDigest !== expectedDigest.toLowerCase()) {
      core.warning(
        `Discarding cached stellar-canary because its SHA-256 does not match the install-time digest ` +
          `(sidecar: ${expectedDigest}; binary: ${actualDigest}); installing a fresh copy.`,
      );
      fs.rmSync(binaryPath, { force: true });
      fs.rmSync(sidecarPath, { force: true });
      return undefined;
    }
    const version = await getInstalledVersion(binaryPath);
    if (version !== resolved.version) {
      core.debug(`Cache hit for ${key} did not produce a matching stellar-canary version; ignoring.`);
      fs.rmSync(binaryPath, { force: true });
      fs.rmSync(sidecarPath, { force: true });
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
    await cache.saveCache([binaryPath, digestSidecarPath(binaryPath)], cacheKeyFor(resolved));
  } catch (error) {
    // Caching is a pure optimization; correctness never depends on it.
    core.debug(`Cache save failed, ignoring: ${String(error)}`);
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
      "The `cargo` command was not found on this runner. Protocol-Canary does not yet publish " +
        "prebuilt release binaries, so this Action installs it from source with `cargo install`. " +
        "GitHub-hosted Ubuntu runners include a Rust toolchain by default; on a self-hosted or " +
        "non-Ubuntu runner, install one first (for example with `dtolnay/rust-toolchain`).\n" +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Builds the `cargo install` argument array for the resolved version. */
function buildInstallArgs(resolved: ResolvedVersion, root: string): string[] {
  const args = ["install", "--git", CANARY_REPO_URL, "--locked", "--root", root];
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
    return new InstallationFailedError(
      `\`cargo install\` for Protocol-Canary ${resolved.version} timed out after ` +
        `${String(Math.round(timeoutMs / 1000))}s and was terminated. ` +
        "This is usually a stalled network connection or an extremely slow build on the runner. " +
        "Re-run the job, or raise the Action's `timeout-minutes` input if a build of this size " +
        "legitimately needs longer.",
    );
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
async function cargoInstall(resolved: ResolvedVersion, timeoutMs: number, root: string): Promise<void> {
  const args = buildInstallArgs(resolved, root);

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
    throw new InstallationFailedError(
      `\`cargo install\` exited with code ${String(execution.exitCode)} while installing ` +
        `Protocol-Canary ${resolved.version}.`,
    );
  }
}

/**
 * Ensures a `stellar-canary` binary matching `resolved.version` is
 * available, in order: a digest-verified cached build or a fresh
 * `cargo install` into an Action-owned runner-temp directory. Never trusts
 * the shared Cargo bin directory or silently falls back to a different version.
 *
 * The install step is bounded by `installTimeoutMs` and terminated when it
 * exceeds it.
 */
export async function ensureCanaryInstalled(
  resolved: ResolvedVersion,
  installTimeoutMs: number = cargoInstallTimeoutMs(15),
  githubToken?: string,
  strictIntegrity: boolean = false,
): Promise<InstalledCanary> {
  const root = ensureInstallRoot();

  const cached = await restoreFromCache(resolved);
  if (cached !== undefined) {
    await verifyInstalledBinary(cached.binaryPath, resolved, githubToken, strictIntegrity);
    return cached;
  }

  const prebuilt = await installPrebuiltRelease(resolved);
  if (prebuilt !== undefined) {
    return prebuilt;
  }

  await ensureCargoAvailable();
  await cargoInstall(resolved, installTimeoutMs, root);

  const binaryPath = installedBinaryPath(root);
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

  await verifyInstalledBinary(binaryPath, resolved, githubToken, strictIntegrity);
  const digest = await sha256File(binaryPath);
  try {
    fs.writeFileSync(digestSidecarPath(binaryPath), `${digest}\n`, { mode: 0o600 });
  } catch (error) {
    throw new InstallationFailedError(
      `Could not write the install-time SHA-256 sidecar at ${digestSidecarPath(binaryPath)}: ${String(error)}`,
    );
  }
  await saveToCache(resolved, binaryPath);
  return { binaryPath, version };
}
