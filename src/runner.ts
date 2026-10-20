import * as core from "@actions/core";
import { spawn } from "node:child_process";

import type { ActionInputs } from "./inputs";
import { CanaryExecutionFailedError, TimeoutError } from "./errors";

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
  args.push("--fixtures-dir", inputs.fixturesDir);

  // Version-gated flags (#413): every flag whose acceptance depends on the
  // engine release is declared in VERSION_GATED_FLAGS with the first release
  // that accepts it. An input that is set but whose resolved engine predates
  // that release is skipped with a `core.info` note — never passed to an
  // engine that would reject it as an unknown argument. The argv is always
  // an array of discrete elements; nothing here is ever a shell string.
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

/** Every version-gated `check` flag, in the order it is appended to argv. */
const VERSION_GATED_FLAGS: readonly VersionGatedFlag[] = [
  ALLOW_EMPTY_FLAG,
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
 * `allow-empty` tests and `src/main.ts` consumers have always used; it is
 * now simply {@link engineAtLeast} over {@link ALLOW_EMPTY_FLAG}'s minimum. */
export function engineSupportsAllowEmpty(version: string | undefined): boolean {
  return engineAtLeast(version, ALLOW_EMPTY_FLAG.minVersion);
}

const SIGNALS_TO_FORWARD: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/**
 * Longest root diagnostic kept from the engine's stderr (#351). Everything
 * beyond this (full backtraces, repeated retries) is dropped from the
 * annotation, which is meant to show the one message that explains the
 * failure, not the whole log — the full stderr still lands in the job log
 * and in the execution-failure summary.
 */
export const MAX_DIAGNOSTIC_LENGTH = 500;

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
  const lines = stderr
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
  return root.length > MAX_DIAGNOSTIC_LENGTH ? `${root.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…` : root;
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
