import * as core from "@actions/core";
import * as fs from "node:fs";
import * as path from "node:path";

import { MAX_PASSTHROUGH_NAMES, PASSTHROUGH_NAME_PATTERN, isDeniedEnvName } from "./child-env";
import { ConfigNotFoundError, InvalidInputError } from "./errors";
import type { Surface } from "./output";
import { describeUrlSafely } from "./redact";

/** The `surface` input accepts exactly the engine's three surface names. */
export type SurfaceFilter = Surface;

export interface ActionInputs {
  readonly protocol: number | undefined;
  readonly config: string | undefined;
  /** Directory treated as Canary's project root (#348), resolved to an
   * absolute path against the working directory; defaults to `.` (the
   * workspace itself). Forwarded as `--project-root` only when it differs
   * from the working directory — see {@link parseWorkingDirectory} and
   * `buildCheckArgs` for why the default is deliberately not forwarded. */
  readonly workingDirectory: string;
  readonly network: string | undefined;
  readonly networkPassphrase: string | undefined;
  readonly rpcUrl: string | undefined;
  readonly rpcMaxRetries: number | undefined;
  readonly rpcRetryDelayMs: number | undefined;
  readonly fixturesDir: string;
  /** Run only the fixture with this exact id (`--fixture=<id>`, #458).
   * `undefined` when unset. Requires an engine release whose `check` accepts
   * `--fixture`; see `engineSupportsFixtureSurfaceCacheDir` in runner.ts. */
  readonly fixture: string | undefined;
  /** Run only fixtures of this surface (`--surface=<surface>`, #458):
   * exactly one of the engine's three lower-case surface names. `undefined`
   * when unset. Same engine gate as {@link fixture}. */
  readonly surface: SurfaceFilter | undefined;
  /** Directory for cached fixture results (`--cache-dir=<path>`, #458),
   * forwarded unchanged — the engine resolves a relative path against
   * `--project-root` when one is given, so the Action never resolves it
   * against the workspace. `undefined` when unset. Same engine gate as
   * {@link fixture}. */
  readonly cacheDir: string | undefined;
  readonly version: string;
  readonly uploadReport: boolean;
  readonly annotations: boolean;
  /** Opt in to a best-effort redacted diagnostics bundle. Disabled by
   * default (CF-08 / D-10): such an artifact is readable by anyone who can
   * read the repository, and redaction by pattern is only best effort. */
  readonly diagnostics: boolean;
  readonly timeoutMinutes: number;
  /** Pass `--allow-empty` to engines that support it (0.2.0 and newer). */
  readonly allowEmpty: boolean;
  /** `--rpc-timeout` request timeout in seconds for engines that support it
   * (0.2.0 and newer), 1–600. `undefined` leaves the engine default (10). */
  readonly rpcTimeoutSeconds: number | undefined;
  /** `--max-concurrency` for live RPC/Soroban requests for engines that
   * support it (0.2.0 and newer), 1–64. `undefined` leaves the engine
   * default (4). */
  readonly maxConcurrency: number | undefined;
  /** `--no-cache` for engines that support it (0.2.0 and newer): `true`
   * forwards the flag, `false`/`undefined` leaves the engine's cache alone.
   * `true` conflicts with {@link ActionInputs.liveCacheTtlSeconds}. */
  readonly noCache: boolean | undefined;
  /** `--live-cache-ttl` in seconds for engines that support it (0.2.0 and
   * newer), 1–604800 (7 days). `undefined` leaves the engine default (cached
   * live results are not replayed). Conflicts with a `noCache` of `true`. */
  readonly liveCacheTtlSeconds: number | undefined;
  /** Fail the check when supported engines report warnings. */
  readonly failOnWarning: boolean;
  /** Skip network-dependent fixtures when supported by the engine. */
  readonly offline: boolean;
  /** Release tag of the fixture pack to run against, e.g. `v1.2.0`, kept as
   * written (leading `v` optional). Validated for format only — see
   * {@link parseFixturesPackVersion} for why it is not forwarded yet. */
  readonly fixturesPackVersion: string | undefined;
  /** Protocol version the fixture pack is pinned to, as a positive integer.
   * Validated for format only — see {@link parseFixturesPackProtocol}. */
  readonly fixturesPackProtocol: number | undefined;
  /** Absolute path to a previous JSON report to validate against (#344).
   * The engine's `diff` command is not released, so this is validated for
   * existence, report shape, and target-protocol compatibility only; it is
   * never claimed to have produced a regression verdict. */
  readonly baselineReport: string | undefined;
  /** GitHub token for authenticating read-only API calls (tag and checksum lookups). */
  readonly githubToken: string | undefined;
  /**
   * Exact environment variable names forwarded to `cargo` and the engine in
   * addition to the default allow-list (`engine-env-passthrough`). Empty
   * unless the workflow asks for it; never includes a denied name.
   */
  readonly engineEnvPassthrough: readonly string[];
  /** Opt in to producing an Execution Receipt (#360) and exporting it as a
   * workflow artifact (#362). Parses the documented boolean literals strictly
   * and defaults to `false` when the input is omitted (#361). */
  readonly generateReceipt: boolean;
  /** Duration in days (integer 1 to 90) to retain the uploaded JSON report artifact. */
  readonly reportRetentionDays: number | undefined;
  /** Render the parsed JSON report to JUnit XML through the engine's own
   * `report <file> --format junit` command (#423) and expose the file as the
   * `junit-report-path` output (also included in the artifact upload).
   * Auxiliary: any failure — an engine without the command, a non-zero exit,
   * empty output, a missing report file — is a warning only and can never
   * change the compatibility result. */
  readonly junitReport: boolean;
  /** Fail closed whenever binary integrity cannot be proven (issue #372).
   * Default `false` preserves the historical degrade-to-pinning behaviour. */
  readonly strictIntegrity: boolean;
  readonly prComment: boolean;
}

