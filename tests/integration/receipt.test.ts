import type * as actionsCore from "@actions/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// Comprehensive receipt tests (#365) at the integration level. The unit
// suites (receipt.test.ts, artifact.test.ts, main.test.ts) call the pieces;
// this file drives the real `run()` against a real engine stub subprocess
// with `generate-receipt: true` — the one producer path no existing test
// exercised (issue #365 gap: `tests/integration/end-to-end.test.ts` never
// sets INPUT_GENERATE-RECEIPT).
//
// The mocks here are the repo's established integration harness from
// end-to-end.test.ts and isolate *infrastructure only*: the GitHub API tag
// lookup stays offline, the artifact service client stands in for a network
// service a test must never reach, and the core logger spies keep output
// assertable. Everything between those boundaries — input parsing, install
// detection, process execution, report parsing, receipt building,
// serialization, file writing, and output plumbing — is the real shipped
// code, which is exactly what "artifact upload integration" in #365 asks to
// be verified.

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

const { uploadArtifactMock } = vi.hoisted(() => ({ uploadArtifactMock: vi.fn() }));
vi.mock("@actions/artifact", () => ({
  DefaultArtifactClient: class {
    uploadArtifact = uploadArtifactMock;
  },
}));

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

import { RECEIPT_ARTIFACT_PREFIX } from "../../src/artifact";
import { parseReport } from "../../src/output";
import { buildReceipt, serializeReceipt } from "../../src/receipt";
import { runCli } from "../../scripts/verify-receipt";

const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const DIGEST = "sha256:9f3e2c1b0a1234567890abcdef1234567890abcdef1234567890abcdef123456";
/** A syntactically valid classic PAT shape, used only as a redaction test vector. */
const SYNTHETIC_TOKEN = `ghp_${"Ab3dEf6hIjKlMn0pQr2sTuVwXyZ012345678".slice(0, 36)}`;

/**
 * A report in the shape a future engine emits through TODAY's producer path:
 * flat additive `engineCommit`/`packDigest` keys, which `parseReport`
 * preserves (src/output.ts:265) and `buildReceipt` reads.
 */
function provenanceReport(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    toolVersion: "0.1.0",
    targetProtocol: 28,
    project: { name: "receipt-integration", type: "soroban" },
    status: "pass",
    counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
    results: [
      { testId: "t1", protocol: 28, surface: "xdr", status: "pass", summary: "ok", durationMs: 1, fixtureId: "t1" },
    ],
    git: { commit: null, branch: null, isDirty: null },
    engineCommit: COMMIT,
    packDigest: DIGEST,
  };
}

/** Builds the stub-binary source echoing `report` on `check`, `0.1.0` on `version`. */
function stubCanarySource(report: unknown): string {
  return [
    "#!/usr/bin/env node",
    '"use strict";',
    "const args = process.argv.slice(2);",
    'if (args[0] === "version") { process.stdout.write("stellar-canary 0.1.0\\n"); process.exit(0); }',
    'if (args[0] !== "check") { process.stderr.write("error: unsupported subcommand\\n"); process.exit(2); }',
    `process.stdout.write(${JSON.stringify(JSON.stringify(report))} + "\\n");`,
    "process.exit(0);",
    "",
  ].join("\n");
}

const ENV_KEYS = [
  "CARGO_HOME",
  "RUNNER_TEMP",
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_RUN_ID",
  "INPUT_VERSION",
  "INPUT_PROTOCOL",
  "INPUT_CONFIG",
  "INPUT_NETWORK",
  "INPUT_NETWORK-PASSPHRASE",
  "INPUT_RPC-URL",
  "INPUT_FIXTURES-DIR",
  "INPUT_UPLOAD-REPORT",
  "INPUT_ANNOTATIONS",
  "INPUT_TIMEOUT-MINUTES",
  "INPUT_GENERATE-RECEIPT",
];

interface Fixture {
  readonly workDir: string;
  readonly runnerTemp: string;
  readonly outputPath: string;
  readonly summaryPath: string;
}

// Same singleton constraint documented in end-to-end.test.ts: core.summary
// caches GITHUB_STEP_SUMMARY at first use for the whole process.
const SUMMARY_PATH = path.join(os.tmpdir(), `canary-receipt-e2e-summary-${String(process.pid)}.md`);

function setUp(stubReport: unknown): Fixture {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-receipt-e2e-"));
  const cargoHome = path.join(workDir, "cargo-home");
  fs.mkdirSync(path.join(cargoHome, "bin"), { recursive: true });
  const binaryPath = path.join(cargoHome, "bin", "stellar-canary");
  fs.writeFileSync(binaryPath, stubCanarySource(stubReport), "utf8");
  fs.chmodSync(binaryPath, 0o755);

  const runnerTemp = path.join(workDir, "runner-temp");
  fs.mkdirSync(runnerTemp, { recursive: true });
  const outputPath = path.join(workDir, "github-output");
  fs.writeFileSync(outputPath, "");
  fs.writeFileSync(SUMMARY_PATH, "");

  for (const key of ENV_KEYS) delete process.env[key];
  process.env["INPUT_NETWORK-PASSPHRASE"] = "\u0001";
  process.env.CARGO_HOME = cargoHome;
  process.env.RUNNER_TEMP = runnerTemp;
  process.env.GITHUB_OUTPUT = outputPath;
  process.env.GITHUB_STEP_SUMMARY = SUMMARY_PATH;
  process.env.GITHUB_RUN_ID = "4321";
  process.env.INPUT_VERSION = "0.1.0";
  process.env.INPUT_PROTOCOL = "28";
  // #400: run() validates fixtures-dir on disk before version resolution
  // and installation, so the input must point at an existing directory.
  const fixturesDir = path.join(workDir, "fixtures");
  fs.mkdirSync(fixturesDir);
  process.env["INPUT_FIXTURES-DIR"] = fixturesDir;
  process.env["INPUT_UPLOAD-REPORT"] = "false";
  process.env["INPUT_ANNOTATIONS"] = "false";
  process.env["INPUT_TIMEOUT-MINUTES"] = "1";
  process.env["INPUT_GENERATE-RECEIPT"] = "true";

  setFailedMock.mockClear();
  errorMock.mockClear();
  warningMock.mockClear();
  infoMock.mockClear();
  uploadArtifactMock.mockReset();
  uploadArtifactMock.mockResolvedValue({ id: 1, size: 100 });

  return { workDir, runnerTemp, outputPath, summaryPath: SUMMARY_PATH };
}

