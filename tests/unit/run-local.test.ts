import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
 * Issue #437: the local runner script's contract, exercised the way its
 * users would: by spawning `node scripts/run-local.mjs` as a subprocess.
 *
 * The Action scenarios use tests/fixtures/mock-canary.cjs as the engine and
 * the same MOCK_CANARY_SCENARIO selection end-to-end.test.ts uses. Nothing
 * here touches a network and nothing installs anything — the script itself
 * refuses to.
 *
 * On Windows a Node script cannot be the executable the Action looks for
 * (`stellar-canary.exe` there), so the process-level Action scenarios, like
 * their end-to-end.test.ts counterparts, are skipped on win32.
 */

const SCRIPT = path.join(__dirname, "..", "..", "scripts", "run-local.mjs");
const MOCK_ENGINE = path.join(__dirname, "..", "fixtures", "mock-canary.cjs");
const DIST = path.join(__dirname, "..", "..", "dist", "index.js");

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runScript(
  args: string[],
  options: { timeoutMs?: number; signal?: NodeJS.Signals; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code: code ?? (signal !== null ? 128 : 1), stdout, stderr });
    });
    if (options.signal !== undefined) {
      setTimeout(() => child.kill(options.signal), options.timeoutMs);
    }
  });
}

function commonActionArgs(tmpDir: string): string[] {
  const fixturesDir = path.join(tmpDir, "fixtures-checked-for-existence");
  fs.mkdirSync(fixturesDir, { recursive: true });
  return [
    "--engine",
    MOCK_ENGINE,
    "--fixtures-dir",
    fixturesDir,
    "--input",
    "version=0.1.0",
    "--input",
    "upload-report=false",
    "--input",
    "timeout-minutes=1",
    // #433: the engine runs with an explicit allow-list, so the mock's
    // scenario switch travels through the same `engine-env-passthrough`
    // input a workflow would use.
    "--input",
    "engine-env-passthrough=MOCK_CANARY_SCENARIO",
  ];
}

// The number of `canary-run-local-*` temp dirs the script creates must not
// change across a run: it cleans up on every path, including failures.
function listTemp(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith("canary-run-local-"));
}

// The process-level scenarios drive the built Action against the mock engine,
// which cannot run as `stellar-canary.exe` on Windows (same reason
// end-to-end.test.ts is skipIf(win32)); they also need a built dist/.
// Evaluated at collection time, before the negative suite moves dist/.
const skipProcessScenarios = process.platform === "win32" || !fs.existsSync(DIST);

describe("scripts/run-local.mjs (local runner script)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-local-test-"));
    // Scenario selection travels from this process to the child Action via
    // the environment, exactly as it does on a runner.
    for (const key of ["MOCK_CANARY_SCENARIO", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY", "GITHUB_ENV", "RUNNER_TEMP", "CARGO_HOME"]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--help documents every option", async () => {
    const result = await runScript(["--help"]);
    expect(result.code).toBe(0);
    const expected = [
      "--engine",
      "--fixtures-dir",
      "--input",
      "--protocol",
      "--help",
      "GITHUB_OUTPUT",
      "GITHUB_STEP_SUMMARY",
      "GITHUB_ENV",
      "RUNNER_TEMP",
      "CARGO_HOME",
      "npm run build",
    ];
    for (const token of expected) {
      expect(result.stdout).toContain(token);
    }
  });

  it("without --engine it exits non-zero, says so, and installs nothing", async () => {
    const before = listTemp();
    const result = await runScript(["--input", "version=0.1.0"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--engine");
    expect(result.stderr).toContain("never installs");
    expect(listTemp()).toEqual(before);
  });

  it.skipIf(skipProcessScenarios)("pass: prints status=pass, the summary, and exits 0", async () => {
    const before = listTemp();
    const result = await runScript([...commonActionArgs(tmpDir)], { env: { MOCK_CANARY_SCENARIO: "pass" } });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("status=pass");
    expect(result.stdout).toContain("✅ **PASS**");
    expect(result.stdout).toContain("=== Action outputs ===");
    expect(result.stdout).toContain("=== Job summary");
    expect(result.stdout).toContain("=== Annotations on stdout ===");
    expect(result.stdout).toContain("Action exit code: 0");
    expect(listTemp()).toEqual(before);
  }, 60_000);

  it.skipIf(skipProcessScenarios)("fail: exits with the Action's non-zero status and prints the annotations", async () => {
    const before = listTemp();
    const result = await runScript([...commonActionArgs(tmpDir)], { env: { MOCK_CANARY_SCENARIO: "fail" } });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("status=fail");
    expect(result.stdout).toContain("❌ **NOT READY**");
    expect(result.stdout).toContain("::error");
    expect(result.stdout).toContain("Action exit code: 1");
    expect(listTemp()).toEqual(before);
  }, 60_000);
});

describe("scripts/run-local.mjs negative cases", () => {
  let tmpDir: string;
  let movedDist: string | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-local-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (movedDist !== null) {
      fs.renameSync(movedDist, DIST);
      movedDist = null;
    }
  });

  it("a missing dist/index.js is a clear error naming 'npm run build'", async () => {
    movedDist = `${DIST}.moved-by-test`;
    fs.renameSync(DIST, movedDist);
    const result = await runScript(["--engine", MOCK_ENGINE, "--input", "version=0.1.0"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("npm run build");
  });

  it("a fixtures directory that does not exist is rejected without running the Action", async () => {
    const result = await runScript([
      "--engine",
      MOCK_ENGINE,
      "--fixtures-dir",
      path.join(tmpDir, "absolutely-not-here"),
      "--input",
      "version=0.1.0",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("does not exist");
  });

  it("an --input without '=' is rejected with usage guidance", async () => {
    const result = await runScript(["--engine", MOCK_ENGINE, "--input", "version"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("NAME=VALUE");
  });

  it("an engine path that does not exist is rejected without running the Action", async () => {
    const result = await runScript(["--engine", path.join(tmpDir, "no-such-engine")]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("does not exist");
  });

  it("an unknown option is rejected and points at --help", async () => {
    const result = await runScript(["--nonsense"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--help");
  });

  it.skipIf(skipProcessScenarios)("an interrupt during the run kills the child, cleans up, and exits non-zero", async () => {
    const fixturesDir = path.join(tmpDir, "fixtures");
    fs.mkdirSync(fixturesDir, { recursive: true });
    const before = listTemp();
    const result = await runScript(
      [
        "--engine",
        MOCK_ENGINE,
        "--fixtures-dir",
        fixturesDir,
        "--input",
        "version=0.1.0",
        "--input",
        "upload-report=false",
        "--input",
        "engine-env-passthrough=MOCK_CANARY_SCENARIO",
      ],
      // The mock's "timeout" scenario keeps the engine alive ~10s (and the
      // Action's own timeout-minutes=1 floor would end it at a minute); a
      // SIGINT into the script must end the whole run promptly, with the
      // temporary environment removed.
      { timeoutMs: 1500, signal: "SIGINT", env: { MOCK_CANARY_SCENARIO: "timeout" } },
    );
    expect(result.code).not.toBe(0);
    expect(listTemp()).toEqual(before);
  }, 60_000);
});
