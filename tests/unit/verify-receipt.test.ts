import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanaryReport } from "../../src/output";
import { buildReceipt, serializeReceipt } from "../../src/receipt";
import { runCli, verifyReceipt } from "../../scripts/verify-receipt";
import { report as reportFixture } from "./helpers";

/**
 * Tests for the standalone receipt verification utility (#363). The pure
 * `verifyReceipt` half never touches the filesystem; the `runCli` half uses
 * real temp files — the utility exists to read artifacts another process
 * wrote, so a mocked `fs` would prove very little here.
 */

const TS = "2026-10-19T12:00:00.000Z";
const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const DIGEST = "sha256:9f3e2c1b0a1234567890abcdef1234567890abcdef1234567890abcdef123456";

/** A report in the shape today's `buildReceipt` producer reads: flat additive keys. */
function flatReport(): CanaryReport {
  const base = reportFixture({ toolVersion: "0.2.0", network: { name: "testnet", observedProtocol: 28 } });
  return { ...base, engineCommit: COMMIT, packDigest: DIGEST } as unknown as CanaryReport;
}

/** A report in the CF-01 documented shape (run.toolBuildCommit / fixturePack.digest). */
function documentedReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = reportFixture({ toolVersion: "0.2.0", network: { name: "testnet", observedProtocol: 28 } });
  return {
    ...base,
    run: { toolBuildCommit: COMMIT },
    fixturePack: { digest: DIGEST },
    ...overrides,
  };
}

function makeReceipt(overrides: Record<string, unknown> = {}) {
  return {
    receiptVersion: 1,
    engineVersion: "0.2.0",
    engineCommit: COMMIT,
    packDigest: DIGEST,
    protocol: 28,
    observedProtocol: 28,
    timestamp: TS,
    ...overrides,
  };
}

function verdictOf(result: ReturnType<typeof verifyReceipt>, field: string) {
  const entry = result.fields.find((f) => f.field === field);
  expect(entry).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return entry!;
}

describe("verifyReceipt (#363) — field comparison", () => {
  it("verifies a real buildReceipt receipt against the flat-key report it was built from", () => {
    const flat = flatReport();
    const receipt = JSON.parse(serializeReceipt(buildReceipt(flat, TS)));
    const result = verifyReceipt(receipt, flat);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(verdictOf(result, "engineVersion").verdict).toBe("match");
    expect(verdictOf(result, "engineCommit").verdict).toBe("match");
    expect(verdictOf(result, "packDigest").verdict).toBe("match");
    expect(verdictOf(result, "protocol").verdict).toBe("match");
    expect(verdictOf(result, "observedProtocol").verdict).toBe("match");
  });

  it("accepts the CF-01 documented paths run.toolBuildCommit and fixturePack.digest", () => {
    const result = verifyReceipt(makeReceipt(), documentedReport());
    expect(result.ok).toBe(true);
    expect(verdictOf(result, "engineCommit").verdict).toBe("match");
    expect(verdictOf(result, "engineCommit").detail).toContain("report.run.toolBuildCommit");
    expect(verdictOf(result, "packDigest").verdict).toBe("match");
    expect(verdictOf(result, "packDigest").detail).toContain("report.fixturePack.digest");
  });

  it("prefers the documented nested path over a disagreeing flat additive key", () => {
    const doc = documentedReport();
    const flatOnly = { ...doc, engineCommit: "ffffffffffffffffffffffffffffffffffffffff" };
    const result = verifyReceipt(makeReceipt(), flatOnly);
    expect(result.ok).toBe(true);
    expect(verdictOf(result, "engineCommit").verdict).toBe("match");
  });

  it("treats 'unknown' receipt fields against an unrecorded report field as not-comparable, never a mismatch", () => {
    const base = reportFixture({ toolVersion: "0.2.0" });
    const result = verifyReceipt(makeReceipt({ engineCommit: "unknown", packDigest: "unknown", observedProtocol: "unknown" }), base);
    expect(result.ok).toBe(true);
    expect(verdictOf(result, "engineCommit").verdict).toBe("not-comparable");
    expect(verdictOf(result, "packDigest").verdict).toBe("not-comparable");
    expect(verdictOf(result, "observedProtocol").verdict).toBe("not-comparable");
  });

  it("does not flag a recorded receipt field against a report that did not record it", () => {
    const legacy = reportFixture({ toolVersion: "0.2.0" });
    const result = verifyReceipt(makeReceipt(), legacy);
    expect(result.ok).toBe(true);
    expect(verdictOf(result, "engineCommit").verdict).toBe("not-comparable");
    expect(verdictOf(result, "engineCommit").detail).toContain("not recorded in the report");
  });

  it("never false-positives on [REDACTED] receipt fields (#364 boundary interaction)", () => {
    const result = verifyReceipt(
      makeReceipt({ engineCommit: "[REDACTED]" }),
      documentedReport(),
    );
    expect(result.ok).toBe(true);
    expect(verdictOf(result, "engineCommit").verdict).toBe("not-comparable");
    expect(verdictOf(result, "engineCommit").detail).toContain("redacted");
  });

  it("flags a tampered engine commit as a mismatch naming the field", () => {
    const result = verifyReceipt(
      makeReceipt({ engineCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }),
      documentedReport(),
    );
    expect(result.ok).toBe(false);
    const entry = verdictOf(result, "engineCommit");
    expect(entry.verdict).toBe("mismatch");
    expect(entry.field).toBe("engineCommit");
    expect(entry.detail).toContain("deadbeef");
    expect(entry.detail).toContain("report.run.toolBuildCommit");
  });

  it("flags a tampered packDigest and protocol", () => {
    expect(verifyReceipt(makeReceipt({ packDigest: "sha256:0000" }), documentedReport()).ok).toBe(false);
    const proto = verifyReceipt(makeReceipt({ protocol: 29 }), documentedReport());
    expect(proto.ok).toBe(false);
    expect(verdictOf(proto, "protocol").verdict).toBe("mismatch");
  });

  it("never compares the transient timestamp", () => {
    const result = verifyReceipt(makeReceipt({ timestamp: "2000-01-01T00:00:00.000Z" }), documentedReport());
    expect(result.ok).toBe(true);
    expect(verdictOf(result, "timestamp").verdict).toBe("not-comparable");
    expect(verdictOf(result, "timestamp").detail).toContain("never compared");
  });

  it("rejects a non-object receipt or report with explicit errors", () => {
    const bad = verifyReceipt([1, 2], documentedReport());
    expect(bad.ok).toBe(false);
    expect(bad.fields).toEqual([]);
    expect(bad.errors.join(" ")).toContain("receipt document is not a JSON object");
    const badReport = verifyReceipt(makeReceipt(), "not-an-object");
    expect(badReport.errors.join(" ")).toContain("report document is not a JSON object");
  });

  it("rejects unsupported receipt and report versions instead of guessing", () => {
    expect(verifyReceipt(makeReceipt({ receiptVersion: 2 }), documentedReport()).errors.join(" ")).toContain(
      "Unsupported receiptVersion 2",
    );
    expect(verifyReceipt(makeReceipt(), documentedReport({ schemaVersion: 2 })).errors.join(" ")).toContain(
      "Unsupported report schemaVersion 2",
    );
    const { schemaVersion: _removed, ...noVersion } = documentedReport();
    expect(verifyReceipt(makeReceipt(), noVersion).errors.join(" ")).toContain("Unsupported report schemaVersion undefined");
  });
});

