import type * as actionsCore from "@actions/core";
import type * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanaryExecutionFailedError, InvalidInputError, TimeoutError } from "../../src/errors";
import type { ActionInputs } from "../../src/inputs";
import {
  MAX_STDERR_CAPTURE_BYTES,
  MAX_STDOUT_CAPTURE_BYTES,
  SIGKILL_GRACE_MS,
  STDERR_DROPPED_NOTICE,
  FIXTURE_SURFACE_CACHE_DIR_MIN_VERSION,
  assertBaselineProtocol,
  buildCheckArgs,
  engineSupportsAllowEmpty,
  engineSupportsFixtureSurfaceCacheDir,
  extractDiagnostic,
  fixtureSurfaceCacheDirGateFailure,
  junitFilePath,
  loadBaselineReport,
  renderJUnitReport,
  runCheck,
} from "../../src/runner";
import { report } from "./helpers";

const { spawnMock, infoMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  infoMock: vi.fn(),
}));

// Most tests exercise the real mock-canary fixture, so `spawn` defaults to a
// pass-through of the real implementation; the timeout-escalation tests below
// swap in a fake child via `mockImplementationOnce`.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  spawnMock.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnMock };
});

// Only `info` is observed: buildCheckArgs logs a note for every version-gated
// input the resolved engine is too old to accept, and those notes are part of
// its contract (#413). Per CONTRIBUTING's partial-mock convention the rest of
// `@actions/core` keeps working through the real module.
vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof actionsCore>();
  return { ...actual, info: infoMock };
});

/** A `child_process.spawn` result that does nothing until it is signalled. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];

  /** Whether the fake process exits in response to `SIGTERM` (rather than ignoring it). */
  constructor(private readonly exitsOnSigterm: boolean) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    const exits = this.exitsOnSigterm ? signal === "SIGTERM" : signal === "SIGKILL";
    if (exits) {
      this.emit("close", null, signal);
    }
    return true;
  }
}

const MOCK_CANARY = path.join(__dirname, "..", "fixtures", "mock-canary.cjs");
const MOCK_CANARY_COMMAND = process.platform === "win32" ? process.execPath : MOCK_CANARY;
const MOCK_CANARY_PREFIX = process.platform === "win32" ? [MOCK_CANARY] : [];

const BASE_INPUTS: ActionInputs = {
  protocol: 28,
  config: undefined,
  network: undefined,
  networkPassphrase: undefined,
  rpcUrl: undefined,
  rpcMaxRetries: undefined,
  rpcRetryDelayMs: undefined,
  fixturesDir: "fixtures",
  fixture: undefined,
  surface: undefined,
  cacheDir: undefined,
  version: "0.1.0",
  uploadReport: true,
  annotations: true,
  diagnostics: false,
  timeoutMinutes: 15,
  allowEmpty: false,
  rpcTimeoutSeconds: undefined,
  maxConcurrency: undefined,
  noCache: undefined,
  liveCacheTtlSeconds: undefined,
  failOnWarning: false,
  offline: false,
  fixturesPackVersion: undefined,
  fixturesPackProtocol: undefined,
  baselineReport: undefined,
  githubToken: undefined,
  generateReceipt: false,
  reportRetentionDays: undefined,
  junitReport: false,
  strictIntegrity: false,
  prComment: false,
  workingDirectory: path.resolve("."),
};

