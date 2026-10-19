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

    let stdout = "";
    let stderr = "";
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

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
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

      if (timedOut) {
        reject(
          new TimeoutError(
            `Stellar Protocol Canary timed out after ${String(Math.round(timeoutMs / 1000))}s and was terminated.`,
          ),
        );
        return;
      }

      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}