describe("runCli (#363) — real files and exit codes", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-receipt-test-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, text: string): string {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, text, "utf8");
    return filePath;
  }

  it("exits 0 when the receipt matches the published report bytes", () => {
    const receiptPath = write(
      "receipt.json",
      serializeReceipt(buildReceipt(flatReport(), TS)),
    );
    const reportPath = write("report.json", JSON.stringify(flatReport(), null, 2));
    expect(runCli([receiptPath, reportPath])).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("receipt verified"));
  });

  it("exits 1 and names the divergent fields for a tampered commit", () => {
    const tampered = { ...makeReceipt(), engineCommit: "cafe0000cafe0000cafe0000cafe0000cafe0000" };
    const receiptPath = write("receipt.json", JSON.stringify(tampered, null, 2));
    const reportPath = write("report.json", JSON.stringify(documentedReport(), null, 2));
    expect(runCli([receiptPath, reportPath])).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("MISMATCH"));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("engineCommit"));
  });

  it("exits 2 on a missing file, invalid JSON, or wrong argument count", () => {
    expect(runCli([path.join(dir, "absent.json"), path.join(dir, "also-absent.json")])).toBe(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Cannot read"));

    const junk = write("junk.json", "{not json");
    const good = write("receipt.json", JSON.stringify(makeReceipt()));
    expect(runCli([good, junk])).toBe(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("not valid JSON"));

    expect(runCli([])).toBe(2);
    expect(runCli(["only-one.json"])).toBe(2);
    expect(runCli(["a.json", "b.json", "c.json"])).toBe(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("usage:"));
  });

  it("end-to-end through the real producer: build → serialize → files → verify exits 0", () => {
    const docReport = documentedReport();
    // The producer reads flat keys, so a documented-shape report yields
    // 'unknown' provenance fields; verification must still pass without
    // false positives (spec: 'unknown' never mismatches).
    const receipt = buildReceipt(docReport as unknown as CanaryReport, TS);
    const receiptPath = write("receipt.json", serializeReceipt(receipt));
    const reportPath = write("report.json", JSON.stringify(docReport, null, 2));
    expect(receipt.engineCommit).toBe("unknown");
    expect(runCli([receiptPath, reportPath])).toBe(0);
  });
});
