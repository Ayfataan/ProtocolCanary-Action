import * as core from "@actions/core";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

import { sanitizeLogText, truncateLogTail } from "./log-block";
import type { ActionInputs } from "./inputs";
import { CanaryExecutionFailedError, InvalidInputError, TimeoutError, describeError } from "./errors";
import { parseReport } from "./output";
import type { CanaryReport } from "./output";

/**
 * Result of running `stellar-canary check`.
 * `exitCode` and `signal` are complementary: when the process is
 * terminated by a signal, Node sets `exitCode` to `null` and populates
 * `signal` with the terminating signal. `src/main.ts` interprets
 * `execution.exitCode === null` as an execution failure caused by a signal.
 * For a normal exit, `signal` is `null` and `exitCode` contains the process
 * status code.
 */
export interface CheckExecutionResult {
  /** Exit status for a normal process exit; `null` if terminated by a signal. */
  readonly exitCode: number | null;
  /** Signal that terminated the process, or `null` for a normal exit. */
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Builds the `stellar-canary check` argument array from validated inputs.
 * Arguments are always passed as an array — never interpolated into a
 * shell string — so nothing in an input can be interpreted as a shell
 * operator (see SECURITY.md).
 *
 * `--format json` is always requested, regardless of any future `format`
 * input: the Action needs structured data to build the job summary and
 * annotations from, and running Canary a second time to get a different
 * format is explicitly out of scope (one invocation drives everything).
 */
export function buildCheckArgs(inputs: ActionInputs, engineVersion?: string): string[] {
  const args = ["check", "--format", "json"];

  if (inputs.protocol !== undefined) {
    args.push("--protocol", String(inputs.protocol));
  }
  if (inputs.network !== undefined) {
    args.push("--network", inputs.network);
  }
  if (inputs.rpcUrl !== undefined) {
    args.push("--rpc-url", inputs.rpcUrl);
  }
  if (inputs.config !== undefined) {
    args.push("--config", inputs.config);
  }
  // #348: `--project-root` is forwarded only when `working-directory` is not
  // the directory the engine already defaults to — the current working
  // directory. A run that never sets the input therefore sends
  // byte-identical arguments to every engine release, including the ones
  // that predate the flag (Protocol-Canary E-010 / #404, which no published
  // release carries yet: v0.1.1 and v0.2.0 reject an unknown argument with
  // exit code 2). An explicit directory that differs from the workspace is
  // precisely the case that needs the flag, and failing loudly there — an
  // engine without the flag reports a clear usage error — beats silently
  // checking the wrong directory.
  if (inputs.workingDirectory !== undefined && inputs.workingDirectory !== path.resolve(".")) {
    args.push("--project-root", inputs.workingDirectory);
  }
  args.push("--fixtures-dir", inputs.fixturesDir);

  // Version-gated flags (#413): every flag whose acceptance depends on the
  // engine release is declared in VERSION_GATED_FLAGS with the first release
  // that accepts it — `allow-empty` and the four #413 check options as
  // before, plus the five inputs main gated separately (`network-passphrase`,
  // `rpc-max-retries`, `rpc-retry-delay-ms`, `fail-on-warning`, `offline`).
  // An input that is set but whose resolved engine predates that release is
  // skipped with a `core.info` note naming the input and the required
  // version — never passed to an engine that would reject it as an unknown
  // argument, and never dropped silently. The argv is always an array of
  // discrete elements; nothing here is ever a shell string. `--fixture`,
  // `--surface` and `--cache-dir` are deliberately NOT in the table: main.ts
  // fails the run before install when the engine cannot honour them
  // (fixtureSurfaceCacheDirGateFailure) instead of skipping them here.
  for (const gated of VERSION_GATED_FLAGS) {
    const gatedArgv = gated.argv(inputs);
    if (gatedArgv === undefined) {
      continue;
    }
    if (!engineAtLeast(engineVersion, gated.minVersion)) {
      core.info(gated.skipNote(engineVersion));
      continue;
    }
    args.push(...gatedArgv);
  }
  // #458 scope/cache options. Single `--flag=value` elements, in a stable
  // order, so a value beginning with `-` (e.g. a fixture id `--weird`) can
  // never be parsed as a separate option, and nothing can be split by a
  // shell: the array goes straight to `spawn`. They are *not* version-gated
  // here — main.ts refuses to start the run at all when the resolved engine
  // cannot honour them (fixtureSurfaceCacheDirGateFailure), because silently
  // dropping a filter would check a different scope than the caller asked.
  if (inputs.fixture !== undefined) {
    args.push(`--fixture=${inputs.fixture}`);
  }
  if (inputs.surface !== undefined) {
    args.push(`--surface=${inputs.surface}`);
  }
  if (inputs.cacheDir !== undefined) {
    args.push(`--cache-dir=${inputs.cacheDir}`);
  }

  return args;
}

/**
 * A `stellar-canary check` flag whose acceptance depends on the engine
 * version (#413): the Action input that sets it, the flag exactly as the
 * engine's CLI spells it, and the first engine release whose `check`
 * accepts it.
 */
interface VersionGatedFlag {
  /** Action input name, as spelled in `action.yml`; used in the skip note. */
  readonly input: string;
  /** The CLI flag exactly as Protocol-Canary's `CheckArgs` spells it. */
  readonly flag: string;
  /** First engine release whose `check` accepts {@link VersionGatedFlag.flag}. */
  readonly minVersion: readonly [number, number, number];
  /** The exact argv to append when the input applies, or `undefined` when
   * it is unset (or `no-cache: false`, which means "engine default"). */
  readonly argv: (inputs: ActionInputs) => readonly string[] | undefined;
  /** What to `core.info` instead of pushing the flag when the resolved
   * engine predates `minVersion`: must name the input and the required
   * version, so a set-but-skipped input is never a silent no-op. */
  readonly skipNote: (engineVersion: string | undefined) => string;
}

/** Builds the uniform skip note: names the input, the engine actually
 * resolved, the flag, and the first engine release that accepts it. */
function requiresNote(
  input: string,
  flag: string,
  minVersion: readonly [number, number, number],
): (engineVersion: string | undefined) => string {
  const required = `${flag} requires Canary ${minVersion.join(".")} or newer.`;
  return (engineVersion) =>
    engineVersion === undefined
      ? `"${input}" has no effect: the engine version could not be resolved; ${required}`
      : `"${input}" has no effect with Canary ${engineVersion}: ${required}`;
}

/** The first engine release whose `check` accepts `--allow-empty`. Earlier
 * releases already exit 0 on a run that executes nothing, so the flag is not
 * needed there and would be rejected as an unknown argument. */
const ALLOW_EMPTY_FLAG: VersionGatedFlag = {
  input: "allow-empty",
  flag: "--allow-empty",
  minVersion: [0, 2, 0],
  argv: (inputs) => (inputs.allowEmpty ? ["--allow-empty"] : undefined),
  // The note keeps the wording it has had since `allow-empty` was the only
  // gated input — existing tests assert this exact frame, and it is the
  // accurate one here: older engines already pass an empty run.
  skipNote: (engineVersion) =>
    engineVersion === undefined
      ? `"allow-empty" was not passed: the engine version could not be resolved.`
      : `"allow-empty" has no effect with Canary ${engineVersion}: ` +
        "that version already passes a run that executes nothing.",
};

/** The first release whose `check` accepts `--network-passphrase`,
 * `--rpc-max-retries` and `--rpc-retry-delay-ms`. Main carried this gate as
 * `engineSupportsNetworkPassphraseAndRpcRetrySettings` with the matching
 * constant; the gate now lives in the table instead. These flags first
 * appear in the Protocol-Canary 0.3.0 development line; older and unknown
 * engines must never receive flags they would reject. */
const NETWORK_PASSPHRASE_AND_RPC_RETRIES_MIN_VERSION: readonly [number, number, number] = [0, 3, 0];

/** Placeholder first release for `--fail-on-warning` and `--offline`,
 * carried over verbatim from main's `FAIL_ON_WARNING_AND_OFFLINE_MIN_VERSION`
 * (formerly in src/inputs.ts) together with its TODO: no released
 * Protocol-Canary accepts these flags yet, so the value may only change when
 * Protocol-Canary publishes the release containing PRs #567 and #527. */
// TODO(#421): Replace this placeholder when Protocol-Canary publishes the
// release containing PRs #567 and #527.
const FAIL_ON_WARNING_AND_OFFLINE_MIN_VERSION: readonly [number, number, number] = [999_999_999, 0, 0];

const NETWORK_PASSPHRASE_FLAG: VersionGatedFlag = {
  input: "network-passphrase",
  flag: "--network-passphrase",
  minVersion: NETWORK_PASSPHRASE_AND_RPC_RETRIES_MIN_VERSION,
  argv: (inputs) =>
    inputs.networkPassphrase !== undefined ? ["--network-passphrase", inputs.networkPassphrase] : undefined,
  skipNote: requiresNote(
    "network-passphrase",
    "--network-passphrase",
    NETWORK_PASSPHRASE_AND_RPC_RETRIES_MIN_VERSION,
  ),
};

const RPC_MAX_RETRIES_FLAG: VersionGatedFlag = {
  input: "rpc-max-retries",
  flag: "--rpc-max-retries",
  minVersion: NETWORK_PASSPHRASE_AND_RPC_RETRIES_MIN_VERSION,
  argv: (inputs) =>
    inputs.rpcMaxRetries !== undefined ? ["--rpc-max-retries", String(inputs.rpcMaxRetries)] : undefined,
  skipNote: requiresNote("rpc-max-retries", "--rpc-max-retries", NETWORK_PASSPHRASE_AND_RPC_RETRIES_MIN_VERSION),
};

const RPC_RETRY_DELAY_MS_FLAG: VersionGatedFlag = {
  input: "rpc-retry-delay-ms",
  flag: "--rpc-retry-delay-ms",
  minVersion: NETWORK_PASSPHRASE_AND_RPC_RETRIES_MIN_VERSION,
  argv: (inputs) =>
    inputs.rpcRetryDelayMs !== undefined ? ["--rpc-retry-delay-ms", String(inputs.rpcRetryDelayMs)] : undefined,
  skipNote: requiresNote("rpc-retry-delay-ms", "--rpc-retry-delay-ms", NETWORK_PASSPHRASE_AND_RPC_RETRIES_MIN_VERSION),
};

const FAIL_ON_WARNING_FLAG: VersionGatedFlag = {
  input: "fail-on-warning",
  flag: "--fail-on-warning",
  minVersion: FAIL_ON_WARNING_AND_OFFLINE_MIN_VERSION,
  argv: (inputs) => (inputs.failOnWarning ? ["--fail-on-warning"] : undefined),
  skipNote: requiresNote("fail-on-warning", "--fail-on-warning", FAIL_ON_WARNING_AND_OFFLINE_MIN_VERSION),
};

const OFFLINE_FLAG: VersionGatedFlag = {
  input: "offline",
  flag: "--offline",
  minVersion: FAIL_ON_WARNING_AND_OFFLINE_MIN_VERSION,
  argv: (inputs) => (inputs.offline ? ["--offline"] : undefined),
  skipNote: requiresNote("offline", "--offline", FAIL_ON_WARNING_AND_OFFLINE_MIN_VERSION),
};

/** The four check options Protocol-Canary 0.2.0 released alongside
 * `--allow-empty` (#413); all are gated on that same first release. */
const ENGINE_CHECK_OPTIONS_MIN_VERSION: readonly [number, number, number] = [0, 2, 0];

const RPC_TIMEOUT_FLAG: VersionGatedFlag = {
  input: "rpc-timeout-seconds",
  flag: "--rpc-timeout",
  minVersion: ENGINE_CHECK_OPTIONS_MIN_VERSION,
  argv: (inputs) =>
    inputs.rpcTimeoutSeconds !== undefined ? ["--rpc-timeout", String(inputs.rpcTimeoutSeconds)] : undefined,
  skipNote: requiresNote("rpc-timeout-seconds", "--rpc-timeout", ENGINE_CHECK_OPTIONS_MIN_VERSION),
};

const MAX_CONCURRENCY_FLAG: VersionGatedFlag = {
  input: "max-concurrency",
  flag: "--max-concurrency",
  minVersion: ENGINE_CHECK_OPTIONS_MIN_VERSION,
  argv: (inputs) =>
    inputs.maxConcurrency !== undefined ? ["--max-concurrency", String(inputs.maxConcurrency)] : undefined,
  skipNote: requiresNote("max-concurrency", "--max-concurrency", ENGINE_CHECK_OPTIONS_MIN_VERSION),
};

const NO_CACHE_FLAG: VersionGatedFlag = {
  input: "no-cache",
  flag: "--no-cache",
  minVersion: ENGINE_CHECK_OPTIONS_MIN_VERSION,
  // `no-cache: false` is the engine default (cache enabled) — no flag to
  // forward, and no skip note: the run behaves as the input asked.
  argv: (inputs) => (inputs.noCache === true ? ["--no-cache"] : undefined),
  skipNote: requiresNote("no-cache", "--no-cache", ENGINE_CHECK_OPTIONS_MIN_VERSION),
};

const LIVE_CACHE_TTL_FLAG: VersionGatedFlag = {
  input: "live-cache-ttl-seconds",
  flag: "--live-cache-ttl",
  minVersion: ENGINE_CHECK_OPTIONS_MIN_VERSION,
  argv: (inputs) =>
    inputs.liveCacheTtlSeconds !== undefined
      ? ["--live-cache-ttl", String(inputs.liveCacheTtlSeconds)]
      : undefined,
  skipNote: requiresNote("live-cache-ttl-seconds", "--live-cache-ttl", ENGINE_CHECK_OPTIONS_MIN_VERSION),
};

/**
 * Every version-gated `check` flag, in the order it is appended to argv.
 * The whole table is emitted right after `--fixtures-dir`, before the
 * ungated `--fixture`/`--surface`/`--cache-dir` forwarding. Main's flags
 * keep the relative order main's inline implementation emitted them in
 * (`--network-passphrase`, `--rpc-max-retries`, `--rpc-retry-delay-ms`,
 * `--allow-empty`, `--fail-on-warning`, `--offline`); #413's four options
 * are appended after them in a stable, documented position.
 */
const VERSION_GATED_FLAGS: readonly VersionGatedFlag[] = [
  NETWORK_PASSPHRASE_FLAG,
  RPC_MAX_RETRIES_FLAG,
  RPC_RETRY_DELAY_MS_FLAG,
  ALLOW_EMPTY_FLAG,
  FAIL_ON_WARNING_FLAG,
  OFFLINE_FLAG,
  RPC_TIMEOUT_FLAG,
  MAX_CONCURRENCY_FLAG,
  NO_CACHE_FLAG,
  LIVE_CACHE_TTL_FLAG,
];

/** True when `version` (a bare `x.y.z`) is at least `min`. An unknown or
 * unparseable version compares as older than every release, so a gate never
 * opens for an engine whose vintage is unknown — the Action never passes an
 * argument an older engine would reject. */
function engineAtLeast(version: string | undefined, min: readonly [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (match === null) {
    return false;
  }
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i++) {
    const minPart = min[i] as number;
    const part = parts[i] as number;
    if (part !== minPart) {
      return part > minPart;
    }
  }
  return true;
}

/** True when `version` (a bare `x.y.z`) is `0.2.0` or newer — that is, when
 * the engine accepts `--allow-empty`. Kept as the named gate the
 * `allow-empty` tests have always used; it is now simply {@link engineAtLeast}
 * over {@link ALLOW_EMPTY_FLAG}'s minimum. */
export function engineSupportsAllowEmpty(version: string | undefined): boolean {
  return engineAtLeast(version, ALLOW_EMPTY_FLAG.minVersion);
}

/**
 * The first published Protocol-Canary release whose `check` accepts all of
 * `--fixture`, `--surface`, and `--cache-dir` together (#458). They exist on
 * the engine's `main` (Protocol-Canary PRs #568 and #564) but not in any
 * published release yet (absent from `v0.2.0`'s `CheckArgs`), so the constant
 * is `undefined` — meaning "no released engine supports these inputs".
 *
 * Do not set this to a guessed version: it may only be set to a release tag
 * whose `CheckArgs` has been read and confirmed to contain all three options,
 * after a maintainer names that release on issue #458.
 */
export const FIXTURE_SURFACE_CACHE_DIR_MIN_VERSION: readonly [number, number, number] | undefined = undefined;

/** True when `version` (a bare `x.y.z`) may receive `--fixture`, `--surface`,
 * and `--cache-dir`. Always false while
 * {@link FIXTURE_SURFACE_CACHE_DIR_MIN_VERSION} is `undefined`, and false for
 * unknown or unparseable versions — the Action never passes a flag an engine
 * would reject, and never silently drops one either (see
 * {@link fixtureSurfaceCacheDirGateFailure}). */
export function engineSupportsFixtureSurfaceCacheDir(version: string | undefined): boolean {
  if (FIXTURE_SURFACE_CACHE_DIR_MIN_VERSION === undefined) {
    return false;
  }
  return engineAtLeast(version, FIXTURE_SURFACE_CACHE_DIR_MIN_VERSION);
}

/**
 * Fail-clearly gate for `fixture`, `surface`, and `cache-dir` (#458):
 * returns the failure message when any of those inputs is set but the
 * resolved engine release cannot honour it, otherwise `undefined`.
 *
 * This deliberately differs from `allow-empty` and the 0.3.0 network inputs,
 * which only relax behaviour and are therefore ignored with a note. A
 * dropped `fixture` or `surface` filter would run the *whole* suite and
 * report success for a different scope than the caller asked for, and a
 * dropped `cache-dir` would store results somewhere else — so the run must
 * not start at all. The message names each offending input, the resolved
 * version, and either the minimum supporting release or the fact that no
 * released engine supports these inputs yet.
 */
export function fixtureSurfaceCacheDirGateFailure(
  version: string,
  setInputs: readonly string[],
): string | undefined {
  if (setInputs.length === 0 || engineSupportsFixtureSurfaceCacheDir(version)) {
    return undefined;
  }
  const plural = setInputs.length > 1;
  const minimum =
    FIXTURE_SURFACE_CACHE_DIR_MIN_VERSION === undefined
      ? `no released Protocol-Canary engine supports ${plural ? "them" : "it"} yet`
      : `the minimum Protocol-Canary release supporting ${plural ? "them" : "it"} is ${FIXTURE_SURFACE_CACHE_DIR_MIN_VERSION.join(".")}`;
  return (
    `The ${setInputs.map((name) => `"${name}"`).join(", ")} input${plural ? "s" : ""} ` +
    `${plural ? "are" : "is"} set, but Canary ${version} cannot honour ${plural ? "them" : "it"}: ` +
    `${minimum}. Omit ${plural ? "those inputs" : "that input"} or use a Protocol-Canary release ` +
    "that supports it; running anyway would silently check a different scope than requested."
  );
}

/** Outcome of an optional JUnit rendering attempt (#423). Exactly one field
 * is present: `path` when the XML file was written, `reason` otherwise. */
export interface JUnitRenderOutcome {
  readonly path?: string;
  readonly reason?: string;
}

/** Path of the JUnit file derived from the JSON report path: the report's
 * `.json` suffix (or the whole path when it has none) plus `.junit.xml`, so
 * both files always live in the same directory. */
export function junitFilePath(reportPath: string): string {
  return reportPath.endsWith(".json") ? `${reportPath.slice(0, -5)}.junit.xml` : `${reportPath}.junit.xml`;
}

/**
 * Renders the JSON report to JUnit XML through the engine's own command:
 * `stellar-canary report <report.json> --format junit` (#423). Uses the
 * engine's renderer so the format has exactly one definition; this Action
 * never writes XML itself.
 *
 * Auxiliary by design: every failure mode — an engine release without the
 * `report` command (it exits non-zero), a failing render, empty stdout, a
 * missing report file, a spawn/timeout error — is captured as a `reason`
 * instead of thrown, so the caller can warn and leave `status` untouched.
 * `leadArgs` carries leading argv elements (the Windows test fixture runs
 * the mock script through `node`); production callers pass nothing.
 */
export async function renderJUnitReport(
  binaryPath: string,
  reportPath: string,
  timeoutMs: number,
  leadArgs: readonly string[] = [],
): Promise<JUnitRenderOutcome> {
  const junitPath = junitFilePath(reportPath);
  try {
    const execution = await runCheck(
      binaryPath,
      [...leadArgs, "report", reportPath, "--format", "junit"],
      timeoutMs,
    );
    if (execution.exitCode !== 0) {
      const diagnostic = extractDiagnostic(execution.stderr);
      return {
        reason:
          `the engine's report command exited with code ${String(execution.exitCode)}` +
          (diagnostic !== "" ? `: ${diagnostic}` : ""),
      };
    }
    if (execution.stdout.trim() === "") {
      return { reason: "the engine's report command produced no output" };
    }
    fs.writeFileSync(junitPath, execution.stdout, "utf8");
    return { path: junitPath };
  } catch (error) {
    return { reason: describeError(error) };
  }
}

/**
 * Reads and validates a `baseline-report` file (#344).
 *
 * The file must be a complete, schemaVersion-1 Canary report: the same
 * validation applied to the engine's own stdout is reused here, so a baseline
 * cannot smuggle in a shape the summary/receipt code would not accept. All
 * failures are raised as {@link InvalidInputError} naming the
 * `baseline-report` input, because the problem is the caller-supplied file,
 * not the engine run.
 *
 * This does not diff anything. The engine's `diff` command is not released
 * (#335), so a valid baseline proves only that the file is usable as a
 * baseline — the Action never reports a regression verdict from it.
 */
export function loadBaselineReport(filePath: string): CanaryReport {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new InvalidInputError(
      `Invalid "baseline-report" input: ${JSON.stringify(filePath)}. ` +
        `The file could not be read: ${describeError(error)}`,
    );
  }
  if (contents.trim() === "") {
    throw new InvalidInputError(
      `Invalid "baseline-report" input: ${JSON.stringify(filePath)}. The baseline report is empty.`,
    );
  }
  try {
    return parseReport(contents);
  } catch (error) {
    throw new InvalidInputError(
      `Invalid "baseline-report" input: ${JSON.stringify(filePath)}. ` +
        `The baseline is not a valid Protocol Canary report: ${describeError(error)}`,
    );
  }
}

