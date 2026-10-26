// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck - untyped .mjs module
import { describe, expect, it } from "vitest";
import {
  classifyCell,
  shouldFailJob,
  formatCellRow,
  formatResultsTable,
} from "../../scripts/classify-compat.mjs";

interface ExpectationEntry {
  engineRef: string;
  packRef: string;
  expectedStatus: "fail" | "error" | "execution-failed";
  failureSignature: string;
  runUrl: string;
  dateAdded: string;
  reason: string;
}

const BASE_FACTS = {
  engineRef: "v0.1.1",
  packRef: "protocol-28",
  actionCommit: "abc123",
  runUrl: "https://github.com/StellarCanary/ProtocolCanary-Action/actions/runs/123",
  buildOutcome: "success" as const,
  ranNoChecks: false,
};

/** @type {ExpectationEntry[]} */
const EMPTY_EXPECTATIONS: ExpectationEntry[] = [];

describe("classifyCell", () => {
  describe("infrastructure failures", () => {
    it("classifies build failure as infrastructure", () => {
      const result = classifyCell(
        { ...BASE_FACTS, buildOutcome: "failure" },
        EMPTY_EXPECTATIONS,
      );
      expect(result.classification).toBe("infrastructure");
      expect(result.reason).toContain("Build/checkout failure");
    });

    it("classifies build timeout as infrastructure", () => {
      const result = classifyCell(
        { ...BASE_FACTS, buildOutcome: "timeout" },
        EMPTY_EXPECTATIONS,
      );
      expect(result.classification).toBe("infrastructure");
      expect(result.reason).toContain("timeout");
    });

    it("classifies cancelled build as infrastructure", () => {
      const result = classifyCell(
        { ...BASE_FACTS, buildOutcome: "cancelled" },
        EMPTY_EXPECTATIONS,
      );
      expect(result.classification).toBe("infrastructure");
      expect(result.reason).toContain("cancelled");
    });
  });

  describe("skipped cells", () => {
    it("classifies ranNoChecks as skipped", () => {
      const result = classifyCell(
        { ...BASE_FACTS, ranNoChecks: true },
        EMPTY_EXPECTATIONS,
      );
      expect(result.classification).toBe("skipped");
      expect(result.reason).toContain("zero checks");
    });

    it("classifies total === 0 as skipped", () => {
      const result = classifyCell(
        { ...BASE_FACTS, total: 0, passed: 0, failures: 0, warnings: 0, errors: 0 },
        EMPTY_EXPECTATIONS,
      );
      expect(result.classification).toBe("skipped");
    });
  });

  describe("supported cells", () => {
    it("classifies pass with checks as supported", () => {
      const result = classifyCell(
        { ...BASE_FACTS, actionStatus: "pass", total: 5, passed: 5 },
        EMPTY_EXPECTATIONS,
      );
      expect(result.classification).toBe("supported");
      expect(result.reason).toBe("Compatibility checks passed");
    });

    it("classifies pass as unexpected-pass when expectation says it should fail", () => {
      const expectations = [
        {
          engineRef: "v0.1.1",
          packRef: "protocol-28",
          expectedStatus: "fail",
          failureSignature: "some error",
          runUrl: "https://example.com/expected-fail",
          dateAdded: "2026-01-01",
          reason: "Known issue",
        },
      ];
      const result = classifyCell(
        { ...BASE_FACTS, actionStatus: "pass", total: 5, passed: 5 },
        expectations,
      );
      expect(result.classification).toBe("unexpected-pass");
      expect(result.reason).toContain("Expected fail");
    });
  });

  describe("expected-incompatible cells", () => {
    it("matches expectation with same status and failure signature", () => {
      const expectations = [
        {
          engineRef: "v0.1.1",
          packRef: "protocol-28",
          expectedStatus: "fail",
          failureSignature: "CAP-83 mismatch",
          runUrl: "https://example.com/expected-fail",
          dateAdded: "2026-01-01",
          reason: "CAP-83 not implemented",
        },
      ];
      const result = classifyCell(
        {
          ...BASE_FACTS,
          actionStatus: "fail",
          firstDiagnostic: "CAP-83 mismatch in transaction envelope",
        },
        expectations,
      );
      expect(result.classification).toBe("expected-incompatible");
      expect(result.reason).toContain("CAP-83 not implemented");
    });

    it("matches expectation for execution-failed status", () => {
      const expectations = [
        {
          engineRef: "v0.2.0",
          packRef: "main",
          expectedStatus: "execution-failed",
          failureSignature: "cargo install failed",
          runUrl: "https://example.com/expected-install-fail",
          dateAdded: "2026-01-01",
          reason: "Engine build broken on this platform",
        },
      ];
      const result = classifyCell(
        {
          ...BASE_FACTS,
          engineRef: "v0.2.0",
          packRef: "main",
          actionStatus: "execution-failed",
          firstDiagnostic: "cargo install failed: linker error",
        },
        expectations,
      );
      expect(result.classification).toBe("expected-incompatible");
    });

    it("does not match when failure signature differs", () => {
      const expectations = [
        {
          engineRef: "v0.1.1",
          packRef: "protocol-28",
          expectedStatus: "fail",
          failureSignature: "CAP-83 mismatch",
          runUrl: "https://example.com/expected-fail",
          dateAdded: "2026-01-01",
          reason: "CAP-83 not implemented",
        },
      ];
      const result = classifyCell(
        {
          ...BASE_FACTS,
          actionStatus: "fail",
          firstDiagnostic: "RPC connection timeout",
        },
        expectations,
      );
      expect(result.classification).toBe("unexpected-failure");
    });

    it("does not match when engine/pack ref differs", () => {
      const expectations = [
        {
          engineRef: "v0.1.1",
          packRef: "protocol-28",
          expectedStatus: "fail",
          failureSignature: "CAP-83 mismatch",
          runUrl: "https://example.com/expected-fail",
          dateAdded: "2026-01-01",
          reason: "CAP-83 not implemented",
        },
      ];
      const result = classifyCell(
        {
          ...BASE_FACTS,
          engineRef: "v0.2.0",
          actionStatus: "fail",
          firstDiagnostic: "CAP-83 mismatch",
        },
        expectations,
      );
      expect(result.classification).toBe("unexpected-failure");
    });
  });

  describe("unexpected-failure cells", () => {
    it("classifies fail without expectation as unexpected-failure", () => {
      const result = classifyCell(
        { ...BASE_FACTS, actionStatus: "fail", firstDiagnostic: "Some new error" },
        EMPTY_EXPECTATIONS,
      );
      expect(result.classification).toBe("unexpected-failure");
      expect(result.reason).toContain("fail");
    });

    it("classifies error without expectation as unexpected-failure", () => {
      const result = classifyCell(
        { ...BASE_FACTS, actionStatus: "error", firstDiagnostic: "Runtime crash" },
        EMPTY_EXPECTATIONS,
      );
      expect(result.classification).toBe("unexpected-failure");
    });

    it("classifies execution-failed without expectation as unexpected-failure", () => {
      const result = classifyCell(
        { ...BASE_FACTS, actionStatus: "execution-failed", firstDiagnostic: "Install failed" },
        EMPTY_EXPECTATIONS,
      );
      expect(result.classification).toBe("unexpected-failure");
    });

    it("classifies warning without expectation as unexpected-failure", () => {
      const result = classifyCell(
        { ...BASE_FACTS, actionStatus: "warning", firstDiagnostic: "Deprecated API" },
        EMPTY_EXPECTATIONS,
      );
      expect(result.classification).toBe("unexpected-failure");
    });
  });

  describe("boundary cases", () => {
    it("handles missing actionStatus as unknown -> unexpected-failure", () => {
      const result = classifyCell(
        { ...BASE_FACTS, actionStatus: undefined },
        EMPTY_EXPECTATIONS,
      );
      expect(result.classification).toBe("unexpected-failure");
    });

    it("includes run URL in evidence for all classifications", () => {
      const result = classifyCell(BASE_FACTS, EMPTY_EXPECTATIONS);
      expect(result.evidence).toBe(BASE_FACTS.runUrl);
    });

    it("includes engineRef, packRef, actionCommit in result", () => {
      const result = classifyCell(BASE_FACTS, EMPTY_EXPECTATIONS);
      expect(result.engineRef).toBe(BASE_FACTS.engineRef);
      expect(result.packRef).toBe(BASE_FACTS.packRef);
      expect(result.actionCommit).toBe(BASE_FACTS.actionCommit);
    });
  });
});