const SEMVER_LIKE = /^\d+\.\d+\.\d+$/;
const PROTOCOL_LIKE = /^\d+$/;

/** An unsigned decimal integer written with ASCII digits only: no sign, no
 * decimal point, no exponent, no hex or other prefix, no internal
 * whitespace. The whole trimmed string must match, so a value such as
 * "1e3" or "5 minutes" is rejected rather than prefix-parsed. */
const DECIMAL_INTEGER = /^[0-9]+$/;

/** The engine's `--protocol` is a u32 and the engine rejects 0
 * ("--protocol must be a positive protocol version number"), so the Action
 * accepts 1 to 4294967295 inclusive; 0 and anything above u32 max are
 * rejected up front with a clear, input-naming message. */
const PROTOCOL_MIN = 1;
const PROTOCOL_MAX = 4294967295;
const RPC_MAX_RETRIES_MAX = 4294967295;
const RPC_RETRY_DELAY_MS_MAX = Number.MAX_SAFE_INTEGER;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const NETWORK_PASSPHRASE_UNSET = "\u0001";

/**
 * Largest whole number of minutes whose millisecond value is at most Node's
 * `setTimeout` limit (2,147,483,647 ms, about 35,791 minutes).
 * 35791 * 60_000 = 2,147,460,000 ms fits; 35792 * 60_000 =
 * 2,147,520,000 ms overflows and Node clamps the timer to fire after 1 ms,
 * ending the run almost immediately — so larger values are rejected up
 * front.
 */
export const TIMEOUT_MINUTES_MAX = Math.floor(2_147_483_647 / 60_000); // 35791
const TIMEOUT_MINUTES_MIN = 1;

/**
 * Parses a decimal integer from the whole trimmed string: ASCII digits only
 * (`^[0-9]+$`), converted with `Number`, rejected when the result is not a
 * safe integer or falls outside `[min, max]`. Throws {@link InvalidInputError}
 * naming the input, quoting the value with `JSON.stringify`, and stating the
 * accepted range. Leading zeros are accepted ("028" → 28), as they are still
 * digits. Returns `undefined` for an empty or whitespace-only input.
 */