/**
 * Rejects a baseline recorded for a different target protocol (#344). A
 * report for protocol 27 says nothing about a run targeting protocol 28, so
 * comparing them — once diffing exists — would be meaningless. The message
 * names both protocols so the caller can fix the baseline or the `protocol`
 * input without digging through the run log.
 */
export function assertBaselineProtocol(
  baseline: CanaryReport,
  current: CanaryReport,
  baselinePath: string,
): void {
  if (baseline.targetProtocol !== current.targetProtocol) {
    throw new InvalidInputError(
      `Incompatible baseline report: ${JSON.stringify(baselinePath)} targets protocol ` +
        `${String(baseline.targetProtocol)}, but this run targets protocol ${String(current.targetProtocol)}. ` +
        "A baseline can only be compared with a report for the same target protocol.",
    );
  }
}

const SIGNALS_TO_FORWARD: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/**
 * Maximum UTF-8 bytes of the sanitized root diagnostic tail, including the
 * truncation notice (#499). The first root-error line is still selected,
 * but oversized lines keep their end. Full stderr is handled separately
 * by the bounded log group and execution-failure summary.
 */
export const MAX_DIAGNOSTIC_LENGTH = 500;

/**
 * Node clamps `setTimeout` delays above this value (2,147,483,647 ms, about
 * 35,791 minutes) and fires them after 1 ms instead, so a timeout beyond it
 * would silently end the run almost immediately. `runCheck` rejects any
 * `timeoutMs` above it — or not a positive finite number — before spawning,
 * so direct callers and future inputs can never hand the engine an
 * immediate-firing timer.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/** Lines that read as the engine's root failure message, in priority order. */
