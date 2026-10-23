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
  renderJUnitReportMock,
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
  renderJUnitReportMock: vi.fn(),
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
  // result to runCheck pins that wiring too. renderJUnitReport is replaced
  // because it calls the module-local (unmocked) runCheck internally — the
  // real one would spawn the fake BINARY_PATH; its own behaviour is covered
  // by runner.test.ts against the mock engine.
  return { ...actual, runCheck: runCheckMock, renderJUnitReport: renderJUnitReportMock };
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

import { run } from "../../src/main";

const BINARY_PATH = path.join("/fake-cargo-home", "bin", "stellar-canary");

const INPUTS: ActionInputs = {
  protocol: 28,
  config: undefined,
  network: "testnet",
  networkPassphrase: undefined,
  rpcUrl: undefined,
  rpcMaxRetries: undefined,
  rpcRetryDelayMs: undefined,
  fixturesDir: "fixtures",
  fixture: undefined,
  surface: undefined,
  cacheDir: undefined,
  version: "0.1.0",
  uploadReport: false,
  annotations: true,
  timeoutMinutes: 1,
  allowEmpty: false,
  failOnWarning: false,
  offline: false,
  fixturesPackVersion: undefined,
  fixturesPackProtocol: undefined,
  baselineReport: undefined,
  githubToken: undefined,
  generateReceipt: false,
  junitReport: false,
  strictIntegrity: false,
  prComment: false,
  workingDirectory: path.resolve("."),
} as ActionInputs;

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
    renderJUnitReportMock.mockReset();
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

  it.each(["timeout", "signal", "parse"])("sanitizes %s failure annotations, reasons and the published summary", async (kind) => {
    const actual = await vi.importActual<typeof summaryModule>("../../src/summary");
    renderExecutionFailureMarkdownMock.mockImplementation(actual.renderExecutionFailureMarkdown);
    const token = "ghp_" + "a".repeat(36);
    const dirty = `fatal \x1b[31m${token}\x1b[0m\0\x85 https://host/?api_key=private-query\n::error::injected`;
    if (kind === "timeout") {
      runCheckMock.mockRejectedValueOnce(new TimeoutError("timed out", "", dirty));
    } else {
      runCheckMock.mockResolvedValueOnce({
        exitCode: kind === "signal" ? null : 1,
        signal: kind === "signal" ? "SIGTERM" : null,
        stdout: dirty,
        stderr: dirty,
      });
    }
    await run();
    const outputs = [...errorMock.mock.calls, ...setFailedMock.mock.calls, ...writeSummaryMock.mock.calls];
    expect(errorMock).toHaveBeenCalled();
    expect(writeSummaryMock).toHaveBeenCalled();
    for (const [value] of outputs) {
      const text = String(value);
      expect(text.includes(token)).toBe(false);
      expect(text).not.toContain("private-query");
      expect(text).not.toContain("::");
      expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    }
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

  it("warns about each new setting ignored by an older engine without exposing the passphrase", async () => {
    runCheckMock.mockResolvedValue({ exitCode: 0, signal: null, stdout: JSON.stringify(PASS_REPORT), stderr: "" });
    getInputsMock.mockReturnValue({
      ...INPUTS,
      version: "0.2.0",
      networkPassphrase: "Private Network ; secret value",
      rpcMaxRetries: 0,
      rpcRetryDelayMs: 250,
    });

    await run();

    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining('"network-passphrase", "rpc-max-retries", "rpc-retry-delay-ms"'),
    );
    expect(warningMock.mock.calls.flat().join(" ")).not.toContain("secret value");
    expect(runCheckMock.mock.calls[0]?.[1]).not.toContain("--network-passphrase");
  });

  it("does not warn about new settings when the resolved engine supports them", async () => {
    runCheckMock.mockResolvedValue({ exitCode: 0, signal: null, stdout: JSON.stringify(PASS_REPORT), stderr: "" });
    getInputsMock.mockReturnValue({ ...INPUTS, version: "0.3.0", rpcMaxRetries: 0 });

    await run();

    expect(warningMock).not.toHaveBeenCalledWith(expect.stringContaining("rpc-max-retries"));
    expect(runCheckMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["--rpc-max-retries", "0"]),
    );
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

  it.each(["stderr", "report"])("sanitizes the exit-failure diagnostic from %s", async (source) => {
    const token = "ghp_" + "f".repeat(36);
    const dirty = `fatal \x1b[31m${token}\x1b[0m\0\x85 https://host/?api_key=private-query\n::error::injected`;
    const failing = report({
      status: "fail",
      counts: { total: 1, passed: 0, failed: 1, warnings: 0, errors: 0, skipped: 0 },
      results: [result({ status: "fail", summary: source === "report" ? dirty : "failed" })],
    });
    runCheckMock.mockResolvedValueOnce({
      exitCode: 1, signal: null, stdout: JSON.stringify(failing),
      stderr: source === "stderr" ? dirty : "",
    });
    await run();
    const message = String(errorMock.mock.calls.find(([value]) => String(value).includes("exit code 1"))?.[0]);
    expect(message).toContain("Engine diagnostic:");
    expect(message.includes(token)).toBe(false);
    expect(message).not.toContain("private-query");
    expect(message).not.toContain("::");
    expect(message).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
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
    // provenance metadata plumbed into the summary: the mocked binary path
    // does not exist, so only the engine version and the reproduction
    // command's argument array are reported (#373, #416).
    expect(renderSummaryMarkdownMock).toHaveBeenCalledWith(PASS_REPORT, {
      engineVersion: "0.1.0",
      engineArgs: ["check", "--format", "json", "--protocol", "28", "--network", "testnet", "--fixtures-dir", "fixtures"],
    });
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

  describe("issue #414: engine-version, total, skipped and observed-protocol outputs", () => {
    it("sets engine-version, total, skipped and observed-protocol on success", async () => {
      ensureCanaryInstalledMock.mockResolvedValueOnce({ binaryPath: BINARY_PATH, version: "0.1.2" });
      const testReport = report({
        status: "pass",
        counts: { total: 4, passed: 4, failed: 0, warnings: 0, errors: 0, skipped: 1 },
        network: { name: "testnet", observedProtocol: 28 },
        results: ["a", "b", "c", "d"].map((testId) => result({ testId, fixtureId: testId })),
        skipped: [{ fixtureId: "e", surface: "soroban", reason: "disabled" }],
      });
      runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(testReport), stderr: "" });

      await run();

      expect(setOutputMock).toHaveBeenCalledWith("engine-version", "0.1.2");
      expect(setOutputMock).toHaveBeenCalledWith("total", "4");
      expect(setOutputMock).toHaveBeenCalledWith("skipped", "1");
      expect(setOutputMock).toHaveBeenCalledWith("observed-protocol", "28");
    });

    it("sets engine-version, total, skipped and observed-protocol on compatibility failure", async () => {
      ensureCanaryInstalledMock.mockResolvedValueOnce({ binaryPath: BINARY_PATH, version: "0.1.2" });
      const testReport = report({
        status: "fail",
        counts: { total: 3, passed: 1, failed: 2, warnings: 0, errors: 0, skipped: 0 },
        network: { name: "testnet", observedProtocol: 28 },
        results: [
          result({ testId: "a", status: "pass", fixtureId: "a" }),
          result({ testId: "b", status: "fail", fixtureId: "b" }),
          result({ testId: "c", status: "fail", fixtureId: "c" }),
        ],
      });
      runCheckMock.mockResolvedValueOnce({ exitCode: 1, signal: null, stdout: JSON.stringify(testReport), stderr: "" });

      await run();

      expect(setOutputMock).toHaveBeenCalledWith("engine-version", "0.1.2");
      expect(setOutputMock).toHaveBeenCalledWith("total", "3");
      expect(setOutputMock).toHaveBeenCalledWith("skipped", "0");
      expect(setOutputMock).toHaveBeenCalledWith("observed-protocol", "28");
    });

    it("sets observed-protocol to empty string for an offline run (no network object)", async () => {
      const testReport = report({
        status: "pass",
        counts: { total: 2, passed: 2, failed: 0, warnings: 0, errors: 0, skipped: 0 },
        results: [result({ testId: "a", fixtureId: "a" })],
      });
      runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(testReport), stderr: "" });

      await run();

      expect(setOutputMock).toHaveBeenCalledWith("observed-protocol", "");
    });

    it("sets observed-protocol to empty string when network is present but observedProtocol is missing or NaN", async () => {
      const missingObserved = report({
        status: "pass",
        counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
        network: { name: "testnet" },
        results: [result({ testId: "a", fixtureId: "a" })],
      });
      runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(missingObserved), stderr: "" });

      await run();

      expect(setOutputMock).toHaveBeenCalledWith("observed-protocol", "");

      setOutputMock.mockClear();
      const nanObserved = report({
        status: "pass",
        counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
        network: { name: "testnet", observedProtocol: Number.NaN },
        results: [result({ testId: "a", fixtureId: "a" })],
      });
      runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(nanObserved), stderr: "" });

      await run();

      expect(setOutputMock).toHaveBeenCalledWith("observed-protocol", "");
    });

    it("sets total and skipped when counts.skipped is absent in older engine report", async () => {
      const rawJson = {
        schemaVersion: 1,
        toolVersion: "0.1.0",
        targetProtocol: 28,
        project: { name: "mock-project", type: "soroban" },
        status: "pass",
        counts: { total: 4, passed: 4, failed: 0, warnings: 0, errors: 0 },
        results: [
          {
            testId: "p28-xdr-1",
            protocol: 28,
            surface: "xdr",
            status: "pass",
            summary: "ok",
            durationMs: 1,
            fixtureId: "p28-xdr-1",
          },
        ],
        git: { commit: "deadbeef", branch: "main", isDirty: false },
      };
      runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(rawJson), stderr: "" });

      await run();

      expect(setOutputMock).toHaveBeenCalledWith("total", "4");
      expect(setOutputMock).toHaveBeenCalledWith("skipped", "0");
    });

    it("sets failure outputs with resolved engine-version when execution fails after install succeeded", async () => {
      getInputsMock.mockReturnValue({ ...INPUTS, version: "0.1.1" });
      runCheckMock.mockResolvedValueOnce({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "" });

      await run();

      expect(setOutputMock).toHaveBeenCalledWith("status", "execution-failed");
      expect(setOutputMock).toHaveBeenCalledWith("total", "0");
      expect(setOutputMock).toHaveBeenCalledWith("skipped", "0");
      expect(setOutputMock).toHaveBeenCalledWith("observed-protocol", "");
      expect(setOutputMock).toHaveBeenCalledWith("engine-version", "0.1.1");
    });

    it("sets failure outputs with empty engine-version when installation fails", async () => {
      ensureCanaryInstalledMock.mockRejectedValueOnce(
        new InstallationFailedError("cargo install failed", "error[E0432]: unresolved import\n"),
      );

      await run();

      expect(setOutputMock).toHaveBeenCalledWith("status", "execution-failed");
      expect(setOutputMock).toHaveBeenCalledWith("total", "0");
      expect(setOutputMock).toHaveBeenCalledWith("skipped", "0");
      expect(setOutputMock).toHaveBeenCalledWith("observed-protocol", "");
      expect(setOutputMock).toHaveBeenCalledWith("engine-version", "");
    });
  });

  describe("issue #340: fixture-pack identity outputs", () => {
    it("sets pack-protocol, pack-version and pack-digest from the report and inputs", async () => {
      const digest = `sha256:${"b".repeat(64)}`;
      const testReport = report({
        status: "pass",
        counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
        results: [result({ testId: "a", fixtureId: "a" })],
        fixturePack: { digest, protocol: 28 },
      });
      getInputsMock.mockReturnValue({ ...INPUTS, fixturesPackVersion: "v1.2.0", fixturesPackProtocol: 28 });
      runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(testReport), stderr: "" });

      await run();

      expect(setOutputMock).toHaveBeenCalledWith("pack-protocol", "28");
      expect(setOutputMock).toHaveBeenCalledWith("pack-version", "v1.2.0");
      expect(setOutputMock).toHaveBeenCalledWith("pack-digest", digest);
    });

    it("sets empty pack outputs when no external pack is in use", async () => {
      runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(PASS_REPORT), stderr: "" });

      await run();

      expect(setOutputMock).toHaveBeenCalledWith("pack-protocol", "");
      expect(setOutputMock).toHaveBeenCalledWith("pack-version", "");
      expect(setOutputMock).toHaveBeenCalledWith("pack-digest", "");
    });

    it("clears pack outputs on an execution failure instead of leaking a stale identity", async () => {
      runCheckMock.mockResolvedValueOnce({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "" });

      await run();

      expect(setOutputMock).toHaveBeenCalledWith("pack-protocol", "");
      expect(setOutputMock).toHaveBeenCalledWith("pack-version", "");
      expect(setOutputMock).toHaveBeenCalledWith("pack-digest", "");
    });
  });

  describe("issue #344: baseline report failure modes", () => {
    function baselineFile(contents: string): string {
      const file = path.join(runnerTemp, "baseline.json");
      fs.writeFileSync(file, contents, "utf8");
      return file;
    }

    it("fails before installation on an invalid JSON baseline with a parse annotation", async () => {
      getInputsMock.mockReturnValue({ ...INPUTS, baselineReport: baselineFile('{"schemaVersion": 1,') });

      await run();

      expect(ensureCanaryInstalledMock).not.toHaveBeenCalled();
      expect(runCheckMock).not.toHaveBeenCalled();
      expect(setFailedMock).toHaveBeenCalledTimes(1);
      expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("baseline-report");
      expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("could not be parsed as JSON");
      expect(errorMock).toHaveBeenCalledWith(
        expect.stringContaining("baseline validation failed"),
        expect.objectContaining({ title: "Stellar Protocol Canary" }),
      );
    });

    it("fails before installation when the baseline schemaVersion is unsupported", async () => {
      getInputsMock.mockReturnValue({
        ...INPUTS,
        baselineReport: baselineFile(JSON.stringify(report({ schemaVersion: 99 }))),
      });

      await run();

      expect(ensureCanaryInstalledMock).not.toHaveBeenCalled();
      expect(setFailedMock).toHaveBeenCalledTimes(1);
      expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("schemaVersion 99");
    });

    it("halts with an incompatibility diagnostic when the baseline targets another protocol", async () => {
      getInputsMock.mockReturnValue({
        ...INPUTS,
        baselineReport: baselineFile(JSON.stringify(report({ targetProtocol: 27 }))),
      });
      runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(PASS_REPORT), stderr: "" });

      await run();

      expect(setFailedMock).toHaveBeenCalledTimes(1);
      const failure = String(setFailedMock.mock.calls[0]?.[0]);
      expect(failure).toContain("Incompatible baseline report");
      expect(failure).toContain("targets protocol 27, but this run targets protocol 28");
      expect(errorMock).toHaveBeenCalledWith(
        expect.stringContaining("targets protocol 27"),
        expect.objectContaining({ title: "Stellar Protocol Canary" }),
      );
      // No regression claim is made and no compatibility outputs are published.
      expect(setOutputMock).not.toHaveBeenCalledWith("status", expect.anything());
    });

    it("validates a matching baseline without claiming a regression verdict", async () => {
      const baseline = baselineFile(JSON.stringify(report({ targetProtocol: 28 })));
      getInputsMock.mockReturnValue({ ...INPUTS, baselineReport: baseline });
      runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(PASS_REPORT), stderr: "" });

      await run();

      expect(setFailedMock).not.toHaveBeenCalled();
      expect(setOutputMock).toHaveBeenCalledWith("status", "pass");
      expect(infoMock).toHaveBeenCalledWith(expect.stringContaining("validated for protocol 28"));
      expect(infoMock).toHaveBeenCalledWith(expect.stringContaining("no regression verdict"));
    });
  });

  it("fails before any install or engine run when a scoped input the engine cannot honour is set (#458)", async () => {
    getInputsMock.mockReturnValue({ ...INPUTS, fixture: "p28-xdr-cap83-empty-tx-set" });

    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    const message = String(setFailedMock.mock.calls[0]?.[0]);
    expect(message).toContain('"fixture"');
    expect(message).toContain("Canary 0.1.0");
    expect(message).toMatch(/no released Protocol-Canary engine supports (it|them) yet/);
    expect(ensureCanaryInstalledMock).not.toHaveBeenCalled();
    expect(runCheckMock).not.toHaveBeenCalled();
  });

  it("names every scoped input in the #458 gate failure and still never installs", async () => {
    getInputsMock.mockReturnValue({ ...INPUTS, surface: "rpc", cacheDir: "cache" });

    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    const message = String(setFailedMock.mock.calls[0]?.[0]);
    expect(message).toContain('"surface"');
    expect(message).toContain('"cache-dir"');
    expect(ensureCanaryInstalledMock).not.toHaveBeenCalled();
    expect(runCheckMock).not.toHaveBeenCalled();
  });

  it("never starts the JUnit render when junit-report is unset (#423)", async () => {
    runCheckMock.mockResolvedValue({ exitCode: 0, signal: null, stdout: JSON.stringify(PASS_REPORT), stderr: "" });

    await run();

    expect(runCheckMock).toHaveBeenCalledTimes(1);
    expect(renderJUnitReportMock).not.toHaveBeenCalled();
    expect(setOutputMock).not.toHaveBeenCalledWith("junit-report-path", expect.anything());
  });

  it("renders JUnit, sets junit-report-path, and keeps status when junit-report is true (#423)", async () => {
    runCheckMock.mockResolvedValue({ exitCode: 0, signal: null, stdout: JSON.stringify(PASS_REPORT), stderr: "" });
    const junitPath = path.join(runnerTemp, "stellar-canary-report.junit.xml");
    fs.writeFileSync(junitPath, '<?xml version="1.0"?>\n<testsuites></testsuites>\n', "utf8");
    renderJUnitReportMock.mockResolvedValueOnce({ path: junitPath });
    getInputsMock.mockReturnValue({ ...INPUTS, junitReport: true });

    await run();

    // The check itself still runs exactly once; the renderer is a second,
    // separate engine process only when the input is enabled.
    expect(runCheckMock).toHaveBeenCalledTimes(1);
    expect(renderJUnitReportMock).toHaveBeenCalledWith(
      BINARY_PATH,
      path.join(runnerTemp, "stellar-canary-report.json"),
      60_000,
    );
    expect(setOutputMock).toHaveBeenCalledWith("junit-report-path", junitPath);
    expect(setOutputMock).toHaveBeenCalledWith("status", "pass");
    expect(warningMock).not.toHaveBeenCalled();
  });

  it("warns without changing status when the JUnit render fails (#423)", async () => {
    runCheckMock.mockResolvedValue({ exitCode: 0, signal: null, stdout: JSON.stringify(PASS_REPORT), stderr: "" });
    renderJUnitReportMock.mockResolvedValueOnce({
      reason: "the engine's report command exited with code 2: unknown subcommand \"report\"",
    });
    getInputsMock.mockReturnValue({ ...INPUTS, junitReport: true });

    await run();

    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining("JUnit report not produced"));
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining("status are unchanged"));
    expect(setOutputMock).not.toHaveBeenCalledWith("junit-report-path", expect.anything());
    expect(setOutputMock).toHaveBeenCalledWith("status", "pass");
    expect(setFailedMock).not.toHaveBeenCalled();
  });
});
