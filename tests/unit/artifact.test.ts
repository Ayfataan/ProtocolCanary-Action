import { afterEach, describe, expect, it, vi } from "vitest";

const { uploadArtifactMock } = vi.hoisted(() => ({ uploadArtifactMock: vi.fn() }));

vi.mock("@actions/artifact", () => ({
  DefaultArtifactClient: class {
    uploadArtifact = uploadArtifactMock;
  },
}));

import { ARTIFACT_NAME, RECEIPT_ARTIFACT_PREFIX, fallbackArtifactName, isArtifactNameCollision, receiptArtifactName, uploadReceipt, uploadReport } from "../../src/artifact";

const REPORT_PATH = "/tmp/stellar-canary-report.json";
const REPORT_DIR = "/tmp";
const RECEIPT_PATH = "/tmp/stellar-canary-receipt.json";

/** The exact error `@actions/artifact` throws for a duplicate name. */
function conflictError(): Error {
  return new Error(
    "Received non-retryable error: Failed request: (409) Conflict: " +
      "an artifact with this name already exists on the workflow run",
  );
}

afterEach(() => {
  uploadArtifactMock.mockReset();
});

describe("uploadReport", () => {
  it("reports success and uses the fixed artifact name", async () => {
    uploadArtifactMock.mockResolvedValue({ id: 1, size: 100 });
    const outcome = await uploadReport(REPORT_PATH);
    expect(outcome).toEqual({ uploaded: true, name: ARTIFACT_NAME, id: 1 });
    expect(uploadArtifactMock).toHaveBeenCalledTimes(1);
    expect(uploadArtifactMock).toHaveBeenCalledWith(ARTIFACT_NAME, [REPORT_PATH], REPORT_DIR);
  });

  it("uploads additional files (e.g. the JUnit rendering) alongside the report (#423)", async () => {
    uploadArtifactMock.mockResolvedValue({ id: 1, size: 100 });
    const outcome = await uploadReport(REPORT_PATH, undefined, ["/tmp/stellar-canary-report.junit.xml"]);
    expect(outcome).toEqual({ uploaded: true, name: ARTIFACT_NAME, id: 1 });
    expect(uploadArtifactMock).toHaveBeenCalledWith(
      ARTIFACT_NAME,
      [REPORT_PATH, "/tmp/stellar-canary-report.junit.xml"],
      REPORT_DIR,
    );
  });

  it("keeps the stable name even when a differentiator is supplied but the name is free", async () => {
    uploadArtifactMock.mockResolvedValue({ id: 1, size: 100 });
    const outcome = await uploadReport(REPORT_PATH, "protocol-28");
    expect(outcome).toEqual({ uploaded: true, name: ARTIFACT_NAME, id: 1 });
    expect(uploadArtifactMock).toHaveBeenCalledTimes(1);
    expect(uploadArtifactMock).toHaveBeenCalledWith(ARTIFACT_NAME, [REPORT_PATH], REPORT_DIR);
  });

  it("retries under a differentiator-derived name when the stable name already exists", async () => {
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 2, size: 100 });

    const outcome = await uploadReport(REPORT_PATH, "protocol-28-network-testnet");

    expect(outcome).toEqual({
      uploaded: true,
      name: `${ARTIFACT_NAME}-protocol-28-network-testnet`,
      id: 2,
    });
    expect(uploadArtifactMock).toHaveBeenCalledTimes(2);
    expect(uploadArtifactMock).toHaveBeenNthCalledWith(1, ARTIFACT_NAME, [REPORT_PATH], REPORT_DIR);
    expect(uploadArtifactMock).toHaveBeenNthCalledWith(
      2,
      `${ARTIFACT_NAME}-protocol-28-network-testnet`,
      [REPORT_PATH],
      REPORT_DIR,
    );
  });

  it("produces distinct artifact names for two colliding invocations with different inputs", async () => {
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 1, size: 1 })
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 2, size: 1 });

    const outcome1 = await uploadReport(REPORT_PATH, "protocol-28-network-testnet");
    const outcome2 = await uploadReport(REPORT_PATH, "protocol-28-network-mainnet");

    expect(outcome1.name).toBe(`${ARTIFACT_NAME}-protocol-28-network-testnet`);
    expect(outcome2.name).toBe(`${ARTIFACT_NAME}-protocol-28-network-mainnet`);

    const names = uploadArtifactMock.mock.calls.map((call) => call[0] as string);
    expect(names).toEqual([
      ARTIFACT_NAME,
      `${ARTIFACT_NAME}-protocol-28-network-testnet`,
      ARTIFACT_NAME,
      `${ARTIFACT_NAME}-protocol-28-network-mainnet`,
    ]);
    expect(new Set(names).size).toBe(3);
  });

  it("falls back to a short unique name when no differentiator was given", async () => {
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 1, size: 1 });

    const outcome = await uploadReport(REPORT_PATH);

    expect(outcome.uploaded).toBe(true);
    expect(outcome.id).toBe(1);
    const fallbackName = uploadArtifactMock.mock.calls[1]?.[0] as string;
    expect(outcome.name).toBe(fallbackName);
    expect(fallbackName).toMatch(new RegExp(`^${ARTIFACT_NAME}-[a-z0-9]+-[a-z0-9]+$`));
    expect(fallbackName).not.toBe(ARTIFACT_NAME);
  });

  it("forwards retentionDays option to uploadArtifact when provided", async () => {
    uploadArtifactMock.mockResolvedValue({ id: 42, size: 200 });
    const outcome = await uploadReport(REPORT_PATH, undefined, 7);
    expect(outcome).toEqual({ uploaded: true, name: ARTIFACT_NAME, id: 42 });
    expect(uploadArtifactMock).toHaveBeenCalledWith(
      ARTIFACT_NAME,
      [REPORT_PATH],
      REPORT_DIR,
      { retentionDays: 7 },
    );
  });

  it("forwards retentionDays during collision retry", async () => {
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 43, size: 200 });
    const outcome = await uploadReport(REPORT_PATH, "protocol-28", 14);
    expect(outcome).toEqual({
      uploaded: true,
      name: `${ARTIFACT_NAME}-protocol-28`,
      id: 43,
    });
    expect(uploadArtifactMock).toHaveBeenNthCalledWith(
      1,
      ARTIFACT_NAME,
      [REPORT_PATH],
      REPORT_DIR,
      { retentionDays: 14 },
    );
    expect(uploadArtifactMock).toHaveBeenNthCalledWith(
      2,
      `${ARTIFACT_NAME}-protocol-28`,
      [REPORT_PATH],
      REPORT_DIR,
      { retentionDays: 14 },
    );
  });

  it("omits id from outcome when client does not return one", async () => {
    uploadArtifactMock.mockResolvedValue({ size: 100 });
    const outcome = await uploadReport(REPORT_PATH);
    expect(outcome).toEqual({ uploaded: true, name: ARTIFACT_NAME });
    expect(outcome.id).toBeUndefined();
  });

  it("does not retry on a non-collision failure, and reports the reason", async () => {
    uploadArtifactMock.mockRejectedValue(new Error("service unavailable"));
    const outcome = await uploadReport(REPORT_PATH, "protocol-28");
    expect(outcome.uploaded).toBe(false);
    expect(outcome.reason).toContain("service unavailable");
    expect(uploadArtifactMock).toHaveBeenCalledTimes(1);
  });

  it("never throws when the fallback upload also fails", async () => {
    uploadArtifactMock.mockRejectedValue(conflictError());
    const outcome = await uploadReport(REPORT_PATH, "protocol-28");
    expect(outcome.uploaded).toBe(false);
    expect(uploadArtifactMock).toHaveBeenCalledTimes(2);
  });

  it("handles a non-Error failure reason when upload fails", async () => {
    uploadArtifactMock.mockRejectedValue("string-rejection-reason");
    const outcome = await uploadReport(REPORT_PATH, "protocol-28");
    expect(outcome).toEqual({ uploaded: false, reason: "string-rejection-reason" });
    expect(uploadArtifactMock).toHaveBeenCalledTimes(1);
  });
});