describe("shouldFailJob", () => {
  it("returns true only for unexpected-failure and unexpected-pass", () => {
    expect(shouldFailJob("supported")).toBe(false);
    expect(shouldFailJob("expected-incompatible")).toBe(false);
    expect(shouldFailJob("infrastructure")).toBe(false);
    expect(shouldFailJob("skipped")).toBe(false);
    expect(shouldFailJob("unexpected-failure")).toBe(true);
    expect(shouldFailJob("unexpected-pass")).toBe(true);
  });
});

describe("formatCellRow", () => {
  it("formats a cell row with correct columns", () => {
    const cell = {
      engineRef: "v0.1.1",
      packRef: "protocol-28",
      actionCommit: "abc123",
      runUrl: "https://example.com/run",
      classification: "supported",
      reason: "All checks passed",
      evidence: "https://example.com/run",
    };
    const row = formatCellRow(cell);
    expect(row).toContain("v0.1.1");
    expect(row).toContain("protocol-28");
    expect(row).toContain("✅ supported");
    expect(row).toContain("All checks passed");
    expect(row).toContain("https://example.com/run");
  });

  it("uses correct icons for each classification", () => {
    const base = {
      engineRef: "v0.1.1",
      packRef: "protocol-28",
      actionCommit: "abc123",
      runUrl: "https://example.com/run",
      reason: "test",
      evidence: "https://example.com/run",
    };

    expect(formatCellRow({ ...base, classification: "supported" })).toContain("✅");
    expect(formatCellRow({ ...base, classification: "expected-incompatible" })).toContain("⚠️");
    expect(formatCellRow({ ...base, classification: "infrastructure" })).toContain("🔧");
    expect(formatCellRow({ ...base, classification: "skipped" })).toContain("⏭️");
    expect(formatCellRow({ ...base, classification: "unexpected-failure" })).toContain("❌");
    expect(formatCellRow({ ...base, classification: "unexpected-pass" })).toContain("🔄");
  });
});

describe("formatResultsTable", () => {
  it("generates a markdown table with header and rows", () => {
    const cells = [
      {
        engineRef: "v0.1.1",
        packRef: "protocol-28",
        actionCommit: "abc123",
        runUrl: "https://example.com/1",
        classification: "supported",
        reason: "Passed",
        evidence: "https://example.com/1",
      },
      {
        engineRef: "v0.2.0",
        packRef: "main",
        actionCommit: "abc123",
        runUrl: "https://example.com/2",
        classification: "unexpected-failure",
        reason: "Failed",
        evidence: "https://example.com/2",
      },
    ];
    const table = formatResultsTable(cells);
    expect(table).toContain("| Engine | Pack | Classification | Reason | Evidence |");
    expect(table).toContain("|---|---|---|---|---|");
    expect(table).toContain("v0.1.1");
    expect(table).toContain("v0.2.0");
    expect(table).toContain("supported");
    expect(table).toContain("unexpected-failure");
  });
});