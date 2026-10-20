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

describe("serializeReceipt contract pinning (#365)", () => {
  /**
   * These tests pin the *documented* serialization contract for inputs the
   * producer never emits (`buildReceipt` always yields `receiptVersion: 1`
   * with string-typed string fields). Receipts also arrive as parsed JSON
   * from older or hand-edited artifacts, and "unvalidated but fully
   * deterministic" is the contract consumers rely on — the verification
   * half lives in the consumer (`scripts/verify-receipt.ts`, #363), not in
   * the serializer. Pinning the behaviour here makes any future change a
   * deliberate one.
   */
  it("emits a foreign receiptVersion verbatim rather than validating it", () => {
    const future = { ...buildReceipt(report(), TS), receiptVersion: 7 } as unknown as Parameters<typeof serializeReceipt>[0];
    const json = serializeReceipt(future);
    expect(JSON.parse(json).receiptVersion).toBe(7);
  });

  it("drops keys the receipt model does not define", () => {
    const withExtra = {
      ...buildReceipt(report(), TS),
      signature: "ed25519:abcdef",
      note: "receipts are unsigned",
    } as unknown as Parameters<typeof serializeReceipt>[0];
    const parsed = JSON.parse(serializeReceipt(withExtra)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "receiptVersion",
      "engineVersion",
      "engineCommit",
      "packDigest",
      "protocol",
      "observedProtocol",
      "timestamp",
    ]);
    expect(parsed.signature).toBeUndefined();
  });

  it("is exactly two-space indented JSON with no trailing newline", () => {
    const json = serializeReceipt(buildReceipt(report(), TS));
    expect(json).toBe(
      JSON.stringify(
        {
          receiptVersion: 1,
          engineVersion: "0.1.0",
          engineCommit: "unknown",
          packDigest: "unknown",
          protocol: 28,
          observedProtocol: "unknown",
          timestamp: TS,
        },
        null,
        2,
      ),
    );
    expect(json.endsWith("}")).toBe(true);
    expect(json).toContain('\n  "engineVersion"');
  });

  it("keeps recorded protocol fields as JSON numbers, unscrubbed", () => {
    const receipt = buildReceipt(report({ network: { name: "testnet", observedProtocol: 29 } }), TS);
    const parsed = JSON.parse(serializeReceipt(receipt)) as Record<string, unknown>;
    expect(parsed.protocol).toBe(28);
    expect(typeof parsed.protocol).toBe("number");
    expect(parsed.observedProtocol).toBe(29);
    expect(typeof parsed.observedProtocol).toBe("number");
  });

  it("throws a TypeError on a hand-constructed non-string in a string field — a programmer error, not a silent coercion", () => {
    // buildReceipt never produces such a receipt (the fields are `string` by
    // construction); this pins that a caller bypassing the type cannot get a
    // silently coerced value into the artifact bytes.
    const bad = { ...buildReceipt(report(), TS), timestamp: 42 } as unknown as Parameters<typeof serializeReceipt>[0];
    expect(() => serializeReceipt(bad)).toThrow(TypeError);
  });
});

