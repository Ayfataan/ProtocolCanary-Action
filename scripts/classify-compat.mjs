/**
 * Classification logic for compatibility matrix cells.
 *
 * This module is kept pure (no I/O, no GitHub Actions dependencies) so it can
 * be unit tested exhaustively. The workflow calls `classifyCell` for each
 * matrix cell and aggregates the results.
 */

/**
 * @typedef {Object} CellFacts
 * @property {string} engineRef - The engine reference that was tested (e.g., "v0.1.1", "main").
 * @property {string} packRef - The fixture pack reference that was tested (e.g., "protocol-28", "main").
 * @property {string} actionCommit - The Action commit SHA that ran the test.
 * @property {string} runUrl - The GitHub Actions run URL for this cell.
 * @property {"success"|"failure"|"timeout"|"cancelled"} buildOutcome - Build/checkout outcome.
 * @property {string} [actionStatus] - The Action's `status` output.
 * @property {number} [passed] - The Action's `passed` output.
 * @property {number} [failures] - The Action's `failures` output.
 * @property {number} [warnings] - The Action's `warnings` output.
 * @property {number} [errors] - The Action's `errors` output.
 * @property {number} [replayedCount] - The Action's `replayed-count` output.
 * @property {number} [total] - Total checks from `counts.total`.
 * @property {string} [firstDiagnostic] - First line of diagnostic/stderr.
 * @property {boolean} ranNoChecks - Whether the run executed zero checks.
 */

/**
 * @typedef {Object} ExpectationEntry
 * @property {string} engineRef - Engine reference this expectation applies to.
 * @property {string} packRef - Fixture pack reference this expectation applies to.
 * @property {"fail"|"error"|"execution-failed"} expectedStatus - Expected Action status.
 * @property {string} failureSignature - First line of diagnostic that identifies this failure.
 * @property {string} runUrl - URL of the run that produced this expectation (evidence).
 * @property {string} dateAdded - Date the expectation was added (ISO 8601).
 * @property {string} reason - Human-readable reason for the expected incompatibility.
 */

/**
 * @typedef {Object} ClassifiedCell
 * @property {string} engineRef
 * @property {string} packRef
 * @property {string} actionCommit
 * @property {string} runUrl
 * @property {string} classification - One of the CellClassification values.
 * @property {string} reason
 * @property {string} evidence
 */

/**
 * @typedef {"supported"|"expected-incompatible"|"infrastructure"|"skipped"|"unexpected-failure"|"unexpected-pass"} CellClassification
 */

/**
 * Classifies a single matrix cell based on its observed facts and the
 * expectations registry.
 *
 * @param {CellFacts} facts
 * @param {ExpectationEntry[]} expectations
 * @returns {ClassifiedCell}
 */
export function classifyCell(facts, expectations) {
  // 1. Infrastructure failures: build/checkout failure, timeout, cancellation
  if (facts.buildOutcome !== "success") {
    return {
      engineRef: facts.engineRef,
      packRef: facts.packRef,
      actionCommit: facts.actionCommit,
      runUrl: facts.runUrl,
      classification: "infrastructure",
      reason: `Build/checkout ${facts.buildOutcome}: unable to evaluate compatibility`,
      evidence: facts.runUrl,
    };
  }

  // 2. No checks executed
  if (facts.ranNoChecks || (facts.total !== undefined && facts.total === 0)) {
    return {
      engineRef: facts.engineRef,
      packRef: facts.packRef,
      actionCommit: facts.actionCommit,
      runUrl: facts.runUrl,
      classification: "skipped",
      reason: "Cell ran but executed zero checks (no compatible fixtures or empty fixture set)",
      evidence: facts.runUrl,
    };
  }

  // 3. Action ran and produced a status
  const status = facts.actionStatus ?? "unknown";

  // 3a. Pass with at least one executed check
  if (status === "pass") {
    // Check if there's an expectation saying this should fail
    const expectation = expectations.find(
      (e) => e.engineRef === facts.engineRef && e.packRef === facts.packRef,
    );
    if (expectation) {
      return {
        engineRef: facts.engineRef,
        packRef: facts.packRef,
        actionCommit: facts.actionCommit,
        runUrl: facts.runUrl,
        classification: "unexpected-pass",
        reason: `Expected ${expectation.expectedStatus} (${expectation.reason}) but got pass`,
        evidence: `Expected: ${expectation.runUrl} | Actual: ${facts.runUrl}`,
      };
    }
    return {
      engineRef: facts.engineRef,
      packRef: facts.packRef,
      actionCommit: facts.actionCommit,
      runUrl: facts.runUrl,
      classification: "supported",
      reason: "Compatibility checks passed",
      evidence: facts.runUrl,
    };
  }

  // 3b. Failure statuses (fail, error, execution-failed, warning)
  // Check if there's a matching expectation
  const expectation = expectations.find(
    (e) =>
      e.engineRef === facts.engineRef &&
      e.packRef === facts.packRef &&
      e.expectedStatus === status &&
      (facts.firstDiagnostic ?? "").includes(e.failureSignature),
  );

  if (expectation) {
    return {
      engineRef: facts.engineRef,
      packRef: facts.packRef,
      actionCommit: facts.actionCommit,
      runUrl: facts.runUrl,
      classification: "expected-incompatible",
      reason: `Known incompatibility: ${expectation.reason}`,
      evidence: `Expectation from: ${expectation.runUrl} | This run: ${facts.runUrl}`,
    };
  }

  // 3c. Unexpected failure
  return {
    engineRef: facts.engineRef,
    packRef: facts.packRef,
    actionCommit: facts.actionCommit,
    runUrl: facts.runUrl,
    classification: "unexpected-failure",
    reason: `Action reported ${status}${facts.firstDiagnostic ? `: ${facts.firstDiagnostic}` : ""}`,
    evidence: facts.runUrl,
  };
}

/**
 * Determines if a cell should fail the overall matrix job.
 * Only unexpected-failure and unexpected-pass cause job failure.
 *
 * @param {CellClassification} classification
 * @returns {boolean}
 */
export function shouldFailJob(classification) {
  return classification === "unexpected-failure" || classification === "unexpected-pass";
}

/**
 * Generates a markdown table row for a classified cell.
 *
 * @param {ClassifiedCell} cell
 * @returns {string}
 */
export function formatCellRow(cell) {
  const statusIcon = {
    supported: "✅",
    "expected-incompatible": "⚠️",
    infrastructure: "🔧",
    skipped: "⏭️",
    "unexpected-failure": "❌",
    "unexpected-pass": "🔄",
  };
  const icon = statusIcon[cell.classification] ?? "❓";
  return `| ${cell.engineRef} | ${cell.packRef} | ${icon} ${cell.classification} | ${cell.reason} | ${cell.evidence} |`;
}

/**
 * Generates the full markdown table for all classified cells.
 *
 * @param {ClassifiedCell[]} cells
 * @returns {string}
 */
export function formatResultsTable(cells) {
  const header = "| Engine | Pack | Classification | Reason | Evidence |\n|---|---|---|---|---|";
  const rows = cells.map(formatCellRow).join("\n");
  return `${header}\n${rows}`;
}