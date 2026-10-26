import type * as actionsCore from "@actions/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/*
 * Issue #436: Windows coverage for the Action's real spawn path.
 *
 * tests/integration/end-to-end.test.ts copies `mock-canary.cjs` (a Node
 * script) to `<CARGO_HOME>/bin/stellar-canary` and skips its whole suite on
 * Windows, because the Action looks for `stellar-canary.exe` there and a
 * script cannot be one. These scenarios close that gap by copying the Node
 * executable itself (process.execPath) to `<CARGO_HOME>/bin/stellar-canary.exe`
 * (ending in `.exe` only on Windows) and pointing NODE_OPTIONS at
 * tests/fixtures/mock-canary-hook.cjs, so the copy runs the existing mock
 * engine the moment it starts. The Action's real binary lookup, path
 * handling, spawn, and exit-code interpretation are all exercised — no
 * compiled binary, no network, and cargo is deliberately made unfindable so
 * no scenario can fall through to a real `cargo install`.
 *
 * The same scenarios pass on Linux and macOS too, so this file runs
 * unconditionally (unlike end-to-end.test.ts, which stays skipIf(win32)).
 */

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

// Resolve-version must not reach the network (same convention as
// end-to-end.test.ts): a failed API response degrades to tag-only pinning,
// and the copied binary below is used because its version matches.
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

const HOOK_PATH = path.join(__dirname, "..", "fixtures", "mock-canary-hook.cjs");
const ENGINE_VERSION = "0.1.0";

// NODE_OPTIONS is parsed by Node itself (not the shell), and its tokenizer
// treats `\` inside a quoted value as an escape: a Windows path would reach
// the preloader with every separator stripped. Forward slashes are valid
// Windows path separators and survive the tokenizer on every platform.
function toNodeOptionsPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

const ENV_KEYS = [
  "CARGO_HOME",
  "RUNNER_TEMP",
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY",
  "MOCK_CANARY_SCENARIO",
  "NODE_OPTIONS",
  "INPUT_PROTOCOL",
  "INPUT_CONFIG",
  "INPUT_NETWORK",
  "INPUT_NETWORK-PASSPHRASE",
  "INPUT_RPC-URL",
  "INPUT_FIXTURES-DIR",
  "INPUT_VERSION",
  "INPUT_UPLOAD-REPORT",
  "INPUT_ANNOTATIONS",
  "INPUT_TIMEOUT-MINUTES",
  "INPUT_ALLOW-EMPTY",
];

// @actions/core caches GITHUB_STEP_SUMMARY on first use and ignores later
// changes to the variable (see end-to-end.test.ts), so every scenario shares
// one persistent summary file, truncated between scenarios.
const SUMMARY_PATH = path.join(os.tmpdir(), `canary-win-smoke-summary-${String(process.pid)}.md`);

interface Scenario {
  readonly workDir: string;
  readonly outputPath: string;
}

function setUp(scenario: string, options: { cargoHomeName?: string } = {}): Scenario {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-win-smoke-"));
  // A deliberately spaceful CARGO_HOME exercises the Windows path-handling
  // the mock-engine suite previously covered only with unit-test mocks.
  const cargoHome = path.join(workDir, options.cargoHomeName ?? "cargo-home");
  fs.mkdirSync(path.join(cargoHome, "bin"), { recursive: true });

  const binaryName = process.platform === "win32" ? "stellar-canary.exe" : "stellar-canary";
  const binaryPath = path.join(cargoHome, "bin", binaryName);
  // Copy the Node executable itself; the preload hook below makes it run the
  // mock engine on startup.
  fs.copyFileSync(process.execPath, binaryPath);
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
  process.env.MOCK_CANARY_SCENARIO = scenario;
  process.env.INPUT_VERSION = ENGINE_VERSION;
  process.env.INPUT_PROTOCOL = "28";
  // #400: run() validates fixtures-dir on disk before version resolution and
  // installation, so the input must point at an existing directory — an
  // empty one inside the scratch workDir is enough for the mock engine.
  const fixturesDir = path.join(workDir, "fixtures");
  fs.mkdirSync(fixturesDir);
  process.env["INPUT_FIXTURES-DIR"] = fixturesDir;
  process.env["INPUT_UPLOAD-REPORT"] = "false";
  process.env.INPUT_ANNOTATIONS = "true";
  process.env["INPUT_TIMEOUT-MINUTES"] = "1";
  // The mock engine does not care about fixtures-dir, but the preload hook
  // is REQUIRED for the copied Node to behave like stellar-canary. Quote the
  // path so spaces in it (e.g. the spaceful CARGO_HOME nearby) cannot break
  // Node's own option parsing — but use forward slashes first: Node's
  // NODE_OPTIONS tokenizer swallows backslashes inside quotes, so a quoted
  // `C:\\path\\to\\hook.cjs` arrives as `C:pathtohook.cjs` and the preload
  // silently fails (observed on windows-latest). Node accepts `/` on Windows.
  process.env.NODE_OPTIONS = `--require "${toNodeOptionsPath(HOOK_PATH)}"`;
  // Make cargo unfindable: with the exact-version binary already in
  // CARGO_HOME/bin, ensureCanaryInstalled must short-circuit to it and never
  // attempt an install. If some code path ever reached for cargo here, the
  // scenario would fail loudly instead of installing anything.
  process.env.PATH = path.join(workDir, "cargo-nowhere");

  setFailedMock.mockClear();
  errorMock.mockClear();
  warningMock.mockClear();
  infoMock.mockClear();

  return { workDir, outputPath };
}