describe("buildCheckArgs", () => {
  it("always requests JSON output and the fixtures directory", () => {
    const args = buildCheckArgs(BASE_INPUTS);
    expect(args).toEqual(["check", "--format", "json", "--protocol", "28", "--fixtures-dir", "fixtures"]);
  });

  it("omits optional flags that were not provided", () => {
    const args = buildCheckArgs({ ...BASE_INPUTS, protocol: undefined });
    expect(args).not.toContain("--protocol");
  });

  it("omits --network specifically when only network is left unset", () => {
    // Every optional flag is guarded by its own independent `if` in
    // `buildCheckArgs`, so a refactor that starts always pushing --network
    // (e.g. as an empty string) must still be caught here, with the other
    // optional inputs deliberately left set.
    const args = buildCheckArgs({
      ...BASE_INPUTS,
      network: undefined,
      rpcUrl: "https://soroban-testnet.stellar.org",
      config: ".stellar-canary.toml",
    });
    expect(args).not.toContain("--network");
    expect(args).not.toContain("");
    // The flags that *were* provided are still forwarded, so this cannot
    // pass by an implementation that drops every optional argument.
    expect(args).toEqual(
      expect.arrayContaining([
        "--protocol",
        "28",
        "--rpc-url",
        "https://soroban-testnet.stellar.org",
        "--config",
        ".stellar-canary.toml",
      ]),
    );
  });

  it("forwards network, rpc-url, and config as separate arguments", () => {
    const args = buildCheckArgs({
      ...BASE_INPUTS,
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      config: ".stellar-canary.toml",
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--network",
        "testnet",
        "--rpc-url",
        "https://soroban-testnet.stellar.org",
        "--config",
        ".stellar-canary.toml",
      ]),
    );
  });

  it("forwards passphrase and retry flags to engines that support them", () => {
    const args = buildCheckArgs(
      {
        ...BASE_INPUTS,
        network: "testnet",
        networkPassphrase: "Private Network ; October 2026",
        rpcMaxRetries: 0,
        rpcRetryDelayMs: 250,
      },
      "0.3.0",
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--network",
        "testnet",
        "--network-passphrase",
        "Private Network ; October 2026",
        "--rpc-max-retries",
        "0",
        "--rpc-retry-delay-ms",
        "250",
      ]),
    );
  });

  it("does not pass new flags to older or unknown engines", () => {
    const inputs = {
      ...BASE_INPUTS,
      networkPassphrase: "Private Network ; October 2026",
      rpcMaxRetries: 0,
      rpcRetryDelayMs: 250,
    };
    for (const version of ["0.2.0", "", undefined]) {
      const args = buildCheckArgs(inputs, version);
      expect(args).not.toContain("--network-passphrase");
      expect(args).not.toContain("--rpc-max-retries");
      expect(args).not.toContain("--rpc-retry-delay-ms");
    }
  });

  it("never concatenates arguments into a single string (command-injection defense)", () => {
    const args = buildCheckArgs({ ...BASE_INPUTS, network: "testnet; rm -rf /" });
    // The dangerous value must appear as exactly one array element, never
    // merged with adjacent flags or split by the shell.
    expect(args).toContain("testnet; rm -rf /");
    expect(args.some((a) => a.includes("--network testnet"))).toBe(false);
  });

  it("forwards fail-on-warning and offline only when enabled and supported", () => {
    const supportedVersion = "999999999.0.0";
    const baseArgs = buildCheckArgs(BASE_INPUTS);

    expect(
      buildCheckArgs({ ...BASE_INPUTS, failOnWarning: true }, supportedVersion),
    ).toEqual([...baseArgs, "--fail-on-warning"]);
    expect(buildCheckArgs({ ...BASE_INPUTS, offline: true }, supportedVersion)).toEqual([
      ...baseArgs,
      "--offline",
    ]);
    expect(
      buildCheckArgs(
        { ...BASE_INPUTS, failOnWarning: true, offline: true },
        supportedVersion,
      ),
    ).toEqual([...baseArgs, "--fail-on-warning", "--offline"]);
    for (const unsupportedVersion of [undefined, "0.2.0", "not-a-version"]) {
      expect(
        buildCheckArgs(
          { ...BASE_INPUTS, failOnWarning: true, offline: true },
          unsupportedVersion,
        ),
      ).toEqual(baseArgs);
    }
  });

  describe("fixture, surface, and cache-dir forwarding (#458)", () => {
    const prefix = ["check", "--format", "json", "--protocol", "28", "--fixtures-dir", "fixtures"];

    it("leaves the argument array identical to before when none of the three is set", () => {
      expect(buildCheckArgs(BASE_INPUTS, "0.1.0")).toEqual(prefix);
      expect(buildCheckArgs(BASE_INPUTS, "0.2.0")).toEqual(prefix);
      expect(buildCheckArgs(BASE_INPUTS)).toEqual(prefix);
    });

    it("forwards each input set alone as one --flag=value element", () => {
      expect(buildCheckArgs({ ...BASE_INPUTS, fixture: "p28-xdr-cap83-empty-tx-set" }, "9.9.9")).toEqual([
        ...prefix,
        "--fixture=p28-xdr-cap83-empty-tx-set",
      ]);
      expect(buildCheckArgs({ ...BASE_INPUTS, surface: "xdr" }, "9.9.9")).toEqual([...prefix, "--surface=xdr"]);
      expect(buildCheckArgs({ ...BASE_INPUTS, cacheDir: ".stellar-canary-cache" }, "9.9.9")).toEqual([
        ...prefix,
        "--cache-dir=.stellar-canary-cache",
      ]);
    });

    it("keeps a stable order for every combination", () => {
      const fixtureSurface = { ...BASE_INPUTS, fixture: "f", surface: "rpc" as const };
      expect(buildCheckArgs(fixtureSurface, "0.1.0")).toEqual([...prefix, "--fixture=f", "--surface=rpc"]);

      const fixtureCache = { ...BASE_INPUTS, fixture: "f", cacheDir: "c" };
      expect(buildCheckArgs(fixtureCache, "0.1.0")).toEqual([...prefix, "--fixture=f", "--cache-dir=c"]);

      const surfaceCache = { ...BASE_INPUTS, surface: "soroban" as const, cacheDir: "c" };
      expect(buildCheckArgs(surfaceCache, "0.1.0")).toEqual([...prefix, "--surface=soroban", "--cache-dir=c"]);

      const all = { ...BASE_INPUTS, fixture: "f", surface: "soroban" as const, cacheDir: "c" };
      expect(buildCheckArgs(all, "0.1.0")).toEqual([
        ...prefix,
        "--fixture=f",
        "--surface=soroban",
        "--cache-dir=c",
      ]);
    });

    it("passes a value beginning with - as one element, never as a separate option", () => {
      const args = buildCheckArgs({ ...BASE_INPUTS, fixture: "--weird-id" }, "0.1.0");
      expect(args).toContain("--fixture=--weird-id");
      expect(args).not.toContain("--weird-id");
      expect(args).not.toContain("");
    });

    it("appends --fixture= after every pre-existing argument", () => {
      const args = buildCheckArgs({ ...BASE_INPUTS, network: "testnet", fixture: "f" }, "0.1.0");
      expect(args.indexOf("--fixture=f")).toBe(args.length - 1);
      expect(args.indexOf("--network")).toBeLessThan(args.indexOf("--fixture=f"));
    });
  });
});

describe("baseline report validation (#344)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-baseline-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, contents: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, contents, "utf8");
    return file;
  }

  it("loads a complete report and preserves its target protocol", () => {
    const file = write("baseline.json", JSON.stringify(report({ targetProtocol: 28 })));
    const baseline = loadBaselineReport(file);
    expect(baseline.targetProtocol).toBe(28);
    expect(baseline.schemaVersion).toBe(1);
  });

  it("rejects an empty file before parsing", () => {
    const file = write("empty.json", "   \n");
    expect(() => loadBaselineReport(file)).toThrow(InvalidInputError);
    expect(() => loadBaselineReport(file)).toThrow(/baseline report is empty/);
  });

  it("rejects invalid JSON with a clear baseline parse error", () => {
    const file = write("broken.json", '{"schemaVersion": 1,');
    expect(() => loadBaselineReport(file)).toThrow(InvalidInputError);
    expect(() => loadBaselineReport(file)).toThrow(/not a valid Protocol Canary report/);
    expect(() => loadBaselineReport(file)).toThrow(/could not be parsed as JSON/);
  });

  it("rejects an unsupported schemaVersion", () => {
    const file = write("future.json", JSON.stringify(report({ schemaVersion: 99 })));
    expect(() => loadBaselineReport(file)).toThrow(InvalidInputError);
    expect(() => loadBaselineReport(file)).toThrow(/schemaVersion 99/);
  });

  it("rejects a missing or unreadable file", () => {
    expect(() => loadBaselineReport(path.join(dir, "absent.json"))).toThrow(InvalidInputError);
    expect(() => loadBaselineReport(path.join(dir, "absent.json"))).toThrow(/could not be read/);
  });

  it("accepts a baseline recorded for the same target protocol", () => {
    const baseline = report({ targetProtocol: 28 });
    const current = report({ targetProtocol: 28 });
    expect(() => assertBaselineProtocol(baseline, current, "baseline.json")).not.toThrow();
  });

  it("rejects a baseline recorded for a different target protocol with both values named", () => {
    const baseline = report({ targetProtocol: 27 });
    const current = report({ targetProtocol: 28 });
    expect(() => assertBaselineProtocol(baseline, current, "/tmp/baseline.json")).toThrow(InvalidInputError);
    expect(() => assertBaselineProtocol(baseline, current, "/tmp/baseline.json")).toThrow(
      /targets protocol 27, but this run targets protocol 28/,
    );
    expect(() => assertBaselineProtocol(baseline, current, "/tmp/baseline.json")).toThrow(/Incompatible baseline report/);
  });
});