function parseDecimalInteger(
  raw: string,
  inputName: string,
  min: number,
  max: number,
): number | undefined {
  const value = optional(raw);
  if (value === undefined) {
    return undefined;
  }
  if (!DECIMAL_INTEGER.test(value)) {
    throw new InvalidInputError(
      `Invalid "${inputName}" input: ${JSON.stringify(value)}. ` +
        `Expected an unsigned decimal integer (ASCII digits only) from ${min} to ${max}, e.g. "28".`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new InvalidInputError(
      `Invalid "${inputName}" input: ${JSON.stringify(value)}. ` +
        `Expected an unsigned decimal integer from ${min} to ${max}, e.g. "28".`,
    );
  }
  return parsed;
}

/**
 * Resolves the GitHub token to use for GitHub API requests according to the precedence rules:
 * 1. Non-empty (after trimming) explicit token / action input value wins.
 * 2. Otherwise a non-empty `GITHUB_TOKEN` environment variable.
 * 3. Otherwise `undefined` (unauthenticated). Whitespace-only values count as empty.
 */
export function resolveGithubToken(explicitToken?: string): string | undefined {
  const inputCandidate = explicitToken?.trim();
  if (inputCandidate !== undefined && inputCandidate !== "") {
    return inputCandidate;
  }
  const envCandidate = process.env.GITHUB_TOKEN?.trim();
  if (envCandidate !== undefined && envCandidate !== "") {
    return envCandidate;
  }
  return undefined;
}

/**
 * A fixture-pack release tag: semver-shaped, with an optional leading `v` and
 * the optional SemVer prerelease (`-rc.1`) and build (`+sha.abc`) suffixes a
 * published release may carry.
 *
 * Deliberately does *not* accept `latest`, `main`, or any other moving
 * reference: this repository pins the engine (`version`) and never tracks an
 * unpinned build, and a reproducibility-oriented pack pin that silently
 * followed a branch would defeat its own purpose.
 */
const PACK_VERSION_LIKE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Reads and validates every Action input. Throws {@link InvalidInputError} or
 * {@link ConfigNotFoundError} on the first problem found. */
export function getInputs(): ActionInputs {
  const protocol = parseProtocol(core.getInput("protocol"));
  const config = parseConfig(core.getInput("config"));
  const workingDirectory = parseWorkingDirectory(core.getInput("working-directory"));
  const network = optional(core.getInput("network"));
  const networkPassphrase = parseNetworkPassphrase(core.getInput("network-passphrase", { trimWhitespace: false }));
  const rpcUrl = parseRpcUrl(core.getInput("rpc-url"));
  if (rpcUrl !== undefined) {
    maskRpcUrlSecrets(rpcUrl, core.setSecret);
  }
  const rpcMaxRetries = parseDecimalInteger(
    core.getInput("rpc-max-retries"),
    "rpc-max-retries",
    0,
    RPC_MAX_RETRIES_MAX,
  );
  const rpcRetryDelayMs = parseDecimalInteger(
    core.getInput("rpc-retry-delay-ms"),
    "rpc-retry-delay-ms",
    0,
    RPC_RETRY_DELAY_MS_MAX,
  );
  const fixturesDir = core.getInput("fixtures-dir") || "fixtures";
  const fixture = parseScopedFilter(core.getInput("fixture"), "fixture");
  const surface = parseSurface(core.getInput("surface"));
  const cacheDir = parseScopedFilter(core.getInput("cache-dir"), "cache-dir");
  const version = parseVersion(core.getInput("version") || "0.2.0");
  const uploadReport = parseBoolean("upload-report", core.getInput("upload-report") || "true");
  const annotations = parseBoolean("annotations", core.getInput("annotations") || "true");
  const diagnostics = parseBoolean("diagnostics", core.getInput("diagnostics") || "false");
  const timeoutMinutes = parseTimeout(core.getInput("timeout-minutes") || "15");
  const allowEmpty = parseBoolean("allow-empty", core.getInput("allow-empty") || "false");
  const rpcTimeoutSeconds = parseBoundedInteger(
    "rpc-timeout-seconds",
    core.getInput("rpc-timeout-seconds"),
    RPC_TIMEOUT_SECONDS_MAX,
    "seconds",
  );
  const maxConcurrency = parseBoundedInteger(
    "max-concurrency",
    core.getInput("max-concurrency"),
    MAX_CONCURRENCY_MAX,
    "concurrent requests",
  );
  const noCache = parseOptionalBoolean("no-cache", core.getInput("no-cache"));
  const liveCacheTtlSeconds = parseBoundedInteger(
    "live-cache-ttl-seconds",
    core.getInput("live-cache-ttl-seconds"),
    LIVE_CACHE_TTL_SECONDS_MAX,
    "seconds",
  );
  const failOnWarning = parseBoolean(
    "fail-on-warning",
    core.getInput("fail-on-warning") || "false",
  );
  const offline = parseBoolean("offline", core.getInput("offline") || "false");
  const fixturesPackVersion = parseFixturesPackVersion(core.getInput("fixtures-pack-version"));
  const fixturesPackProtocol = parseFixturesPackProtocol(core.getInput("fixtures-pack-protocol"));
  const baselineReport = parseBaselineReport(core.getInput("baseline-report"));
  const githubToken = resolveGithubToken(core.getInput("github-token"));
  const engineEnvPassthrough = parseEngineEnvPassthrough(core.getInput("engine-env-passthrough"));

  if (githubToken !== undefined) {
    core.setSecret(githubToken);
  }
  // A `working-directory` that resolves to the workspace itself is exactly
  // what the engine already uses as its project root, so the default run is
  // not forwarded anything and needs no explanation. Any other value changes
  // what the engine treats as the project root and requires an engine that
  // accepts `--project-root`; say so up front instead of leaving the user to
  // infer it from a version-dependent CLI usage error.
  if (workingDirectory !== path.resolve(".")) {
    core.info(
      `"working-directory" will be forwarded to Canary as --project-root (${JSON.stringify(workingDirectory)}). ` +
        "This requires a Protocol-Canary release whose CLI supports --project-root; older releases reject the argument.",
    );
  }
  if (networkPassphrase !== undefined) {
    core.setSecret(networkPassphrase);
  }
  const generateReceipt = parseBoolean("generate-receipt", core.getInput("generate-receipt") || "false");
  const reportRetentionDays = parseReportRetentionDays(core.getInput("report-retention-days"));
  const junitReport = parseBoolean("junit-report", core.getInput("junit-report") || "false");

  const strictIntegrity = parseBoolean("strict-integrity", core.getInput("strict-integrity") || "false");

  // The "fail-on-warning"/"offline" engine gate that used to `core.warning`
  // here moved into buildCheckArgs's VERSION_GATED_FLAGS table (#413): the
  // skip note is now emitted against the *resolved* engine version, exactly
  // where the flag would have been forwarded, so getInputs only parses.

  // The engine declares `--no-cache` and `--live-cache-ttl` as conflicting
  // (`conflicts_with` on `no_cache` in Protocol-Canary's `CheckArgs`), so a
  // run carrying both would die at the CLI with an opaque clap error. Reject
  // the combination here, where the message can name both inputs and say how
  // to fix it. `no-cache: false` with a TTL is the engine-default cache
  // behavior plus an explicit TTL — not a conflict.
  if (noCache === true && liveCacheTtlSeconds !== undefined) {
    throw new InvalidInputError(
      `Invalid input combination: "no-cache" is set to true, which conflicts with ` +
        `"live-cache-ttl-seconds": the engine rejects \`--no-cache\` together with ` +
        "`--live-cache-ttl`, because disabling the cache and configuring how long cached " +
        "live results stay reusable are mutually exclusive. Set \"no-cache\" to `false` (or " +
        'omit it) to use a live-cache TTL, or omit "live-cache-ttl-seconds" to disable the cache.',
    );
  }

  // A validated input that silently does nothing is worse than a missing one:
  // it reads as "my pack is pinned" when the run used whatever
  // `--fixtures-dir` happened to contain. Say so explicitly, the same way an
  // `allow-empty` that cannot apply to the resolved engine is reported.
  if (fixturesPackVersion !== undefined || fixturesPackProtocol !== undefined) {
    core.info(
      `"fixtures-pack-version"/"fixtures-pack-protocol" are accepted and validated, but not ` +
        "forwarded to Canary: `stellar-canary check` loads fixtures only from a local " +
        "--fixtures-dir and has no fixture-pack flag. This run used " +
        `${JSON.stringify(fixturesDir)} as its fixtures directory.`,
    );
  }

  return {
    protocol,
    config,
    workingDirectory,
    network,
    networkPassphrase,
    rpcUrl,
    rpcMaxRetries,
    rpcRetryDelayMs,
    fixturesDir,
    fixture,
    surface,
    cacheDir,
    version,
    uploadReport,
    annotations,
    diagnostics,
    timeoutMinutes,
    allowEmpty,
    rpcTimeoutSeconds,
    maxConcurrency,
    noCache,
    liveCacheTtlSeconds,
    failOnWarning,
    offline,
    fixturesPackVersion,
    fixturesPackProtocol,
    baselineReport,
    githubToken,
    engineEnvPassthrough,
    generateReceipt,
    reportRetentionDays,
    junitReport,
    strictIntegrity,
    prComment: parseBoolean("pr-comment", core.getInput("pr-comment") || "false"),
  };
}

/** Validates an explicitly supplied passphrase without trimming it: spaces
 * can be part of a network identity, while control characters are never safe
 * in an Action input or CLI argument. An omitted input remains undefined. */
function parseNetworkPassphrase(raw: string): string | undefined {
  if (raw === NETWORK_PASSPHRASE_UNSET) {
    return undefined;
  }
  if (raw === "") {
    throw new InvalidInputError(
      'Invalid "network-passphrase" input: "". Expected a non-empty passphrase without control characters.',
    );
  }
  if (CONTROL_CHARACTERS.test(raw)) {
    throw new InvalidInputError(
      `Invalid "network-passphrase" input: ${JSON.stringify(raw)}. ` +
        "Control characters are not allowed in a network passphrase.",
    );
  }
  return raw;
}

/**
 * Validates the "report-retention-days" input as an integer from 1 to 90;
 * undefined when unset. Throws {@link InvalidInputError} naming the input
 * for non-integers or values outside 1 to 90.
 */
function parseReportRetentionDays(raw: string): number | undefined {
  const value = optional(raw);
  if (value === undefined) {
    return undefined;
  }
  if (!PROTOCOL_LIKE.test(value)) {
    throw new InvalidInputError(
      `Invalid "report-retention-days" input: ${JSON.stringify(value)}. Expected an integer from 1 to 90.`,
    );
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1 || parsed > 90) {
    throw new InvalidInputError(
      `Invalid "report-retention-days" input: ${JSON.stringify(value)}. Expected an integer from 1 to 90.`,
    );
  }
  return parsed;
}

/**
 * Parses the "engine-env-passthrough" input: a comma- or newline-separated
 * list of exact environment variable names to forward to `cargo` and the
 * engine on top of the default allow-list.
 *
 * Rules (see SECURITY.md and README.md):
 *
 * - names only — no wildcards, no `=value` pairs;
 * - each name matches `^[A-Za-z_][A-Za-z0-9_]*$`;
 * - at most {@link MAX_PASSTHROUGH_NAMES} names, no duplicates;
 * - anything denied by {@link isDeniedEnvName} (GITHUB_*, ACTIONS_*,
 *   RUNNER_*, INPUT_*, cloud/npm credential families, Cargo registry
 *   credentials, or a name containing TOKEN/SECRET/PASSWORD/… ) is rejected.
 *
 * Errors name the offending variable and never print a value. A malformed
 * entry such as `LD_LIBRARY_PATH=/opt/lib` is reported by its name, with the
 * value elided, so a secret pasted in the wrong place cannot reach the job
 * log. An empty or whitespace-only input yields no names.
 */
export function parseEngineEnvPassthrough(raw: string): string[] {
  const value = optional(raw);
  if (value === undefined) {
    return [];
  }

  const names = value
    .split(/[\n,]/)
    .map((name) => name.trim())
    .filter((name) => name !== "");

  if (names.length > MAX_PASSTHROUGH_NAMES) {
    throw new InvalidInputError(
      `Invalid "engine-env-passthrough" input: ${String(names.length)} variable names were given, ` +
        `but at most ${String(MAX_PASSTHROUGH_NAMES)} are accepted.`,
    );
  }

  const seen = new Set<string>();
  const accepted: string[] = [];
  for (const name of names) {
    if (!PASSTHROUGH_NAME_PATTERN.test(name)) {
      throw new InvalidInputError(
        `Invalid "engine-env-passthrough" input: ${describePassthroughEntry(name)}. Expected an ` +
          'environment variable name, e.g. "LD_LIBRARY_PATH", not a wildcard or a name/value pair ' +
          "(names only; values are read from the workflow environment).",
      );
    }

    // Windows environment names are case-insensitive, so `PATH,path` is the
    // same variable twice there.
    const key = process.platform === "win32" ? name.toUpperCase() : name;
    if (seen.has(key)) {
      throw new InvalidInputError(
        `Invalid "engine-env-passthrough" input: ${JSON.stringify(name)} is listed more than once.`,
      );
    }
    seen.add(key);

    if (isDeniedEnvName(name)) {
      throw new InvalidInputError(
        `Invalid "engine-env-passthrough" input: ${JSON.stringify(name)} is never passed to child ` +
          "processes. GitHub/Actions/runner variables, cloud and npm credentials, Cargo registry " +
          "credentials, and any name containing TOKEN, SECRET, PASSWORD, PASSWD, CREDENTIAL, " +
          "PRIVATE_KEY, API_KEY, ACCESS_KEY, or SESSION are denied by default and cannot be " +
          "restored through this input. Use a different mechanism for a credential the build " +
          "genuinely needs, and accept the documented risk — this input is not that mechanism.",
      );
    }

    accepted.push(name);
  }

  return accepted;
}

/**
 * Renders a rejected passthrough entry for an error message: the name only.
 * When the entry looks like `NAME=value`, the value is elided so it never
 * reaches the job log.
 */
function describePassthroughEntry(entry: string): string {
  const separator = entry.indexOf("=");
  if (separator === -1) {
    return JSON.stringify(entry);
  }
  return `${JSON.stringify(entry.slice(0, separator))} (a value was supplied; this input takes names only)`;
}

/**
 * Validates the "fixtures-pack-version" input as a published fixture-pack
 * release tag; `undefined` when unset. Throws {@link InvalidInputError},
 * naming the input and an accepted example, for anything else.
 *
 * The validated value is returned as written (only surrounding whitespace
 * trimmed) rather than normalized the way `version` is, because it identifies
 * an already-published pack release: there is no tag to reconstruct from it,
 * and stripping a leading `v` would lose the caller's exact token.
 *
 * **Not forwarded to the CLI.** `stellar-canary check` has no fixture-pack
 * flag: its fixture-loading contract accepts a local path via `--fixtures-dir`
 * and states there is "no other loading mechanism — no network fetch, no
 * package registry, no database", with remote bundles fetched by version
 * explicitly out of scope upstream for now
 * (`Protocol-Canary`'s `docs/fixture-contract.md`, sections 1 and 8). Parsing
 * and validating the input here is what the issue asks for; wiring it to the
 * invocation has to wait for an upstream flag to forward it to. See the
 * informational note in {@link getInputs}.
 */
function parseFixturesPackVersion(raw: string): string | undefined {
  const value = optional(raw);
  if (value === undefined) {
    return undefined;
  }
  if (!PACK_VERSION_LIKE.test(value)) {
    throw new InvalidInputError(
      `Invalid "fixtures-pack-version" input: ${JSON.stringify(value)}. ` +
        'Expected a fixture-pack release tag, e.g. "v1.2.0" or "1.2.0" ' +
        "(an unpinned value such as \"latest\" or \"main\" is not accepted).",
    );
  }
  return value;
}

/**
 * Masks sensitive components extracted from a validated RPC URL by registering
 * them with the GitHub Actions runner via `core.setSecret()`.
 *
 * This runs after `parseRpcUrl` validation, so malformed URLs are already
 * rejected. The original URL string is preserved for full-URL masking.
 *
 * Components masked (if non-empty):
 *   - Username from URL userinfo (`user:password@host`)
 *   - Password from URL userinfo
 *   - Every query parameter value
 *   - URL fragment
 *   - The complete RPC URL if any sensitive component is present
 *
 * @param rpcUrl The validated RPC URL string (already validated as https:// or
 *   permitted plain http:// for localhost/127.0.0.1).
 */
function maskRpcUrlSecrets(rpcUrl: string, setSecret: (secret: string) => void): void {
  const parsed = new URL(rpcUrl);
  let hasSensitive = false;

  // 1. Username and password from URL userinfo.
  if (parsed.username !== "") {
    setSecret(parsed.username);
    hasSensitive = true;
  }
  if (parsed.password !== "") {
    setSecret(parsed.password);
    hasSensitive = true;
  }

  // 2. Every query parameter value.
  if (parsed.searchParams.size > 0) {
    for (const [, value] of parsed.searchParams.entries()) {
      const decodedValue = decodeURIComponent(value);
      if (decodedValue !== "") {
        setSecret(decodedValue);
        hasSensitive = true;
      }
    }
  }

  // 3. URL fragment.
  if (parsed.hash && parsed.hash.length > 1) {
    const fragment = parsed.hash.slice(1); // strip leading #
    if (fragment !== "") {
      setSecret(fragment);
      hasSensitive = true;
    }
  }

  // 4. The complete RPC URL if any sensitive component is present.
  if (hasSensitive) {
    setSecret(rpcUrl);
  }
}

/**
 * Validates the "fixtures-pack-version" input as a published fixture-pack
 * release tag; `undefined` when unset. Throws {@link InvalidInputError},
 * naming the input and an accepted example, for anything else.
 * Not forwarded to the CLI, for the same reason as
 * {@link parseFixturesPackVersion}.
 */
function parseFixturesPackProtocol(raw: string): number | undefined {
  const value = optional(raw);
  if (value === undefined) {
    return undefined;
  }
  if (!PROTOCOL_LIKE.test(value)) {
    throw new InvalidInputError(
      `Invalid "fixtures-pack-protocol" input: ${JSON.stringify(value)}. Expected a positive integer, e.g. "28".`,
    );
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed <= 0 || !Number.isSafeInteger(parsed)) {
    throw new InvalidInputError(
      `Invalid "fixtures-pack-protocol" input: ${JSON.stringify(value)}. ` +
        "Expected a positive integer that fits in a JavaScript safe integer, e.g. \"28\".",
    );
  }
  return parsed;
}

/**
 * Validates the "baseline-report" input as a path to an existing regular
 * file, resolved against the current working directory; `undefined` when
 * unset. Throws {@link InvalidInputError} naming the input and the path as
 * written when it is missing or is not a file (for example a directory).
 *
 * Only the path is checked here. Reading and validating the report contents —
 * JSON syntax, schemaVersion, and target protocol — happens in
 * `runner.loadBaselineReport` once the Action is committed to using it, so a
 * missing path fails before any installation or engine work (#344).
 *
 * Returns the resolved path for the same reason as {@link parseConfig}: the
 * file that was validated and the file the Action reads must be one path by
 * construction.
 */
function parseBaselineReport(raw: string): string | undefined {
  const value = optional(raw);
  if (value === undefined) {
    return undefined;
  }
  const resolved = path.resolve(value);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new InvalidInputError(
      `Invalid "baseline-report" input: ${JSON.stringify(value)}. ` +
        "Expected a path to an existing JSON report, but the file does not exist.",
    );
  }
  if (!stats.isFile()) {
    throw new InvalidInputError(
      `Invalid "baseline-report" input: ${JSON.stringify(value)}. ` +
        "Expected a path to a JSON report file, but the path is not a regular file.",
    );
  }
  return resolved;
}

