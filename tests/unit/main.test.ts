import type * as actionsCore from "@actions/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as artifactModule from "../../src/artifact";
import type * as canaryModule from "../../src/canary";
import { InstallationFailedError, SummaryPublishFailedError, TimeoutError } from "../../src/errors";
import type { ActionInputs } from "../../src/inputs";
import type * as inputsModule from "../../src/inputs";
import type * as runnerModule from "../../src/runner";
import type * as summaryModule from "../../src/summary";
import { report, result } from "./helpers";

const {
  getInputsMock,
  ensureCanaryInstalledMock,
  runCheckMock,
  writeSummaryMock,
  renderSummaryMarkdownMock,
  renderExecutionFailureMarkdownMock,
  setFailedMock,
  setOutputMock,
  errorMock,
  warningMock,
  infoMock,
  debugMock,
  startGroupMock,
  endGroupMock,
  uploadReceiptMock,
} = vi.hoisted(() => ({
  getInputsMock: vi.fn<() => ActionInputs>(),
  ensureCanaryInstalledMock: vi.fn(),
  runCheckMock: vi.fn(),
  writeSummaryMock: vi.fn(),
  renderSummaryMarkdownMock: vi.fn(),
  renderExecutionFailureMarkdownMock: vi.fn(),
  setFailedMock: vi.fn(),
  setOutputMock: vi.fn(),
  errorMock: vi.fn(),
  warningMock: vi.fn(),
  infoMock: vi.fn(),
  debugMock: vi.fn(),
  startGroupMock: vi.fn(),
  endGroupMock: vi.fn(),
  uploadReceiptMock: vi.fn(),
}));

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof actionsCore>();
  return {
    ...actual,
    setFailed: setFailedMock,
    setOutput: setOutputMock,
    error: errorMock,
    warning: warningMock,
    info: infoMock,
    debug: debugMock,
    startGroup: startGroupMock,
    endGroup: endGroupMock,
  };
});

vi.mock("../../src/inputs", async (importOriginal) => {
  const actual = await importOriginal<typeof inputsModule>();
  return { ...actual, getInputs: getInputsMock };
});

// Only `ensureCanaryInstalled` — the entry point that reaches the cache,
// `cargo`, and the network — is replaced, so the real install chain stays out
// of these tests entirely: the branches under test all run *after*
// installation has succeeded. Everything else is re-exported from the real
// module, notably the pure `cargoInstallTimeoutMs` that `run()` derives from
// the inputs (issue #65).
vi.mock("../../src/canary", async (importOriginal) => {
  const actual = await importOriginal<typeof canaryModule>();
  return { ...actual, ensureCanaryInstalled: ensureCanaryInstalledMock };
});

vi.mock("../../src/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof runnerModule>();
  // buildCheckArgs stays real: it is pure, and asserting run() forwards its
  // result to runCheck pins that wiring too.
  return { ...actual, runCheck: runCheckMock };
});

vi.mock("../../src/summary", async (importOriginal) => {
  const actual = await importOriginal<typeof summaryModule>();
  return {
    ...actual,
    writeSummary: writeSummaryMock,
    renderSummaryMarkdown: renderSummaryMarkdownMock,
    renderExecutionFailureMarkdown: renderExecutionFailureMarkdownMock,
  };
});

// #362: only `uploadReceipt` is replaced — receipt tests assert the gate
// (upload when generate-receipt is true, skip when false) without ever
// touching the artifact service.
vi.mock("../../src/artifact", async (importOriginal) => {
  const actual = await importOriginal<typeof artifactModule>();
  return { ...actual, uploadReceipt: uploadReceiptMock };
});

// Mock resolveVersion to prevent GitHub API calls during unit tests.
// This ensures the 'fails the run when writeSummary rejects' test is
// deterministic and not affected by rate limiting or network issues.
vi.mock("../../src/version", async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/version')>();
  return {
    ...actual,
    resolveVersion: vi.fn().mockImplementation(async (version) => {
      return { version, tag: 'v' + version, commitSha: 'abc123' };
    }),
  };
});

import { run } from "../../src/main";

const BINARY_PATH = path.join("/fake-cargo-home", "bin", "stellar-canary");

const INPUTS: ActionInputs = {
  protocol: 28,
  config: undefined,
  network: "testnet",
  rpcUrl: undefined,
  fixturesDir: "fixtures",
  version: "0.1.0",
  uploadReport: false,
  annotations: true,
  timeoutMinutes: 1,
  allowEmpty: false,
  fixturesPackVersion: undefined,
  fixturesPackProtocol: undefined,
  githubToken: undefined,
  generateReceipt: false,
  strictIntegrity: false,
};