describe("allow-empty forwarding", () => {
  it("is not passed unless the input is set", () => {
    expect(buildCheckArgs(BASE_INPUTS, "0.2.0")).not.toContain("--allow-empty");
  });

  it("is passed to an engine that supports it", () => {
    const args = buildCheckArgs({ ...BASE_INPUTS, allowEmpty: true }, "0.2.0");
    expect(args).toEqual([
      "check",
      "--format",
      "json",
      "--protocol",
      "28",
      "--fixtures-dir",
      "fixtures",
      "--allow-empty",
    ]);
  });

  it("is never passed to an engine that would reject it", () => {
    expect(buildCheckArgs({ ...BASE_INPUTS, allowEmpty: true }, "0.1.1")).not.toContain("--allow-empty");
  });

  it("is not passed when the engine version is unknown", () => {
    expect(buildCheckArgs({ ...BASE_INPUTS, allowEmpty: true })).not.toContain("--allow-empty");
  });

  it.each([
    ["0.1.0", false],
    ["0.1.1", false],
    ["0.1.99", false],
    ["0.2.0", true],
    ["0.2.1", true],
    ["0.10.0", true],
    ["1.0.0", true],
    ["", false],
    ["v0.2.0", false],
    ["0.2", false],
    ["0.2.0-rc1", false],
    [undefined, false],
  ])("engineSupportsAllowEmpty(%j) is %s", (version, expected) => {
    expect(engineSupportsAllowEmpty(version)).toBe(expected);
  });
});

// #413: the four engine check options `allow-empty` already paved the way
// for are declared in the same version-gate table, so every input must show
// up in argv only when set *and* accepted by the resolved engine — and a
// set input skipped for an older engine must always be reported.
describe("engine check option forwarding (#413)", () => {
  // Each case pairs one input with what `getInputs` returns for a set value:
  // `flag` is the exact spelling Protocol-Canary's `CheckArgs` declares (v0.2.0),
  // `value` the argv element that must follow it (undefined for a value-less
  // flag).
  const CASES: ReadonlyArray<{
    readonly input: string;
    readonly patch: Partial<ActionInputs>;
    readonly flag: string;
    readonly value: string | undefined;
  }> = [
    { input: "rpc-timeout-seconds", patch: { rpcTimeoutSeconds: 30 }, flag: "--rpc-timeout", value: "30" },
    { input: "max-concurrency", patch: { maxConcurrency: 8 }, flag: "--max-concurrency", value: "8" },
    { input: "no-cache", patch: { noCache: true }, flag: "--no-cache", value: undefined },
    { input: "live-cache-ttl-seconds", patch: { liveCacheTtlSeconds: 600 }, flag: "--live-cache-ttl", value: "600" },
  ];

  // Reset on both sides: earlier tests in this file (the unsupported
  // allow-empty case) also emit notes, and a stale call must never satisfy
  // an assertion here.
  beforeEach(() => infoMock.mockReset());
  afterEach(() => infoMock.mockReset());

  it.each(CASES)("forwards $input to a 0.2.0 engine when set", ({ patch, flag, value }) => {
    const args = buildCheckArgs({ ...BASE_INPUTS, ...patch }, "0.2.0");
    const index = args.indexOf(flag);
    expect(index).toBeGreaterThanOrEqual(0);
    if (value !== undefined) {
      // The value is its own argv element — never concatenated onto the flag.
      expect(args[index + 1]).toBe(value);
      expect(args).not.toContain(`${flag} ${value}`);
    }
    // Nothing was skipped, so there is nothing to report.
    expect(infoMock).not.toHaveBeenCalled();
  });

  it.each(CASES)("does not pass $input's flag when the input is unset", ({ flag }) => {
    const args = buildCheckArgs(BASE_INPUTS, "0.2.0");
    expect(args).not.toContain(flag);
    expect(infoMock).not.toHaveBeenCalled();
  });

  it.each(CASES)("skips $input on a 0.1.1 engine and logs a note naming it", ({ input, patch, flag }) => {
    const args = buildCheckArgs({ ...BASE_INPUTS, ...patch }, "0.1.1");
    expect(args).not.toContain(flag);
    const notes = infoMock.mock.calls.map((call) => String(call[0]));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`"${input}"`);
    // The note names the first engine release that accepts the flag.
    expect(notes[0]).toContain("0.2.0");
  });

  it("skips a new input when the engine version is unknown, with a note", () => {
    const args = buildCheckArgs({ ...BASE_INPUTS, rpcTimeoutSeconds: 30 });
    expect(args).not.toContain("--rpc-timeout");
    const notes = infoMock.mock.calls.map((call) => String(call[0]));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('"rpc-timeout-seconds"');
  });

  it("passes none of the flags to a 0.1.1 engine and logs a note per skipped input", () => {
    // Every gated input set at once. `no-cache: true` together with a TTL is
    // rejected by getInputs (#413), but buildCheckArgs does not validate
    // inputs and must still gate and report each flag independently.
    const all = {
      ...BASE_INPUTS,
      allowEmpty: true,
      rpcTimeoutSeconds: 30,
      maxConcurrency: 8,
      noCache: true,
      liveCacheTtlSeconds: 600,
    };
    const args = buildCheckArgs(all, "0.1.1");
    expect(args).toEqual(["check", "--format", "json", "--protocol", "28", "--fixtures-dir", "fixtures"]);
    const notes = infoMock.mock.calls.map((call) => String(call[0]));
    expect(notes).toHaveLength(5);
    for (const input of [
      "allow-empty",
      "rpc-timeout-seconds",
      "max-concurrency",
      "no-cache",
      "live-cache-ttl-seconds",
    ]) {
      expect(notes.some((note) => note.includes(`"${input}"`))).toBe(true);
    }
  });

  it("builds the exact argv for a 0.2.0 engine with every new input set", () => {
    const args = buildCheckArgs(
      { ...BASE_INPUTS, allowEmpty: true, rpcTimeoutSeconds: 30, maxConcurrency: 8, noCache: true },
      "0.2.0",
    );
    expect(args).toEqual([
      "check",
      "--format",
      "json",
      "--protocol",
      "28",
      "--fixtures-dir",
      "fixtures",
      "--allow-empty",
      "--rpc-timeout",
      "30",
      "--max-concurrency",
      "8",
      "--no-cache",
    ]);
  });

  it("builds the exact argv for a 0.2.0 engine with no-cache: false and a live-cache TTL", () => {
    const args = buildCheckArgs({ ...BASE_INPUTS, noCache: false, liveCacheTtlSeconds: 600 }, "0.2.0");
    expect(args).toEqual([
      "check",
      "--format",
      "json",
      "--protocol",
      "28",
      "--fixtures-dir",
      "fixtures",
      "--live-cache-ttl",
      "600",
    ]);
    // `false` is the engine default: no flag to forward.
    expect(args).not.toContain("--no-cache");
  });
});