/** Normalizes a raw Action input: returns undefined for an empty or
 * whitespace-only value, otherwise the trimmed value. Never throws. */
function optional(value: string): string | undefined {
  return value.trim() === "" ? undefined : value.trim();
}

/**
 * Validates a scope-affecting string input (#458 `fixture`, `cache-dir`):
 * trimmed, with empty/whitespace-only meaning *unset* (the same normalization
 * as every optional string input), and free of control characters once
 * trimmed — C0 (`U+0000`-`U+001F`), `U+007F`, and C1 (`U+0080`-`U+009F`).
 *
 * Nothing beyond control characters is restricted: the engine decides what a
 * fixture id is, and a cache path legitimately contains spaces, dots, slashes,
 * and can begin with `-` (forwarded as `--flag=value`, so it can never be
 * mistaken for another option). A silently ignored value here would run a
 * different scope than the caller asked for (#458), so a bad value is an
 * input error, never a downgraded warning.
 *
 * Exported for tests: a NUL byte cannot be carried through `process.env`
 * (the platform rejects it), so the NUL case of this check is only
 * reachable through the function directly.
 */
export function parseScopedFilter(raw: string, inputName: string): string | undefined {
  const value = optional(raw);
  if (value === undefined) {
    return undefined;
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new InvalidInputError(
      `Invalid "${inputName}" input: ${JSON.stringify(value)}. ` +
        "Control characters (C0, DEL, and C1) are not allowed.",
    );
  }
  return value;
}