describe("fallbackArtifactName", () => {
  it("sanitizes a differentiator into a valid artifact name", () => {
    expect(fallbackArtifactName("protocol-28 network: testnet")).toBe(
      `${ARTIFACT_NAME}-protocol-28-network-testnet`,
    );
  });

  it("generates unique names when no differentiator is available", () => {
    expect(fallbackArtifactName()).not.toBe(fallbackArtifactName());
  });

  it("falls back to a unique name when the differentiator sanitizes away", () => {
    const name = fallbackArtifactName("!!!");

    expect(name).toMatch(new RegExp(`^${ARTIFACT_NAME}-[a-z0-9]+-[a-z0-9]+$`));
    expect(name).not.toBe(`${ARTIFACT_NAME}-`);
  });
});

describe("isArtifactNameCollision", () => {
  it("recognizes the duplicate-name conflict and ignores unrelated failures", () => {
    expect(isArtifactNameCollision(conflictError())).toBe(true);
    expect(isArtifactNameCollision(new Error("service unavailable"))).toBe(false);
    expect(isArtifactNameCollision(new Error("File /tmp/report.json does not exist"))).toBe(false);
  });

  it("recognizes collisions across Error, string, and object inputs", () => {
    // Error instances
    expect(isArtifactNameCollision(new Error("Failed request: (409)"))).toBe(true);
    expect(isArtifactNameCollision(new Error("Upload conflict detected"))).toBe(true);
    expect(isArtifactNameCollision(new Error("an artifact with this name already exists"))).toBe(true);
    expect(isArtifactNameCollision(new Error("something already exists on disk"))).toBe(false);
    expect(isArtifactNameCollision(new Error("artifact upload timed out"))).toBe(false);
    expect(isArtifactNameCollision(new Error("unrelated error"))).toBe(false);

    // String error values
    expect(isArtifactNameCollision("Received HTTP (409)")).toBe(true);
    expect(isArtifactNameCollision("Conflict: name already registered")).toBe(true);
    expect(isArtifactNameCollision("an artifact already exists in this run")).toBe(true);
    expect(isArtifactNameCollision("file already exists")).toBe(false);
    expect(isArtifactNameCollision("arbitrary string error")).toBe(false);

    // Object values with toString representation
    expect(isArtifactNameCollision({ toString: () => "status: (409) Conflict" })).toBe(true);
    expect(isArtifactNameCollision({ toString: () => "Error: Conflict occurred" })).toBe(true);
    expect(isArtifactNameCollision({ toString: () => "an artifact with this name already exists" })).toBe(true);
    expect(isArtifactNameCollision({ toString: () => "plain object without collision info" })).toBe(false);
    expect(isArtifactNameCollision({})).toBe(false);
  });
});

