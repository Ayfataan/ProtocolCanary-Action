import type * as actionsCore from "@actions/core";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/*
 * Issue #438: how the Action translates the REAL engine's exit codes 1, 3
 * and 4 — and its skipped[] output — into a status, step failure, summary
 * and annotations. end-to-end.test.ts covers these paths only against the
 * mock engine (written by the same team as the mapping), and
 * real-engine.test.ts covers only passes/empty-runs; this file runs the real
 * engine named by STELLAR_CANARY_BIN through freshly generated, tiny fixture
 * packs and asserts the documented mapping end to end.
 *
 * Like real-engine.test.ts, the file skips cleanly when STELLAR_CANARY_BIN
 * is unset, so plain `npm test` is unchanged for contributors without an
 * engine binary. Nothing here needs the network: the exit-3 case points the
 * RPC fixture at http://127.0.0.1:1, where the OS refuses every connection
 * without a single packet leaving the machine. Each case is time-bounded so
 * a retrying engine still finishes inside its 30s budget.
 *
 * Engine ground truth (checked, not assumed):
 * - exit contract: 0 pass, 1 compatibility_failure, 2 configuration_error,
 *   3 execution_error, 4 invalid_fixture (docs/json-report-contract.md).
 * - skipped[] entries carry fixtureId, surface, reason; `skipped[].code`
 *   does NOT exist in v0.2.0 (canary-report/src/json.rs at v0.2.0) — it was
 *   added on main afterwards (canary-core/src/report.rs, "UNSUPPORTED_…"
 *   SCREAMING_SNAKE spellings). The skipped case therefore asserts the
 *   summary/reason unconditionally, and the `code` spelling only when the
 *   engine under test emits one. Which engine this file was last verified
 *   against is recorded in docs/releases.md and the PR.
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

// Tag lookup must not reach the network; resolveVersion degrades to
// tag-only pinning and the already-built binary is used (same convention as
// real-engine.test.ts).
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

// Logged from a copy of StellarCanary/ProtocolCanary-Fixtures at the
// immutable protocol-28 pack tag (commit 75ec2c2, file
// protocol-28/xdr/cap-0083/p28-xdr-cap83-empty-tx-set.toml), checked in as
// text per issue #438. The comments of the original are dropped; the fields
// the loader reads are verbatim.
const CAP83_VALUE_BASE64 =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaIwDgAAAAAAAAAACEREREREREREREREREREREREREREREREREREREREREREiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIgAAABwAAAAAMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMAAABARERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERA==";

const ENV_KEYS = [
  "CARGO_HOME",
  "RUNNER_TEMP",
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY",
  "INPUT_PROTOCOL",
  "INPUT_CONFIG",
  "INPUT_NETWORK",
  "INPUT_RPC-URL",
  "INPUT_FIXTURES-DIR",
  "INPUT_VERSION",
  "INPUT_UPLOAD-REPORT",
  "INPUT_ANNOTATIONS",
  "INPUT_TIMEOUT-MINUTES",
  "INPUT_ALLOW-EMPTY",
];

// core.summary caches GITHUB_STEP_SUMMARY on first use (see
// real-engine.test.ts), so every case shares one summary file.
const SUMMARY_PATH = path.join(os.tmpdir(), `canary-exit-code-summary-${String(process.pid)}.md`);

interface Case {
  readonly workDir: string;
  readonly outputPath: string;
  readonly reportPath: string;
  readonly packDir: string;
}

function engineVersion(binary: string): string {
  if (!fs.existsSync(binary)) {
    throw new Error(
      `STELLAR_CANARY_BIN is set but points at a missing file: ${binary}. ` +
        "Build the engine first (cargo build --release) or unset the variable to skip these tests.",
    );
  }
  const out = execFileSync(binary, ["version"], { encoding: "utf8" });
  const match = /(\d+\.\d+\.\d+)/.exec(out);
  if (match === null) {
    throw new Error(`could not read a version from: ${out}`);
  }
  return match[1] as string;
}

/** One tiny generated pack (fixtures/, never committed) plus one generated
 * config, a runner environment, and clean INPUT_* state. */