// The five engine-gated inputs are asserted through buildCheckArgs, the
// single place every version gate lives (#413): (a) forwarded with the right
// value on a supporting engine, (b) skipped with a core.info note naming the
// input and the required version on an older one, (c) absent and silent when
// unset.
describe("the five inputs main gated separately are table-driven now (#413)", () => {
  const CASES: ReadonlyArray<{
    readonly input: string;
    readonly patch: Partial<ActionInputs>;
    readonly flag: string;
    readonly value: string | undefined;
    readonly minVersion: string;
    readonly supported: string;
    readonly older: string;
  }> = [
    {
      input: "network-passphrase",
      patch: { networkPassphrase: "Private Network ; October 2026" },
      flag: "--network-passphrase",
      value: "Private Network ; October 2026",
      minVersion: "0.3.0",
      supported: "0.3.0",
      older: "0.2.9",
    },
    {
      input: "rpc-max-retries",
      patch: { rpcMaxRetries: 0 },
      flag: "--rpc-max-retries",
      value: "0",
      minVersion: "0.3.0",
      supported: "0.3.0",
      older: "0.2.9",
    },
    {
      input: "rpc-retry-delay-ms",
      patch: { rpcRetryDelayMs: 250 },
      flag: "--rpc-retry-delay-ms",
      value: "250",
      minVersion: "0.3.0",
      supported: "0.3.0",
      older: "0.2.9",
    },
    {
      input: "fail-on-warning",
      patch: { failOnWarning: true },
      flag: "--fail-on-warning",
      value: undefined,
      minVersion: "999999999.0.0",
      supported: "999999999.0.0",
      older: "0.3.0",
    },
    {
      input: "offline",
      patch: { offline: true },
      flag: "--offline",
      value: undefined,
      minVersion: "999999999.0.0",
      supported: "999999999.0.0",
      older: "0.3.0",
    },
  ];

  beforeEach(() => infoMock.mockReset());
  afterEach(() => infoMock.mockReset());

  it.each(CASES)("forwards $input when set on a $minVersion engine", ({ patch, flag, value, supported }) => {
    const args = buildCheckArgs({ ...BASE_INPUTS, ...patch }, supported);
    const index = args.indexOf(flag);
    expect(index).toBeGreaterThanOrEqual(0);
    if (value !== undefined) {
      // The value is its own argv element — never concatenated onto the flag.
      expect(args[index + 1]).toBe(value);
      expect(args).not.toContain(`${flag} ${value}`);
    }
    // Nothing was skipped, so there is nothing to report.
    expect(infoMock).not.toHaveBeenCalled();
  });

  it.each(CASES)("skips $input on a $older engine with a note naming it and $minVersion", ({
    input,
    patch,
    flag,
    older,
    minVersion,
  }) => {
    const args = buildCheckArgs({ ...BASE_INPUTS, ...patch }, older);
    expect(args).not.toContain(flag);
    const notes = infoMock.mock.calls.map((call) => String(call[0]));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`"${input}"`);
    expect(notes[0]).toContain(minVersion);
  });

  it.each(CASES)("emits nothing at all when $input is unset", ({ flag }) => {
    const args = buildCheckArgs(BASE_INPUTS, "0.1.1");
    expect(args).not.toContain(flag);
    expect(infoMock).not.toHaveBeenCalled();
  });

  it("skips all five on an engine too old for any of them, one note each", () => {
    const all = {
      ...BASE_INPUTS,
      networkPassphrase: "Private Network ; October 2026",
      rpcMaxRetries: 0,
      rpcRetryDelayMs: 250,
      failOnWarning: true,
      offline: true,
    };
    const args = buildCheckArgs(all, "0.1.1");
    expect(args).toEqual(["check", "--format", "json", "--protocol", "28", "--fixtures-dir", "fixtures"]);
    const notes = infoMock.mock.calls.map((call) => String(call[0]));
    expect(notes).toHaveLength(5);
    for (const input of [
      "network-passphrase",
      "rpc-max-retries",
      "rpc-retry-delay-ms",
      "fail-on-warning",
      "offline",
    ]) {
      expect(notes.some((note) => note.includes(`"${input}"`))).toBe(true);
    }
  });
});

describe("fixture/surface/cache-dir fail-clearly gate (#458)", () => {
  it("has no minimum release hard-coded while no release supports the flags", () => {
    // Only change this assertion together with FIXTURE_SURFACE_CACHE_DIR_MIN_VERSION,
    // after reading CheckArgs at the release a maintainer names on #458.
    expect(FIXTURE_SURFACE_CACHE_DIR_MIN_VERSION).toBeUndefined();
  });

  it("reports no support for any engine version while the gate constant is undefined", () => {
    for (const version of ["0.1.0", "0.2.0", "0.3.0", "9.9.9", "", undefined]) {
      expect(engineSupportsFixtureSurfaceCacheDir(version)).toBe(false);
    }
  });

  it("produces no failure when no scoped input is set, whatever the engine version", () => {
    expect(fixtureSurfaceCacheDirGateFailure("0.1.0", [])).toBeUndefined();
    expect(fixtureSurfaceCacheDirGateFailure("9.9.9", [])).toBeUndefined();
  });

  it.each([["fixture"], ["surface"], ["cache-dir"], ["fixture", "surface"], ["fixture", "surface", "cache-dir"]])(
    "names the input(s), the resolved version, and the missing support for %j",
    (...setInputs) => {
      const message = fixtureSurfaceCacheDirGateFailure("0.2.0", setInputs);
      expect(message).toBeDefined();
      const text = message ?? "";
      for (const name of setInputs) {
        expect(text).toContain(`"${name}"`);
      }
      expect(text).toContain("Canary 0.2.0");
      expect(text).toMatch(/no released Protocol-Canary engine supports (it|them) yet/);
      expect(text).toMatch(/different scope than requested/);
    },
  );
});

