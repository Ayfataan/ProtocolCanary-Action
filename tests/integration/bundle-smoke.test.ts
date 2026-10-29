import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/*
 * Issue #435: the committed bundle, `dist/index.js`, is exactly what a
 * consumer's workflow executes, yet no test in this repository runs it. The
 * unit and integration suites import `src/`, and CI only proves `dist/`
 * matches a fresh build. A bundling mistake (for example an ESM-only
 * dependency turned into a stub by the bundler) produces a file that loads
 * fine at build time and fails only at run time — see scripts/build.mjs.
 *
 * This suite closes that gap with one process-level scenario per outcome. It
 * spawns `node dist/index.js` with the same environment a runner provides:
 *
 *   - `INPUT_*` variables for the Action inputs,
 *   - `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`, `GITHUB_ENV`,
 *   - `RUNNER_TEMP`, `CARGO_HOME` and `HOME` pointing at temporary
 *     directories,
 *   - `tests/fixtures/mock-canary.cjs` installed, unchanged, where the
 *     Action looks for an installed engine (`<RUNNER_TEMP>/stellar-canary-
 *     action/bin/stellar-canary`, with the install-time SHA-256 sidecar #433
 *     requires), plus the `CARGO_HOME` a source install would use,
 *   - `engine-env-passthrough` set to the mock's own scenario selectors, the
 *     same opt-in a workflow needs now that #433 gives the engine an
 *     allow-listed environment instead of the job's,
 *   - `PATH` intact, except in the "no engine, no cargo" scenario where it is
 *     an empty temporary directory.
 *
 * It never installs anything and never reaches the network: a preload hook
 * written into the temporary directory makes every `node:https` request fail
 * immediately. That covers the version-tag lookup, the prebuilt-asset
 * lookup, and the checksum lookup, so the pass/fail scenarios cannot download
 * a real engine release and the no-engine scenario reaches `cargo` (absent)
 * quickly instead of waiting for GitHub API timeouts. The cache service
 * variables are deleted for the same reason.
 *
 * Windows note: the mock engine is a Node script with a shebang, and the
 * Action looks for `stellar-canary.exe` there — a script cannot be one. The
 * Windows-specific runner for the same scenarios is tracked in
 * https://github.com/StellarCanary/ProtocolCanary-Action/issues/436 (it
 * copies the Node executable instead), so this file skips Windows with that
 * reason recorded here rather than silently passing.
 *
 * A local runner script is proposed separately (#437, scripts/run-local.mjs).
 * If it grows a reusable helper, this file should adopt it instead of keeping
 * its own; until then the helper stays local to this file.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
const MOCK_CANARY_SOURCE = path.join(REPO_ROOT, "tests", "fixtures", "mock-canary.cjs");

/** The mock engine reports this version by default; the run requests it too,
 * so `findExisting` short-circuits and no install is ever attempted. */
const ENGINE_VERSION = "0.1.0";

/** Hard ceiling for one spawned process. Every scenario must finish well
 * inside this; a value this low turns a hang into a clear failure instead of
 * a suite that waits for the global test timeout. */
const RUN_TIMEOUT_MS = 10_000;

/** Windows cannot run the shebang mock engine as `stellar-canary.exe`; see
 * the file comment above and issue #436. */
const IS_WINDOWS = process.platform === "win32";

/** Variables inherited from the surrounding CI job that would let the child
 * reach a real service (or a cached binary) if they were left in place. */
const HERMETIC_ENV_KEYS = [
  "CARGO_HOME",
  "RUNNER_TEMP",
  "RUNNER_TOOL_CACHE",
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_ENV",
  "GITHUB_EVENT_PATH",
  "GITHUB_TOKEN",
  "MOCK_CANARY_SCENARIO",
  "MOCK_CANARY_VERSION",
  "NODE_OPTIONS",
  // @actions/cache considers itself available when any of these is set, and
  // would then talk to the real cache service.
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_CACHE_URL",
  "ACTIONS_RESULTS_URL",
] as const;

