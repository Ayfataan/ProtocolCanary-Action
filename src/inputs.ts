import * as core from "@actions/core";
import * as fs from "node:fs";
import * as path from "node:path";

import { ConfigNotFoundError, InvalidInputError } from "./errors";

export interface ActionInputs {
  readonly protocol: number | undefined;
  readonly config: string | undefined;
  readonly network: string | undefined;
  readonly rpcUrl: string | undefined;
  readonly fixturesDir: string;
  readonly version: string;
  readonly uploadReport: boolean;
  readonly annotations: boolean;
  readonly timeoutMinutes: number;
  /** Pass `--allow-empty` to engines that support it (0.2.0 and newer). */
  readonly allowEmpty: boolean;
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
  /** Opt in to producing an Execution Receipt (#360) and exporting it as a
   * workflow artifact (#362). Parses the documented boolean literals strictly
   * and defaults to `false` when the input is omitted (#361). */
  readonly generateReceipt: boolean;
  /** Fail closed whenever binary integrity cannot be proven (issue #372).
   * Default `false` preserves the historical degrade-to-pinning behaviour. */
  readonly strictIntegrity: boolean;
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
  const network = optional(core.getInput("network"));
  const rpcUrl = parseRpcUrl(core.getInput("rpc-url"));
  const fixturesDir = core.getInput("fixtures-dir") || "fixtures";
  const version = parseVersion(core.getInput("version") || "0.1.1");
  const uploadReport = parseBoolean("upload-report", core.getInput("upload-report") || "true");
  const annotations = parseBoolean("annotations", core.getInput("annotations") || "true");
  const timeoutMinutes = parseTimeout(core.getInput("timeout-minutes") || "15");
  const allowEmpty = parseBoolean("allow-empty", core.getInput("allow-empty") || "false");
  const fixturesPackVersion = parseFixturesPackVersion(core.getInput("fixtures-pack-version"));
  const fixturesPackProtocol = parseFixturesPackProtocol(core.getInput("fixtures-pack-protocol"));
  const baselineReport = parseBaselineReport(core.getInput("baseline-report"));
  const githubToken = resolveGithubToken(core.getInput("github-token"));

  if (githubToken !== undefined) {
    core.setSecret(githubToken);
  }
  const generateReceipt = parseBoolean("generate-receipt", core.getInput("generate-receipt") || "false");

  const strictIntegrity = parseBoolean("strict-integrity", core.getInput("strict-integrity") || "false");

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
    network,
    rpcUrl,
    fixturesDir,
    version,
    uploadReport,
    annotations,
    timeoutMinutes,
    allowEmpty,
    fixturesPackVersion,
    fixturesPackProtocol,
    baselineReport,
    githubToken,
    generateReceipt,
    strictIntegrity,
  };
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
 * Validates the "fixtures-pack-protocol" input as a **positive** integer
 * string; `undefined` when unset. Throws {@link InvalidInputError}, naming the
 * input and an accepted example, for anything else.
 *
 * Unlike the `protocol` input — which accepts `0` because a non-negative
 * integer is the right shape there — zero is rejected here: a pack pinned to
 * protocol 0 is not a pack anyone publishes, so accepting it would only defer
 * the error to somewhere less actionable.
 *
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
 * non-https scheme. */
function parseRpcUrl(raw: string): string | undefined {
  const value = optional(raw);
  if (value === undefined) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidInputError(`Invalid "rpc-url" input: ${JSON.stringify(value)}. Expected a valid URL.`);
  }

  const isLocalHttp =
    parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !isLocalHttp) {
    throw new InvalidInputError(
      `Invalid "rpc-url" input: ${JSON.stringify(value)}. Must be an https:// URL ` +
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
