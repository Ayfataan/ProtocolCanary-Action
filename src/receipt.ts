import type { CanaryReport } from "./output";
import { REDACTED, redactSecrets } from "./redact";

/**
 * The Execution Receipt model (`receiptVersion: 1`).
 *
 * A receipt is a lightweight, machine-readable *provenance record* of what an
 * Action run checked and with which engine: the engine version and build
 * commit, the fixture-pack digest, the target protocol, the protocol actually
 * observed on the network, and the UTC time of the run. It is deliberately
 * **not** a signed or otherwise cryptographically verifiable attestation —
 * nothing here is hashed, signed, or anchored anywhere, and consumers must not
 * treat its contents as stronger than "what this run reported".
 *
 * Additive engine fields (`engineCommit`, `packDigest`) arrive in future
 * Protocol-Canary releases (E-055, E-071). Reports from engines that predate
 * them are still valid inputs: the corresponding receipt fields fall back to
 * the literal `"unknown"` rather than a guess. In particular `git.commit` in a
 * report describes the *project under check*, never the engine build, and is
 * deliberately not consulted here.
 */
export const RECEIPT_VERSION = 1;

/** The documented fallback for a provenance field the report did not carry. */
const UNKNOWN = "unknown";

/**
 * One serialized execution receipt. `receiptVersion` pins the shape; every
 * string field is present by construction ("`unknown`" when not recorded),
 * while the protocol fields stay numeric when they were recorded.
 */
export interface ExecutionReceipt {
  readonly receiptVersion: typeof RECEIPT_VERSION;
  /** Protocol Canary's own version, from the report's `toolVersion`. */
  readonly engineVersion: string;
  /** Build commit of the engine binary, from the future E-055 report field. */
  readonly engineCommit: string;
  /** Digest identifying the fixture pack, from the future E-071 report field. */
  readonly packDigest: string;
  /** Protocol the run targeted (`targetProtocol`), or `"unknown"`. */
  readonly protocol: number | typeof UNKNOWN;
  /** Protocol observed live on the network, or `"unknown"` when not checked. */
  readonly observedProtocol: number | typeof UNKNOWN;
  /** When this run produced its report, ISO-8601 UTC. */
  readonly timestamp: string;
}

/**
 * Report fields consumed by the receipt that are not (yet) part of the
 * schemaVersion-1 type. Everything is read defensively: parsed JSON from an
 * arbitrary engine release may carry any of them with the wrong type or not
 * at all, and the receipt must never throw or guess.
 */
type ReceiptSourceFields = Partial<CanaryReport> & {
  readonly engineCommit?: unknown;
  readonly packDigest?: unknown;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Absolute POSIX paths (`/home/runner/work/...`, `/tmp/...`) as two or more
 * root-anchored path segments. A single segment (`/main`) is not enough:
 * it occurs in ordinary identifiers, while real filesystem paths always
 * carry at least a directory below the root.
 */
const POSIX_ABSOLUTE_PATH_PATTERN = /(?:\/[A-Za-z0-9._+-]+){2,}/g;

/**
 * Absolute Windows paths (`C:\a\runner\...`): a drive letter, `:\`, and at
 * least one path character. Stops at whitespace and shell metacharacters so
 * a masked path cannot swallow the rest of the field.
 */
const WINDOWS_ABSOLUTE_PATH_PATTERN = /\b[A-Za-z]:\\[^\s"'`<>|]+/g;

/**
 * The CF-08 redaction boundary for receipt string fields (#364).
 *
 * Receipts are published as workflow artifacts readable by anyone who can
 * see the repository, so every string that leaves this module passes through
 * here: recognised credential shapes (GitHub tokens, Stellar secret seeds,
 * URL credentials, sensitive environment values) are masked via
 * `redactSecrets` from `src/redact.ts`, and machine-specific absolute
 * filesystem paths are replaced with the same `[REDACTED]` placeholder.
 *
 * `redactSecrets` is used rather than `redact` because a receipt is a pure
 * JSON artifact, never a log line: `escapeWorkflowCommands` would corrupt
 * legitimate values (a digest like `sha256:...` contains `:`) with
 * backslash escapes that no JSON consumer can undo.
 *
 * The function is idempotent, which lets {@link buildReceipt} scrub at the
 * source and {@link serializeReceipt} scrub again at the byte boundary
 * without the two passes interfering. Semantic identifiers that receipts
 * actually carry — hex commit SHAs, `sha256:` digests, semver, ISO-8601
 * timestamps — match none of these patterns and are preserved verbatim.
 */
function redactReceiptString(value: string): string {
  return redactSecrets(value)
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, REDACTED)
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, REDACTED);
}

/**
 * Builds the provenance receipt for one Canary report. Missing or
 * ill-typed fields fall back to `"unknown"`; this never throws, whatever
 * shape the engine produced.
 *
 * Every string field is passed through the CF-08 redaction boundary
 * ({@link redactReceiptString}) at the source, so a receipt object is already
 * free of runner paths and credential-shaped values — not just its
 * serialization.
 */
export function buildReceipt(report: CanaryReport, timestamp: string = new Date().toISOString()): ExecutionReceipt {
  const source = report as unknown as ReceiptSourceFields;
  return {
    receiptVersion: RECEIPT_VERSION,
    engineVersion: redactReceiptString(asString(source.toolVersion) ?? UNKNOWN),
    engineCommit: redactReceiptString(asString(source.engineCommit) ?? UNKNOWN),
    packDigest: redactReceiptString(asString(source.packDigest) ?? UNKNOWN),
    protocol: typeof source.targetProtocol === "number" ? source.targetProtocol : UNKNOWN,
    observedProtocol:
      typeof source.network?.observedProtocol === "number" ? source.network.observedProtocol : UNKNOWN,
    timestamp: redactReceiptString(timestamp),
  };
}

/**
 * Serializes a receipt deterministically: keys are re-emitted in the fixed
 * documented order (regardless of the caller object's own key order), with
 * stable two-space indentation, so the same receipt always yields the same
 * bytes.
 *
 * The four string fields are re-scrubbed through {@link redactReceiptString}
 * here at the byte boundary — receipts are also consumed by callers that
 * hand-construct the object (e.g. parsed from an artifact), and the redaction
 * must not be avoidable by skipping {@link buildReceipt}. The function remains
 * idempotent for receipts that already came from `buildReceipt`. The protocol
 * fields are not scrubbed: by construction they are either numeric or the
 * `"unknown"` sentinel, and stringifying them would corrupt a legitimate
 * value rather than protect one.
 */
export function serializeReceipt(receipt: ExecutionReceipt): string {
  const ordered: ExecutionReceipt = {
    receiptVersion: receipt.receiptVersion,
    engineVersion: redactReceiptString(receipt.engineVersion),
    engineCommit: redactReceiptString(receipt.engineCommit),
    packDigest: redactReceiptString(receipt.packDigest),
    protocol: receipt.protocol,
    observedProtocol: receipt.observedProtocol,
    timestamp: redactReceiptString(receipt.timestamp),
  };
  return JSON.stringify(ordered, null, 2);
}
