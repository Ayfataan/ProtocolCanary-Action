import * as core from "@actions/core";

import { formatSafeDiagnosticTail } from "./log-block";
import { describeExitCode } from "./output";
import type { CanaryReport } from "./output";

const TITLE = "Stellar Protocol Canary";

const STATUS_LABEL: Readonly<Record<string, string>> = {
  fail: "compatibility failure",
  error: "execution error",
  warning: "warning",
};

/**
 * Converts fail/error/warning results into GitHub annotations. No fixture
 * in the documented report schema carries a file/line location, so every
 * annotation is a general workflow-level one (`core.error`/`core.warning`
 * with no `AnnotationProperties.file`) — never a fabricated location.
 * Passing and skipped results never produce an annotation: they are not
 * actionable.
 */
export function emitAnnotations(report: CanaryReport): void {
  for (const result of report.results) {
    const label = STATUS_LABEL[result.status] ?? result.status;
    const message = `[${result.surface}] ${result.testId}: [${label}] ${result.summary}`;
    if (result.status === "fail" || result.status === "error") {
      core.error(message, { title: TITLE });
    } else if (result.status === "warning") {
      core.warning(message, { title: TITLE });
    }
  }
}

/**
 * Emits a workflow-level error annotation when Canary could not be executed
 * or did not produce a usable report. Use this for execution failures
 * (install, process, timeout, or parse errors) instead of `emitAnnotations`,
 * which annotates individual results from a report. Like `emitAnnotations`,
 * this never attaches a file/line location.
 *
 * When a diagnostic is available (the engine's stderr, a timeout notice), it
 * is appended so the annotation shows the engine's own reason instead of only
 * a generic "could not be executed" (issue #351). Reasons and diagnostics
 * are sanitized before bounding: each retains at most 40 tail lines plus
 * the truncation notice, within 8 KiB UTF-8 including that notice. Fixed
 * annotation labels are outside this content budget (#499).
 */
export function emitExecutionFailureAnnotation(reason: string, diagnostic?: string): void {
  const message = `Protocol Canary could not be executed: ${formatSafeDiagnosticTail(reason)}`;
  const detail = formatSafeDiagnosticTail(diagnostic ?? "").trim();
  core.error(detail === "" ? message : `${message}\nEngine diagnostic: ${detail}`, { title: TITLE });
}

/**
 * Emits a workflow-level error annotation when a supplied `baseline-report`
 * cannot be used (#344): the file is missing, is not a Canary report, or was
 * recorded for a different target protocol. Kept distinct from the
 * execution-failure annotation because Canary itself ran successfully; the
 * failure is in the comparison input, not the engine.
 */
export function emitBaselineFailureAnnotation(reason: string): void {
  core.error(`Protocol Canary baseline validation failed: ${reason}`, { title: TITLE });
}

/**
 * The engine exit code arrived, but the run did not pass (#351): turn the
 * exit code into an explicit classification plus the engine's own root
 * diagnostic, instead of a bare "Process exited with code N".
 *
 * Exit code 1 is classified as test assertion failures, exit code 2 as the
 * regression gate (or an invalid configuration), and exit code 3 as an
 * unexpected runtime crash — never as a regression — following
 * {@link describeExitCode}'s contract table.
 *
 * Diagnostics use the same 8 KiB / 40 tail-line budget as execution
 * failures, including the truncation notice in the byte budget (#499).
 *
 * Like every other annotation this Action emits, it carries no file/line
 * location: no fixture in the report schema carries one.
 */
export function emitExitFailureAnnotation(exitCode: number, diagnostic: string): void {
  const exitInfo = describeExitCode(exitCode);
  const message = `Stellar Protocol Canary reported a failure (exit code ${String(exitCode)}): ${exitInfo.description}`;
  const detail = formatSafeDiagnosticTail(diagnostic).trim();
  core.error(detail === "" ? message : `${message}\nEngine diagnostic: ${detail}`, { title: TITLE });
}
