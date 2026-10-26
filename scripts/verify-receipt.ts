/**
 * Standalone Execution Receipt verification utility for consumers (#363).
 *
 * Lets a consumer or compliance tool check that a published Execution
 * Receipt (`receiptVersion: 1`, as written by `serializeReceipt` in
 * `src/receipt.ts`) agrees with the engine report JSON of the run it claims
 * to describe. Only genuinely shared, durable provenance fields are
 * compared: engine version, engine build commit, fixture-pack digest,
 * target protocol, and observed protocol. The receipt `timestamp` is a
 * transient run fact that never appears in the report, so it is deliberately
 * never compared.
 *
 * Field paths: the issue text names `report.engine.commit` and
 * `report.pack.digest`, which exist in no contract. The authoritative
 * locations per CF-01 §3 are `report.run.toolBuildCommit` (E-055) and
 * `report.fixturePack.digest` (E-071), and neither is emitted by any
 * released engine yet; `src/receipt.ts` today reads the flat additive keys
 * `engineCommit` / `packDigest` that its producer actually consults. This
 * verifier therefore checks the documented nested path first and falls back
 * to the flat additive key, and it reads the report with plain `JSON.parse`
 * — not `parseReport` — so future report-tightening cannot make a valid
 * receipt unreadable here.
 *
 * Absence handling: a value of `"unknown"` (the receipt's encoding of "not
 * recorded"), an absent/null/blank report field, or a `[REDACTED]` receipt
 * field all mean "nothing to compare". Comparing them would produce false
 * positive mismatches, so those fields are reported `not-comparable` and
 * never fail the verification.
 *
 * This is integrity checking of published JSON, not attestation: receipts
 * are unsigned, and nothing here proves the receipt was produced by the
 * Action — only that it is consistent with the report beside it.
 *
 * Exit codes: 0 = all comparable fields agree; 1 = at least one divergence;
 * 2 = the inputs could not be verified at all (unreadable file, not JSON,
 * not an object, or an unsupported receipt/report version).
 */

import * as fs from "node:fs";

import { RECEIPT_VERSION } from "../src/receipt";
import { REDACTED } from "../src/redact";

/** The receipt's documented encoding of "this field was not recorded". */
const UNKNOWN = "unknown";

/** The only report schema version this utility knows how to read. */
const SUPPORTED_REPORT_SCHEMA_VERSION = 1;

export type FieldVerdict = "match" | "mismatch" | "not-comparable";

export interface FieldVerification {
  readonly field: string;
  readonly verdict: FieldVerdict;
  /** The receipt's recorded value, or `null` when it was not recorded. */
  readonly receiptValue: string | null;
  /** The report's recorded value, or `null` when it was not recorded. */
  readonly reportValue: string | null;
  readonly detail: string;
}

export interface ReceiptVerification {
  /** True when the inputs are usable and no comparable field diverges. */
  readonly ok: boolean;
  readonly fields: readonly FieldVerification[];
  /** Structural problems that made verification impossible. */
  readonly errors: readonly string[];
}

