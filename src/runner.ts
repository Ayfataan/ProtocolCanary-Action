import { spawn } from "node:child_process";
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
  args.push("--fixtures-dir", inputs.fixturesDir);
  if (inputs.allowEmpty && engineSupportsAllowEmpty(engineVersion)) {
    args.push("--allow-empty");
  }

  return args;
}

/** The first engine release whose `check` accepts `--allow-empty`. Earlier
 * releases already exit 0 on a run that executes nothing, so the flag is not
 * needed there and would be rejected as an unknown argument. */
const ALLOW_EMPTY_MIN_VERSION: readonly [number, number, number] = [0, 2, 0];

/** True when `version` (a bare `x.y.z`) is `0.2.0` or newer. An unknown or
 * unparseable version is treated as not supporting the flag, so the Action
 * never passes an argument an older engine would reject. */
export function engineSupportsAllowEmpty(version: string | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (match === null) {
    return false;
  }
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i++) {
    const min = ALLOW_EMPTY_MIN_VERSION[i] as number;
    const part = parts[i] as number;
    if (part !== min) {
      return part > min;
    }
  }
  return true;
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
