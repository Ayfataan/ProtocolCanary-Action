import type * as actionsCore from "@actions/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { setFailedMock, errorMock, warningMock, infoMock } = vi.hoisted(() => ({
  setFailedMock: vi.fn(),
  errorMock: vi.fn(),
  warningMock: vi.fn(),
  infoMock: vi.fn(),
}));

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof actionsCore>();
  return { ...actual, setFailed: setFailedMock, error: errorMock, warning: warningMock, info: infoMock };
});

// Mock ensureCanaryInstalled to use the fixture's mock binary without
// making real network calls. The fixture places the mock at
// cargoHome/bin/stellar-canary; this mock intercepts the install so the
// real install chain (downloading from GitHub / prebuilt assets) is avoided.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
vi.mock("../../src/canary", async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/canary')>();
  return {
    ...actual,
    ensureCanaryInstalled: vi.fn().mockImplementation(() => {
      const cargoHome = process.env.CARGO_HOME ?? "";
      const binaryDir = path.join(cargoHome, "bin");
      const binaryPath = path.join(binaryDir, "stellar-canary");

      try {
        fs.mkdirSync(binaryDir, { recursive: true });
        // The fixture copies the mock binary; ensure it exists for the test.
        if (!fs.existsSync(binaryPath)) {
          const mockSource = path.join(__dirname, "..", "fixtures", "mock-canary.cjs");
          fs.copyFileSync(mockSource, binaryPath);
          fs.chmodSync(binaryPath, 0o755);
        }
      } catch (_error) {
        // Best-effort: don't block the test if we can't create the directory.
      }

      return {
        binaryPath,
        version: "0.1.0",
      };
    }),
  };
});

// #278: the upload-report=true scenario asserts against the artifact client's
// upload method, mocked here exactly the way tests/unit/artifact.test.ts does.
const { uploadArtifactMock } = vi.hoisted(() => ({ uploadArtifactMock: vi.fn() }));
vi.mock("@actions/artifact", () => ({
  DefaultArtifactClient: class {
    uploadArtifact = uploadArtifactMock;
  },
}));

// Keep resolveVersion's GitHub API call out of the network entirely: it
// must degrade gracefully (see version.test.ts), and this suite only
// cares about what happens downstream of installation.
vi.mock("node:https", () => ({
  get: vi.fn((_url: string, _options: unknown, callback: (response: unknown) => void) => {
    const response = {
      statusCode: 500,
      setEncoding: () => undefined,
      resume: () => undefined,
      on: () => undefined,
    };
    queueMicrotask(() => callback(response));
    return { on: () => undefined, destroy: () => undefined };
  }),
}));

const MOCK_CANARY_SOURCE = path.join(__dirname, "..", "fixtures", "mock-canary.cjs");
const ENV_KEYS = [
  "CARGO_HOME",
  "RUNNER_TEMP",
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY",
  "MOCK_CANARY_SCENARIO",
  "MOCK_CANARY_VERSION",
  "INPUT_PROTOCOL",
  "INPUT_CONFIG",
  "INPUT_NETWORK",
  "INPUT_RPC-URL",
  "INPUT_FIXTURES-DIR",
  "INPUT_VERSION",
  "INPUT_UPLOAD-REPORT",
  "INPUT_ANNOTATIONS",
  "INPUT_TIMEOUT-MINUTES",
];

interface Fixture {
  readonly workDir: string;
  readonly outputPath: string;
  readonly summaryPath: string;
}

// @actions/core's `core.summary` is a process-wide singleton that resolves
// and caches GITHUB_STEP_SUMMARY from the environment on its *first* use
// and ignores later changes to that variable. A fresh path per test would
// silently be ignored after the first test (and, worse, throw ENOENT once
// that first test's directory is cleaned up) — so every test in this file
// shares one persistent summary file instead, truncated between tests.
const SUMMARY_PATH = path.join(os.tmpdir(), `canary-e2e-summary-${String(process.pid)}.md`);