const PASS_REPORT = report({
  status: "pass",
  counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
  results: [
    result({
      testId: "p28-xdr-cap83-empty-tx-set",
      surface: "xdr",
      status: "pass",
      summary: "StellarValue round-tripped byte-for-byte",
      fixtureId: "p28-xdr-cap83-empty-tx-set",
    }),
  ],
});

describe("run", () => {
  let runnerTemp: string;

  beforeEach(() => {
    getInputsMock.mockReset().mockReturnValue(INPUTS);
    ensureCanaryInstalledMock.mockReset().mockResolvedValue({ binaryPath: BINARY_PATH, version: "0.1.0" });
    runCheckMock.mockReset();
    writeSummaryMock.mockReset().mockResolvedValue(undefined);
    renderSummaryMarkdownMock.mockReset().mockReturnValue("## Stellar Protocol Canary (rendered summary)");
    renderExecutionFailureMarkdownMock.mockReset().mockReturnValue("## Stellar Protocol Canary (execution failure)");
    setFailedMock.mockReset();
    setOutputMock.mockReset();
    errorMock.mockReset();
    warningMock.mockReset();
    infoMock.mockReset();
    debugMock.mockReset();
    startGroupMock.mockReset();
    endGroupMock.mockReset();
    uploadReceiptMock.mockReset();

    // The success path writes the report under RUNNER_TEMP; give each test a
    // private directory (as the integration suite does) so it neither leaks
    // nor races a parallel worker's file.
    runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "canary-main-unit-"));
    process.env.RUNNER_TEMP = runnerTemp;
  });

  afterEach(() => {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
    delete process.env.RUNNER_TEMP;
  });

  it("forwards the installed binary, the built args, and the millisecond timeout to runCheck", async () => {
    runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(PASS_REPORT), stderr: "" });

    await run();

    expect(runCheckMock).toHaveBeenCalledTimes(1);
    expect(runCheckMock).toHaveBeenCalledWith(BINARY_PATH, expect.arrayContaining(["check", "--format", "json"]), 60_000);
  });

  it("forwards --allow-empty only when the resolved engine supports it", async () => {
    runCheckMock.mockResolvedValue({ exitCode: 0, signal: null, stdout: JSON.stringify(PASS_REPORT), stderr: "" });

    getInputsMock.mockReturnValue({ ...INPUTS, version: "0.2.0", allowEmpty: true });
    await run();
    expect(runCheckMock.mock.calls[0]?.[1]).toContain("--allow-empty");

    runCheckMock.mockClear();
    infoMock.mockClear();
    getInputsMock.mockReturnValue({ ...INPUTS, version: "0.1.1", allowEmpty: true });
    await run();
    expect(runCheckMock.mock.calls[0]?.[1]).not.toContain("--allow-empty");
    expect(infoMock).toHaveBeenCalledWith(expect.stringContaining('"allow-empty" has no effect with Canary 0.1.1'));
  });

  // #65: run() derives the install bound from timeout-minutes and hands it to
  // ensureCanaryInstalled, so a hung `cargo install` is terminated by this
  // Action's own timeout path instead of blocking until GitHub's job-level
  // timeout. Here timeoutMinutes is 1, which is also the install floor.
  it("passes the timeout-minutes-derived install bound to ensureCanaryInstalled", async () => {
    runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(PASS_REPORT), stderr: "" });

    await run();

    expect(ensureCanaryInstalledMock).toHaveBeenCalledTimes(1);
    expect(ensureCanaryInstalledMock).toHaveBeenCalledWith(expect.anything(), 60_000, undefined, false);
  });

  // #271, branch 1: a child killed by a signal closes with a null exit code,
  // which is neither a pass nor a compatibility failure — run() must route it
  // through handleExecutionFailure with a message that names the signal.
  it("reports a signal-terminated run as an execution failure naming the signal", async () => {
    runCheckMock.mockResolvedValueOnce({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "killed mid-check" });

    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("Protocol Canary could not be executed.");
    expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("Canary was terminated by signal SIGTERM.");

    // Routed through the execution-failure path, not a compatibility result.
    expect(setOutputMock).toHaveBeenCalledWith("status", "execution-failed");
    expect(setOutputMock).toHaveBeenCalledWith("passed", "0");
    expect(setOutputMock).toHaveBeenCalledWith("failures", "0");
    // No report was produced, so no "report" output is set.
    expect(setOutputMock).not.toHaveBeenCalledWith("report", expect.anything());

    // The diagnostic (stderr) is carried into the execution-failure summary,
    // which is still written despite the abnormal termination.
    expect(renderExecutionFailureMarkdownMock).toHaveBeenCalledWith("Canary was terminated by signal SIGTERM.", "killed mid-check");
    expect(writeSummaryMock).toHaveBeenCalledWith("## Stellar Protocol Canary (execution failure)");

    // annotations: true, so the execution-failure annotation is emitted too.
    expect(errorMock).toHaveBeenCalledTimes(1);
    // No report existed at all, so nothing was replayed (#350).
    expect(setOutputMock).toHaveBeenCalledWith("replayed-count", "0");
  });

  // #350: the replayed-count output mirrors how many results the engine
  // served from its result cache instead of executing in this run.
  it("sets the replayed-count output from the report (#350)", async () => {
    const cachedRun = report({
      status: "pass",
      counts: { total: 2, passed: 2, failed: 0, warnings: 0, errors: 0, skipped: 0 },
      results: [
        result({ testId: "a", fixtureId: "a", source: "cache" }),
        result({ testId: "b", fixtureId: "b", source: "live" }),
      ],
    });
    runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(cachedRun), stderr: "" });

    await run();

    expect(setOutputMock).toHaveBeenCalledWith("replayed-count", "1");
    expect(setOutputMock).toHaveBeenCalledWith("status", "pass");
  });

  // #351: a non-zero engine exit with a usable report gets an annotation
  // carrying the exit-code classification and the engine's root diagnostic.
  it("annotates a non-zero engine exit with its classification and diagnostic (#351)", async () => {
    const failing = report({
      status: "fail",
      counts: { total: 1, passed: 0, failed: 1, warnings: 0, errors: 0, skipped: 0 },
      results: [
        result({ testId: "p28-xdr-1", surface: "xdr", status: "fail", summary: "decode failed", fixtureId: "p28-xdr-1" }),
      ],
    });
    runCheckMock.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      stdout: JSON.stringify(failing),
      stderr: "stellar-canary 0.2.0\nerror: assertion failed at byte 12\n",
    });

    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(setOutputMock).toHaveBeenCalledWith("status", "fail");
    const messages = errorMock.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes("exit code 1"))).toBe(true);
    expect(messages.some((message) => message.includes("Test failures detected"))).toBe(true);
    expect(messages.some((message) => message.includes("assertion failed at byte 12"))).toBe(true);
  });

  // #271, branch 2: writeSummary rejecting on the otherwise-successful path
  // must fail the run with the underlying reason, without swallowing or
  // overwriting the compatibility result the outputs already carry.
  it("fails the run when writeSummary rejects on the success path, after outputs are set", async () => {
    runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: `${JSON.stringify(PASS_REPORT)}\n`, stderr: "" });
    writeSummaryMock.mockRejectedValueOnce(new SummaryPublishFailedError("Failed to publish Canary summary: HTTP 502"));

    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(setFailedMock).toHaveBeenCalledWith("Failed to publish Canary summary: HTTP 502");

    // The pass outputs were set even though the summary publish failed, and
    // the zero exit code means the job failure comes only from the summary.
    expect(setOutputMock).toHaveBeenCalledWith("status", "pass");
    expect(setOutputMock).toHaveBeenCalledWith("passed", "1");
    expect(setOutputMock).toHaveBeenCalledWith("warnings", "0");
    expect(setOutputMock).toHaveBeenCalledWith("failures", "0");
    expect(setOutputMock).toHaveBeenCalledWith("errors", "0");

    // The report was still written next to the (failed) summary, and its
    // path is what the "report" output advertises.
    const reportPath = path.join(runnerTemp, "stellar-canary-report.json");
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(setOutputMock).toHaveBeenCalledWith("report", reportPath);

    // The success-path summary rendering was attempted exactly once, and a
    // passing report emits no annotations. The second argument is the
    // provenance metadata plumbed into the summary (#373): the mocked
    // binary path does not exist, so only the engine version is reported.
    expect(renderSummaryMarkdownMock).toHaveBeenCalledWith(PASS_REPORT, { engineVersion: "0.1.0" });
    expect(writeSummaryMock).toHaveBeenCalledTimes(1);
    expect(errorMock).not.toHaveBeenCalled();
    expect(warningMock).not.toHaveBeenCalled();
  });

  // #429: engine stderr is printed in a collapsed log group if non-empty
  it("prints non-empty Canary stderr in a collapsed log group on success (#429)", async () => {
    runCheckMock.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify(PASS_REPORT),
      stderr: "warning: test surface warning\n",
    });

    await run();

    expect(startGroupMock).toHaveBeenCalledWith("Canary diagnostics");
    expect(endGroupMock).toHaveBeenCalledTimes(1);
    const printed = infoMock.mock.calls.map((call) => String(call[0])).join("\n");
    expect(printed).toContain("warning: test surface warning");
  });

  it("does not print Canary diagnostics log group when stderr is whitespace or empty (#429)", async () => {
    runCheckMock.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify(PASS_REPORT),
      stderr: "   \n\t  ",
    });

    await run();

    expect(startGroupMock).not.toHaveBeenCalledWith("Canary diagnostics");
  });

  // #426: installation diagnostics are forwarded to handleExecutionFailure
  it("forwards cargo install failure diagnostics to execution-failure summary (#426)", async () => {
    ensureCanaryInstalledMock.mockRejectedValueOnce(
      new InstallationFailedError("cargo install failed", "error[E0432]: unresolved import\n"),
    );

    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(renderExecutionFailureMarkdownMock).toHaveBeenCalledWith(
      expect.stringContaining("cargo install failed"),
      "error[E0432]: unresolved import\n",
    );
  });

  // #427 / #429: TimeoutError stderr is printed in log block and forwarded to summary
  it("prints diagnostics and forwards stderr to execution-failure summary on timeout (#427, #429)", async () => {
    runCheckMock.mockRejectedValueOnce(
      new TimeoutError("Canary check timed out after 60000ms and was terminated.", "", "partial engine log before timeout"),
    );

    await run();

    expect(startGroupMock).toHaveBeenCalledWith("Canary diagnostics");
    expect(endGroupMock).toHaveBeenCalledTimes(1);
    expect(renderExecutionFailureMarkdownMock).toHaveBeenCalledWith(
      expect.stringContaining("timed out"),
      "partial engine log before timeout",
    );
  });

  // #428: githubToken is forwarded to ensureCanaryInstalled
  it("forwards githubToken to ensureCanaryInstalled (#428)", async () => {
    getInputsMock.mockReturnValue({ ...INPUTS, githubToken: "ghp_custom123" });
    runCheckMock.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify(PASS_REPORT),
      stderr: "",
    });

    await run();

    expect(ensureCanaryInstalledMock).toHaveBeenCalledWith(
      expect.anything(),
      60_000,
      "ghp_custom123",
      false,
    );
  });

  // #362: the receipt is strictly opt-in. With generate-receipt unset/false
  // nothing is written, no receipt-path output exists, and no upload runs.
  it("skips receipt generation and upload when generate-receipt is false (#362)", async () => {
    runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(PASS_REPORT), stderr: "" });

    await run();

    expect(uploadReceiptMock).not.toHaveBeenCalled();
    expect(setOutputMock).not.toHaveBeenCalledWith("receipt-path", expect.anything());
    expect(fs.existsSync(path.join(runnerTemp, "stellar-canary-receipt.json"))).toBe(false);
  });

  it("writes the receipt, sets receipt-path, and uploads it when generate-receipt is true (#362)", async () => {
    getInputsMock.mockReturnValue({ ...INPUTS, generateReceipt: true });
    uploadReceiptMock.mockResolvedValue({ uploaded: true });
    runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(PASS_REPORT), stderr: "" });

    await run();

    const receiptPath = path.join(runnerTemp, "stellar-canary-receipt.json");
    expect(fs.existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as { receiptVersion: number; engineVersion: string };
    expect(receipt.receiptVersion).toBe(1);
    expect(receipt.engineVersion).toBe(PASS_REPORT.toolVersion);
    expect(setOutputMock).toHaveBeenCalledWith("receipt-path", receiptPath);
    expect(uploadReceiptMock).toHaveBeenCalledWith(receiptPath);
  });

  // Negative testing from the issue: a failed receipt upload is auxiliary —
  // reported, never fatal, and never changes the compatibility outcome.
  it("does not fail the run when the receipt upload fails (#362)", async () => {
    getInputsMock.mockReturnValue({ ...INPUTS, generateReceipt: true });
    uploadReceiptMock.mockResolvedValue({ uploaded: false, reason: "artifact service down" });
    runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(PASS_REPORT), stderr: "" });

    await run();

    expect(setFailedMock).not.toHaveBeenCalled();
    expect(setOutputMock).toHaveBeenCalledWith("status", "pass");
    expect(setOutputMock).toHaveBeenCalledWith("receipt-path", expect.any(String));
  });

  // #362: no report, no receipt — the execution-failure path returns before
  // any receipt generation, so the output stays unset.
  it("sets no receipt-path when the run ended in an execution failure (#362)", async () => {
    getInputsMock.mockReturnValue({ ...INPUTS, generateReceipt: true });
    runCheckMock.mockResolvedValueOnce({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "" });

    await run();

    expect(setOutputMock).not.toHaveBeenCalledWith("receipt-path", expect.anything());
    expect(uploadReceiptMock).not.toHaveBeenCalled();
  });
});