interface FieldSpec {
  readonly field: string;
  /** Report candidate paths, most authoritative first. Dot-separated. */
  readonly reportPaths: readonly string[];
  readonly comparable: boolean;
  readonly reason?: string;
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { field: "engineVersion", reportPaths: ["toolVersion"], comparable: true },
  { field: "engineCommit", reportPaths: ["run.toolBuildCommit", "engineCommit"], comparable: true },
  { field: "packDigest", reportPaths: ["fixturePack.digest", "packDigest"], comparable: true },
  { field: "protocol", reportPaths: ["targetProtocol"], comparable: true },
  { field: "observedProtocol", reportPaths: ["network.observedProtocol"], comparable: true },
  {
    field: "timestamp",
    reportPaths: [],
    comparable: false,
    reason: "transient run time; never recorded in the report and never compared (#363)",
  },
];

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a dot-separated path, yielding undefined at the first miss. */
function readPath(root: unknown, dotted: string): unknown {
  let current: unknown = root;
  for (const segment of dotted.split(".")) {
    if (!isJsonObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/**
 * Normalizes one side's value to a comparable string, or `null` for "not
 * recorded": absent, non-string/non-number, blank, the `"unknown"`
 * sentinel, or a `[REDACTED]` placeholder all mean there is nothing a
 * mismatch verdict could honestly be drawn on.
 */
function recorded(value: unknown): string | null {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string" && value.trim() !== "" && value !== UNKNOWN && value !== REDACTED) {
    return value;
  }
  return null;
}

function verifyField(spec: FieldSpec, receipt: Record<string, unknown>, report: Record<string, unknown>): FieldVerification {
  const receiptValue = recorded(receipt[spec.field]);
  if (!spec.comparable) {
    return {
      field: spec.field,
      verdict: "not-comparable",
      receiptValue,
      reportValue: null,
      detail: spec.reason ?? "not comparable by design",
    };
  }
  let reportValue: string | null = null;
  let sourcePath = "";
  for (const candidate of spec.reportPaths) {
    const value = recorded(readPath(report, candidate));
    if (value !== null) {
      reportValue = value;
      sourcePath = candidate;
      break;
    }
  }
  if (receiptValue === null || reportValue === null) {
    const missing = receiptValue === null ? (receipt[spec.field] === REDACTED ? "redacted in the receipt" : "not recorded in the receipt") : "not recorded in the report";
    return { field: spec.field, verdict: "not-comparable", receiptValue, reportValue, detail: `${missing}; skipped without guessing` };
  }
  if (receiptValue === reportValue) {
    return {
      field: spec.field,
      verdict: "match",
      receiptValue,
      reportValue,
      detail: sourcePath === spec.field ? "identical in both documents" : `receipt matches report.${sourcePath}`,
    };
  }
  return {
    field: spec.field,
    verdict: "mismatch",
    receiptValue,
    reportValue,
    detail: `receipt carries "${receiptValue}" but report.${sourcePath} carries "${reportValue}"`,
  };
}

/**
 * Verifies a parsed receipt object against a parsed report object without
 * touching the filesystem. Never throws: structural problems are returned
 * in `errors` and surface as exit code 2 at the CLI boundary.
 */
export function verifyReceipt(receiptJson: unknown, reportJson: unknown): ReceiptVerification {
  const errors: string[] = [];
  if (!isJsonObject(receiptJson)) {
    errors.push("The receipt document is not a JSON object.");
  } else if (receiptJson.receiptVersion !== RECEIPT_VERSION) {
    errors.push(
      `Unsupported receiptVersion ${String(receiptJson.receiptVersion)} ` +
        `(this utility verifies receiptVersion ${String(RECEIPT_VERSION)} receipts only).`,
    );
  }
  if (!isJsonObject(reportJson)) {
    errors.push("The report document is not a JSON object.");
  } else if (reportJson.schemaVersion !== SUPPORTED_REPORT_SCHEMA_VERSION) {
    errors.push(
      `Unsupported report schemaVersion ${String(reportJson.schemaVersion)} ` +
        `(this utility verifies schemaVersion ${String(SUPPORTED_REPORT_SCHEMA_VERSION)} reports only).`,
    );
  }
  if (errors.length > 0) {
    return { ok: false, fields: [], errors };
  }
  const receipt = receiptJson as Record<string, unknown>;
  const report = reportJson as Record<string, unknown>;
  const fields = FIELD_SPECS.map((spec) => verifyField(spec, receipt, report));
  const mismatches = fields.filter((entry) => entry.verdict === "mismatch");
  return { ok: mismatches.length === 0, fields, errors };
}

type JsonRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

function readJsonFile(filePath: string, label: string): JsonRead {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Cannot read the ${label} file "${filePath}": ${reason}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `The ${label} file "${filePath}" is not valid JSON: ${reason}` };
  }
}

/**
 * CLI entry: `verify-receipt <receipt.json> <report.json>`. Returns the
 * process exit code so the function is directly unit-testable.
 */
export function runCli(argv: readonly string[]): number {
  const [receiptPath, reportPath] = argv;
  if (argv.length !== 2 || receiptPath === undefined || reportPath === undefined) {
    console.error("usage: verify-receipt <receipt.json> <report.json>");
    return 2;
  }
  const receiptRead = readJsonFile(receiptPath, "receipt");
  if (!receiptRead.ok) {
    console.error(receiptRead.error);
    return 2;
  }
  const reportRead = readJsonFile(reportPath, "report");
  if (!reportRead.ok) {
    console.error(reportRead.error);
    return 2;
  }
  const verification = verifyReceipt(receiptRead.value, reportRead.value);
  for (const entry of verification.fields) {
    const line = `${entry.verdict.toUpperCase().padEnd(14)}${entry.field.padEnd(17)}${entry.detail}`;
    if (entry.verdict === "mismatch") {
      console.error(line);
    } else {
      console.log(line);
    }
  }
  if (verification.errors.length > 0) {
    for (const error of verification.errors) {
      console.error(`error          ${error}`);
    }
    return 2;
  }
  const matched = verification.fields.filter((entry) => entry.verdict === "match").length;
  const skipped = verification.fields.filter((entry) => entry.verdict === "not-comparable").length;
  if (verification.ok) {
    console.log(`receipt verified: ${String(matched)} field(s) match, ${String(skipped)} not comparable.`);
    return 0;
  }
  const divergences = verification.fields.filter((entry) => entry.verdict === "mismatch").map((entry) => entry.field);
  console.error(`receipt does NOT match the report on: ${divergences.join(", ")}.`);
  return 1;
}

/* istanbul ignore next -- CLI entry point; unit tests call runCli() directly */
if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2));
}