describe("junit-report rendering through the engine (#423)", () => {
  let dir: string;
  let reportPath: string;
  let previousScenario: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-junit-"));
    reportPath = path.join(dir, "stellar-canary-report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report({})), "utf8");
    previousScenario = process.env.MOCK_CANARY_SCENARIO;
    delete process.env.MOCK_CANARY_SCENARIO;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previousScenario === undefined) {
      delete process.env.MOCK_CANARY_SCENARIO;
    } else {
      process.env.MOCK_CANARY_SCENARIO = previousScenario;
    }
  });

  function render(): ReturnType<typeof renderJUnitReport> {
    return renderJUnitReport(MOCK_CANARY_COMMAND, reportPath, 10_000, MOCK_CANARY_PREFIX);
  }

  it("derives the JUnit path from the report path", () => {
    expect(junitFilePath("/tmp/stellar-canary-report.json")).toBe("/tmp/stellar-canary-report.junit.xml");
    expect(junitFilePath("/tmp/report")).toBe("/tmp/report.junit.xml");
  });

  it("writes a well-formed XML file and returns its path on success", async () => {
    const outcome = await render();
    expect(outcome.reason).toBeUndefined();
    expect(outcome.path).toBe(path.join(dir, "stellar-canary-report.junit.xml"));
    const xml = fs.readFileSync(String(outcome.path), "utf8");
    expect(xml).toMatch(/^<\?xml version="1\.0"/);
    expect(xml).toContain("<testsuites");
    expect(xml).toContain("</testsuites>");
  });

  it("reports an engine without the report command as a failure, producing nothing", async () => {
    process.env.MOCK_CANARY_SCENARIO = "junit-unknown";
    const outcome = await render();
    expect(outcome.path).toBeUndefined();
    expect(outcome.reason).toContain("exited with code 2");
    expect(outcome.reason).toContain('unknown subcommand "report"');
    expect(fs.existsSync(path.join(dir, "stellar-canary-report.junit.xml"))).toBe(false);
  });

  it("reports a non-zero render exit as a failure, producing nothing", async () => {
    process.env.MOCK_CANARY_SCENARIO = "junit-fail";
    const outcome = await render();
    expect(outcome.path).toBeUndefined();
    expect(outcome.reason).toContain("exited with code 5");
    expect(outcome.reason).toContain("internal error while rendering JUnit XML");
    expect(fs.existsSync(path.join(dir, "stellar-canary-report.junit.xml"))).toBe(false);
  });

  it("reports empty engine output as a failure, producing nothing", async () => {
    process.env.MOCK_CANARY_SCENARIO = "junit-empty";
    const outcome = await render();
    expect(outcome.path).toBeUndefined();
    expect(outcome.reason).toContain("produced no output");
    expect(fs.existsSync(path.join(dir, "stellar-canary-report.junit.xml"))).toBe(false);
  });

  it("reports a missing report file as a failure without throwing", async () => {
    reportPath = path.join(dir, "absent.json");
    const outcome = await render();
    expect(outcome.path).toBeUndefined();
    expect(outcome.reason).toContain("exited with code 2");
    expect(outcome.reason).toContain("report file not found");
  });

  it("captures a spawn failure as a reason instead of throwing", async () => {
    const outcome = await renderJUnitReport(path.join(dir, "no-such-binary"), reportPath, 5_000);
    expect(outcome.path).toBeUndefined();
    expect(outcome.reason).toBeTruthy();
  });
});

describe("runCheck", () => {
  // Node's signal delivery and child termination semantics differ on Windows;
  // the process-signal assertions below are covered by the Unix job.
  const itWithUnixSignals = process.platform === "win32" ? it.skip : it;

  function run(timeoutMs = 5000) {
    return runCheck(MOCK_CANARY_COMMAND, [...MOCK_CANARY_PREFIX, "check"], timeoutMs);
  }

  it("captures stdout and a zero exit code on pass", async () => {
    process.env.MOCK_CANARY_SCENARIO = "pass";
    const result = await run();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "pass" });
    expect(result.stderr).toBe("");
  });

  it("preserves a non-zero exit code without throwing", async () => {
    process.env.MOCK_CANARY_SCENARIO = "fail";
    const result = await run();
    expect(result.exitCode).toBe(1);
  });

  it("captures stderr separately when there is no JSON on stdout", async () => {
    process.env.MOCK_CANARY_SCENARIO = "config-error";
    const result = await run();
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("configuration error");
  });

  itWithUnixSignals("rejects with TimeoutError and kills the process when it runs too long", async () => {
    process.env.MOCK_CANARY_SCENARIO = "timeout";
    await expect(
      runCheck(MOCK_CANARY_COMMAND, [...MOCK_CANARY_PREFIX, "check"], 200),
    ).rejects.toThrow(TimeoutError);
  });

  it("rejects with CanaryExecutionFailedError when the binary cannot be started", async () => {
    await expect(runCheck(path.join(__dirname, "does-not-exist"), ["check"], 5000)).rejects.toThrow(
      CanaryExecutionFailedError,
    );
  });

  // The child's "error" and "close" handlers both guard on the shared
  // `settled` flag. Node can emit "error" after "close" (e.g. a read error
  // surfacing on a stream whose process has already exited); the guard makes
  // such a late event a no-op. Per ES semantics a second settle would be an
  // unobservable no-op on the promise itself, so what this test pins is the
  // observable contract the issue asks for (#272): the late "error" neither
  // changes the already-delivered result nor produces an unhandled rejection
  // (which fails the whole vitest run), and the child's listeners stay in
  // the cleaned-up state `close` left them in.
  it("ignores a late error event after already settling via close (#272)", async () => {
    // The timeout-escalation suite swaps in fake children via `fakeSpawn`;
    // that helper lives in another describe block, so swap here directly
    // (the vi.mock wrapper restores the real spawn after this Once).
    const child = new FakeChild(true); // exits in response to SIGTERM
    spawnMock.mockImplementationOnce(() => child as unknown as ChildProcess);

    // runCheck registers its signal-forwarding listeners synchronously
    // inside the promise executor; capture the baseline to compare against.
    const baselineInt = process.listenerCount("SIGINT");
    const baselineTerm = process.listenerCount("SIGTERM");

    const pending = runCheck("fake-canary", ["check"], 60_000);
    expect(process.listenerCount("SIGINT")).toBe(baselineInt + 1);
    expect(process.listenerCount("SIGTERM")).toBe(baselineTerm + 1);

    // Emit "close" first (the child exits on SIGTERM, so the result is a
    // null exit code with the signal set), and let the queue drain so the
    // promise has really settled before the late event arrives.
    child.emit("close", null, "SIGTERM");
    const settled = await pending;
    expect(settled).toEqual({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" });

    // Now fire "error" the way Node would after the fact. If the settled
    // guard were broken such that the late event rejected the promise
    // anew, vitest would report an unhandled rejection and fail the run.
    child.emit("error", new Error("read EIO: terminal attributes"));

    // Let any misplaced second settle surface before asserting.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The already-delivered result is unchanged by the late event.
    expect(await pending).toEqual(settled);
    // No listener leaked and none was removed twice: the state is exactly
    // what close's single cleanup() left behind.
    expect(process.listenerCount("SIGINT")).toBe(baselineInt);
    expect(process.listenerCount("SIGTERM")).toBe(baselineTerm);
  });

  // `process` is a process-wide EventEmitter shared by every runCheck call
  // in the host process, so a leaked forwardSignal listener would accumulate
  // across repeated runs (eventually tripping Node's
  // MaxListenersExceededWarning). These tests pin the contract that the
  // listeners registered before spawning are removed once the promise
  // settles, whichever way it settles.
  describe("signal listener hygiene", () => {
    const SIGNALS = ["SIGINT", "SIGTERM"] as const;

    function snapshotListenerCounts(): Record<(typeof SIGNALS)[number], number> {
      const counts: Record<(typeof SIGNALS)[number], number> = { SIGINT: 0, SIGTERM: 0 };
      for (const signal of SIGNALS) {
        counts[signal] = process.listenerCount(signal);
      }
      return counts;
    }

    it("registers its signal listeners while running and removes them after a successful run", async () => {
      process.env.MOCK_CANARY_SCENARIO = "pass";
      const before = snapshotListenerCounts();

      const pending = run();

      // process.on(...) runs synchronously inside runCheck's Promise
      // executor, so exactly one listener per signal is present immediately.
      for (const signal of SIGNALS) {
        expect(process.listenerCount(signal)).toBe(before[signal] + 1);
      }

      const result = await pending;
      expect(result.exitCode).toBe(0);

      // cleanup() must restore the pre-run counts exactly.
      for (const signal of SIGNALS) {
        expect(process.listenerCount(signal)).toBe(before[signal]);
      }
    });

    it("removes its signal listeners after a rejected run (timeout)", async () => {
      process.env.MOCK_CANARY_SCENARIO = "timeout";
      const before = snapshotListenerCounts();

      const pending = runCheck(MOCK_CANARY_COMMAND, [...MOCK_CANARY_PREFIX, "check"], 200);

      for (const signal of SIGNALS) {
        expect(process.listenerCount(signal)).toBe(before[signal] + 1);
      }

      await expect(pending).rejects.toThrow(TimeoutError);

      for (const signal of SIGNALS) {
        expect(process.listenerCount(signal)).toBe(before[signal]);
      }
    });

    it("removes its signal listeners when the binary cannot be started", async () => {
      const before = snapshotListenerCounts();

      await expect(runCheck(path.join(__dirname, "does-not-exist"), ["check"], 5000)).rejects.toThrow(
        CanaryExecutionFailedError,
      );

      for (const signal of SIGNALS) {
        expect(process.listenerCount(signal)).toBe(before[signal]);
      }
    });
  });
});