const ROOT_DIAGNOSTIC = /^(?:error|panic|fatal|failed|failure|no checks ran|invalid|unknown|unsupported|could not|cannot)\b/i;

/**
 * Extracts the root diagnostic message from the engine's stderr (#351).
 * Failure exits often bury the one useful line under progress output, so
 * the first line that reads as a root failure message wins; otherwise the
 * first non-empty line is used. Returns `""` when stderr carries nothing
 * actionable, so callers can fall back to the report (or nothing) instead
 * of annotating an empty diagnostic.
 */
export function extractDiagnostic(stderr: string): string {
  // Redact the entire input before line selection: environment secrets may
  // span lines, and selecting first would expose fragments.
  const lines = sanitizeLogText(stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) {
    return "";
  }
  const root = lines.find((line) => ROOT_DIAGNOSTIC.test(line)) ?? lines[0];
  if (root === undefined) {
    return "";
  }
  return truncateLogTail(root, 1, MAX_DIAGNOSTIC_LENGTH).text;
}

/**
 * How long a timed-out Canary process is given to exit after `SIGTERM`
 * before it is forcefully killed with `SIGKILL`. A process that ignores
 * `SIGTERM` (for example one blocked in an uninterruptible network call)
 * must not outlive the Action's own timeout, or it would keep burning
 * runner minutes until GitHub's much longer job timeout.
 */