/**
 * Preload hook installed with `NODE_OPTIONS=--require`. It runs before the
 * bundle, so the bundle's `require("node:https")` namespace sees the patched
 * `get` and every outbound request rejects at once with an explicit reason.
 */
const OFFLINE_HOOK_SOURCE = `"use strict";
// Written by tests/integration/bundle-smoke.test.ts. Keeps the spawned Action
// off the network: every HTTPS request fails immediately instead of waiting
// for (or downloading from) GitHub.
const https = require("node:https");
const { EventEmitter } = require("node:events");

https.get = function offlineGet(target) {
  const request = new EventEmitter();
  request.destroy = () => request;
  process.nextTick(() => {
    request.emit("error", new Error(
      "network access is disabled by the bundle smoke test: " + String(target),
    ));
  });
  return request;
};
`;

interface Runner {
  /** Temporary directory holding every file this run owns. */
  readonly workDir: string;
  /** Environment for the spawned bundle, complete and hermetic. */
  readonly env: NodeJS.ProcessEnv;
  /** File the Action writes its outputs to (`GITHUB_OUTPUT` format). */
  readonly outputPath: string;
  /** File the Action writes the job summary to (`GITHUB_STEP_SUMMARY`). */
  readonly summaryPath: string;
}

interface RunnerOptions {
  /** Value of MOCK_CANARY_SCENARIO for the installed mock engine. */
  readonly scenario: string;
  /** Install the mock engine at `<CARGO_HOME>/bin/stellar-canary`. */
  readonly installEngine?: boolean;
}

interface RunResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the run had to be killed at RUN_TIMEOUT_MS. */
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/** Node's `NODE_OPTIONS` tokenizer treats a backslash inside a quoted value
 * as an escape, so Windows separators would be stripped. Forward slashes are
 * valid path separators there and survive the tokenizer everywhere. */
function toNodeOptionsPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

/** Creates the temporary directories, the runner files, the offline hook and
 * the environment for one spawned run. */
