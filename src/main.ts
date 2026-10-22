import * as core from "@actions/core";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { uploadReceipt, uploadReport } from "./artifact";
import {
  emitAnnotations,
  emitBaselineFailureAnnotation,
  emitExecutionFailureAnnotation,
  emitExitFailureAnnotation,
} from "./annotations";
import { cargoInstallTimeoutMs, ensureCanaryInstalled, sha256File } from "./canary";
import { InstallationFailedError, TimeoutError, describeError, isCanaryActionError } from "./errors";
import type { ActionInputs } from "./inputs";
import { getInputs, validateFixturesDir } from "./inputs";
import { printLogBlock } from "./log-block";
import { countReplayed, describeExitCode, parseReport, resolvePackIdentity } from "./output";
import type { CanaryReport } from "./output";
import { buildReceipt, serializeReceipt } from "./receipt";
import {
  assertBaselineProtocol,
  buildCheckArgs,
  engineSupportsAllowEmpty,
  extractDiagnostic,
  loadBaselineReport,
  runCheck,
} from "./runner";
import { renderExecutionFailureMarkdown, renderSummaryMarkdown, writeSummary } from "./summary";
import { resolveVersion } from "./version";

/** Maximum length of the sanitized `GITHUB_ACTION` identifier embedded in
 * the report filename (#399), keeping the name short on every filesystem. */
const REPORT_IDENTIFIER_MAX_LENGTH = 64;

/** Step identifier used when `GITHUB_ACTION` is unset or sanitizes to
 * nothing usable (#399). */
const FALLBACK_ACTION_IDENTIFIER = "action";

/**
 * Reduces the untrusted `GITHUB_ACTION` environment variable to a single
 * safe path component (#399): every run of characters outside ASCII
 * letters, digits, `-` and `_` collapses to one hyphen, leading/trailing
 * hyphens are trimmed, and the result is length-capped. Path separators,
 * traversal sequences, spaces, and Unicode therefore can never survive
 * into the generated filename.
 */
export function sanitizeActionIdentifier(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, REPORT_IDENTIFIER_MAX_LENGTH)
    .replace(/-+$/, "");
}

/**
 * The report path for *this* Action invocation (#399): a uniquely named
 * JSON file directly inside the runner's temporary directory
 * (`RUNNER_TEMP`, falling back to `os.tmpdir()`), so two invocations in
 * one job — a second Action step, or a matrix leg sharing the runner —
 * never overwrite each other's report.
 *
 * The filename is `stellar-canary-report-<step>-<random>.json`, where
 * `<step>` is the sanitized `GITHUB_ACTION` identifier (a safe fallback
 * when it is missing or empty) and `<random>` is a short cryptographically
 * random hex suffix, so uniqueness never depends on the identifier alone.
 * The filename is a single path component built only from `[A-Za-z0-9_-]`,
 * so resolving it cannot escape the temp directory.
 *
 * `run()` calls this exactly once per invocation and reuses the result for
 * writing the report, the `report` output, and the artifact upload — the
 * path is never regenerated after the file has been written.
 */
export function reportFilePath(): string {
  const dir = process.env.RUNNER_TEMP ?? os.tmpdir();
  const sanitized = sanitizeActionIdentifier(process.env.GITHUB_ACTION ?? "");
  const step = sanitized !== "" ? sanitized : FALLBACK_ACTION_IDENTIFIER;
  const unique = crypto.randomBytes(8).toString("hex");
  return path.resolve(dir, `stellar-canary-report-${step}-${unique}.json`);
}

/** Location of the Execution Receipt written when `generate-receipt` is
 * true (#361 input, #362 export); same temp dir as the report. */
