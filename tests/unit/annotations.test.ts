import type * as actionsCore from "@actions/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const { errorMock, warningMock } = vi.hoisted(() => ({
  errorMock: vi.fn(),
  warningMock: vi.fn(),
}));

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof actionsCore>();
  return { ...actual, error: errorMock, warning: warningMock };
});

import type { AnnotationProperties } from "@actions/core";
import { emitAnnotations, emitExecutionFailureAnnotation, emitExitFailureAnnotation } from "../../src/annotations";
import { report, result } from "./helpers";

afterEach(() => {
  errorMock.mockReset();
  warningMock.mockReset();
});

describe("emitAnnotations", () => {
  it("emits an error annotation for a fail result with compatibility failure label", () => {
    emitAnnotations(report([result({ status: "fail", testId: "p28-xdr-1", summary: "decode failed" })]));
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(errorMock.mock.calls[0]?.[0]).toContain("p28-xdr-1");
    expect(errorMock.mock.calls[0]?.[0]).toContain("[compatibility failure]");
    expect(errorMock.mock.calls[0]?.[1]).toMatchObject({ title: "Stellar Protocol Canary" });
  });

  it("emits an error annotation for an error result with execution error label", () => {
    emitAnnotations(report([result({ status: "error", testId: "p28-rpc-1" })]));
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(errorMock.mock.calls[0]?.[0]).toContain("[execution error]");
  });

  it("emits a warning annotation for a warning result with warning label", () => {
    emitAnnotations(report([result({ status: "warning", testId: "p28-rpc-2" })]));
    expect(warningMock).toHaveBeenCalledTimes(1);
    expect(warningMock.mock.calls[0]?.[0]).toContain("[warning]");
  });

  it("never annotates a pass or skipped result", () => {
    emitAnnotations(report([result({ status: "pass" }), result({ status: "skipped" })]));
    expect(errorMock).not.toHaveBeenCalled();
    expect(warningMock).not.toHaveBeenCalled();
  });

  it("never sets a file/line location, since fixtures do not carry one", () => {
    emitAnnotations(report([result({ status: "fail" })]));
    const properties = errorMock.mock.calls[0]?.[1] as AnnotationProperties | undefined;
    expect(properties?.file).toBeUndefined();
    expect(properties?.startLine).toBeUndefined();
  });

  it("passes a multi-line fail summary through unchanged to core.error", () => {
    // @actions/core is responsible for percent-encoding newlines in the
    // workflow command; emitAnnotations must hand it the raw message.
    const summary = "surface mismatch\n  expected: protocol 28\n  actual: protocol 27";
    emitAnnotations(report([result({ status: "fail", testId: "p28-xdr-2", summary })]));
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(errorMock.mock.calls[0]?.[0]).toBe(`[xdr] p28-xdr-2: [compatibility failure] ${summary}`);
    expect(errorMock.mock.calls[0]?.[0]?.split("\n")).toHaveLength(3);
  });

  it("passes a multi-line warning summary through unchanged to core.warning", () => {
    const summary = "deprecated endpoint\n  use the v2 RPC URL";
    emitAnnotations(report([result({ status: "warning", testId: "p28-rpc-3", summary })]));
    expect(warningMock).toHaveBeenCalledTimes(1);
    expect(warningMock.mock.calls[0]?.[0]).toBe(`[xdr] p28-rpc-3: [warning] ${summary}`);
    expect(errorMock).not.toHaveBeenCalled();
  });
});describe("emitExecutionFailureAnnotation", () => {
  it("emits a single general error annotation", () => {
    emitExecutionFailureAnnotation("cargo install failed");
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(errorMock.mock.calls[0]?.[0]).toContain("cargo install failed");
  });

  // #351: the reason alone ("Canary configuration is invalid. (exit code 2)")
  // hid the engine's actual explanation; the diagnostic belongs in the
  // annotation too, since that is what surfaces on the run page.
  it("includes the engine diagnostic when one is available (#351)", () => {
    emitExecutionFailureAnnotation("Canary exited with code 2.", "error: no checks ran: all 7 fixtures skipped");
    expect(errorMock).toHaveBeenCalledTimes(1);
    const message = String(errorMock.mock.calls[0]?.[0]);
    expect(message).toContain("Canary exited with code 2.");
    expect(message).toContain("no checks ran: all 7 fixtures skipped");
    expect(message).toContain("Engine diagnostic:");
  });

  it("omits the diagnostic line when stderr is empty or blank (#351)", () => {
    emitExecutionFailureAnnotation("timed out", "   \n  ");
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(String(errorMock.mock.calls[0]?.[0])).not.toContain("Engine diagnostic:");
  });
});

describe("emitExitFailureAnnotation", () => {
  it("classifies exit code 1 as test assertion failures and carries the diagnostic (#351)", () => {
    emitExitFailureAnnotation(1, "assertion failed: byte 12 differs");
    expect(errorMock).toHaveBeenCalledTimes(1);
    const message = String(errorMock.mock.calls[0]?.[0]);
    expect(message).toContain("exit code 1");
    expect(message).toContain("Test failures detected");
    expect(message).toContain("assertion failed: byte 12 differs");
    expect(errorMock.mock.calls[0]?.[1]).toMatchObject({ title: "Stellar Protocol Canary" });
  });

  it("classifies exit code 2 as the regression gate, not a generic process error (#351)", () => {
    emitExitFailureAnnotation(2, "error: no checks ran: all 7 loaded fixtures were skipped");
    expect(errorMock).toHaveBeenCalledTimes(1);
    const message = String(errorMock.mock.calls[0]?.[0]);
    expect(message).toContain("exit code 2");
    expect(message).toContain("Regression gate triggered");
    expect(message).toContain("all 7 loaded fixtures were skipped");
  });

  it("classifies exit code 3 as an unexpected runtime crash and never as a regression (#351)", () => {
    emitExitFailureAnnotation(3, "panicked at canary-core/src/main.rs:42");
    expect(errorMock).toHaveBeenCalledTimes(1);
    const message = String(errorMock.mock.calls[0]?.[0]);
    expect(message).toContain("exit code 3");
    expect(message).toContain("Unexpected runtime crash");
    // Negative case: a crash must not be reported as a regression gate.
    expect(message).not.toContain("Regression gate");
    expect(message).toContain("panicked at canary-core/src/main.rs:42");
  });

  it("still classifies it when no diagnostic is available (#351)", () => {
    emitExitFailureAnnotation(2, "");
    expect(errorMock).toHaveBeenCalledTimes(1);
    const message = String(errorMock.mock.calls[0]?.[0]);
    expect(message).toContain("Regression gate triggered");
    expect(message).not.toContain("Engine diagnostic:");
  });

  it("never sets a file/line location, since no fixture carries one (#351)", () => {
    emitExitFailureAnnotation(1, "failed to decode StellarValue");
    const properties = errorMock.mock.calls[0]?.[1] as AnnotationProperties | undefined;
    expect(properties?.file).toBeUndefined();
    expect(properties?.startLine).toBeUndefined();
  });
});
