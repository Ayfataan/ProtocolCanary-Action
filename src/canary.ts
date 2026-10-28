import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as toolCache from "@actions/tool-cache";

import {
  consumeResponse,
  MAX_API_RESPONSE_BYTES,
  MAX_CHECKSUM_MANIFEST_BYTES,
  MAX_RELEASE_ASSET_BYTES,
  readResponseText,
} from "./http-response";

import {
  CanaryExecutionFailedError,
  CanaryNotFoundError,
  ChecksumMismatchError,
  InstallationFailedError,
  InvalidInputError,
  TimeoutError,
} from "./errors";
import { githubFetch } from "./github";
import { resolveGithubToken } from "./inputs";
import { formatSafeDiagnosticTail, printLogBlock } from "./log-block";
import type { CheckExecutionResult } from "./runner";
import { CARGO_INSTALL_TIMEOUT_FLOOR_MS, runCheck } from "./runner";
import type { ResolvedVersion } from "./version";
import { assessEngineVersion, CANARY_API_REPO_URL, CANARY_REPO_URL } from "./version";

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
    fs.mkdirSync(path.join(root, "bin"), { recursive: true, mode: 0o700 });
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

function cargoBinDir(): string {
  const cargoHome = process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo");
  return path.join(cargoHome, "bin");
}