function receiptFilePath(): string {
  const dir = process.env.RUNNER_TEMP ?? os.tmpdir();
  return path.join(dir, "stellar-canary-receipt.json");
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
async function handleExecutionFailure(
  reason: string,
  diagnostic: string,
  annotate: boolean,
  engineVersion: string = "",
): Promise<void> {
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
  core.setOutput("total", "0");
  core.setOutput("skipped", "0");
  core.setOutput("replayed-count", "0");
  core.setOutput("engine-version", engineVersion);
  core.setOutput("observed-protocol", "");
  core.setOutput("pack-protocol", "");
  core.setOutput("pack-version", "");
  core.setOutput("pack-digest", "");
}

/**
 * Orchestrates one Action run, in order: read and validate inputs (including
 * the `fixtures-dir` directory on disk, #400), resolve
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

  // #400: fail fast when `fixtures-dir` does not name an existing directory
  // — after input parsing, before any version resolution or installation
  // work — so a mistyped path costs milliseconds, not a full `cargo
  // install`. Routed through the execution-failure handler so the error
  // reaches the annotation, the job summary, and the failure outputs exactly
  // like every other reason Canary could not be executed.
  try {
    validateFixturesDir(inputs.fixturesDir, inputs.allowEmpty);
  } catch (error) {
    await handleExecutionFailure(describeError(error), "", inputs.annotations, "");
    return;
  }

  // #344: validate a supplied baseline before installing or running anything.
  // The engine's diff command is not released, so this only proves the file is
  // a usable report; it never produces a regression verdict.
  let baselineReport: CanaryReport | undefined;
  if (inputs.baselineReport !== undefined) {
    try {
      baselineReport = loadBaselineReport(inputs.baselineReport);
    } catch (error) {
      const reason = describeError(error);
      core.setFailed(reason);
      if (inputs.annotations) {
        emitBaselineFailureAnnotation(reason);
      }
      return;
    }
  }

  const resolved = await resolveVersion(inputs.version, { token: inputs.githubToken });
  core.info(
    `Stellar Protocol Canary Action\nCanary version: ${resolved.version} (${resolved.tag}${
      resolved.commitSha !== undefined ? `@${resolved.commitSha.slice(0, 12)}` : ""
    })`,
  );

  let installed;
  try {
    installed = await ensureCanaryInstalled(
      resolved,
      cargoInstallTimeoutMs(inputs.timeoutMinutes),
      inputs.githubToken,
      inputs.strictIntegrity,
    );
  } catch (error) {
    const diagnostic = error instanceof InstallationFailedError && error.diagnostic ? error.diagnostic : "";
    await handleExecutionFailure(describeError(error), diagnostic, inputs.annotations, "");
    return;
  }

  if (inputs.allowEmpty && !engineSupportsAllowEmpty(resolved.version)) {
    core.info(
      `"allow-empty" has no effect with Canary ${resolved.version}: that version already passes a run that executes nothing.`,
    );
  }

  core.info(`Protocol: ${inputs.protocol !== undefined ? String(inputs.protocol) : "(from configuration)"}`);
  core.info("Running compatibility checks...");

  // Build the engine arguments for the reproduction command display
  const engineArgs = buildCheckArgs(inputs, resolved.version);

  let execution;
  try {
    execution = await runCheck(installed.binaryPath, engineArgs, inputs.timeoutMinutes * 60_000);
  } catch (error) {
    const diagnostic = error instanceof TimeoutError && error.stderr ? error.stderr : "";
    if (error instanceof TimeoutError && error.stderr.trim() !== "") {
      printLogBlock("Canary diagnostics", error.stderr);
    }
    await handleExecutionFailure(describeError(error), diagnostic, inputs.annotations, resolved.version);
    return;
  }

  if (execution.stderr.trim() !== "") {
    printLogBlock("Canary diagnostics", execution.stderr);
  }

  // #399: generated exactly once per invocation; the same path is reused
  // below for the write, the "report" output, and the artifact upload.
  const reportPath = reportFilePath();
  if (execution.stdout.trim() !== "") {
    fs.writeFileSync(reportPath, execution.stdout, "utf8");
  }

  if (execution.exitCode === null) {
    await handleExecutionFailure(
      `Canary was terminated by signal ${execution.signal ?? "unknown"}.`,
      execution.stderr,
      inputs.annotations,
      resolved.version,
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
      resolved.version,
    );
    return;
  }

  core.info(`${String(report.counts.passed)}/${String(report.counts.total)} applicable checks passed.`);
  core.info(`Status: ${report.status.toUpperCase()}`);

  if (baselineReport !== undefined && inputs.baselineReport !== undefined) {
    try {
      assertBaselineProtocol(baselineReport, report, inputs.baselineReport);
    } catch (error) {
      const reason = describeError(error);
      core.setFailed(reason);
      if (inputs.annotations) {
        emitBaselineFailureAnnotation(reason);
      }
      return;
    }
    core.info(
      `Baseline report ${JSON.stringify(inputs.baselineReport)} validated for protocol ` +
        `${String(report.targetProtocol)}; the engine's diff command is not released, so this run ` +
        "produced no regression verdict.",
    );
  }

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
    // Provenance & Trust section (issue #373): digest of the binary this run
    // actually executed, observed (not verified — decision D-07 bounds that
    // claim). The fixture-pack digest awaits the #338 download pipeline;
    // fields this run cannot produce are rendered as explicitly unverified
    // rather than fabricated, and omitted from the metadata object entirely
    // when there is nothing honest to say.
    let binarySha256: string | undefined;
    try {
      binarySha256 = await sha256File(installed.binaryPath);
    } catch {
      // A binary that vanished between check and reporting is itself
      // diagnostic; the summary says "unverified" instead of guessing.
      core.debug("Provenance: could not hash the executed binary for the summary.");
    }
    await writeSummary(
      renderSummaryMarkdown(report, {
        ...(binarySha256 !== undefined ? { binarySha256 } : {}),
        engineVersion: installed.version,
        // Reproduction command (issue #416): the exact argument array the
        // engine was invoked with, so a reader can rerun the same check.
        engineArgs,
      }),
    );
  } catch (error) {
    core.setFailed(describeError(error));
  }

  core.setOutput("status", report.status);
  core.setOutput("passed", String(report.counts.passed));
  core.setOutput("warnings", String(report.counts.warnings));
  core.setOutput("failures", String(report.counts.failed));
  core.setOutput("errors", String(report.counts.errors));
  core.setOutput("total", String(report.counts.total));
  core.setOutput("skipped", String(report.counts.skipped ?? 0));
  core.setOutput("replayed-count", String(countReplayed(report)));
  core.setOutput("engine-version", installed.version);
  const observedProtocol =
    report.network?.observedProtocol !== undefined &&
    report.network.observedProtocol !== null &&
    !Number.isNaN(report.network.observedProtocol)
      ? String(report.network.observedProtocol)
      : "";
  core.setOutput("observed-protocol", observedProtocol);
  const packIdentity = resolvePackIdentity(report, inputs);
  core.setOutput("pack-protocol", packIdentity.protocol === undefined ? "" : String(packIdentity.protocol));
  core.setOutput("pack-version", packIdentity.version ?? "");
  core.setOutput("pack-digest", packIdentity.digest ?? "");
  core.setOutput("report", reportPath);

  if (inputs.uploadReport) {
    await uploadReport(reportPath, artifactDifferentiator(inputs));
  }

  // #362: strictly opt-in, and auxiliary like the report artifact. A receipt
  // is only produced when Canary actually yielded a report (the
  // execution-failure paths returned above), and neither a write failure nor
  // an upload failure can change the compatibility result.
  if (inputs.generateReceipt) {
    const receiptPath = receiptFilePath();
    let written = false;
    try {
      fs.writeFileSync(receiptPath, serializeReceipt(buildReceipt(report)), "utf8");
      core.setOutput("receipt-path", receiptPath);
      written = true;
    } catch (error) {
      core.warning(`Failed to write the Execution Receipt: ${describeError(error)}`);
    }
    if (written) {
      await uploadReceipt(receiptPath);
    }
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
