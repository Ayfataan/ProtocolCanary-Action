import * as core from "@actions/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { uploadReport } from "./artifact";
import { emitAnnotations, emitExecutionFailureAnnotation, emitExitFailureAnnotation } from "./annotations";
import { cargoInstallTimeoutMs, ensureCanaryInstalled } from "./canary";
import { describeError, isCanaryActionError } from "./errors";
import type { ActionInputs } from "./inputs";
import { getInputs } from "./inputs";
import { classifyCoverage, countReplayed, describeExitCode, parseReport } from "./output";
import { buildCheckArgs, engineSupportsAllowEmpty, extractDiagnostic, runCheck } from "./runner";
import { renderExecutionFailureMarkdown, renderSummaryMarkdown, writeSummary } from "./summary";
import { resolveVersion } from "./version";

function reportFilePath(): string {
  const dir = process.env.RUNNER_TEMP ?? os.tmpdir();
  return path.join(dir, "stellar-canary-report.json");
}

/**
 * A stable, human-readable suffix describing what this invocation checked,
 * used only when the default artifact name is already taken in the same
 * workflow run (a matrix leg or a second Action step). Returns `undefined`
 * when no inputs distinguish this invocation, in which case the upload
 * falls back to a short unique suffix instead.
 */
function artifactDifferentiator(inputs: ActionInputs): string | undefined {
  const parts: string[] = [];
  if (inputs.protocol !== undefined) {
    parts.push(`protocol-${String(inputs.protocol)}`);
  }
  if (inputs.network !== undefined) {
    parts.push(`network-${inputs.network}`);
  }
  if (inputs.config !== undefined) {
    parts.push(`config-${path.basename(inputs.config)}`);
  }
  return parts.length > 0 ? parts.join("-") : undefined;
}

/** Handles every case where Canary did not produce a usable report at all
 * (install failure, process error, timeout, or malformed JSON) —
 * distinct from a real compatibility failure per section 29. */
async function handleExecutionFailure(reason: string, diagnostic: string, annotate: boolean): Promise<void> {
  core.setFailed(`Protocol Canary could not be executed.\n\nReason:\n${reason}`);
  if (annotate) {
    emitExecutionFailureAnnotation(reason, diagnostic);
  }
  try {
    await writeSummary(renderExecutionFailureMarkdown(reason, diagnostic));
  } catch (error) {
    core.setFailed(describeError(error));
  }
  core.setOutput("status", "execution-failed");
  core.setOutput("passed", "0");
  core.setOutput("warnings", "0");
  core.setOutput("failures", "0");
  core.setOutput("errors", "0");
  // No report was produced, so no fixture can be claimed as executed. #333:
  // set explicitly so a downstream job reading `coverage-state` sees `none`
  // rather than an unset (empty) output on the execution-failure path.
  core.setOutput("coverage-state", "none");
  core.setOutput("replayed-count", "0");
}

/**
 * Orchestrates one Action run, in order: read and validate inputs, resolve
 * the requested version to a pinned commit, ensure a matching binary is
 * installed, execute the compatibility check, parse stdout into a report,
 * emit annotations, write the job summary, set the Action outputs, and
 * optionally upload the report artifact.
 *
 * Returns early — never throwing past the Action boundary — when Canary
 * could not be run at all: invalid inputs are reported directly via
 * `core.setFailed`, while an install failure, an abnormal process exit (or
 * timeout), or an unparseable report go through `handleExecutionFailure`.
 * These are deliberately distinct from a real compatibility failure, where
 * Canary ran and produced a usable report.
 *
 * Canary's own exit code, not the parsed report, is authoritative for
 * pass/fail (see the final check at the bottom of the function).
 */