/**
 * Validates the `surface` input (#458) as exactly one of the engine's three
 * lower-case surface names; empty/whitespace-only means unset. The engine
 * rejects any other value (`invalid value ... [possible values: xdr, rpc,
 * soroban]`), and a case or spelling mismatch must fail here with an
 * input-naming message instead of surfacing as an engine failure — or, worse,
 * as a differently scoped run.
 */
function parseSurface(raw: string): SurfaceFilter | undefined {
  const value = optional(raw);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "xdr" && value !== "rpc" && value !== "soroban") {
    throw new InvalidInputError(
      `Invalid "surface" input: ${JSON.stringify(value)}. Expected exactly ` +
        'one of "xdr", "rpc" or "soroban" (lower case).',
    );
  }
  return value;
}

/** Validates the "protocol" input as an unsigned decimal integer from 1 to
 * 4294967295 inclusive (the engine's `--protocol` is a u32 and rejects 0);
 * undefined when unset. Throws {@link InvalidInputError} for anything else. */
function parseProtocol(raw: string): number | undefined {
  return parseDecimalInteger(raw, "protocol", PROTOCOL_MIN, PROTOCOL_MAX);
}

/** Validates the "config" input as a path to an existing regular file,
 * resolved against the current working directory; undefined when unset.
 * Throws {@link ConfigNotFoundError} (naming the path as written) when the
 * path does not exist, and {@link InvalidInputError} when it exists but is
 * not a file (e.g. a directory).
 *
 * Returns the *resolved* path rather than the raw input. The existence check
 * above already runs against `path.resolve(value)`, so returning the
 * unresolved string would leave the path that was validated and the path
 * forwarded to the CLI as `--config` dependent on the two sharing a working
 * directory. Returning `resolved` keeps them the same path by construction. */