function createRunner(options: RunnerOptions): Runner {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-bundle-smoke-"));

  const cargoHome = path.join(workDir, "cargo-home");
  fs.mkdirSync(path.join(cargoHome, "bin"), { recursive: true });

  const runnerTemp = path.join(workDir, "runner-temp");
  // The Action validates that `fixtures-dir` exists before installing or
  // running anything, so the simulated workspace has one; the mock engine
  // ignores its contents.
  const fixturesDir = path.join(workDir, "fixtures");
  const home = path.join(workDir, "home");
  fs.mkdirSync(runnerTemp, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(fixturesDir, { recursive: true });

  if (options.installEngine !== false) {
    // #433: the Action no longer trusts whatever sits in `<CARGO_HOME>/bin`.
    // It uses an Action-owned root under RUNNER_TEMP, and only when the
    // install-time SHA-256 sidecar next to the binary matches it. Reproduce
    // exactly what a completed install leaves behind — the committed mock
    // engine, copied as-is (the test never edits it).
    const binaryDir = path.join(runnerTemp, "stellar-canary-action", "bin");
    fs.mkdirSync(binaryDir, { recursive: true });
    const enginePath = path.join(binaryDir, "stellar-canary");
    fs.copyFileSync(MOCK_CANARY_SOURCE, enginePath);
    fs.chmodSync(enginePath, 0o755);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(enginePath)).digest("hex");
    fs.writeFileSync(path.join(binaryDir, "stellar-canary.sha256"), `${digest}\n`, { mode: 0o600 });
  }

  const outputPath = path.join(workDir, "github-output");
  const summaryPath = path.join(workDir, "github-step-summary");
  const envPath = path.join(workDir, "github-env");
  for (const file of [outputPath, summaryPath, envPath]) {
    fs.writeFileSync(file, "");
  }

  const hookPath = path.join(workDir, "offline-hook.cjs");
  fs.writeFileSync(hookPath, OFFLINE_HOOK_SOURCE);

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    // Whatever INPUT_* the surrounding shell/CI carries must not leak into
    // this run: the invocation below is the whole input set.
    if (key.startsWith("INPUT_")) {
      delete env[key];
    }
  }
  for (const key of HERMETIC_ENV_KEYS) {
    delete env[key];
  }

  env.CARGO_HOME = cargoHome;
  env.HOME = home;
  env.RUNNER_TEMP = runnerTemp;
  env.GITHUB_OUTPUT = outputPath;
  env.GITHUB_STEP_SUMMARY = summaryPath;
  env.GITHUB_ENV = envPath;
  env.NODE_OPTIONS = `--require "${toNodeOptionsPath(hookPath)}"`;
  env.MOCK_CANARY_SCENARIO = options.scenario;
  env.MOCK_CANARY_VERSION = ENGINE_VERSION;
  env.INPUT_VERSION = ENGINE_VERSION;
  env.INPUT_PROTOCOL = "28";
  env["INPUT_FIXTURES-DIR"] = fixturesDir;
  env["INPUT_UPLOAD-REPORT"] = "false";
  env.INPUT_ANNOTATIONS = "true";
  env["INPUT_TIMEOUT-MINUTES"] = "1";
  // The sentinel `action.yml` declares as this input's default, so the value
  // the runner would pass is reproduced exactly (see src/inputs.ts).
  env["INPUT_NETWORK-PASSPHRASE"] = "\u0001";
  // #433: the engine runs with an allow-listed environment, so the mock's own
  // scenario selectors have to be forwarded the way a workflow would.
  env["INPUT_ENGINE-ENV-PASSTHROUGH"] = "MOCK_CANARY_SCENARIO,MOCK_CANARY_VERSION";

  return { workDir, env, outputPath, summaryPath };
}

/** Fails with an actionable message when the committed bundle is absent. */
function assertBundlePresent(): void {
  if (!fs.existsSync(DIST_INDEX)) {
    throw new Error(
      `${path.relative(REPO_ROOT, DIST_INDEX)} does not exist. Run \`npm run build\` before ` +
        "the bundle smoke test: it executes the committed artifact exactly as a workflow runner does.",
    );
  }
}

/** Runs a Node script with the runner's environment and kills it at
 * `timeoutMs`, reporting the timeout instead of hanging the suite. */
function runNode(scriptPath: string, runner: Runner, timeoutMs: number): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [scriptPath], {
      cwd: runner.workDir,
      env: runner.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    };

    child.on("error", (error) => {
      stderr += String(error);
      settle(null, null);
    });
    child.on("close", (code, signal) => {
      settle(code, signal);
    });
  });
}

/** Runs the committed bundle (`dist/index.js`) once. */
function runBundle(runner: Runner): Promise<RunResult> {
  assertBundlePresent();
  return runNode(DIST_INDEX, runner, RUN_TIMEOUT_MS);
}

/** Reads the heredoc-format `GITHUB_OUTPUT` file the Action wrote. */
function readOutputs(outputPath: string): Record<string, string> {
  const content = fs.readFileSync(outputPath, "utf8");
  const outputs: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)<<(.+)$/.exec(lines[i] ?? "");
    if (match === null) {
      continue;
    }
    const [, name, delimiter] = match;
    const valueLines: string[] = [];
    i++;
    while (i < lines.length && lines[i] !== delimiter) {
      valueLines.push(lines[i] ?? "");
      i++;
    }
    outputs[name as string] = valueLines.join("\n");
  }
  return outputs;
}

/** The `::error` workflow commands the run printed on stdout. */
function errorAnnotations(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((line) => line.startsWith("::error"));
}

/** Describes a run for an assertion message, so a failure is diagnosable
 * without re-running it. */