/**
 * #362: the Execution Receipt artifact. Named per workflow run
 * (`stellar-canary-receipt-<run-id>`), auxiliary like the report artifact —
 * an upload failure is reported through the outcome and never throws, so it
 * cannot crash the action (#362 negative testing: "upload failure does not
 * crash action").
 */
describe("uploadReceipt", () => {
  afterEach(() => {
    delete process.env.GITHUB_RUN_ID;
  });

  it("uploads under the run-scoped name when GITHUB_RUN_ID is set", async () => {
    process.env.GITHUB_RUN_ID = "4321";
    uploadArtifactMock.mockResolvedValue({ id: 7, size: 10 });

    const outcome = await uploadReceipt(RECEIPT_PATH);

    expect(outcome).toEqual({ uploaded: true });
    expect(uploadArtifactMock).toHaveBeenCalledTimes(1);
    expect(uploadArtifactMock).toHaveBeenCalledWith(
      `${RECEIPT_ARTIFACT_PREFIX}-4321`,
      [RECEIPT_PATH],
      REPORT_DIR,
    );
  });

  it("still produces a unique run name when GITHUB_RUN_ID is absent", async () => {
    uploadArtifactMock.mockResolvedValue({ id: 8, size: 10 });

    const outcome = await uploadReceipt(RECEIPT_PATH);

    expect(outcome).toEqual({ uploaded: true });
    const name = uploadArtifactMock.mock.calls[0]?.[0] as string;
    expect(name).toMatch(new RegExp(`^${RECEIPT_ARTIFACT_PREFIX}-[a-z0-9]+(-[a-z0-9]+)?$`));
    expect(name).not.toBe(RECEIPT_ARTIFACT_PREFIX);
  });

  it("retries once under a unique name when the run-scoped name collides (two invocations, one run)", async () => {
    process.env.GITHUB_RUN_ID = "4321";
    uploadArtifactMock.mockRejectedValueOnce(conflictError()).mockResolvedValueOnce({ id: 9, size: 10 });

    const outcome = await uploadReceipt(RECEIPT_PATH);

    expect(outcome).toEqual({ uploaded: true });
    expect(uploadArtifactMock).toHaveBeenCalledTimes(2);
    expect(uploadArtifactMock).toHaveBeenNthCalledWith(1, `${RECEIPT_ARTIFACT_PREFIX}-4321`, [RECEIPT_PATH], REPORT_DIR);
    const retryName = uploadArtifactMock.mock.calls[1]?.[0] as string;
    expect(retryName).toMatch(new RegExp(`^${RECEIPT_ARTIFACT_PREFIX}-4321-[a-z0-9-]+$`));
  });

  it("reports a non-collision failure through the outcome and never throws", async () => {
    process.env.GITHUB_RUN_ID = "4321";
    uploadArtifactMock.mockRejectedValue(new Error("artifact service down"));

    await expect(uploadReceipt(RECEIPT_PATH)).resolves.toMatchObject({
      uploaded: false,
      reason: expect.stringContaining("artifact service down"),
    });
    expect(uploadArtifactMock).toHaveBeenCalledTimes(1);
  });

  it("never throws when the collision retry also fails", async () => {
    uploadArtifactMock.mockRejectedValue(conflictError());
    const outcome = await uploadReceipt(RECEIPT_PATH);
    expect(outcome.uploaded).toBe(false);
  });

  it("handles a non-Error failure reason when receipt upload fails", async () => {
    uploadArtifactMock.mockRejectedValue("string-receipt-rejection");
    const outcome = await uploadReceipt(RECEIPT_PATH);
    expect(outcome).toEqual({ uploaded: false, reason: "string-receipt-rejection" });
  });
});