function parseConfig(raw: string): string | undefined {
  const value = optional(raw);
  if (value === undefined) {
    return undefined;
  }
  const resolved = path.resolve(value);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new ConfigNotFoundError(value);
  }
  if (!stats.isFile()) {
    throw new InvalidInputError(
      `Invalid "config" input: ${JSON.stringify(value)}. Expected a path to a configuration ` +
        "file, but the path is a directory.",
    );
  }
  return resolved;
}

/**
 * Validates the "working-directory" input (#348) as a path to an existing
 * directory, resolved against the current working directory; defaults to
 * `.` (the workspace itself) when unset or whitespace-only, matching the
 * declared default in `action.yml`.
 *
 * Throws {@link InvalidInputError} — naming the input, quoting the value as
 * written, and including the resolved path — when nothing exists at that
 * path or when it exists but is not a directory (e.g. a regular file), so
 * the mistake is caught here rather than surfacing later as an engine exit
 * code 2 with no actionable path context.
 *
 * Returns the *resolved* path rather than the raw input, for the same
 * reason {@link parseConfig} does: the directory this function validated is
 * then forwarded to the CLI as `--project-root`, and the two must be the
 * same path by construction regardless of the working directory the engine
 * happens to inherit.
 */
function parseWorkingDirectory(raw: string): string {
  const value = optional(raw) ?? ".";
  const resolved = path.resolve(value);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new InvalidInputError(
      `Invalid "working-directory" input: ${JSON.stringify(value)}. Expected a path to an existing ` +
        `directory, but no such path exists (resolved to ${JSON.stringify(resolved)}).`,
    );
  }
  if (!stats.isDirectory()) {
    throw new InvalidInputError(
      `Invalid "working-directory" input: ${JSON.stringify(value)}. Expected a path to a directory, ` +
        `but the path is not a directory (resolved to ${JSON.stringify(resolved)}).`,
    );
  }
  return resolved;
}