export const SIGKILL_GRACE_MS = 5000;

/**
 * Maximum stdout captured from `stellar-canary check` (64 MiB).
 * If the engine emits more than this limit, the process is terminated and the run
 * fails with a `CanaryExecutionFailedError` rather than exhausting runner memory.
 */
export const MAX_STDOUT_CAPTURE_BYTES = 64 * 1024 * 1024;

/**
 * Maximum stderr captured from `stellar-canary check` (1 MiB).
 * If stderr exceeds this limit, earlier output is dropped and the tail is retained
 * with a notice so that root diagnostics remain visible without unbounded memory growth.
 */
export const MAX_STDERR_CAPTURE_BYTES = 1 * 1024 * 1024;

/** Notice prepended to stderr when earlier output was dropped due to exceeding capture limits. */
export const STDERR_DROPPED_NOTICE = "[... earlier output dropped ...]\n";

function sliceTailSafely(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) {
    return str;
  }
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
    start++;
  }
  return buf.subarray(start).toString("utf8");
}

/**
 * Floor for the `cargo install` time bound derived from `timeout-minutes`.
 *
 * `timeout-minutes` is documented as bounding the `stellar-canary check`
 * process, so a user may set it very low without expecting installation to
 * be affected; clamping the install bound to at least one minute keeps such
 * configurations working while still guaranteeing (per issue #65) that a
 * hung `cargo install` can never outlive the Action's own timeout path and
 * block the job until GitHub's much longer job-level timeout.
 */