function setUp(version: string, options: { pack: "exit1" | "exit3" | "exit4" | "exit4-two-invalid" | "skipped" }): Case {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-exit-code-"));
  const packDir = path.join(workDir, "fixtures");
  fs.mkdirSync(packDir, { recursive: true });

  const xdrFixture = (id: string, protocol: number, kind: string): string =>
    [
      `id = "${id}"`,
      `protocol = ${String(protocol)}`,
      'surface = "xdr"',
      `category = "cap-0083"`,
      `description = "generated scenario pack for issue #438"`,
      "",
      `type = "StellarValue"`,
      `kind = "${kind}"`,
      `value_base64 = "${CAP83_VALUE_BASE64}"`,
      "",
    ].join("\n");
  const invalidToml = (id: string): string =>
    [
      `id = "${id}"`,
      `protocol = 28`,
      `surface = "xdr"`,
      `# value_base64 is truncated mid-string below: a parse-time TOML error`,
      `value_base64 = "partial`,
      "",
    ].join("\n");

  switch (options.pack) {
    case "exit1": {
      // A well-formed CAP-0083 value, but the fixture now asks the engine
      // whether decoding it FAILS — the real value decodes fine, so the
      // compatibility check fails: exit 1.
      fs.writeFileSync(
        path.join(packDir, "p28-xdr-cap83-decode-failure.toml"),
        xdrFixture("p28-xdr-cap83-decode-failure", 28, "decode-failure"),
      );
      break;
    }
    case "exit3": {
      // The Fixtures get-network RPC fixture; the run targets an RPC
      // endpoint on the local machine's refused port (no traffic leaves
      // the machine).
      fs.writeFileSync(
        path.join(packDir, "p28-rpc-network-refused.toml"),
        [
          "id = \"p28-rpc-network-refused\"",
          "protocol = 28",
          'surface = "rpc"',
          'category = "network"',
          'description = "getNetwork against a deliberately refused local port"',
          "",
          'method = "get-network"',
          "",
          "[[assert]]",
          'kind = "field-exists"',
          'field = "passphrase"',
          "",
        ].join("\n"),
      );
      break;
    }
    case "exit4": {
      fs.writeFileSync(
        path.join(packDir, "p28-xdr-broken-toml.toml"),
        invalidToml("p28-xdr-broken-toml"),
      );
      break;
    }
    case "exit4-two-invalid": {
      // Two invalid fixtures: the engine must still refuse the whole pack
      // with exit 4 rather than report a partial result.
      fs.writeFileSync(
        path.join(packDir, "p28-xdr-broken-one.toml"),
        invalidToml("p28-xdr-broken-one"),
      );
      fs.writeFileSync(
        path.join(packDir, "p28-xdr-broken-two.toml"),
        invalidToml("p28-xdr-broken-two"),
      );
      break;
    }
    case "skipped": {
      // One fixture for this run's protocol, one for another protocol; the
      // planner must skip exactly the second.
      fs.writeFileSync(
        path.join(packDir, "p28-xdr-cap83-run.toml"),
        xdrFixture("p28-xdr-cap83-run", 28, "roundtrip"),
      );
      fs.writeFileSync(
        path.join(packDir, "p29-xdr-other-protocol.toml"),
        xdrFixture("p29-xdr-other-protocol", 29, "roundtrip"),
      );
      break;
    }
  }

  const config = path.join(workDir, "scenario.stellar-canary.toml");
  fs.writeFileSync(
    config,
    options.pack === "exit3"
      ? "version = 1\nprotocol = 28\n\n[tests]\nxdr = false\nrpc = true\n"
      : "version = 1\nprotocol = 28\n\n[tests]\nxdr = true\nrpc = false\n",
  );

  const cargoHome = path.join(workDir, "cargo-home");
  fs.mkdirSync(path.join(cargoHome, "bin"), { recursive: true });
  // The engine is placed where the Action looks for an exact-version
  // installed binary (same convention as real-engine.test.ts), so the suite
  // exercises the check path only and never impulsively runs cargo install.
  fs.copyFileSync(binary as string, path.join(cargoHome, "bin", "stellar-canary"));
  fs.chmodSync(path.join(cargoHome, "bin", "stellar-canary"), 0o755);

  const runnerTemp = path.join(workDir, "runner-temp");
  fs.mkdirSync(runnerTemp, { recursive: true });
  const outputPath = path.join(workDir, "github-output");
  fs.writeFileSync(outputPath, "");
  fs.writeFileSync(SUMMARY_PATH, "");

  for (const key of ENV_KEYS) delete process.env[key];
  process.env.CARGO_HOME = cargoHome;
  process.env.RUNNER_TEMP = runnerTemp;
  process.env.GITHUB_OUTPUT = outputPath;
  process.env.GITHUB_STEP_SUMMARY = SUMMARY_PATH;
  process.env.INPUT_VERSION = version;
  process.env.INPUT_PROTOCOL = "28";
  process.env.INPUT_CONFIG = config;
  process.env["INPUT_FIXTURES-DIR"] = packDir;
  process.env["INPUT_UPLOAD-REPORT"] = "false";
  process.env.INPUT_ANNOTATIONS = "true";
  process.env["INPUT_TIMEOUT-MINUTES"] = "1";

  setFailedMock.mockClear();
  errorMock.mockClear();
  warningMock.mockClear();
  infoMock.mockClear();

  return { workDir, outputPath, reportPath: path.join(runnerTemp, "stellar-canary-report.json"), packDir };
}

