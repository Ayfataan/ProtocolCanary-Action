import type * as actionsCore from "@actions/core";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { engineSupportsAllowEmpty } from "../../src/runner";

/*
 * Runs the whole Action (`run()`) against a REAL `stellar-canary` binary, not
 * the mock used by end-to-end.test.ts. The binary is taken from the environment
 * so nothing is built, downloaded or installed by the test itself:
 *
 *   STELLAR_CANARY_BIN         a binary of the engine under test (for example
 *                              0.2.0 or a build of Protocol-Canary `main`)
 *   STELLAR_CANARY_LEGACY_BIN  optional, a 0.1.x binary, to prove that the same
 *                              workflow inputs still work on the old engine
 *
 * Each suite is skipped when its variable is not set, so `npm test` is
 * unchanged for contributors who have no engine binary. The workflow
 * `.github/workflows/engine-compat.yml` builds the engine from a requested git
 * ref and sets these variables.
 *
 * The scenarios are offline: one XDR round-trip fixture and a config that
 * disables RPC and Soroban, so no network or credentials are involved.
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

// The tag lookup must not reach the network; resolveVersion degrades to
// installing nothing, and the already-installed binary below is used.
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

const FIXTURE_ROOT = path.join(__dirname, "..", "fixtures", "real-engine");
const OFFLINE_CONFIG = path.join(FIXTURE_ROOT, "offline.stellar-canary.toml");
const TYPO_CONFIG = path.join(FIXTURE_ROOT, "typo.stellar-canary.toml");
const PACK_DIR = path.join(FIXTURE_ROOT, "fixtures");

const ENV_KEYS = [
  "CARGO_HOME",
  "RUNNER_TEMP",
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY",
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

// core.summary caches GITHUB_STEP_SUMMARY on first use (see end-to-end.test.ts),
// so every test shares one summary file.
const SUMMARY_PATH = path.join(os.tmpdir(), `canary-real-summary-${String(process.pid)}.md`);

interface Run {
  readonly workDir: string;
  readonly outputPath: string;
  readonly reportPath: () => string;
  readonly emptyDir: string;
}

function engineVersion(binary: string): string {
  const out = execFileSync(binary, ["version"], { encoding: "utf8" });
  const match = /(\d+\.\d+\.\d+)/.exec(out);
  if (match === null) {
    throw new Error(`could not read a version from: ${out}`);
  }
  return match[1] as string;
}

function setUp(binary: string, version: string, inputs: Record<string, string>, omitVersion = false): Run {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-real-"));
  const cargoHome = path.join(workDir, "cargo-home");
  fs.mkdirSync(path.join(cargoHome, "bin"), { recursive: true });
  const exeName = process.platform === "win32" ? "stellar-canary.exe" : "stellar-canary";
  const destPath = path.join(cargoHome, "bin", exeName);
  fs.copyFileSync(binary, destPath);
  if (process.platform !== "win32") {
    fs.chmodSync(destPath, 0o755);
  }

  const runnerTemp = path.join(workDir, "runner-temp");
  fs.mkdirSync(runnerTemp, { recursive: true });
  const emptyDir = path.join(workDir, "no-fixtures-here");
  fs.mkdirSync(emptyDir);
  const outputPath = path.join(workDir, "github-output");
  fs.writeFileSync(outputPath, "");
  fs.writeFileSync(SUMMARY_PATH, "");

  for (const key of ENV_KEYS) delete process.env[key];
  process.env["INPUT_NETWORK-PASSPHRASE"] = "\u0001";
  process.env.CARGO_HOME = cargoHome;
  process.env.RUNNER_TEMP = runnerTemp;
  process.env.GITHUB_OUTPUT = outputPath;
  process.env.GITHUB_STEP_SUMMARY = SUMMARY_PATH;
  if (!omitVersion) {
    process.env.INPUT_VERSION = version;
  }
  process.env.INPUT_PROTOCOL = "28";
  process.env["INPUT_UPLOAD-REPORT"] = "false";
  process.env.INPUT_ANNOTATIONS = "true";
  process.env["INPUT_TIMEOUT-MINUTES"] = "2";
  process.env.INPUT_CONFIG = OFFLINE_CONFIG;
  process.env["INPUT_FIXTURES-DIR"] = PACK_DIR;
  for (const [name, value] of Object.entries(inputs)) {
    process.env[`INPUT_${name.toUpperCase()}`] = value === "$EMPTY" ? emptyDir : value;
  }

  setFailedMock.mockClear();
  errorMock.mockClear();
  warningMock.mockClear();
  infoMock.mockClear();

  // #399: the report filename is unique per invocation, so the path is read
  // back from the run's "report" output instead of being reconstructed.
  return { workDir, outputPath, reportPath: () => readOutputs(outputPath).report as string, emptyDir };
}

function readOutputs(outputPath: string): Record<string, string> {
  const content = fs.readFileSync(outputPath, "utf8").replace(/\r\n/g, "\n");
  const lines = content.split("\n");
  const outputs: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$/.exec(lines[i] ?? "");
    if (match) {
      const [, name, delimiter] = match;
      const value: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) {
        value.push(lines[i] ?? "");
        i++;
      }
      outputs[name as string] = value.join("\n");
    }
  }
  return outputs;
}

function resolveBinary(envName: string): string | undefined {
  const raw = process.env[envName];
  if (!raw || raw.trim() === "") {
    return undefined;
  }
  let candidate = raw.trim();
  if (process.platform === "win32" && /^\/[a-zA-Z]\//.test(candidate)) {
    candidate = `${candidate[1]}:${candidate.slice(2)}`;
  }
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  if (process.platform === "win32" && !candidate.toLowerCase().endsWith(".exe") && fs.existsSync(`${candidate}.exe`)) {
    return `${candidate}.exe`;
  }
  return undefined;
}

function suite(label: string, envName: string): void {
  const rawBinary = process.env[envName];
  const binary = resolveBinary(envName);
  const enabled = binary !== undefined;
  const skipReason = !enabled
    ? rawBinary && rawBinary.trim() !== ""
      ? `binary at ${rawBinary} is absent`
      : `${envName} is not set`
    : "";
  const version = enabled ? engineVersion(binary) : "0.0.0";
  const modern = engineSupportsAllowEmpty(version);

  describe.skipIf(!enabled)(
    `Action against a real engine: ${label}${enabled ? ` (${version})` : ` (skipped: ${skipReason})`}`,
    () => {
      let current: Run | undefined;

      afterEach(() => {
        if (current) fs.rmSync(current.workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        current = undefined;
        for (const key of ENV_KEYS) delete process.env[key];
      });

      afterAll(() => {
        fs.rmSync(SUMMARY_PATH, { force: true, maxRetries: 5, retryDelay: 100 });
      });

    // The engine writes .stellar-canary-cache/ in the project root (the current
    // directory), so every run happens in the scratch directory, never in the
    // repository.
    async function runAction(): Promise<void> {
      const { run } = await import("../../src/main");
      const cwd = process.cwd();
      process.chdir((current as Run).workDir);
      try {
        await run();
      } finally {
        process.chdir(cwd);
      }
    }

    it("passes an offline Protocol 28 fixture and publishes a parseable report", async () => {
      current = setUp(binary as string, version, {});
      await runAction();

      expect(setFailedMock).not.toHaveBeenCalled();
      const outputs = readOutputs(current.outputPath);
      expect(outputs.status).toBe("pass");
      expect(outputs.passed).toBe("1");
      expect(outputs.failures).toBe("0");

      const report = JSON.parse(fs.readFileSync(current.reportPath(), "utf8")) as {
        schemaVersion: number;
        toolVersion: string;
        counts: { total: number };
      };
      expect(report.schemaVersion).toBe(1);
      expect(report.toolVersion).toBe(version);
      expect(report.counts.total).toBe(1);
    });

    if (version === "0.2.0") {
      it("uses the v2 default engine version when version is omitted", async () => {
        current = setUp(binary as string, version, {}, true);
        await runAction();

        expect(setFailedMock).not.toHaveBeenCalled();
        expect(readOutputs(current.outputPath)["engine-version"]).toBe("0.2.0");
      });
    }

    it("allow-empty: true passes an empty run on this engine, whether or not it knows the flag", async () => {
      current = setUp(binary as string, version, { "fixtures-dir": "$EMPTY", "allow-empty": "true" });
      await runAction();

      expect(setFailedMock).not.toHaveBeenCalled();
      const outputs = readOutputs(current.outputPath);
      expect(outputs.status).toBe("pass");
      expect(outputs.passed).toBe("0");
      const report = JSON.parse(fs.readFileSync(current.reportPath(), "utf8")) as { counts: { total: number } };
      expect(report.counts.total).toBe(0);

      const notes = infoMock.mock.calls.map((call) => String(call[0]));
      expect(notes.some((line) => line.includes('"allow-empty" has no effect'))).toBe(!modern);
    });

    if (modern) {
      it("an empty run fails by default, as an execution failure that shows the engine's reason", async () => {
        current = setUp(binary as string, version, { "fixtures-dir": "$EMPTY" });
        await runAction();

        expect(setFailedMock).toHaveBeenCalled();
        const outputs = readOutputs(current.outputPath);
        expect(outputs.status).toBe("execution-failed");
        expect(outputs.passed).toBe("0");
        expect(fs.readFileSync(SUMMARY_PATH, "utf8")).toContain("no checks ran");
      });

      it("a misspelled config section is rejected and the engine's field name reaches the summary", async () => {
        current = setUp(binary as string, version, { config: TYPO_CONFIG });
        await runAction();

        expect(setFailedMock).toHaveBeenCalled();
        expect(readOutputs(current.outputPath).status).toBe("execution-failed");
        expect(fs.readFileSync(SUMMARY_PATH, "utf8")).toContain("test");
      });

      it("accepts results replayed from the cache on a second run", async () => {
        current = setUp(binary as string, version, {});
        await runAction();
        const first = JSON.parse(fs.readFileSync(current.reportPath(), "utf8")) as {
          results: { source?: string }[];
        };
        expect(first.results.map((r) => r.source ?? "absent")).toEqual(["live"]);

        setFailedMock.mockClear();
        await runAction();
        const second = JSON.parse(fs.readFileSync(current.reportPath(), "utf8")) as {
          results: { source?: string }[];
        };
        expect(second.results.map((r) => r.source)).toEqual(["cache"]);
        expect(setFailedMock).not.toHaveBeenCalled();
        expect(readOutputs(current.outputPath).status).toBe("pass");
      });
    } else {
      it("an empty run passes by default on this older engine (the behavior 0.2.0 changes)", async () => {
        current = setUp(binary as string, version, { "fixtures-dir": "$EMPTY" });
        await runAction();

        expect(setFailedMock).not.toHaveBeenCalled();
        expect(readOutputs(current.outputPath).status).toBe("pass");
      });
    }
  });
}

suite("engine under test", "STELLAR_CANARY_BIN");
suite("older engine", "STELLAR_CANARY_LEGACY_BIN");