describe("receipt redaction boundary (#364)", () => {
  /** A syntactically valid classic PAT shape (ghp_ + 36+ alphanumerics). */
  const SYNTHETIC_TOKEN = `ghp_${"Ab3dEf6hIjKlMn0pQr2sTuVwXyZ012345678".slice(0, 36)}`;
  /** A StrKey secret-seed shape: S + 55 base32 characters. */
  const SYNTHETIC_SEED = `S${"A".repeat(55)}`;

  it("masks a synthetic GitHub token smuggled through an additive report field", () => {
    const polluted = { ...report(), engineCommit: SYNTHETIC_TOKEN } as unknown as CanaryReport;
    const receipt = buildReceipt(polluted, TS);
    expect(receipt.engineCommit).toBe("[REDACTED]");
    expect(serializeReceipt(receipt)).not.toContain(SYNTHETIC_TOKEN.slice(0, 12));
  });

  it("masks a token injected into the toolVersion (engineVersion) field", () => {
    const polluted = report({ toolVersion: `0.2.0 ${SYNTHETIC_TOKEN}` });
    const receipt = buildReceipt(polluted, TS);
    expect(receipt.engineVersion).toBe(`0.2.0 ${"[REDACTED]"}`);
  });

  it("masks a Stellar secret seed smuggled through packDigest", () => {
    const polluted = { ...report(), packDigest: SYNTHETIC_SEED } as unknown as CanaryReport;
    expect(buildReceipt(polluted, TS).packDigest).toBe("[REDACTED]");
  });

  it("strips POSIX absolute runner paths from receipt fields", () => {
    const polluted = {
      ...report(),
      engineCommit: "/home/runner/work/repo/repo/dist/canary",
    } as unknown as CanaryReport;
    const receipt = buildReceipt(polluted, TS);
    expect(receipt.engineCommit).toBe("[REDACTED]");
    expect(receipt.engineCommit).not.toContain("/home/runner");
  });

  it("strips Windows absolute runner paths from receipt fields", () => {
    const polluted = {
      ...report(),
      packDigest: "C:\\a\\runner\\work\\repo\\canary.exe",
    } as unknown as CanaryReport;
    const receipt = buildReceipt(polluted, TS);
    expect(receipt.packDigest).toBe("[REDACTED]");
    expect(serializeReceipt(receipt)).not.toContain("C:\\a\\");
  });

  it("scrubs a caller-supplied timestamp carrying a runner temp path", () => {
    const receipt = buildReceipt(report(), "/tmp/runner/stellar-canary-receipt.json");
    expect(receipt.timestamp).toBe("[REDACTED]");
  });

  it("redacts at the serialize boundary too, for hand-constructed receipts", () => {
    // A receipt parsed from an artifact bypasses buildReceipt entirely; the
    // byte boundary must still not emit a credential-shaped string.
    const handMade = {
      receiptVersion: 1,
      engineVersion: `cli ${SYNTHETIC_TOKEN}`,
      engineCommit: SYNTHETIC_SEED,
      packDigest: "/home/runner/work/x/y",
      protocol: 28,
      observedProtocol: "unknown",
      timestamp: TS,
    } as const satisfies Record<string, unknown>;
    const json = serializeReceipt(handMade as unknown as Parameters<typeof serializeReceipt>[0]);
    expect(json).not.toContain(SYNTHETIC_TOKEN.slice(0, 12));
    expect(json).not.toContain(SYNTHETIC_SEED);
    expect(json).not.toContain("/home/runner");
    expect(json).toContain("[REDACTED]");
  });

  it("preserves legitimate semantic identifiers unchanged", () => {
    const legit = {
      ...report(),
      engineCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      packDigest: "sha256:9f3e2c1b0a1234567890abcdef1234567890abcdef1234567890abcdef123456",
    } as unknown as CanaryReport;
    const receipt = buildReceipt(legit, TS);
    expect(receipt.engineCommit).toBe("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    expect(receipt.packDigest).toBe(
      "sha256:9f3e2c1b0a1234567890abcdef1234567890abcdef1234567890abcdef123456",
    );
    expect(receipt.engineVersion).toBe("0.1.0");
    expect(receipt.timestamp).toBe(TS);
  });

  it("is idempotent: the build and serialize passes cannot double-mangle a clean receipt", () => {
    const receipt = buildReceipt(fullReport(), TS);
    const once = serializeReceipt(receipt);
    const twice = serializeReceipt(JSON.parse(once) as ReturnType<typeof buildReceipt>);
    expect(twice).toBe(once);
  });

  it("leaves the 'unknown' sentinel fields untouched", () => {
    const receipt = buildReceipt({} as unknown as CanaryReport, TS);
    expect(receipt.engineCommit).toBe("unknown");
    expect(receipt.packDigest).toBe("unknown");
    expect(receipt.engineVersion).toBe("unknown");
  });
});