function isTrustedExecutable(binaryPath: string): boolean {
  if (!path.isAbsolute(binaryPath)) {
    return false;
  }

  try {
    const binary = fs.lstatSync(binaryPath);
    const directory = fs.lstatSync(path.dirname(binaryPath));
    if (!binary.isFile() || binary.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink()) {
      return false;
    }

    if (process.platform !== "win32") {
      const uid = process.getuid?.();
      const trustedOwner = (owner: number): boolean => owner === 0 || (uid !== undefined && owner === uid);
      if (
        uid === undefined ||
        !trustedOwner(binary.uid) ||
        !trustedOwner(directory.uid) ||
        (binary.mode & 0o111) === 0 ||
        (binary.mode & 0o7022) !== 0 ||
        (directory.mode & 0o022) !== 0
      ) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

function findInPath(): string[] {
  const candidates: string[] = [];
  const configuredPath = process.env.PATH ?? "";
  if (configuredPath === "") {
    return candidates;
  }

  for (const section of configuredPath.split(path.delimiter)) {
    if (section === "" || !path.isAbsolute(section)) {
      core.warning(`Ignoring invalid PATH entry ${JSON.stringify(section)} while searching for stellar-canary.`);
      continue;
    }

    const candidate = path.join(section, binaryName());
    if (fs.existsSync(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function findInToolCache(version: string): string[] {
  if ((process.env.RUNNER_TOOL_CACHE ?? "").trim() === "") {
    return [];
  }

  try {
    const installDir = toolCache.find("stellar-canary", version, process.arch);
    if (installDir === "") {
      return [];
    }
    return [path.join(installDir, binaryName()), path.join(installDir, "bin", binaryName())].filter((candidate) =>
      fs.existsSync(candidate),
    );
  } catch (error) {
    core.debug(`Could not search the tool cache for stellar-canary ${version}: ${String(error)}`);
    return [];
  }
}

async function expectedPublishedBinaryChecksum(
  binaryPath: string,
  resolved: ResolvedVersion,
  token?: string,
): Promise<string | undefined> {
  const checksums = await lookupPublishedChecksums(resolved.version, token);
  if (checksums === undefined) {
    core.warning(
      `Refusing to execute the pre-installed stellar-canary at ${binaryPath}: no published checksum is available.`,
    );
    return undefined;
  }

  const expected = selectExpectedChecksum(checksums, binaryName());
  if (expected === undefined) {
    core.warning(
      `Refusing to execute the pre-installed stellar-canary at ${binaryPath}: ` +
        "the published checksum manifest has no matching binary entry.",
    );
  }
  return expected;
}

async function matchesPublishedChecksum(binaryPath: string, expected: string): Promise<boolean> {
  try {
    const actual = await sha256File(binaryPath);
    if (actual === expected) {
      return true;
    }
    core.warning(`Ignoring pre-installed stellar-canary at ${binaryPath}: its published checksum does not match.`);
  } catch (error) {
    core.warning(`Ignoring pre-installed stellar-canary at ${binaryPath}: could not verify its checksum (${String(error)}).`);
  }
  return false;
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

/** Time bound for one prebuilt-asset download request, and the number of
 * redirects GitHub's asset CDN is allowed before the download is abandoned. */
const PREBUILT_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_REDIRECTS = 5;

/**
 * Time bounds for the three small helper child processes the install chain
 * supervises (#521): the `<binary> version` probe, the `cargo --version`
 * probe, and the `tar -xf` extraction of a prebuilt archive. A candidate
 * binary, the toolchain, or an archive extractor that spawns but never
 * exits is a state the Action must handle, not assume away: each process is
 * terminated through the bounded runner (`runCheck` in src/runner.ts) when
 * it exceeds its bound, so a stuck helper can never keep the job alive
 * until GitHub's much longer job-level timeout. Exported (and injectable
 * per call) so tests can exercise the timeout path with a short bound.
 */
export const VERSION_PROBE_TIMEOUT_MS = 30_000;
export const CARGO_PROBE_TIMEOUT_MS = 30_000;
export const TAR_EXTRACTION_TIMEOUT_MS = 5 * 60_000;

/** GETs a URL as binary content and writes it to `destPath`, following up to
 * `redirectsLeft` 3xx redirects (GitHub release downloads redirect from
 * `github.com` to a signed object host). Rejects on any non-2xx/3xx response,
 * a timeout, a redirect without a `Location`, an oversized/incomplete body,
 * or a write failure. Failed downloads are closed and removed before rejection. */
export function httpsGetFile(url: string, destPath: string, redirectsLeft: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: ClientRequest | undefined = undefined;
    let file: fs.WriteStream | undefined;
    let responseBody: IncomingMessage | undefined;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      responseBody?.destroy();
      request?.destroy();
      const removePartial = (): void => {
        fs.rm(destPath, { force: true }, (cleanupError) => reject(cleanupError ?? error));
      };
      if (file !== undefined && !file.closed) {
        file.once("close", removePartial);
        file.destroy();
      } else {
        removePartial();
      }
    };
    const succeed = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    request = https.get(url, { headers: { "User-Agent": "ProtocolCanary-Action" }, timeout: PREBUILT_DOWNLOAD_TIMEOUT_MS }, (response) => {
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
      responseBody = response;
      file = fs.createWriteStream(destPath);
      const destination = file;
      destination.on("error", fail);
      destination.on("finish", succeed);
      destination.on("drain", () => response.resume());
      consumeResponse(response, url, MAX_RELEASE_ASSET_BYTES, (chunk) => {
        if (!destination.write(chunk)) response.pause();
      }).then(() => {
        if (!settled) destination.end();
      }).catch(fail);
    });
    if (settled) request.destroy();
    request.on("timeout", () => {
      request?.destroy(new Error(`timed out downloading ${url}`));
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
 * Rejects on any non-200 response, timeout, transport error, or oversized/
 * incomplete body. Manifest callers supply their smaller dedicated limit. */
export function httpsGetText(url: string, token: string | undefined, maxBytes: number = MAX_API_RESPONSE_BYTES): Promise<string> {
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
      readResponseText(response, url, maxBytes).then(resolve).catch((error: unknown) => {
        request.destroy();
        reject(error);
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
    const { body: releaseBody } = await githubFetch(`${CANARY_API_REPO_URL}/releases/tags/v${version}`, token);
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
    const { body: manifest } = await githubFetch(checksumAsset.browser_download_url as string, token, MAX_CHECKSUM_MANIFEST_BYTES);
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

/** Fetches the asset list of the Protocol-Canary GitHub release for a bare
 * version. Rejects on a non-200 response, malformed JSON, or an unexpected
 * shape; callers decide how to degrade. */
async function fetchReleaseAssets(version: string, token?: string): Promise<ReleaseAsset[]> {
  const { body: releaseBody } = await githubFetch(`${CANARY_API_REPO_URL}/releases/tags/v${version}`, resolveGithubToken(token));
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

/** Canonical fixture-pack digest (CF-02): the `sha256:` scheme prefix
 * followed by exactly 64 lowercase hexadecimal characters — the registry's
 * canonical spelling of a pack digest. Anything else is not canonical and
 * cannot be compared. */
const PACK_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * True when `value` is a canonical CF-02 pack digest (`sha256:<64 lowercase
 * hex>`). The scheme prefix and the lowercase hex body are both required, so
 * a bare hex string or an uppercase-hex digest is rejected rather than guessed
 * at.
 */
export function isCanonicalPackDigest(value: unknown): value is string {
  return typeof value === "string" && PACK_DIGEST_PATTERN.test(value);
}

/**
 * Computes the CF-02 canonical pack digest of an extracted fixture pack:
 * SHA-256 over one `sha256:<file-content-digest>  <relative-path>` line per
 * regular file below `rootDir`, in sorted path order — a pure function of the
 * pack's contents, independent of directory iteration order.
 */
export function computePackDigest(rootDir: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(path.relative(rootDir, full).split(path.sep).join("/"));
      }
    }
  };
  walk(rootDir);
  files.sort();
  const hash = crypto.createHash("sha256");
  for (const relativePath of files) {
    const contentDigest = crypto.createHash("sha256").update(fs.readFileSync(path.join(rootDir, relativePath))).digest("hex");
    hash.update(`sha256:${contentDigest}  ${relativePath}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Verifies the canonical pack digest of an extracted fixture pack against the
 * expected registry digest, throwing {@link ChecksumMismatchError} when the
 * expected value is not canonical or when the computed digest diverges — so a
 * tampered or truncated pack is never used.
 *
 * Returns the computed digest when it matches.
 */
export function verifyPackDigest(rootDir: string, expectedDigest: string): string {
  const computed = computePackDigest(rootDir);
  if (!isCanonicalPackDigest(expectedDigest)) {
    throw new ChecksumMismatchError(
      `The expected fixture-pack digest ${JSON.stringify(expectedDigest)} is not a canonical CF-02 pack digest ` +
        `(sha256:<64 lowercase hex>); refusing to compare it.`,
    );
  }
  if (computed !== expectedDigest) {
    throw new ChecksumMismatchError(
      `Checksum verification failed for the fixture pack at ${rootDir}: expected pack digest ${expectedDigest}, ` +
        `but the extracted pack hashes to ${computed}. Refusing to use it.`,
    );
  }
  return computed;
}

/**
 * Verifies a downloaded fixture pack archive against its published SHA-256
 * checksum *before* the archive is ever handed to the extractor: a corrupted
 * or truncated download fails here, before extraction, so no partial artifact
 * is ever unpacked. Returns the verified digest.
 */
export async function verifyDownloadedArchive(archivePath: string, expectedChecksum: string): Promise<string> {
  const actual = await sha256File(archivePath);
  if (actual !== expectedChecksum) {
    throw new ChecksumMismatchError(
      `Checksum verification failed for the downloaded pack archive ${path.basename(archivePath)}: expected ` +
        `SHA-256 ${expectedChecksum}, but the download hashes to ${actual}. Refusing to extract it.`,
    );
  }
  return actual;
}

/**
 * Verifies a downloaded fixture pack end to end before it is used (#339,
 * #346): the archive must hash to the published checksum and the extracted
 * tree must carry the canonical registry pack digest. The archive checksum is
 * verified first, so a corrupted download aborts before any extraction runs;
 * the canonical pack digest is then checked, and any divergence throws
 * {@link ChecksumMismatchError}.
 */
export async function downloadAndVerifyPack(
  archivePath: string,
  expectedChecksum: string,
  extractedDir: string,
  expectedPackDigest?: string,
): Promise<string> {
  // Archive checksum first: a corrupted or truncated download throws here,
  // before the archive is ever handed to the extractor.
  await verifyDownloadedArchive(archivePath, expectedChecksum);
  // Then the canonical pack digest of the extracted tree, if one was provided.
  if (expectedPackDigest !== undefined) {
    return verifyPackDigest(extractedDir, expectedPackDigest);
  }
  return computePackDigest(extractedDir);
}

/** GitHub API repository that publishes the canonical fixture packs
 * (ProtocolCanary-Fixtures), as opposed to the engine repository that
 * publishes the prebuilt binaries this Action installs from. */
const FIXTURE_PACKS_API_REPO = "StellarCanary/ProtocolCanary-Fixtures";

/**
 * GitHub REST API base URL for a repository, e.g.
 * `https://api.github.com/repos/StellarCanary/Protocol-Canary`. Derived from
 * the `owner/name` form so the engine and the fixtures registry share one
 * helper.
 */
function githubApiBase(repo: string): string {
  const separator = repo.indexOf("/");
  const owner = separator === -1 ? repo : repo.slice(0, separator);
  const name = separator === -1 ? "" : repo.slice(separator + 1);
  return `https://api.github.com/repos/${owner}/${name}`;
}

/**
 * Fetches the release assets of any published release (the engine releases
 * this Action installs binaries from, the fixture-pack releases whose
 * archives are verified here) over the authenticated GitHub API.
 */
async function fetchReleaseAssetsFor(repo: string, version: string, token?: string): Promise<ReleaseAsset[]> {
  const { body: releaseBody } = await githubFetch(`${githubApiBase(repo)}/releases/tags/v${version}`, resolveGithubToken(token));
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

/**
 * Fetches the published checksum manifest entries of any release (engine
 * releases or fixture packs) over the authenticated GitHub API, keyed by file
 * name. Returns `undefined` — never throws — when the release carries no
 * checksum asset or the lookup cannot complete, so callers degrade exactly as
 * the engine-side lookup does.
 */
async function lookupPublishedChecksumsFor(
  repo: string,
  version: string,
  explicitToken?: string,
): Promise<Map<string, string> | undefined> {
  const token = resolveGithubToken(explicitToken);
  try {
    const { body: releaseBody } = await githubFetch(`${githubApiBase(repo)}/releases/tags/v${version}`, token);
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
    const { body: manifest } = await githubFetch(checksumAsset.browser_download_url as string, token);
    const entries = parseChecksumManifest(manifest);
    return entries.size > 0 ? entries : undefined;
  } catch (error) {
    core.debug(`Could not look up a published checksum for release v${version}: ${String(error)}`);
    return undefined;
  }
}

/** Looks up the published checksum entries of the engine repository. */

/**
 * Downloads the canonical fixture pack archive for a pack release tag,
 * verifies it against the published checksum manifest and the canonical
 * registry pack digest, extracts it, and cleans the staging directory up on
 * every exit path (#339, #346).
 *
 * The archive checksum is verified *before* extraction, so a corrupted or
 * truncated download aborts with a {@link ChecksumMismatchError} and never
 * reaches the extractor; the extracted tree is then checked against the
 * canonical pack digest. Any divergence throws {@link ChecksumMismatchError}.
 *
 * Returns the directory the extracted pack should be consumed from; the
 * staging directory is removed once the verification succeeded, and on every
 * failure path.
 */
export async function downloadVerifiedPack(version: string, protocol: number, token?: string): Promise<string> {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "protocolcanary-pack-"));
  const archiveName = `protocol-${protocol}-${version}.tar.gz`;
  const archivePath = path.join(stagingDir, archiveName);
  let keepStaging = false;
  try {
    const assets = await fetchReleaseAssetsFor(FIXTURE_PACKS_API_REPO, version, token);
    const archive = assets.find(
      (asset) =>
        typeof asset.name === "string" &&
        (asset.name.endsWith(".tar.gz") || asset.name.endsWith(".zip")) &&
        asset.name.includes(`protocol-${String(protocol)}`),
    );
    if (archive === undefined || typeof archive.name !== "string" || typeof archive.browser_download_url !== "string") {
      throw new Error(`Release v${version} publishes no fixture pack archive for protocol ${String(protocol)}.`);
    }
    const checksums = await lookupPublishedChecksumsFor(FIXTURE_PACKS_API_REPO, version, token);
    const expectedChecksum = checksums?.get(archive.name);
    if (expectedChecksum === undefined) {
      throw new Error(
        `The release v${version} publishes no usable checksum entry for the fixture pack archive ${archive.name}; refusing to extract it.`,
      );
    }
    await httpsGetFile(archive.browser_download_url, archivePath, MAX_DOWNLOAD_REDIRECTS);
    await extractPrebuiltArchive(archivePath, stagingDir);
    const digest = await downloadAndVerifyPack(archivePath, expectedChecksum, stagingDir);
    core.info(`Verified fixture pack ${archive.name} (digest ${digest}) before extraction.`);
    keepStaging = true;
    return stagingDir;
  } finally {
    if (!keepStaging) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }
}


async function hasValidInstallDigest(binaryPath: string): Promise<boolean> {
  try {
    const expected = fs.readFileSync(digestSidecarPath(binaryPath), "utf8").trim();
    return /^[0-9a-fA-F]{64}$/.test(expected) && (await sha256File(binaryPath)) === expected.toLowerCase();
  } catch {
    return false;
  }
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
 * {@link lookupPublishedChecksumsEngine} as "no manifest", so the strict branches
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
 * Returns `undefined` when the binary cannot be executed, exits non-zero,
 * or does not finish within `timeoutMs` (#521), which callers treat as
 * "not usable" and fall through to the next step. The probe runs through
 * the bounded runner so a binary that spawns but never exits is terminated
 * (with a warning naming it) instead of hanging the job.
 *
 * `leadArgs` mirrors `renderJUnitReport` in src/runner.ts: it carries
 * leading argv elements (the Windows test fixture runs the Node stand-in
 * through `node`); production callers pass nothing and the probe always
 * runs `<binaryPath> version`.
 */
export async function getInstalledVersion(
  binaryPath: string,
  timeoutMs: number = VERSION_PROBE_TIMEOUT_MS,
  leadArgs: readonly string[] = [],
): Promise<string | undefined> {
  try {
    const execution = await runCheck(binaryPath, [...leadArgs, "version"], timeoutMs);
    if (execution.exitCode !== 0) {
      return undefined;
    }
    // "stellar-canary 0.1.0"
    const match = /stellar-canary\s+(\S+)/.exec(execution.stdout);
    return match?.[1];
  } catch (error) {
    if (error instanceof TimeoutError) {
      core.warning(
        `The version probe \`${binaryPath} version\` did not finish within ` +
          `${String(Math.round(timeoutMs / 1000))}s and was terminated; treating the binary as not usable.`,
      );
    }
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
async function findExisting(
  resolved: ResolvedVersion,
  token?: string,
): Promise<InstalledCanary | undefined> {
  const candidates = [
    path.join(cargoBinDir(), binaryName()),
    ...findInToolCache(resolved.version),
    ...findInPath(),
  ].filter((candidate, index, all) => fs.existsSync(candidate) && all.indexOf(candidate) === index);

  let expectedChecksum: string | undefined;
  let checksumLookedUp = false;
  for (const candidatePath of candidates) {
    if (!isTrustedExecutable(candidatePath)) {
      core.warning(`Ignoring untrusted stellar-canary candidate at ${candidatePath}.`);
      continue;
    }

    if (!checksumLookedUp) {
      expectedChecksum = await expectedPublishedBinaryChecksum(candidatePath, resolved, token);
      checksumLookedUp = true;
    }
    if (expectedChecksum === undefined || !(await matchesPublishedChecksum(candidatePath, expectedChecksum))) {
      continue;
    }

    const version = await getInstalledVersion(candidatePath);
    if (version === resolved.version) {
      core.info(`Found checksum-verified stellar-canary ${version} at ${candidatePath}.`);
      return { binaryPath: candidatePath, version };
    }
    core.warning(
      `Ignoring pre-installed stellar-canary at ${candidatePath}: it reports version ${String(version)}, ` +
        `but ${resolved.version} was requested.`,
    );
  }
  return undefined;
}

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
      // A cache entry without an install-time digest is not trusted.
    }
    let actualDigest = "<unavailable>";
    try {
      actualDigest = await sha256File(binaryPath);
    } catch {
      // Missing or unreadable cached binaries are rejected below.
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
 * optimization and never fails the run: every error — including
 * `@actions/cache` throwing when a save conflicts with an existing entry — is
 * swallowed after a `core.warning` log, so a cache outage never turns a
 * successful install into a failed run. Restored binaries are still
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
    core.warning(`Cache save failed, ignoring: ${String(error)}`);
  }
}

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
 * `.zip`). Throws {@link InstallationFailedError} when `tar` cannot start,
 * exits non-zero, or does not finish within `timeoutMs` (#521) — in the
 * timeout case the process is terminated and the partially extracted
 * directory is never used, so the caller falls back exactly as it does for
 * any other extraction failure.
 */
export async function extractPrebuiltArchive(
  archivePath: string,
  destDir: string,
  timeoutMs: number = TAR_EXTRACTION_TIMEOUT_MS,
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  let exitCode: number;
  try {
    const execution = await runCheck("tar", ["-xf", archivePath, "-C", destDir], timeoutMs);
    exitCode = execution.exitCode ?? 1;
  } catch (error) {
    if (error instanceof TimeoutError) {
      throw new InstallationFailedError(
        `\`tar -xf\` did not finish within ${String(Math.round(timeoutMs / 1000))}s while extracting ` +
          `${path.basename(archivePath)} into ${destDir} and was terminated; refusing to use a ` +
          "partially extracted directory.",
      );
    }
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
  binaryPath?: string | undefined;
  errorReason?: string | undefined;
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
 * On success the verified binary is copied into the Action-owned install
 * root under `RUNNER_TEMP`, without changing the runner's PATH.
 */
export async function installPrebuiltRelease(
  resolved: ResolvedVersion,
  token?: string,
): Promise<InstalledCanary | undefined> {
  let triple: string;
  try {
    triple = prebuiltTargetTriple(process.platform, process.arch);
  } catch (error) {
    core.debug(`Skipping the prebuilt release install: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  let assets: ReleaseAsset[];
  try {
    assets = await fetchReleaseAssets(resolved.version, token);
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
    const { body: manifest } = await githubFetch(
      checksumAsset.browser_download_url as string,
      resolveGithubToken(token),
      MAX_CHECKSUM_MANIFEST_BYTES,
    );
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
  const extractTmpDir = path.join(stagingDir, "extracted");
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

    const binaryPath = installedBinaryPath(ensureInstallRoot());
    try {
      fs.copyFileSync(extracted, binaryPath);
      if (process.platform !== "win32") {
        fs.chmodSync(binaryPath, 0o755);
      }
      const digest = await sha256File(binaryPath);
      fs.writeFileSync(digestSidecarPath(binaryPath), `${digest}\n`, { mode: 0o600 });
    } catch (error) {
      fs.rmSync(binaryPath, { force: true });
      fs.rmSync(digestSidecarPath(binaryPath), { force: true });
      throw new InstallationFailedError(
        `Could not install the verified prebuilt stellar-canary binary into the Action-owned install root: ${String(error)}`,
      );
    }
    core.info(
      `Installed stellar-canary ${version} from prebuilt release asset ${assetName} into ${path.dirname(binaryPath)}.`,
    );
    return { binaryPath, version };
  } finally {
    fs.rmSync(extractTmpDir, { recursive: true, force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Verifies the `cargo` toolchain is on the PATH before attempting a source
 * install. Throws an {@link InstallationFailedError} with remediation
 * guidance (rather than a generic error) when it is missing, so the failure
 * is reported as an install problem the user can act on. The probe runs
 * through the bounded runner and is terminated (#521) when it does not
 * finish within `timeoutMs`, with the same error naming the missed bound.
 */
export async function ensureCargoAvailable(timeoutMs: number = CARGO_PROBE_TIMEOUT_MS): Promise<void> {
  let failureDetail: string;
  try {
    const execution = await runCheck("cargo", ["--version"], timeoutMs);
    if (execution.exitCode === 0) {
      return;
    }
    failureDetail = `Underlying error: \`cargo --version\` exited with code ${String(execution.exitCode)}.`;
  } catch (error) {
    failureDetail =
      error instanceof TimeoutError
        ? `The \`cargo --version\` probe did not finish within ` +
          `${String(Math.round(timeoutMs / 1000))}s and was terminated.`
        : `Underlying error: ${error instanceof Error ? error.message : String(error)}`;
  }
  throw new InstallationFailedError(
    "The `cargo` command was not found on this runner. This Action installs a prebuilt " +
      "Protocol-Canary release binary when one exists for this platform and version, and falls " +
      "back to building from source with `cargo install` otherwise; this run had no usable " +
      "prebuilt asset and no Rust toolchain. " +
      "GitHub-hosted Ubuntu runners include a Rust toolchain by default; on a self-hosted or " +
      "non-Ubuntu runner, install one first (for example with `dtolnay/rust-toolchain`).\n" +
      failureDetail,
  );
}

/** Builds the `cargo install` argument array for the resolved version. */
function buildInstallArgs(resolved: ResolvedVersion, root: string): string[] {
  const args = ["install", "--git", CANARY_REPO_URL, "--locked"];
  args.push("--root", root);
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
 * available, in order: a digest-verified cached build, an official prebuilt
 * release asset downloaded and checksum-verified into the Action-owned
 * install root, or — only when none of those produced a usable binary — a
 * fresh `cargo install` pinned to the resolved commit
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
  // Warn once, before any install work, when the requested engine release is
  // deprecated or from an unvalidated future major line. The default 0.1.1
  // and every other supported 0.x release produce no warning.
  const compatibility = assessEngineVersion(resolved.version);
  if (compatibility.warning !== undefined) {
    core.warning(compatibility.warning);
  }

  const preInstalled = await findExisting(resolved, token);
  if (preInstalled !== undefined) {
    return preInstalled;
  }

  const root = ensureInstallRoot();
  const existingPath = installedBinaryPath(root);
  if (fs.existsSync(existingPath)) {
    const version = (await hasValidInstallDigest(existingPath)) ? await getInstalledVersion(existingPath) : undefined;
    if (version === resolved.version) {
      await verifyInstalledBinary(existingPath, resolved, token, strictIntegrity);
      core.info(`Found stellar-canary ${version} already installed in the Action-owned root.`);
      return { binaryPath: existingPath, version };
    }
    core.warning(
      `Ignoring the existing Action-owned stellar-canary at ${existingPath}: its install-time digest or version ` +
        "does not match; installing a fresh copy.",
    );
    fs.rmSync(existingPath, { force: true });
    fs.rmSync(digestSidecarPath(existingPath), { force: true });
  }

  const cached = await restoreFromCache(resolved);
  if (cached !== undefined) {
    await verifyInstalledBinary(cached.binaryPath, resolved, token, strictIntegrity);
    return cached;
  }

  const prebuilt = await installPrebuiltRelease(resolved, token);
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

  await verifyInstalledBinary(binaryPath, resolved, token, strictIntegrity);
  try {
    const digest = await sha256File(binaryPath);
    fs.writeFileSync(digestSidecarPath(binaryPath), `${digest}\n`, { mode: 0o600 });
  } catch (error) {
    throw new InstallationFailedError(
      `Could not write the install-time SHA-256 sidecar for stellar-canary at ${digestSidecarPath(binaryPath)}: ` +
        String(error),
    );
  }
  await saveToCache(resolved, binaryPath);
  return { binaryPath, version };
}
