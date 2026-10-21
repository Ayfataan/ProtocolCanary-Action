import type * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CanaryExecutionFailedError, TimeoutError } from "../../src/errors";
import type { ActionInputs } from "../../src/inputs";
import {
  MAX_STDERR_CAPTURE_BYTES,
  STDERR_DROPPED_NOTICE,
  buildCheckArgs,
  engineSupportsAllowEmpty,
  extractDiagnostic,
  runCheck,
} from "../../src/runner";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

// Most tests exercise the real mock-canary fixture, so `spawn` defaults to a
// pass-through of the real implementation; the timeout-escalation tests below
// swap in a fake child via `mockImplementationOnce`.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  spawnMock.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnMock };
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
  rpcUrl: undefined,
  fixturesDir: "fixtures",
  version: "0.1.0",
  uploadReport: true,
  annotations: true,
  timeoutMinutes: 15,
  allowEmpty: false,
  fixturesPackVersion: undefined,
  fixturesPackProtocol: undefined,
  githubToken: undefined,
  generateReceipt: false,
  strictIntegrity: false,
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

  it("never concatenates arguments into a single string (command-injection defense)", () => {
    const args = buildCheckArgs({ ...BASE_INPUTS, network: "testnet; rm -rf /" });
    // The dangerous value must appear as exactly one array element, never
    // merged with adjacent flags or split by the shell.
    expect(args).toContain("testnet; rm -rf /");
    expect(args.some((a) => a.includes("--network testnet"))).toBe(false);
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
    expect(diagnostic.startsWith("error: ")).toBe(true);
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
