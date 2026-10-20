import type { CanaryReport } from "./output";

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
 * Builds the provenance receipt for one Canary report. Missing or
 * ill-typed fields fall back to `"unknown"`; this never throws, whatever
 * shape the engine produced.
 */
export function buildReceipt(report: CanaryReport, timestamp: string = new Date().toISOString()): ExecutionReceipt {
  const source = report as unknown as ReceiptSourceFields;
  return {
    receiptVersion: RECEIPT_VERSION,
    engineVersion: asString(source.toolVersion) ?? UNKNOWN,
    engineCommit: asString(source.engineCommit) ?? UNKNOWN,
    packDigest: asString(source.packDigest) ?? UNKNOWN,
    protocol: typeof source.targetProtocol === "number" ? source.targetProtocol : UNKNOWN,
    observedProtocol:
      typeof source.network?.observedProtocol === "number" ? source.network.observedProtocol : UNKNOWN,
    timestamp,
  };
}

/**
 * Serializes a receipt deterministically: keys are re-emitted in the fixed
 * documented order (regardless of the caller object's own key order), with
 * stable two-space indentation, so the same receipt always yields the same
 * bytes.
 */
export function serializeReceipt(receipt: ExecutionReceipt): string {
  const ordered: ExecutionReceipt = {
    receiptVersion: receipt.receiptVersion,
    engineVersion: receipt.engineVersion,
    engineCommit: receipt.engineCommit,
    packDigest: receipt.packDigest,
    protocol: receipt.protocol,
    observedProtocol: receipt.observedProtocol,
    timestamp: receipt.timestamp,
  };
  return JSON.stringify(ordered, null, 2);
}
