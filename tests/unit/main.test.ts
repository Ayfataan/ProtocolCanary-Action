import type * as actionsCore from "@actions/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as canaryModule from "../../src/canary";
import { SummaryPublishFailedError } from "../../src/errors";
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
    expect(ensureCanaryInstalledMock).toHaveBeenCalledWith(expect.anything(), 60_000);
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
    // #333: coverage-state is still set, and explicitly to `none` — a run that
    // produced no report cannot claim to have executed any fixture.
    expect(setOutputMock).toHaveBeenCalledWith("coverage-state", "none");

    // The diagnostic (stderr) is carried into the execution-failure summary,
    // which is still written despite the abnormal termination.
    expect(renderExecutionFailureMarkdownMock).toHaveBeenCalledWith("Canary was terminated by signal SIGTERM.", "killed mid-check");
    expect(writeSummaryMock).toHaveBeenCalledWith("## Stellar Protocol Canary (execution failure)");

    // annotations: true, so the execution-failure annotation is emitted too.
    expect(errorMock).toHaveBeenCalledTimes(1);
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
    // passing report emits no annotations.
    expect(renderSummaryMarkdownMock).toHaveBeenCalledWith(PASS_REPORT);
    expect(writeSummaryMock).toHaveBeenCalledTimes(1);
    expect(errorMock).not.toHaveBeenCalled();
    expect(warningMock).not.toHaveBeenCalled();
  });

  // #333: the coverage-state output is what a downstream promotion job reads,
  // so run() has to derive it from the parsed report on every successful run —
  // including one whose fixtures were only partially exercised.
  it("sets coverage-state from the parsed report on the success path", async () => {
    const partiallySkipped = {
      ...PASS_REPORT,
      status: "fail" as const,
      results: [result({ testId: "a", surface: "xdr", status: "fail", summary: "mismatch", fixtureId: "a" })],
      skipped: [{ fixtureId: "b", surface: "xdr", reason: "fixture targets protocol 27" }],
      counts: { total: 1, passed: 0, failed: 1, warnings: 0, errors: 0, skipped: 1 },
    };
    runCheckMock.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      stdout: JSON.stringify(partiallySkipped),
      stderr: "",
    });

    await run();

    expect(setOutputMock).toHaveBeenCalledWith("coverage-state", "partial");
    expect(infoMock).toHaveBeenCalledWith("Coverage: partial");
  });

  it("sets coverage-state to `full` for a report with no skips and `none` for an empty report", async () => {
    runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(PASS_REPORT), stderr: "" });
    await run();
    expect(setOutputMock).toHaveBeenCalledWith("coverage-state", "full");

    setOutputMock.mockClear();
    infoMock.mockClear();

    const emptyReport = {
      ...PASS_REPORT,
      results: [],
      counts: { total: 0, passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0 },
    };
    runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(emptyReport), stderr: "" });
    await run();

    expect(setOutputMock).toHaveBeenCalledWith("coverage-state", "none");
    expect(infoMock).toHaveBeenCalledWith("Coverage: none");
  });
});