export const CARGO_INSTALL_TIMEOUT_FLOOR_MS = 60_000;

/**
 * Runs a Canary binary with the given arguments, capturing stdout and
 * stderr separately, enforcing `timeoutMs`, and forwarding cancellation
 * signals to the child process so a cancelled workflow does not leave it
 * orphaned.
 *
 * Resolves with the process's own exit code/signal in all normal cases —
 * it never throws for a *non-zero* Canary exit code, since that is a
 * meaningful result the caller must interpret, not a failure of this
 * function. It throws only when the process could not be run at all, or
 * was killed for exceeding its timeout.
 *
 * Takes `args`, `timeoutMs`, and the `sigkillGraceMs` grace period
 * directly (rather than an `ActionInputs`) so it can be exercised in
 * tests without minute-granularity timeouts; `main.ts` is the only caller
 * that derives these from real inputs, and it relies on the default grace
 * period.
 */
export function runCheck(
  binaryPath: string,
  args: readonly string[],
  timeoutMs: number,
  sigkillGraceMs: number = SIGKILL_GRACE_MS,
): Promise<CheckExecutionResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
    return Promise.reject(
      new Error(
        `Invalid timeoutMs ${String(timeoutMs)}: expected a positive finite number of milliseconds not ` +
          `exceeding ${MAX_TIMER_MS} (Node's setTimeout limit).`,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    if (typeof child.stdout?.setEncoding === "function") {
      child.stdout.setEncoding("utf8");
    }
    if (typeof child.stderr?.setEncoding === "function") {
      child.stderr.setEncoding("utf8");
    }

    let stdout = "";
    let stdoutBytes = 0;
    let stdoutExceeded = false;
    let stderr = "";
    let stderrBytes = 0;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    let sigkillHandle: NodeJS.Timeout | undefined;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      // Arm the escalation timer *before* signalling: if the process closes
      // synchronously in response to SIGTERM, `cleanup` must see the handle
      // so it can clear it, rather than leaving an orphaned timer that kills
      // (or worse, signals a reused pid) after the fact.
      sigkillHandle = setTimeout(() => {
        child.kill("SIGKILL");
      }, sigkillGraceMs);
      child.kill("SIGTERM");
    }, timeoutMs);
    const forwardSignal = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    for (const signal of SIGNALS_TO_FORWARD) {
      process.on(signal, forwardSignal);
    }

    const cleanup = (): void => {
      clearTimeout(timeoutHandle);
      if (sigkillHandle !== undefined) {
        clearTimeout(sigkillHandle);
      }
      for (const signal of SIGNALS_TO_FORWARD) {
        process.off(signal, forwardSignal);
      }
    };

    child.stdout.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stdoutExceeded) {
        return;
      }
      const chunkBytes = Buffer.byteLength(text, "utf8");
      if (stdoutBytes + chunkBytes > MAX_STDOUT_CAPTURE_BYTES) {
        stdoutExceeded = true;
        child.stdout.pause();
        child.stdout.destroy();
        if (sigkillHandle === undefined) {
          sigkillHandle = setTimeout(() => {
            child.kill("SIGKILL");
          }, sigkillGraceMs);
        }
        child.kill("SIGTERM");
        return;
      }
      stdout += text;
      stdoutBytes += chunkBytes;
    });

    child.stderr.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const chunkBytes = Buffer.byteLength(text, "utf8");
      stderrBytes += chunkBytes;
      stderr += text;

      if (stderrBytes > MAX_STDERR_CAPTURE_BYTES) {
        stderrTruncated = true;
        if (stderr.length > MAX_STDERR_CAPTURE_BYTES * 1.5) {
          stderr = sliceTailSafely(stderr, MAX_STDERR_CAPTURE_BYTES);
        }
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new CanaryExecutionFailedError(`Failed to start ${binaryPath}: ${error.message}`));
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      let finalStderr = stderr;
      if (stderrTruncated) {
        const noticeBuf = Buffer.from(STDERR_DROPPED_NOTICE, "utf8");
        const targetBytes = Math.max(0, MAX_STDERR_CAPTURE_BYTES - noticeBuf.length);
        const tail = sliceTailSafely(stderr, targetBytes);
        finalStderr = `${STDERR_DROPPED_NOTICE}${tail}`;
      }

      if (stdoutExceeded) {
        reject(
          new CanaryExecutionFailedError(
            `Canary stdout exceeded limit of ${String(MAX_STDOUT_CAPTURE_BYTES / (1024 * 1024))} MiB and output was truncated; process terminated.`,
          ),
        );
        return;
      }

      if (timedOut) {
        reject(
          new TimeoutError(
            `Stellar Protocol Canary timed out after ${String(Math.round(timeoutMs / 1000))}s and was terminated.`,
            stdout,
            finalStderr,
          ),
        );
        return;
      }

      resolve({ exitCode, signal, stdout, stderr: finalStderr });
    });
  });
}