function readOutputs(outputPath: string): Record<string, string> {
  const content = fs.readFileSync(outputPath, "utf8");
  const outputs: Record<string, string> = {};
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Hyphens allowed: `receipt-path` is one of the documented output names.
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

// The stub is an extensionless POSIX script, exactly like tests/fixtures/
// mock-canary.cjs; the platform binary-name branch is covered by
// canary.test.ts. Skip on Windows rather than falling through to a real
// cargo install, mirroring end-to-end.test.ts's documented convention.
describe.skipIf(process.platform === "win32")("Execution Receipt integration (real run() chain, #365)", () => {
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

  it("writes the receipt as byte-exact serializeReceipt output: fixed keys, 2-space indent, UTF-8, no trailing newline", async () => {
    fixture = setUp(provenanceReport());
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).not.toHaveBeenCalled();
    const outputs = readOutputs(fixture.outputPath);
    const receiptPath = path.join(fixture.runnerTemp, "stellar-canary-receipt.json");

    const actual = fs.readFileSync(receiptPath);
    // Byte fixed point: re-serializing the parsed artifact through the real
    // producer function yields the identical bytes — the file on disk *is*
    // serializeReceipt output, in the documented key order, 2-space indent,
    // and with no trailing newline.
    const parsed = JSON.parse(actual.toString("utf8")) as Record<string, unknown>;
    const text = actual.toString("utf8");
    expect(serializeReceipt(parsed as unknown as ReturnType<typeof buildReceipt>)).toBe(text);
    expect(text.endsWith("\n")).toBe(false);
    expect(actual[actual.length - 1]).toBe("}".charCodeAt(0));
    expect(Object.keys(parsed)).toEqual([
      "receiptVersion",
      "engineVersion",
      "engineCommit",
      "packDigest",
      "protocol",
      "observedProtocol",
      "timestamp",
    ]);

    // Field content must agree with the producer recomputed from the report
    // file of the same run, apart from the transient timestamp.
    const reportText = fs.readFileSync(outputs.report as string, "utf8");
    const expected = buildReceipt(parseReport(reportText));
    expect({ ...parsed, timestamp: "" }).toEqual({ ...expected, timestamp: "" });
    expect(Date.parse(parsed.timestamp as string)).not.toBeNaN();
    expect(parsed.receiptVersion).toBe(1);
    expect(parsed.engineVersion).toBe("0.1.0");
    expect(parsed.engineCommit).toBe(COMMIT);
    expect(parsed.packDigest).toBe(DIGEST);
    expect(parsed.protocol).toBe(28);
    expect(parsed.observedProtocol).toBe("unknown");
  });

  it("plumbs receipt-path and uploads under the run-scoped artifact name beside the compatibility outputs", async () => {
    fixture = setUp(provenanceReport());
    const { run } = await import("../../src/main");
    await run();

    const outputs = readOutputs(fixture.outputPath);
    const receiptPath = path.join(fixture.runnerTemp, "stellar-canary-receipt.json");
    expect(outputs["receipt-path"]).toBe(receiptPath);
    expect(outputs.status).toBe("pass");
    expect(uploadArtifactMock).toHaveBeenCalledWith(
      `${RECEIPT_ARTIFACT_PREFIX}-4321`,
      [receiptPath],
      fixture.runnerTemp,
    );
  });

  it("keeps the CF-08 boundary at the artifact edge: a token and a runner path in an additive field never reach the receipt bytes", async () => {
    const polluted = { ...provenanceReport(), packDigest: `/home/runner/work/acme/repo/packs/${SYNTHETIC_TOKEN}` };
    fixture = setUp(polluted);
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).not.toHaveBeenCalled();
    const receiptText = fs.readFileSync(path.join(fixture.runnerTemp, "stellar-canary-receipt.json"), "utf8");
    expect(receiptText).not.toContain(SYNTHETIC_TOKEN.slice(0, 12));
    expect(receiptText).not.toContain("/home/runner");
    expect(receiptText).toContain("[REDACTED]");
    // The compatibility result is untouched by the masking: still a pass.
    expect(readOutputs(fixture.outputPath).status).toBe("pass");
  });

  it("produces artifacts a consumer can verify: the real receipt and report files pass the standalone verifier with exit 0", async () => {
    fixture = setUp(provenanceReport());
    const { run } = await import("../../src/main");
    await run();

    const outputs = readOutputs(fixture.outputPath);
    const receiptPath = outputs["receipt-path"] as string;
    const reportPath = outputs.report as string;
    expect(runCli([receiptPath, reportPath])).toBe(0);

    // Tampering with the receipt byte-breaks the verification (exit 1),
    // proving the round trip verifies durable fields rather than trivia.
    const tampered = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    tampered.engineCommit = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const tamperedPath = path.join(fixture.workDir, "tampered.json");
    fs.writeFileSync(tamperedPath, JSON.stringify(tampered, null, 2), "utf8");
    expect(runCli([tamperedPath, reportPath])).toBe(1);
  });
});