/**
 * Validates the "fixtures-dir" input against the filesystem (issue #400): the
 * resolved path must name an existing directory. Called from `run()` after
 * input parsing and before version resolution or engine installation, so a
 * mistyped path fails the job in milliseconds instead of after a full
 * `cargo install`.
 *
 * The path is resolved against the current working directory — the same
 * working directory the CLI reads `--fixtures-dir` from — and stat'ed in
 * its normalized form, so `..` segments and relative input can never make
 * the validated path differ from the forwarded one. `fs.statSync` follows
 * symbolic links, so a dangling symlink is indistinguishable from a missing
 * path and gets the same, predictable missing-path treatment (the same
 * convention `parseConfig` uses for `config`).
 *
 * A missing directory is fatal by default, with a message naming the input
 * and the resolved absolute path. With `allow-empty` enabled it degrades to
 * a `core.warning` and the run continues — `allow-empty` exists precisely to
 * tolerate a run that executes no checks — and the directory is never
 * created behind the user's back. A resolved path that exists but is not a
 * directory (e.g. a regular file) is always rejected, even with
 * `allow-empty`: that input excuses an empty fixture set, not a mistyped
 * path.
 *
 * Returns the resolved absolute path that was validated. Throws
 * {@link InvalidInputError} when the path is not an existing directory and
 * `allowEmpty` is false.
 */
export function validateFixturesDir(fixturesDir: string, allowEmpty: boolean): string {
  const resolved = path.resolve(fixturesDir);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    // statSync throws for a missing path (ENOENT) — including a dangling
    // symlink, which it follows to a target that does not exist — and for
    // paths it cannot stat at all. All of them get the missing-path
    // treatment rather than being forwarded to the engine to fail there
    // with a less actionable error.
    if (allowEmpty) {
      core.warning(
        `"fixtures-dir" input: the fixtures directory ${resolved} does not exist. ` +
          "Continuing because \"allow-empty\" is true; Canary will load no fixtures from it.",
      );
      return resolved;
    }
    throw new InvalidInputError(
      `Invalid "fixtures-dir" input: the fixtures directory ${resolved} does not exist. ` +
        "Provide a path to an existing directory, or set \"allow-empty\" to true to run without one.",
    );
  }
  if (!stats.isDirectory()) {
    throw new InvalidInputError(
      `Invalid "fixtures-dir" input: ${resolved} exists but is not a directory. ` +
        "\"fixtures-dir\" must point at a directory of fixtures; a regular file is not one.",
    );
  }
  return resolved;
}

/** Validates the "rpc-url" input as a parseable URL and enforces the scheme
 * allow-list: https:// only, with one deliberate exception — plain http://
 * is accepted for localhost/127.0.0.1 so local development endpoints work.
 * Throws {@link InvalidInputError} for an unparseable URL or any other
 * non-https scheme. The error message never contains the rejected text: a
 * parseable URL is described with userinfo, query and fragment redacted, and
 * an unparseable value is described by non-sensitive facts only (#510). */