describe("receiptArtifactName (#365)", () => {
  it("embeds a well-formed run id verbatim", () => {
    expect(receiptArtifactName("4321")).toBe(`${RECEIPT_ARTIFACT_PREFIX}-4321`);
  });

  it("is deterministic for the same id (a retried step addresses one artifact name)", () => {
    expect(receiptArtifactName("4321")).toBe(receiptArtifactName("4321"));
    expect(receiptArtifactName("feat/363 canary!")).toBe(receiptArtifactName("feat/363 canary!"));
  });

  it("collapses awkward run ids through the same sanitizer as the report differentiator", () => {
    expect(receiptArtifactName("feat/363 canary!")).toBe(`${RECEIPT_ARTIFACT_PREFIX}-feat-363-canary`);
    expect(receiptArtifactName("protocol.28_v2")).toBe(`${RECEIPT_ARTIFACT_PREFIX}-protocol.28_v2`);
  });

  it("falls back to a short unique suffix when the id is absent, empty, or blank", () => {
    for (const id of [undefined, "", "   "]) {
      const name = receiptArtifactName(id);
      expect(name).toMatch(new RegExp(`^${RECEIPT_ARTIFACT_PREFIX}-[a-z0-9]+(-[a-z0-9]+)?$`));
      expect(name).not.toBe(RECEIPT_ARTIFACT_PREFIX);
    }
  });

  it("trims a padded run id to its documented name", () => {
    expect(receiptArtifactName("  4321  ")).toBe(`${RECEIPT_ARTIFACT_PREFIX}-4321`);
  });
});