function setUp(scenario: string): Fixture {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-e2e-"));
  const cargoHome = path.join(workDir, "cargo-home");
  fs.mkdirSync(path.join(cargoHome, "bin"), { recursive: true });
  fs.copyFileSync(MOCK_CANARY_SOURCE, path.join(cargoHome, "bin", "stellar-canary"));
  fs.chmodSync(path.join(cargoHome, "bin", "stellar-canary"), 0o755);

  const runnerTemp = path.join(workDir, "runner-temp");
  fs.mkdirSync(runnerTemp, { recursive: true });
  const outputPath = path.join(workDir, "github-output");
  const summaryPath = SUMMARY_PATH;
  fs.writeFileSync(outputPath, "");
  fs.writeFileSync(summaryPath, "");

  for (const key of ENV_KEYS) delete process.env[key];
  process.env.CARGO_HOME = cargoHome;
  process.env.RUNNER_TEMP = runnerTemp;
  process.env.GITHUB_OUTPUT = outputPath;
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
  process.env.MOCK_CANARY_SCENARIO = scenario;
  process.env.MOCK_CANARY_VERSION = "0.1.0";
  process.env.INPUT_VERSION = "0.1.0";
  process.env.INPUT_PROTOCOL = "28";
  process.env["INPUT_FIXTURES-DIR"] = "fixtures";
  process.env["INPUT_UPLOAD-REPORT"] = "false";
  process.env["INPUT_ANNOTATIONS"] = "true";
  process.env["INPUT_TIMEOUT-MINUTES"] = "1";

  setFailedMock.mockClear();
  errorMock.mockClear();
  warningMock.mockClear();
  infoMock.mockClear();
  uploadArtifactMock.mockReset();
  uploadArtifactMock.mockResolvedValue({ id: 1, size: 100 });

  return { workDir, outputPath, summaryPath };
}

function readOutputs(outputPath: string): Record<string, string> {
  const content = fs.readFileSync(outputPath, "utf8");
  const outputs: Record<string, string> = {};
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)<<(.+)$/.exec(lines[i] ?? "");
    if (match) {
      const [, name, delimiter] = match;
      const valueLines: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) {
        valueLines.push(lines[i] ?? "");
        i++;
      }
      outputs[name as string] = valueLines.join("\n");
    }
  }
  return outputs;
}