function readOutputs(outputPath: string): Record<string, string> {
  const lines = fs.readFileSync(outputPath, "utf8").split("\n");
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

const binary = process.env.STELLAR_CANARY_BIN;
const enabled = binary !== undefined && binary !== "" && process.platform !== "win32";
const version = enabled ? engineVersion(binary) : "0.0.0";

describe.skipIf(!enabled)(`Real-engine exit codes 1/3/4 and skips (engine ${version})`, () => {
  let current: Case | undefined;

  afterEach(() => {
    if (current) fs.rmSync(current.workDir, { recursive: true, force: true });
    current = undefined;
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterAll(() => {
    fs.rmSync(SUMMARY_PATH, { force: true });
  });

  /** The engine keeps its result cache in the project root (the current
   * directory), so every run happens in the scratch directory. */
  async function runAction(): Promise<void> {
    const { run } = await import("../../src/main");
    const cwd = process.cwd();
    process.chdir((current as Case).workDir);
    try {
      await run();
    } finally {
      process.chdir(cwd);
    }
  }

  const CASE_BUDGET_MS = 30_000;

  it(
    "exit 1: a failed compatibility expectation produces status=fail, fails the step, and annotates once per result",
    async () => {
      current = setUp(version, { pack: "exit1" });
      await runAction();

      // The documented mapping for exit 1 is a real compatibility failure,
      // not an execution failure: the report is parsed and used.
      expect(setFailedMock).toHaveBeenCalledTimes(1);
      expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("fail");
      const outputs = readOutputs(current.outputPath);
      expect(outputs.status).toBe("fail");
      expect(outputs.failures).toBe("1");

      const summary = fs.readFileSync(SUMMARY_PATH, "utf8");
      expect(summary).toContain("❌ **NOT READY**");
      expect(summary).toContain("p28-xdr-cap83-decode-failure");
      expect(summary).toContain("0/1 applicable checks passed");

      // One annotation for the failing result plus one for the engine's
      // exit classification + root diagnostic (#351).
      expect(errorMock).toHaveBeenCalledTimes(2);
      expect(errorMock.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "exit code 1",
      );
    },
    CASE_BUDGET_MS,
  );

  it(
    "exit 3: a refused RPC endpoint inside the run surfaces as status=error and fails the step",
    async () => {
      current = setUp(version, { pack: "exit3" });
      process.env["INPUT_RPC-URL"] = "http://127.0.0.1:1";
      await runAction();

      expect(setFailedMock).toHaveBeenCalledTimes(1);
      const outputs = readOutputs(current.outputPath);
      expect(outputs.status).toBe("error");
      expect(outputs.errors).toBe("1");

      const summary = fs.readFileSync(SUMMARY_PATH, "utf8");
      expect(summary).toContain("🚫 **ERROR**");
      expect(summary).toContain("p28-rpc-network-refused");

      // Per-result annotation plus the exit-code annotation (#351).
      expect(errorMock).toHaveBeenCalledTimes(2);
      expect(errorMock.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "exit code 3",
      );
    },
    CASE_BUDGET_MS,
  );

  it(
    "exit 4: invalid fixture TOML refuses the pack before any report; the Action reports an execution failure",
    async () => {
      current = setUp(version, { pack: "exit4" });
      await runAction();

      expect(setFailedMock).toHaveBeenCalledTimes(1);
      // The engine died before a report could exist: execution failure,
      // not a compatibility failure, and the engine's classification
      // (exit code 4) is named.
      const reason = String(setFailedMock.mock.calls[0]?.[0]);
      expect(reason).toContain("could not be executed");
      expect(reason).toContain("exit code 4");

      const outputs = readOutputs(current.outputPath);
      expect(outputs.status).toBe("execution-failed");
      expect(outputs.passed).toBe("0");

      const summary = fs.readFileSync(SUMMARY_PATH, "utf8");
      expect(summary).toContain("🚫 **ERROR**");
      expect(summary).toContain("exit code 4");

      // Nothing on stdout means no report file was written.
      expect(fs.existsSync(current.reportPath)).toBe(false);
      expect(fs.readdirSync(current.packDir)).toHaveLength(1);
    },
    CASE_BUDGET_MS,
  );

  it(
    "exit 4 again with TWO invalid fixtures in the pack: still exit 4, never a partial result",
    async () => {
      current = setUp(version, { pack: "exit4-two-invalid" });
      await runAction();

      expect(setFailedMock).toHaveBeenCalledTimes(1);
      expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("exit code 4");
      expect(readOutputs(current.outputPath).status).toBe("execution-failed");
      expect(fs.readdirSync(current.packDir)).toHaveLength(2);
    },
    CASE_BUDGET_MS,
  );

  it(
    "skipped fixtures: a foreign-protocol fixture is skipped with its reason in the summary and does not fail the step",
    async () => {
      current = setUp(version, { pack: "skipped" });
      await runAction();

      expect(setFailedMock).not.toHaveBeenCalled();
      const outputs = readOutputs(current.outputPath);
      expect(outputs.status).toBe("pass");

      const summary = fs.readFileSync(SUMMARY_PATH, "utf8");
      expect(summary).toContain("✅ **PASS**");
      // The skipped section lists the skipped fixture id and the planner's
      // reason (docs/fixture-contract.md §5: "fixture targets protocol X…").
      expect(summary).toContain("Skipped fixtures");
      expect(summary).toContain("p29-xdr-other-protocol");
      expect(summary).toContain("targets protocol 29");

      // counts.skipped counts skips outside the result totals.
      const report = JSON.parse(fs.readFileSync(current.reportPath, "utf8")) as {
        counts: { total: number; passed: number; skipped: number };
        skipped: { fixtureId: string; reason: string; code?: string }[];
      };
      expect(report.counts.total).toBe(1);
      expect(report.counts.passed).toBe(1);
      expect(report.counts.skipped).toBe(1);
      expect(report.skipped?.[0]?.fixtureId).toBe("p29-xdr-other-protocol");
      expect(report.skipped?.[0]?.reason).toContain("29");
      // `skipped[].code` does not exist in v0.2.0; when the engine emits it,
      // it must use the documented spelling.
      const code = report.skipped?.[0]?.code;
      if (code !== undefined) {
        expect(code).toBe("UNSUPPORTED_PROTOCOL");
      }
    },
    CASE_BUDGET_MS,
  );
});