// Mirrors readOutputs in end-to-end.test.ts (the GITHUB_OUTPUT heredoc
// format); kept local so no existing file is edited (#436).
function readOutputs(outputPath: string): Record<string, string> {
  const content = fs.readFileSync(outputPath, "utf8");
  const outputs: Record<string, string> = {};
  // @actions/core terminates file-command lines with os.EOL, so on Windows
  // every name and delimiter carries a trailing `\r`; split on either form.
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$/.exec(lines[i] ?? "");
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

describe("Action against the Node-copy mock engine (Windows spawn path)", () => {
  let scenario: Scenario | undefined;

  afterEach(() => {
    if (scenario) fs.rmSync(scenario.workDir, { recursive: true, force: true });
    scenario = undefined;
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterAll(() => {
    fs.rmSync(SUMMARY_PATH, { force: true });
  });

  it("pass: succeeds through the real spawn path and never reaches cargo", async () => {
    scenario = setUp("pass");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).not.toHaveBeenCalled();
    expect(readOutputs(scenario.outputPath).status).toBe("pass");
    expect(fs.readFileSync(SUMMARY_PATH, "utf8")).toContain("✅ **PASS**");

    // The matching binary in CARGO_HOME/bin was used directly; the install
    // chain (and therefore cargo, which PATH above cannot find) was never
    // invoked.
    expect(
      infoMock.mock.calls.some((call) => String(call[0]).includes("already installed")),
    ).toBe(true);
    expect(infoMock.mock.calls.some((call) => String(call[0]).startsWith("Installing"))).toBe(false);
  });

  // Before #521 the version probe ran through @actions/exec, which treats
  // the tool as a command LINE and splits it on whitespace
  // (argStringToArray), so a CARGO_HOME whose path contains a space could
  // not be executed on any platform (real engine builds install to
  // <CARGO_HOME>/bin too) and the step failed with "could not be
  // executed". The probe now runs through the bounded runner
  // (src/runner.ts), which spawns the path verbatim: the spaceful binary
  // is probed, its version matches, and the run succeeds without ever
  // reaching for cargo.
  it("a spaceful CARGO_HOME is probed verbatim and the run succeeds", async () => {
    scenario = setUp("pass", { cargoHomeName: "cargo home with spaces" });
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).not.toHaveBeenCalled();
    expect(readOutputs(scenario.outputPath).status).toBe("pass");
    expect(
      infoMock.mock.calls.some((call) => String(call[0]).includes("already installed")),
    ).toBe(true);
    expect(infoMock.mock.calls.some((call) => String(call[0]).startsWith("Installing"))).toBe(false);
  });

  it("fail: the engine's compatibility failure fails the step through the real spawn", async () => {
    scenario = setUp("fail");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    const outputs = readOutputs(scenario.outputPath);
    expect(outputs.status).toBe("fail");
    expect(outputs.failures).toBe("1");
    expect(fs.readFileSync(SUMMARY_PATH, "utf8")).toContain("NOT READY");
    // The per-result annotation plus the engine-exit annotation (#351).
    expect(errorMock).toHaveBeenCalledTimes(2);
  });

  it("malformed-json: an unparseable report is an execution failure on the real spawn path", async () => {
    scenario = setUp("malformed-json");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("could not be executed");
    const outputs = readOutputs(scenario.outputPath);
    expect(outputs.status).toBe("execution-failed");
    expect(fs.readFileSync(SUMMARY_PATH, "utf8")).toContain("could not be executed");
  });

  it("config-error: an engine exit before any report is an execution failure", async () => {
    scenario = setUp("config-error");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("could not be executed");
    expect(readOutputs(scenario.outputPath).status).toBe("execution-failed");
    expect(fs.readFileSync(SUMMARY_PATH, "utf8")).toContain("could not be executed");
  });

  it("an unknown scenario name makes the mock exit non-zero mid-contract and the Action reports an execution failure", async () => {
    scenario = setUp("definitely-not-a-scenario");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(readOutputs(scenario.outputPath).status).toBe("execution-failed");
    // The mock wrote its reason on stderr; the Action surfaces it (#351).
    expect(errorMock).toHaveBeenCalled();
    expect(fs.readFileSync(SUMMARY_PATH, "utf8")).toContain("unknown MOCK_CANARY_SCENARIO");
  });

  it("a preload hook that cannot be found fails the run with a clear message (no hang)", async () => {
    scenario = setUp("pass");
    process.env.NODE_OPTIONS = `--require "${toNodeOptionsPath(path.join(scenario.workDir, "no-such-hook.cjs"))}"`;
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(readOutputs(scenario.outputPath).status).toBe("execution-failed");
  });
});