// The fixture is an executable script without a Windows PE wrapper. The
// platform-specific binary-name branch is covered by canary.test.ts; skip
// this process-level fixture suite on Windows rather than falling through to
// a real cargo install during CI.
describe.skipIf(process.platform === "win32")("Action end-to-end (via mock-canary)", () => {
  let fixture: Fixture;

  afterEach(() => {
    if (fixture) {
      fs.rmSync(fixture.workDir, { recursive: true, force: true });
    }
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterAll(() => {
    fs.rmSync(SUMMARY_PATH, { force: true });
  });

  it("pass: succeeds, sets outputs, and writes no annotations", async () => {
    fixture = setUp("pass");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).not.toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs.status).toBe("pass");
    expect(outputs.passed).toBe("1");
    expect(outputs.failures).toBe("0");
    expect(outputs.total).toBe("1");
    expect(outputs.skipped).toBe("0");
    expect(outputs["engine-version"]).toBe("0.1.0");
    expect(outputs["observed-protocol"]).toBe("");
    expect(typeof outputs.report).toBe("string");
    const passReport = outputs.report as string;
    expect(path.isAbsolute(passReport)).toBe(true);
    expect(fs.existsSync(passReport)).toBe(true);
    expect(fs.readFileSync(fixture.summaryPath, "utf8")).toContain("✅ **PASS**");
  });

  // Regression test: found during three-repository E2E validation against
  // a real build of Protocol-Canary's actual tagged v0.1.0 release, whose
  // report predates the `counts` field. Without this, every check against
  // that release — even a fully passing one — was misreported as an
  // execution failure.
  it("pass-no-counts: a schemaVersion-1 report missing counts still parses as a real pass", async () => {
    fixture = setUp("pass-no-counts");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).not.toHaveBeenCalled();
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs.status).toBe("pass");
    expect(outputs.passed).toBe("1");
  });

  it("warning: does not fail the job (default policy), but does annotate", async () => {
    fixture = setUp("warning");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).not.toHaveBeenCalled();
    expect(warningMock).toHaveBeenCalledTimes(1);
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs.status).toBe("warning");
    expect(outputs.warnings).toBe("1");
  });

  it("fail: fails the job and annotates the failing check", async () => {
    fixture = setUp("fail");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("fail");
    // #351: one annotation for the failing result plus one for the engine's
    // non-zero exit (classification + root diagnostic).
    expect(errorMock).toHaveBeenCalledTimes(2);
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs.status).toBe("fail");
    expect(outputs.failures).toBe("1");
    expect(outputs.total).toBe("1");
    expect(outputs.skipped).toBe("0");
    expect(outputs["engine-version"]).toBe("0.1.0");
    expect(outputs["observed-protocol"]).toBe("");
    expect(typeof outputs.report).toBe("string");
    const failReport = outputs.report as string;
    expect(path.isAbsolute(failReport)).toBe(true);
    expect(fs.existsSync(failReport)).toBe(true);
    expect(fs.readFileSync(fixture.summaryPath, "utf8")).toContain("NOT READY");
  });

  it("config-error: reported as an execution failure, not a compatibility failure", async () => {
    fixture = setUp("config-error");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("could not be executed");
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs.status).toBe("execution-failed");
    expect(outputs.total).toBe("0");
    expect(outputs.skipped).toBe("0");
    expect(outputs["engine-version"]).toBe("0.1.0");
    expect(outputs["observed-protocol"]).toBe("");
    expect(fs.readFileSync(fixture.summaryPath, "utf8")).toContain("could not be executed");
  });

  it("pass-network: succeeds, sets observed-protocol, engine-version, total and skipped", async () => {
    fixture = setUp("pass-network");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).not.toHaveBeenCalled();
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs.status).toBe("pass");
    expect(outputs.passed).toBe("1");
    expect(outputs.total).toBe("1");
    expect(outputs.skipped).toBe("0");
    expect(outputs["engine-version"]).toBe("0.1.0");
    expect(outputs["observed-protocol"]).toBe("28");
  });

  it("offline run: observed-protocol is empty string when report has no network object", async () => {
    fixture = setUp("pass");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).not.toHaveBeenCalled();
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs["observed-protocol"]).toBe("");
    expect(outputs["engine-version"]).toBe("0.1.0");
    expect(outputs.total).toBe("1");
    expect(outputs.skipped).toBe("0");
  });

  // Maintainer decision D-02: after Protocol-Canary 0.1.1 a run that executes
  // nothing exits 2 with the reason on stderr and no report. An Action pinned
  // to such an engine must fail the job with that reason in front of the
  // user, not a bare "invalid report" and never a pass.
  it("empty-run: the engine's refusal reaches the job summary as an execution failure", async () => {
    fixture = setUp("empty-run");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("could not be executed");
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs.status).toBe("execution-failed");
    expect(outputs.passed).toBe("0");

    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    expect(summary).toContain("no checks ran");
    expect(summary).toContain("the fixtures target protocol 28");
    expect(summary).toContain("--allow-empty");
    expect(summary).not.toMatch(/Status:? *PASS/i);
  });

  it("empty-run: the diagnostic is also the annotation text, so it appears on the run page", async () => {
    fixture = setUp("empty-run");
    const { run } = await import("../../src/main");
    await run();

    expect(errorMock).toHaveBeenCalled();
    expect(errorMock.mock.calls.map((call) => String(call[0])).join("\n")).toContain("exit code 2");
  });

  // Additive report fields (`results[].source`, `skipped[].code`) must not
  // trip the Action's validation, and the outcome is unchanged.
  it("pass-with-result-source: additive result and skip fields are tolerated", async () => {
    fixture = setUp("pass-with-result-source");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).not.toHaveBeenCalled();
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs.status).toBe("pass");
    expect(outputs.passed).toBe("2");
  });

  it("rpc-error: a per-fixture execution error still produces a real report", async () => {
    fixture = setUp("rpc-error");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs.status).toBe("error");
    expect(outputs.errors).toBe("1");
  });

  it("fixture-error: reported as an execution failure", async () => {
    fixture = setUp("fixture-error");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(readOutputs(fixture.outputPath).status).toBe("execution-failed");
  });

  it("internal-error: reported as an execution failure", async () => {
    fixture = setUp("internal-error");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(readOutputs(fixture.outputPath).status).toBe("execution-failed");
  });

  it("malformed-json: a zero exit code with unparseable stdout is still an execution failure", async () => {
    fixture = setUp("malformed-json");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("could not be executed");
    expect(readOutputs(fixture.outputPath).status).toBe("execution-failed");
  });

  it("many-failures: summary lists all 60 failures even though GitHub truncates annotations at 50", async () => {
    fixture = setUp("many-failures");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    // 60 per-result annotations plus one exit-code annotation (#351).
    expect(errorMock).toHaveBeenCalledTimes(61); // all 60 fail results should produce annotations
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs.status).toBe("fail");
    expect(outputs.failures).toBe("60");

    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    // Verify all 60 test IDs appear in the summary's failure list
    for (let i = 1; i <= 60; i++) {
      expect(summary).toContain(`p28-xdr-many-${i}`);
    }
    // The summary should show 0 passed out of 60 total
    expect(summary).toContain("0/60 applicable checks passed");
  });

  // #277: every earlier scenario sets INPUT_ANNOTATIONS="true", so the
  // `if (inputs.annotations)` guards in main.ts were never exercised
  // end-to-end. This is the documented "annotations: false" configuration:
  // a compatibility failure still fails the job and still writes the job
  // summary, but emits no error/warning annotations at all.
  it("fail with annotations=false: job still fails and the summary is written, but no annotation is emitted", async () => {
    fixture = setUp("fail");
    process.env["INPUT_ANNOTATIONS"] = "false";
    const { run } = await import("../../src/main");
    await run();

    // The job still fails on the compatibility failure, exactly as with
    // annotations on.
    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("fail");
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs.status).toBe("fail");
    expect(outputs.failures).toBe("1");

    // The job summary is still written without annotations.
    expect(fs.readFileSync(fixture.summaryPath, "utf8")).toContain("NOT READY");

    // ...but no error/warning annotation is emitted for the failing check.
    expect(errorMock).not.toHaveBeenCalled();
    expect(warningMock).not.toHaveBeenCalled();
  });

  // #277, second case: with annotations disabled even an execution failure
  // (config-error exits before any report exists) must skip
  // emitExecutionFailureAnnotation, i.e. core.error is never called.
  it("config-error with annotations=false: the execution-failure annotation is not emitted", async () => {
    fixture = setUp("config-error");
    process.env["INPUT_ANNOTATIONS"] = "false";
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("could not be executed");
    expect(readOutputs(fixture.outputPath).status).toBe("execution-failed");
    expect(fs.readFileSync(fixture.summaryPath, "utf8")).toContain("could not be executed");

    // emitExecutionFailureAnnotation's underlying core.error is not called.
    expect(errorMock).not.toHaveBeenCalled();
    expect(warningMock).not.toHaveBeenCalled();
  });

  // #278: every earlier scenario sets INPUT_UPLOAD-REPORT="false", so the
  // wiring from a completed run to uploadReport — including the
  // artifactDifferentiator value derived from the inputs — was never
  // exercised end-to-end. This is the only remaining branch of run() with
  // zero integration coverage.
  it("pass with upload-report=true: the artifact client uploads the produced report once", async () => {
    fixture = setUp("pass");
    process.env["INPUT_UPLOAD-REPORT"] = "true";
    const { run } = await import("../../src/main");
    await run();

    // The run itself still succeeds.
    expect(setFailedMock).not.toHaveBeenCalled();
    expect(readOutputs(fixture.outputPath).status).toBe("pass");

    // The artifact client's upload method was called exactly once, with the
    // stable artifact name and the report file path the run produced.
    expect(uploadArtifactMock).toHaveBeenCalledTimes(1);
    const [name, files, rootDirectory] = uploadArtifactMock.mock.calls[0] as [string, string[], string];
    expect(name).toBe("stellar-protocol-canary-report");
    expect(files).toHaveLength(1);
    const uploadedReportPath = files[0] as string;
    expect(path.isAbsolute(uploadedReportPath)).toBe(true);
    expect(fs.existsSync(uploadedReportPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(uploadedReportPath, "utf8"))).toMatchObject({ status: "pass" });
    expect(rootDirectory).toBe(path.dirname(uploadedReportPath));

    // The same file the "report" output advertises is what got uploaded.
    const outputs = readOutputs(fixture.outputPath);
    expect(uploadedReportPath).toBe(outputs.report);

    // The differentiator built from this scenario's inputs (protocol=28,
    // no config) is the retry name only; the stable name is tried first, so
    // the successful first call never needed it. Log it for debugging.
    expect(infoMock.mock.calls.some((call) => String(call[0]).includes("Uploaded stellar-protocol-canary-report artifact."))).toBe(
      true,
    );
  });
});