describe("runCheck signal handling", () => {
  const itWithUnixSignals = process.platform === "win32" ? it.skip : it;

  itWithUnixSignals("resolves with a null exit code and the signal when the child is killed by a signal", async () => {
    // This exercises the `close` branch where `exitCode` is null and a real
    // signal is set, without going through the timeout path: the child
    // terminates itself with SIGTERM.
    const result = await runCheck(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], 5000);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  itWithUnixSignals("forwards a cancellation signal to the child and removes its listeners on settle", async () => {
    process.env.MOCK_CANARY_SCENARIO = "timeout";
    const baselineInt = process.listenerCount("SIGINT");
    const baselineTerm = process.listenerCount("SIGTERM");

    // runCheck registers its signal-forwarding listeners synchronously
    // inside the promise executor, so they are present the moment it returns.
    const pending = runCheck(MOCK_CANARY, ["check"], 8000);
    expect(process.listenerCount("SIGINT")).toBe(baselineInt + 1);
    expect(process.listenerCount("SIGTERM")).toBe(baselineTerm + 1);

    // Invoke the forwarding listener the way the OS would, proving the
    // signal reaches the child: the child dies from SIGINT, so the close
    // event reports a null exit code with the signal set and runCheck
    // resolves rather than rejecting.
    const listeners = process.rawListeners("SIGINT");
    const forwardSignal = listeners[listeners.length - 1] as (signal: NodeJS.Signals) => void;
    forwardSignal("SIGINT");

    const result = await pending;
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGINT");

    // cleanup() removed both forwarding listeners: no leak across runs.
    expect(process.listenerCount("SIGINT")).toBe(baselineInt);
    expect(process.listenerCount("SIGTERM")).toBe(baselineTerm);
  });
});

describe("runCheck timeout escalation", () => {
  afterEach(() => {
    spawnMock.mockClear();
  });

  function fakeSpawn(child: FakeChild): void {
    spawnMock.mockImplementationOnce(() => child as unknown as ChildProcess);
  }

  it("sends SIGKILL when the process ignores SIGTERM past the grace period", async () => {
    const child = new FakeChild(false);
    fakeSpawn(child);

    await expect(runCheck("fake-canary", ["check"], 10, 20)).rejects.toThrow(TimeoutError);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("never sends SIGKILL when the process exits after SIGTERM", async () => {
    const child = new FakeChild(true);
    fakeSpawn(child);

    await expect(runCheck("fake-canary", ["check"], 10, 20)).rejects.toThrow(TimeoutError);
    // Wait beyond the grace period: the escalation timer must have been
    // cleared when the process closed, or SIGKILL would appear here.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(child.signals).toEqual(["SIGTERM"]);
  });
});

describe("extractDiagnostic", () => {
  // #351: failure annotations must carry the engine's root message, not a
  // bare "Process exited with code N" — so the useful line has to be dug
  // out of stderr that often leads with progress/banner noise.
  it("prefers the root error line over surrounding noise (#351)", () => {
    const stderr = [
      "stellar-canary 0.2.0 (canary-cli)",
      "loading fixtures from ./fixtures",
      "error: configuration error: no checks ran: all 7 loaded fixtures were skipped",
      "stack backtrace: ...",
    ].join("\n");
    expect(extractDiagnostic(stderr)).toBe(
      "error: configuration error: no checks ran: all 7 loaded fixtures were skipped",
    );
  });

  it("falls back to the first non-empty line when nothing reads as an error (#351)", () => {
    expect(extractDiagnostic("\n\n   just context   \nmore detail\n")).toBe("just context");
  });

  it("honors other root-message prefixes the engine uses (#351)", () => {
    expect(extractDiagnostic("no checks ran: empty plan")).toBe("no checks ran: empty plan");
    expect(extractDiagnostic("panic: thread main panicked")).toBe("panic: thread main panicked");
    expect(extractDiagnostic("Invalid fixture: bad xdr")).toBe("Invalid fixture: bad xdr");
  });

  it("returns an empty string for empty or whitespace-only stderr (#351)", () => {
    expect(extractDiagnostic("")).toBe("");
    expect(extractDiagnostic("  \n \t \n")).toBe("");
  });

  it("truncates a very long diagnostic to the documented bound (#351)", () => {
    const long = `error: ${"x".repeat(5_000)}`;
    const diagnostic = extractDiagnostic(long);
    expect(diagnostic.length).toBe(500);
    expect(diagnostic.startsWith("[... earlier output truncated ...]\n")).toBe(true);
  });
});

describe("UTF-8 stream decoding and bounded capture (issue #427)", () => {
  it("survives 2, 3 and 4 byte characters being split at every possible byte offset across child writes", async () => {
    // 2-byte: é (0xC3 0xA9)
    // 3-byte: € (0xE2 0x82 0xAC)
    // 4-byte: 🎉 (0xF0 0x9F 0x8E 0x89)
    const script = `
      const e2 = Buffer.from("é", "utf8");
      const e3 = Buffer.from("€", "utf8");
      const e4 = Buffer.from("🎉", "utf8");

      // Split 2-byte at offset 1
      process.stdout.write(e2.subarray(0, 1));
      process.stdout.write(e2.subarray(1));

      // Split 3-byte at offset 1 and 2
      process.stdout.write(e3.subarray(0, 1));
      process.stdout.write(e3.subarray(1));
      process.stdout.write(e3.subarray(0, 2));
      process.stdout.write(e3.subarray(2));

      // Split 4-byte at offset 1, 2, 3
      process.stdout.write(e4.subarray(0, 1));
      process.stdout.write(e4.subarray(1));
      process.stdout.write(e4.subarray(0, 2));
      process.stdout.write(e4.subarray(2));
      process.stdout.write(e4.subarray(0, 3));
      process.stdout.write(e4.subarray(3));
    `;

    const result = await runCheck(process.execPath, ["-e", script], 5000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("é€€🎉🎉🎉");
    expect(result.stdout).not.toContain("\uFFFD");
  });

  it("handles one-byte chunks without corrupting text", async () => {
    const script = `
      const buf = Buffer.from("Stellar Protocol Canary 🚀 € 28", "utf8");
      for (const b of buf) {
        process.stdout.write(Buffer.from([b]));
      }
    `;

    const result = await runCheck(process.execPath, ["-e", script], 5000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Stellar Protocol Canary 🚀 € 28");
  });

  it("replaces invalid byte sequences and lone continuation bytes without damaging surrounding valid text", async () => {
    const script = `
      process.stdout.write(Buffer.from([0x61, 0xFF, 0x62])); // 'a', 0xFF, 'b'
      process.stdout.write(Buffer.from([0x63, 0x80, 0x64])); // 'c', 0x80, 'd'
    `;

    const result = await runCheck(process.execPath, ["-e", script], 5000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a\uFFFDb\nc\uFFFDd".replace("\n", ""));
  });

  it("handles an empty stream cleanly", async () => {
    const result = await runCheck(process.execPath, ["-e", ""], 5000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("terminates child and fails with CanaryExecutionFailedError when stdout exceeds 64 MiB", async () => {
    // 65 MiB in stdout
    const script = `
      process.stdout.write(Buffer.alloc(65 * 1024 * 1024, "a"));
    `;

    await expect(runCheck(process.execPath, ["-e", script], 10_000)).rejects.toThrow(
      CanaryExecutionFailedError,
    );

    try {
      await runCheck(process.execPath, ["-e", script], 10_000);
    } catch (err) {
      expect(err).toBeInstanceOf(CanaryExecutionFailedError);
      const message = (err as CanaryExecutionFailedError).message;
      expect(message).toContain("64 MiB");
      expect(message).toContain("output was truncated");
      expect(message).toContain("process terminated");
    }
  });

  it("terminates a child that writes stdout without ever exiting", async () => {
    const script = `
      setInterval(() => {
        process.stdout.write(Buffer.alloc(1024 * 1024, "x"));
      }, 5);
    `;

    await expect(runCheck(process.execPath, ["-e", script], 10_000)).rejects.toThrow(
      CanaryExecutionFailedError,
    );
  });

  it("keeps bounded tail and prepends notice when stderr exceeds 1 MiB", async () => {
    const script = `
      process.stderr.write(Buffer.alloc(2 * 1024 * 1024, "e"));
      process.stderr.write("FINAL ROOT DIAGNOSTIC ERROR\\n");
    `;

    const result = await runCheck(process.execPath, ["-e", script], 10_000);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.startsWith(STDERR_DROPPED_NOTICE)).toBe(true);
    expect(result.stderr).toContain("FINAL ROOT DIAGNOSTIC ERROR");
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(MAX_STDERR_CAPTURE_BYTES);
  });
});

describe("runCheck timeoutMs guard (#456)", () => {
  beforeEach(() => {
    spawnMock.mockClear();
  });

  it("rejects a timeoutMs above the Node timer limit instead of starting a timer", async () => {
    await expect(
      runCheck("fake-canary", ["check"], 2_147_483_648),
    ).rejects.toThrow(/timeoutMs/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity])(
    "rejects a non-positive or non-finite timeoutMs %j",
    async (timeoutMs) => {
      await expect(runCheck("fake-canary", ["check"], timeoutMs)).rejects.toThrow(
        /timeoutMs/,
      );
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it("passes a sub-limit delay to setTimeout for 35791 minutes and does not fire immediately", async () => {
    // Regression: timeout-minutes: 40000 used to be multiplied by 60,000 and
    // handed to setTimeout, which clamped delays above 2,147,483,647 ms to
    // fire after 1 ms and terminate the engine almost immediately. The largest
    // accepted value (35791 minutes) must keep a real, sub-limit delay.
    vi.useFakeTimers();
    try {
      const child = new FakeChild(false); // ignores SIGTERM: only the timer can settle it
      spawnMock.mockImplementationOnce(() => child as unknown as ChildProcess);
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      let settled = false;
      const pending = runCheck("fake-canary", ["check"], 35791 * 60_000);
      pending.then(() => {
        settled = true;
      }, () => {
        settled = true;
      });

      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      const [, delay] = setTimeoutSpy.mock.lastCall as [unknown, number];
      expect(delay).toBe(35791 * 60_000);
      expect(delay).toBeLessThan(2_147_483_647);

      // Advancing 1 ms must not settle the promise: the timer is honoured,
      // not clamped to fire immediately.
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);

      // Letting the timer fire proves the delay is real: SIGTERM is sent, the
      // child ignores it, and SIGKILL after the grace period settles it.
      await vi.advanceTimersByTimeAsync(35791 * 60_000 + 6_000);
      await expect(pending).rejects.toThrow(TimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runCheck capture limits at their exact boundaries (#514)", () => {
  const MIB = 1024 * 1024;

  beforeEach(() => {
    spawnMock.mockClear();
  });

  /** Starts runCheck against a fake child and returns both, so a test can feed
   * the child's streams directly. The spawn mock is consumed by runCheck's
   * synchronous `spawn` call, so the listeners are attached by the time this
   * returns. */
  function start(exitsOnSigterm = true): { child: FakeChild; pending: ReturnType<typeof runCheck> } {
    const child = new FakeChild(exitsOnSigterm);
    spawnMock.mockImplementationOnce(() => child as unknown as ChildProcess);
    return { child, pending: runCheck("fake-canary", ["check"], 60_000) };
  }

  function emit(stream: PassThrough, text: string, chunkChars = text.length): void {
    for (let offset = 0; offset < text.length; offset += chunkChars) {
      stream.emit("data", text.slice(offset, offset + chunkChars));
    }
  }

  it("pins the documented limits by value", () => {
    expect(MAX_STDOUT_CAPTURE_BYTES).toBe(64 * MIB);
    expect(MAX_STDOUT_CAPTURE_BYTES).toBe(67_108_864);
    expect(MAX_STDERR_CAPTURE_BYTES).toBe(MIB);
    expect(MAX_STDERR_CAPTURE_BYTES).toBe(1_048_576);
    expect(SIGKILL_GRACE_MS).toBe(5000);
    expect(Buffer.byteLength(STDERR_DROPPED_NOTICE, "utf8")).toBe(33);
  });

  describe("stderr", () => {
    it("keeps exactly 1 MiB whole, without the dropped-output notice", async () => {
      const text = `${"e".repeat(MIB - 4)}LAST`;
      const { child, pending } = start();

      emit(child.stderr, text, 256 * 1024);
      child.emit("close", 0, null);
      const result = await pending;

      expect(result.exitCode).toBe(0);
      expect(result.stderr.length).toBe(MIB);
      expect(result.stderr).toBe(text);
      expect(result.stderr.startsWith(STDERR_DROPPED_NOTICE)).toBe(false);
    });

    it("drops the head of 1 MiB plus one byte, keeps the tail and stays within 1 MiB", async () => {
      const text = `${"e".repeat(MIB - 3)}LAST`;
      expect(Buffer.byteLength(text, "utf8")).toBe(MIB + 1);
      const { child, pending } = start();

      emit(child.stderr, text, 256 * 1024);
      child.emit("close", 0, null);
      const { stderr } = await pending;

      expect(stderr.startsWith(STDERR_DROPPED_NOTICE)).toBe(true);
      expect(stderr.endsWith("eLAST")).toBe(true);
      expect(Buffer.byteLength(stderr, "utf8")).toBe(MAX_STDERR_CAPTURE_BYTES);
      expect(stderr).toBe(
        `${STDERR_DROPPED_NOTICE}${text.slice(-(MAX_STDERR_CAPTURE_BYTES - Buffer.byteLength(STDERR_DROPPED_NOTICE)))}`,
      );
    });

    it("keeps the true tail when many small chunks cross 1.5 times the limit", async () => {
      // Numbered lines make "the tail" checkable by value, not just by length.
      let text = "";
      for (let n = 0; text.length < 1.7 * MIB; n++) {
        text += `line ${String(n).padStart(7, "0")}\n`;
      }
      const { child, pending } = start();

      emit(child.stderr, text, 8 * 1024);
      child.emit("close", 0, null);
      const { stderr } = await pending;

      const noticeBytes = Buffer.byteLength(STDERR_DROPPED_NOTICE);
      expect(Buffer.byteLength(stderr, "utf8")).toBe(MAX_STDERR_CAPTURE_BYTES);
      expect(stderr).toBe(`${STDERR_DROPPED_NOTICE}${text.slice(-(MAX_STDERR_CAPTURE_BYTES - noticeBytes))}`);
      expect(stderr.endsWith(text.slice(-20))).toBe(true);
    });
  });

  describe("stderr, trim at the very end of the stream", () => {
    it("keeps a full 1 MiB tail when the mid-stream trim fires on the last chunk", async () => {
      // 1.5 MiB plus one character: the final chunk is the first one that
      // pushes the buffer over 1.5 times the limit, so nothing arrives after
      // the trim to refill it. The retained buffer must still hold enough for
      // the final notice-plus-tail to be exactly 1 MiB.
      let text = "";
      for (let n = 0; text.length < 1.5 * MIB + 1; n++) {
        text += `line ${String(n).padStart(7, "0")}\n`;
      }
      text = text.slice(0, 1.5 * MIB + 1);
      const { child, pending } = start();

      emit(child.stderr, text, 8 * 1024);
      child.emit("close", 0, null);
      const { stderr } = await pending;

      const noticeBytes = Buffer.byteLength(STDERR_DROPPED_NOTICE);
      expect(Buffer.byteLength(stderr, "utf8")).toBe(MAX_STDERR_CAPTURE_BYTES);
      expect(stderr).toBe(`${STDERR_DROPPED_NOTICE}${text.slice(-(MAX_STDERR_CAPTURE_BYTES - noticeBytes))}`);
    });
  });

  describe("stdout", () => {
    it("accepts exactly 64 MiB without terminating the child", async () => {
      // One 1 MiB string, emitted 64 times: the payload is allocated once.
      const chunk = "a".repeat(MIB);
      const { child, pending } = start();

      for (let i = 0; i < 64; i++) {
        child.stdout.emit("data", chunk);
      }
      child.emit("close", 0, null);
      const result = await pending;

      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBe(MAX_STDOUT_CAPTURE_BYTES);
      expect(child.signals).toEqual([]);
    });

    it("rejects and terminates the child at 64 MiB plus one byte", async () => {
      const chunk = "a".repeat(MIB);
      const { child, pending } = start();
      const outcome = pending.catch((error: unknown) => error);

      for (let i = 0; i < 64; i++) {
        child.stdout.emit("data", chunk);
      }
      expect(child.signals).toEqual([]);
      child.stdout.emit("data", "a");

      const error = await outcome;
      expect(error).toBeInstanceOf(CanaryExecutionFailedError);
      expect((error as Error).message).toContain("64 MiB");
      expect(child.signals).toEqual(["SIGTERM"]);
    });

    it("counts bytes, not characters: 64 MiB of 3-byte characters is over the limit", async () => {
      const chunk = "\u20AC".repeat(65_536); // 196,608 bytes per chunk
      const { child, pending } = start();
      const outcome = pending.catch((error: unknown) => error);

      let sent = 0;
      while (sent + Buffer.byteLength(chunk) <= MAX_STDOUT_CAPTURE_BYTES) {
        child.stdout.emit("data", chunk);
        sent += Buffer.byteLength(chunk);
      }
      expect(child.signals).toEqual([]);
      child.stdout.emit("data", chunk);

      expect(await outcome).toBeInstanceOf(CanaryExecutionFailedError);
      expect(child.signals).toEqual(["SIGTERM"]);
    });
  });

  describe("settling", () => {
    it("settles once when the child errors and then closes", async () => {
      const { child, pending } = start();

      child.emit("error", new Error("spawn failed"));
      child.emit("close", 0, null);

      await expect(pending).rejects.toThrow(CanaryExecutionFailedError);
      await expect(pending).rejects.toThrow("Failed to start fake-canary: spawn failed");
    });

    it("keeps the first exit when close is emitted twice", async () => {
      const { child, pending } = start();

      child.stdout.emit("data", "first");
      child.emit("close", 3, null);
      child.stdout.emit("data", "late");
      child.emit("close", 0, null);

      const result = await pending;
      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe("first");
    });
  });
});
