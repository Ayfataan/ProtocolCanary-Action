import { describe, expect, it } from "vitest";

import type { CanaryReport } from "../../src/output";
import { RECEIPT_VERSION, buildReceipt, serializeReceipt } from "../../src/receipt";
import { report } from "./helpers";

/** A frozen timestamp so every serialization assertion is byte-exact. */
const TS = "2026-10-19T12:00:00.000Z";

/** A report as a future engine (E-055/E-071) would emit it: with the
 * engine build commit and pack digest fields present. */
function fullReport(): CanaryReport {
  const base = report({ toolVersion: "0.2.0", targetProtocol: 28, network: { name: "testnet", observedProtocol: 28 } });
  return {
    ...base,
    // engineCommit/packDigest are additive report fields not yet in the
    // schemaVersion-1 type; buildReceipt reads them from the parsed JSON.
    ...{ engineCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", packDigest: "sha256:9f3e2c1b0a..." },
  } as CanaryReport;
}

describe("buildReceipt (#360)", () => {
  it("serializes a receiptVersion 1 JSON receipt for a report with all provenance fields", () => {
    const receipt = buildReceipt(fullReport(), TS);
    expect(serializeReceipt(receipt)).toBe(
      JSON.stringify(
        {
          receiptVersion: 1,
          engineVersion: "0.2.0",
          engineCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
          packDigest: "sha256:9f3e2c1b0a...",
          protocol: 28,
          observedProtocol: 28,
          timestamp: TS,
        },
        null,
        2,
      ),
    );
  });

  it("defaults missing engineCommit and packDigest to 'unknown' without guessing", () => {
    // The current schemaVersion-1 report carries neither field, and its
    // `git.commit` describes the *project* under check, not the engine
    // build — falling back to it would be exactly the guess the issue
    // forbids ("without guessing").
    const oldEngine = report({ git: { commit: "1111111111111111111111111111111111111111", branch: "main", isDirty: false } });
    const receipt = buildReceipt(oldEngine, TS);
    expect(receipt.engineCommit).toBe("unknown");
    expect(receipt.packDigest).toBe("unknown");
  });

  it("falls back to 'unknown' when an additive field is present but the wrong type", () => {
    const odd = { ...report(), engineCommit: 42, packDigest: null } as unknown as CanaryReport;
    const receipt = buildReceipt(odd, TS);
    expect(receipt.engineCommit).toBe("unknown");
    expect(receipt.packDigest).toBe("unknown");
  });

  it("reads engineVersion from the report's toolVersion, 'unknown' when missing", () => {
    expect(buildReceipt(report({ toolVersion: "0.1.1" }), TS).engineVersion).toBe("0.1.1");
    const missing = { ...report(), toolVersion: undefined } as unknown as CanaryReport;
    expect(buildReceipt(missing, TS).engineVersion).toBe("unknown");
  });

  it("uses targetProtocol and network.observedProtocol, 'unknown' when absent", () => {
    // The shared fixture has targetProtocol 28 and no `network` block at all.
    const receipt = buildReceipt(report(), TS);
    expect(receipt.protocol).toBe(28);
    expect(receipt.observedProtocol).toBe("unknown");

    const live = report({ network: { name: "testnet", observedProtocol: 29 } });
    expect(buildReceipt(live, TS).observedProtocol).toBe(29);

    const noProtocol = { ...report(), targetProtocol: undefined } as unknown as CanaryReport;
    expect(buildReceipt(noProtocol, TS).protocol).toBe("unknown");
  });

  it("never throws on a bare report object — every field falls back to 'unknown'", () => {
    const receipt = buildReceipt({} as unknown as CanaryReport, TS);
    expect(receipt).toEqual({
      receiptVersion: RECEIPT_VERSION,
      engineVersion: "unknown",
      engineCommit: "unknown",
      packDigest: "unknown",
      protocol: "unknown",
      observedProtocol: "unknown",
      timestamp: TS,
    });
  });

  it("stamps the current UTC time when no timestamp is supplied", () => {
    const before = Date.now();
    const receipt = buildReceipt(report());
    const after = Date.now();
    const stamped = Date.parse(receipt.timestamp);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(after + 1000);
  });
});

describe("serializeReceipt (#360)", () => {
  it("emits keys in a fixed, deterministic order regardless of input key order", () => {
    const receipt = buildReceipt(report(), TS);
    const shuffled = {
      timestamp: receipt.timestamp,
      protocol: receipt.protocol,
      receiptVersion: receipt.receiptVersion,
      packDigest: receipt.packDigest,
      observedProtocol: receipt.observedProtocol,
      engineCommit: receipt.engineCommit,
      engineVersion: receipt.engineVersion,
    };
    expect(serializeReceipt(shuffled)).toBe(serializeReceipt(receipt));
    expect(Object.keys(JSON.parse(serializeReceipt(receipt)))).toEqual([
      "receiptVersion",
      "engineVersion",
      "engineCommit",
      "packDigest",
      "protocol",
      "observedProtocol",
      "timestamp",
    ]);
  });

  it("always carries receiptVersion 1", () => {
    expect(RECEIPT_VERSION).toBe(1);
    expect(JSON.parse(serializeReceipt(buildReceipt(report(), TS))).receiptVersion).toBe(1);
  });
});