export async function run(): Promise<void> {
  let inputs;
  try {
    inputs = getInputs();
  } catch (error) {
    core.setFailed(describeError(error));
    return;
  }

  const resolved = await resolveVersion(inputs.version);
  core.info(
    `Stellar Protocol Canary Action\nCanary version: ${resolved.version} (${resolved.tag}${
      resolved.commitSha !== undefined ? `@${resolved.commitSha.slice(0, 12)}` : ""
    })`,
  );

  let installed;
  try {
    installed = await ensureCanaryInstalled(resolved, cargoInstallTimeoutMs(inputs.timeoutMinutes));
  } catch (error) {
    await handleExecutionFailure(describeError(error), "", inputs.annotations);
    return;
  }

  if (inputs.allowEmpty && !engineSupportsAllowEmpty(resolved.version)) {
    core.info(
      `"allow-empty" has no effect with Canary ${resolved.version}: that version already passes a run that executes nothing.`,
    );
  }

  core.info(`Protocol: ${inputs.protocol !== undefined ? String(inputs.protocol) : "(from configuration)"}`);
  core.info("Running compatibility checks...");

  let execution;
  try {
    execution = await runCheck(installed.binaryPath, buildCheckArgs(inputs, resolved.version), inputs.timeoutMinutes * 60_000);
  } catch (error) {
    await handleExecutionFailure(describeError(error), "", inputs.annotations);
    return;
  }

  const reportPath = reportFilePath();
  if (execution.stdout.trim() !== "") {
    fs.writeFileSync(reportPath, execution.stdout, "utf8");
  }

  if (execution.exitCode === null) {
    await handleExecutionFailure(
      `Canary was terminated by signal ${execution.signal ?? "unknown"}.`,
      execution.stderr,
      inputs.annotations,
    );
    return;
  }

  const exitInfo = describeExitCode(execution.exitCode);

  let report;
  try {
    report = parseReport(execution.stdout);
  } catch (error) {
    await handleExecutionFailure(
      `${exitInfo.description} (exit code ${String(execution.exitCode)}). ${describeError(error)}`,
      execution.stderr,
      inputs.annotations,
    );
    return;
  }

  core.info(`${String(report.counts.passed)}/${String(report.counts.total)} applicable checks passed.`);
  core.info(`Status: ${report.status.toUpperCase()}`);
  const coverageState = classifyCoverage(report);
  core.info(`Coverage: ${coverageState}`);

  if (inputs.annotations) {
    emitAnnotations(report);
    if (execution.exitCode !== 0) {
      // The engine's own exit code failed the run (#351): annotate the root
      // diagnostic from stderr, falling back to the failing result the
      // report itself carries (engines report some failures there only),
      // and finally to nothing — never a fabricated reason.
      const rootResult =
        report.results.find((r) => r.status === "fail") ?? report.results.find((r) => r.status === "error");
      const reportDiagnostic =
        rootResult !== undefined ? `${rootResult.testId} (${rootResult.surface}): ${rootResult.summary}` : "";
      emitExitFailureAnnotation(execution.exitCode, extractDiagnostic(execution.stderr) || reportDiagnostic);
    }
  }

  try {
    await writeSummary(renderSummaryMarkdown(report));
  } catch (error) {
    core.setFailed(describeError(error));
  }

  core.setOutput("status", report.status);
  core.setOutput("passed", String(report.counts.passed));
  core.setOutput("warnings", String(report.counts.warnings));
  core.setOutput("failures", String(report.counts.failed));
  core.setOutput("errors", String(report.counts.errors));
  core.setOutput("replayed-count", String(countReplayed(report)));
  core.setOutput("report", reportPath);
  core.setOutput("coverage-state", coverageState);

  if (inputs.uploadReport) {
    await uploadReport(reportPath, artifactDifferentiator(inputs));
  }

  // Canary's own exit code is authoritative: never recompute pass/fail
  // from the parsed report.
  if (execution.exitCode !== 0) {
    core.setFailed(
      `Stellar Protocol Canary reported ${report.status} (${exitInfo.description}, exit code ${String(execution.exitCode)}).`,
    );
  }
}

/* istanbul ignore next -- exercised via the compiled entry point, not unit tests */
if (require.main === module) {
  run().catch((error: unknown) => {
    core.setFailed(isCanaryActionError(error) ? error.message : describeError(error));
  });
}