function describeRun(result: RunResult): string {
  const timedOut = result.timedOut ? " (killed at the timeout)" : "";
  return (
    `exit code ${String(result.exitCode)} in ${String(result.durationMs)}ms${timedOut}\n` +
    `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
  );
}

describe.skipIf(IS_WINDOWS)("committed bundle (dist/index.js)", () => {
  let runner: Runner | undefined;

  afterEach(() => {
    if (runner !== undefined) {
      fs.rmSync(runner.workDir, { recursive: true, force: true });
      runner = undefined;
    }
  });

  it("pass: exits 0, writes status=pass and a summary, and prints no error annotation", async () => {
    runner = createRunner({ scenario: "pass" });
    const result = await runBundle(runner);

    expect(result.timedOut, describeRun(result)).toBe(false);
    expect(result.exitCode, describeRun(result)).toBe(0);

    const outputs = readOutputs(runner.outputPath);
    expect(outputs.status, describeRun(result)).toBe("pass");
    expect(outputs.passed).toBe("1");
    expect(outputs.failures).toBe("0");

    const summary = fs.readFileSync(runner.summaryPath, "utf8");
    expect(summary.trim(), "the job summary was not written").not.toBe("");
    expect(summary).toContain("PASS");

    expect(errorAnnotations(result.stdout), describeRun(result)).toEqual([]);
  });

  it("fail: exits non-zero, writes status=fail, and prints an error annotation", async () => {
    runner = createRunner({ scenario: "fail" });
    const result = await runBundle(runner);

    expect(result.timedOut, describeRun(result)).toBe(false);
    expect(result.exitCode, describeRun(result)).not.toBe(0);
    expect(result.exitCode).not.toBeNull();

    const outputs = readOutputs(runner.outputPath);
    expect(outputs.status, describeRun(result)).toBe("fail");
    expect(outputs.failures).toBe("1");

    expect(errorAnnotations(result.stdout).length, describeRun(result)).toBeGreaterThan(0);
  });

  it("no engine and no cargo on PATH: fails fast with status=execution-failed naming cargo", async () => {
    runner = createRunner({ scenario: "pass", installEngine: false });
    // An empty directory: `cargo` cannot be found, exactly as on a
    // self-hosted runner without a Rust toolchain.
    const emptyPath = path.join(runner.workDir, "empty-path");
    fs.mkdirSync(emptyPath, { recursive: true });
    runner.env.PATH = emptyPath;

    const result = await runBundle(runner);

    expect(result.timedOut, describeRun(result)).toBe(false);
    expect(result.exitCode, describeRun(result)).not.toBe(0);

    expect(readOutputs(runner.outputPath).status, describeRun(result)).toBe("execution-failed");

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(errorAnnotations(result.stdout).length, describeRun(result)).toBeGreaterThan(0);
    expect(combined).toContain("cargo");
    expect(combined).toMatch(/cargo`? command was not found|cargo.*not found/i);
  });

  it("a truncated bundle fails with the runtime error, not with a hang", async () => {
    runner = createRunner({ scenario: "pass" });
    assertBundlePresent();

    const bundle = fs.readFileSync(DIST_INDEX);
    const truncatedPath = path.join(runner.workDir, "index-truncated.js");
    fs.writeFileSync(truncatedPath, bundle.subarray(0, Math.min(256, bundle.length)));

    const result = await runNode(truncatedPath, runner, 5_000);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.timedOut, `the truncated bundle hung instead of failing: ${describeRun(result)}`).toBe(false);
    expect(result.exitCode, describeRun(result)).not.toBe(0);
    // Acceptance criterion: the runtime error, within 10 seconds.
    expect(result.durationMs, describeRun(result)).toBeLessThan(10_000);
    expect(output, `expected a Node runtime error, got: ${describeRun(result)}`).toMatch(
      /SyntaxError|Unexpected end of input|Unexpected token|Invalid or unexpected token/,
    );
  });
});