function parseRpcUrl(raw: string): string | undefined {
  const value = optional(raw);
  if (value === undefined) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // The value is deliberately not echoed, not even a prefix or suffix of it:
    // an unparseable URL may still carry a credential (#510). Only facts that
    // cannot reveal one are reported.
    const facts = [`${String(value.length)} characters`, ...(/\s/.test(value) ? ["contains whitespace"] : [])];
    throw new InvalidInputError(
      `Invalid "rpc-url" input: the value could not be parsed as a URL (${facts.join(", ")}) and is not shown ` +
        "because it may contain credentials. Expected a valid URL.",
    );
  }

  const isLocalHttp =
    parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !isLocalHttp) {
    throw new InvalidInputError(
      `Invalid "rpc-url" input: ${describeUrlSafely(parsed)}. Must be an https:// URL ` +
        `(plain http:// is only accepted for localhost/127.0.0.1).`,
    );
  }

  return value;
}

/** Validates the "version" input as a semver-like x.y.z after stripping an
 * optional leading "v". Throws {@link InvalidInputError} for anything else. */
function parseVersion(raw: string): string {
  const value = raw.trim().replace(/^v/i, "");
  if (!SEMVER_LIKE.test(value)) {
    throw new InvalidInputError(
      `Invalid "version" input: ${JSON.stringify(raw)}. Expected a semantic version, e.g. "0.1.0".`,
    );
  }
  return value;
}

const TRUE_VALUES = new Set(["true", "True", "TRUE"]);
const FALSE_VALUES = new Set(["false", "False", "FALSE"]);

/** Validates a boolean input against the documented literals
 * (true/True/TRUE, false/False/FALSE) after trimming whitespace. Throws
 * {@link InvalidInputError}, naming the offending input, for any other
 * form. */
function parseBoolean(name: string, raw: string): boolean {
  const value = raw.trim();
  if (TRUE_VALUES.has(value)) {
    return true;
  }
  if (FALSE_VALUES.has(value)) {
    return false;
  }
  throw new InvalidInputError(
    `Invalid "${name}" input: ${JSON.stringify(raw)}. Expected one of true/True/TRUE/false/False/FALSE.`,
  );
}

/**
 * Upper bounds for the engine-forwarded check options (#413). Protocol-Canary
 * itself only enforces positivity for these — `live-cache-ttl` is declared
 * `range(1..)` and the other two are unsigned integers — so the upper bounds
 * are the Action's own, chosen so that a value which is practically a unit
 * mistake fails here, in input validation, with a message naming the input,
 * instead of surfacing later as a hung or throttled run:
 *
 * - `rpc-timeout-seconds` 1–600 (10 minutes): a single-request RPC timeout
 *   longer than that outruns the Action's own default `timeout-minutes` of
 *   15 and can only be seconds-passed-as-something-else.
 * - `max-concurrency` 1–64: the engine defaults to 4; beyond 64 concurrent
 *   requests against a public RPC/Soroban endpoint is self-inflicted rate
 *   limiting, not useful parallelism.
 * - `live-cache-ttl-seconds` 1–604800 (7 days): the engine already rejects
 *   0; a "live" result replayed for longer than a week no longer says
 *   anything about what the network does now.
 */
const RPC_TIMEOUT_SECONDS_MAX = 600;
const MAX_CONCURRENCY_MAX = 64;
const LIVE_CACHE_TTL_SECONDS_MAX = 604_800;

/**
 * Strictly parses a positive-integer engine check option (#413) between 1
 * and `max`, expressed in `unit`; `undefined` when unset/empty.
 *
 * Deliberately stricter than {@link parseTimeout}: the value must be digits
 * only, so `"12abc"`, `"+7"`, `"12.5"` and `"-1"` are rejected outright
 * rather than truncated the way `parseInt` would read them, and anything
 * outside `1..max` — including digit strings too large to be safe integers
 * — is rejected with an {@link InvalidInputError} naming the input.
 */
function parseBoundedInteger(name: string, raw: string, max: number, unit: string): number | undefined {
  const value = optional(raw);
  if (value === undefined) {
    return undefined;
  }
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new InvalidInputError(
      `Invalid "${name}" input: ${JSON.stringify(value)}. ` +
        `Expected a positive integer between 1 and ${max} ${unit}.`,
    );
  }
  return parsed;
}

/** Validates an optional boolean input: `undefined` when unset (or
 * empty/whitespace-only), otherwise the documented literals via
 * {@link parseBoolean}, which throws {@link InvalidInputError} naming the
 * input for anything else. */
function parseOptionalBoolean(name: string, raw: string): boolean | undefined {
  const value = optional(raw);
  return value === undefined ? undefined : parseBoolean(name, value);
}

/** Validates the "timeout-minutes" input as an unsigned decimal integer from
 * 1 to {@link TIMEOUT_MINUTES_MAX} inclusive (35,791 minutes: the largest
 * whole number of minutes whose millisecond value fits Node's `setTimeout`
 * limit). Throws {@link InvalidInputError} for zero, negative, non-numeric,
 * out-of-range, or non-whole input. The default of 15 and the one-minute
 * floor for `cargo install` are unchanged. */
function parseTimeout(raw: string): number {
  const parsed = parseDecimalInteger(raw, "timeout-minutes", TIMEOUT_MINUTES_MIN, TIMEOUT_MINUTES_MAX);
  if (parsed === undefined) {
    throw new InvalidInputError(
      `Invalid "timeout-minutes" input: ${JSON.stringify(raw)}. ` +
        `Expected an unsigned decimal integer from 1 to ${TIMEOUT_MINUTES_MAX}, e.g. "15".`,
    );
  }
  return parsed;
}
