import { MAX_API_RESPONSE_BYTES, MAX_CHECKSUM_MANIFEST_BYTES, MAX_RELEASE_ASSET_BYTES } from "../../src/http-response";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import type * as osModule from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

const cacheMocks = vi.hoisted(() => ({
  isFeatureAvailableMock: vi.fn(),
  restoreCacheMock: vi.fn(),
  saveCacheMock: vi.fn(),
}));

const coreMocks = vi.hoisted(() => ({
  infoMock: vi.fn(),
  debugMock: vi.fn(),
  warningMock: vi.fn(),
  startGroupMock: vi.fn(),
  endGroupMock: vi.fn(),
  addPathMock: vi.fn(),
}));

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

// The GitHub REST calls made while looking up a published checksum are
// stubbed too: no test in this file may hit the network.
const httpsGetMock = vi.hoisted(() => vi.fn());

// `node:os` is mocked (spreading the real module, overriding only `homedir`)
// so the `cargoBinDir` home-directory fallback can be observed against a
// sentinel instead of the runner's real home, which varies by machine.
const osMocks = vi.hoisted(() => ({ homedirMock: vi.fn() }));

// `@actions/cache` and `@actions/core` are also mocked so every test in
// this file is offline and deterministic: no GitHub cache service, no Rust
// toolchain, and no real `stellar-canary` binary is ever needed (see the
// issue's "fully mocked" requirement).
vi.mock("@actions/cache", () => ({
  isFeatureAvailable: cacheMocks.isFeatureAvailableMock,
  restoreCache: cacheMocks.restoreCacheMock,
  saveCache: cacheMocks.saveCacheMock,
}));

vi.mock("@actions/core", () => ({
  info: coreMocks.infoMock,
  debug: coreMocks.debugMock,
  warning: coreMocks.warningMock,
  startGroup: coreMocks.startGroupMock,
  endGroup: coreMocks.endGroupMock,
  addPath: coreMocks.addPathMock,
}));

// Every child process the install chain supervises — the version probes,
// `cargo --version`, `tar`, and `cargo install` — runs through the bounded
// `runCheck` runner, which spawns directly (#521). The spawn is mocked
// here: the real-process timeout behavior of `runCheck` is covered by
// runner.test.ts against the mock-canary fixture; these tests only assert
// what `ensureCanaryInstalled` passes to it and how it interprets the
// outcome.
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("node:https", () => ({
  get: httpsGetMock,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>();
  return { ...actual, homedir: osMocks.homedirMock };
});

import {
  ENGINE_ENV_PASSTHROUGH_HINT,
  httpsGetText,
  httpsGetFile,
  installPrebuiltRelease,
  cargoInstallTimeoutMs,
  ensureCanaryInstalled,
  ensureVerifiedPack,
  packCacheKey,
  prebuiltTargetTriple,
} from "../../src/canary";
import { CARGO_INSTALL_TIMEOUT_FLOOR_MS } from "../../src/runner";
import { CanaryNotFoundError, InstallationFailedError, InvalidInputError } from "../../src/errors";
import { REDACTED } from "../../src/redact";
import type { ResolvedVersion } from "../../src/version";
import { CANARY_API_REPO_URL, CANARY_REPO_URL } from "../../src/version";

const RESOLVED: ResolvedVersion = { version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" };

/** A spawn result that closes immediately with the given exit code. */
class ImmediateChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(exitCode: number, stdoutText = "", stderrText = "") {
    super();
    if (stdoutText !== "") {
      this.stdout.write(stdoutText);
    }
    this.stdout.end();
    if (stderrText !== "") {
      this.stderr.write(stderrText);
    }
    this.stderr.end();
    setImmediate(() => this.emit("close", exitCode, null));
  }

  kill(): boolean {
    return true;
  }
}

/** A spawn result that stays alive until it is signalled (a "hung install"). */
class HungChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];

  /** Whether the fake process exits in response to `SIGTERM` (rather than ignoring it). */
  constructor(private readonly exitsOnSigterm: boolean, stdoutText = "", stderrText = "") {
    super();
    if (stdoutText !== "") {
      this.stdout.write(stdoutText);
    }
    if (stderrText !== "") {
      this.stderr.write(stderrText);
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    const exits = this.exitsOnSigterm ? signal === "SIGTERM" : signal === "SIGKILL";
    if (exits) {
      this.stdout.end();
      this.stderr.end();
      this.emit("close", null, signal);
    }
    return true;
  }
}

/** A spawn result that fails to start, as when the binary is missing or
 * not executable (`spawn` emits `error` instead of `close`). */
class SpawnErrorChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(message: string) {
    super();
    setImmediate(() => this.emit("error", new Error(message)));
  }

  kill(): boolean {
    return true;
  }
}

/** Routes one mocked spawn call to the stand-in child for the command the
 * bounded runner supervises (#521): `cargo --version`, `tar`, the
 * `<binary> version` probe, and `cargo install`. Handlers are optional;
 * unset commands fall back to a promptly-exiting success child. */
function routedSpawn(
  command: string,
  args: readonly string[],
  handlers: {
    cargoVersion?: () => ChildProcess;
    tar?: (tarArgs: readonly string[]) => ChildProcess;
    version?: () => ChildProcess;
    install?: () => ChildProcess;
  },
): ChildProcess {
  if (command === "cargo" && args[0] === "--version") {
    return handlers.cargoVersion?.() ?? (new ImmediateChild(0, "cargo 1.0.0\n") as unknown as ChildProcess);
  }
  if (command === "tar") {
    return handlers.tar?.(args) ?? (new ImmediateChild(0) as unknown as ChildProcess);
  }
  if (args[0] === "version") {
    return handlers.version?.() ?? (new ImmediateChild(0, "stellar-canary 0.1.0\n") as unknown as ChildProcess);
  }
  return handlers.install?.() ?? (new ImmediateChild(0) as unknown as ChildProcess);
}

/** Whether any mocked spawn call ran `cargo install` (as opposed to a
 * probe or extraction the bounded runner also supervises). */
function cargoInstallSpawned(): boolean {
  return spawnMock.mock.calls.some(
    (call) => call[0] === "cargo" && Array.isArray(call[1]) && (call[1] as string[])[0] === "install",
  );
}

describe("cargoInstallTimeoutMs", () => {
  it("derives the bound from timeout-minutes", () => {
    expect(cargoInstallTimeoutMs(15)).toBe(15 * 60_000);
    expect(cargoInstallTimeoutMs(1)).toBe(60_000);
  });

  it("floors the bound at one minute so a tiny check timeout cannot break installs", () => {
    expect(cargoInstallTimeoutMs(0)).toBe(CARGO_INSTALL_TIMEOUT_FLOOR_MS);
    // Fractional minutes would never come from the validated input, but the
    // floor must hold regardless.
    expect(cargoInstallTimeoutMs(0.5)).toBe(CARGO_INSTALL_TIMEOUT_FLOOR_MS);
  });
});

// Sentinel home served by the os.homedir mock: any path that reached
// cargoBinDir's homedir fallback would contain this marker rather than the
// runner's real home, which varies by machine.
const FAKE_HOME = path.join(os.tmpdir(), "protocolcanary-not-the-real-home");

/** The binary name binaryName() picks on the runner this suite executes on. */
function platformBinaryName(): string {
  return process.platform === "win32" ? "stellar-canary.exe" : "stellar-canary";
}

/**
 * Overrides `process.platform` for the duration of `run`, awaiting an async
 * body so the override spans the whole awaited execution (a synchronous
 * try/finally would restore the value as soon as `run` returned its pending
 * promise, before the body finished). On Node >= 20 `process.platform` is a
 * non-writable but configurable data property, so
 * `vi.spyOn(process, "platform", "get")` cannot be used; redefine it and
 * always restore, even when the body throws.
 */
async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T> | T): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true, enumerable: true, writable: false });
  try {
    return await run();
  } finally {
    if (original !== undefined) {
      Object.defineProperty(process, "platform", original);
    }
  }
}

class FakeResponse extends EventEmitter {
  destroy(): void { this.emit("close"); }
  pause(): void {}
  statusCode: number;
  headers: Record<string, string> = {};
  constructor(statusCode: number) {
    super();
    this.statusCode = statusCode;
  }
  setEncoding(): void {
    /* no-op for this fake */
  }
  resume(): void {
    /* no-op for this fake */
  }
}

class FakeRequest extends EventEmitter {
  destroy(error?: Error): void {
    if (error) {
      this.emit("error", error);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function respond(statusCode: number, body: string): any {
  return (_url: string, _options: unknown, callback: (response: FakeResponse) => void) => {
    const response = new FakeResponse(statusCode);
    const request = new FakeRequest();
    callback(response);
    queueMicrotask(() => {
      response.emit("data", body);
      response.emit("end");
    });
    return request;
  };
}

function simulateRequestTimeout(): FakeRequest {
  const request = new FakeRequest();
  queueMicrotask(() => request.emit("timeout"));
  return request;
}

/** Serves a checksum manifest listing and the manifest itself. */
function mockPublishedChecksums(manifest: string): void {
  httpsGetMock
    .mockImplementationOnce(
      respond(
        200,
        JSON.stringify({
          assets: [{ name: "SHA256SUMS", browser_download_url: "https://example.test/SHA256SUMS" }],
        }),
      ),
    )
    .mockImplementationOnce(respond(200, manifest));
}

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeCachedFiles(paths: string[], contents = "cached binary"): void {
  const binary = paths[0];
  const sidecar = paths[1];
  if (binary === undefined || sidecar === undefined) {
    throw new Error("cache restore did not receive the binary and digest sidecar paths");
  }
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, contents, { mode: 0o755 });
  fs.writeFileSync(sidecar, `${sha256(binary)}\n`, { mode: 0o600 });
}

describe("ensureCanaryInstalled", () => {
  let tempCargoHome: string;
  let originalCargoHome: string | undefined;
  let originalRunnerTemp: string | undefined;
  let versionProbeResults: string[];
  let versionProbeExitCode: number;
  let cargoVersionFails: boolean;

  function binaryPath(): string {
    const binary = path.join(tempCargoHome, "stellar-canary-action", "bin", platformBinaryName());
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    return binary;
  }

  function cargoBinaryPath(): string {
    return path.join(tempCargoHome, "bin", platformBinaryName());
  }

  function writeInstalledBinary(contents = "binary"): string {
    const binary = binaryPath();
    fs.writeFileSync(binary, contents, { mode: 0o755 });
    fs.writeFileSync(path.join(path.dirname(binary), "stellar-canary.sha256"), `${sha256(binary)}\n`, {
      mode: 0o600,
    });
    return binary;
  }

  /** The `cargo install` argument array from the single install spawn. */
  function installArgs(): readonly string[] {
    const call = spawnMock.mock.calls.find(
      (call) => call[0] === "cargo" && (call[1] as string[])[0] === "install",
    );
    if (call === undefined) {
      throw new Error("cargo install was never spawned");
    }
    return call[1] as readonly string[];
  }

  beforeEach(() => {
    tempCargoHome = fs.mkdtempSync(path.join(os.tmpdir(), "canary-cargo-home-"));
    fs.mkdirSync(path.join(tempCargoHome, "bin"), { recursive: true });
    originalCargoHome = process.env.CARGO_HOME;
    originalRunnerTemp = process.env.RUNNER_TEMP;
    process.env.CARGO_HOME = tempCargoHome;
    process.env.RUNNER_TEMP = tempCargoHome;

    versionProbeResults = [];
    versionProbeExitCode = 0;
    cargoVersionFails = false;

    cacheMocks.isFeatureAvailableMock.mockReset().mockReturnValue(false);
    cacheMocks.restoreCacheMock.mockReset().mockResolvedValue(undefined);
    cacheMocks.saveCacheMock.mockReset().mockResolvedValue(undefined);
    // No test in this file depends on the runner's real home directory:
    // anything reaching the homedir fallback without overriding the mock
    // sees a sentinel that must not leak into a CARGO_HOME-based path.
    osMocks.homedirMock.mockReset().mockReturnValue(FAKE_HOME);
    coreMocks.infoMock.mockReset();
    coreMocks.debugMock.mockReset();
    coreMocks.warningMock.mockReset();

    // No checksum release by default: every lookup degrades gracefully.
    httpsGetMock.mockReset();
    httpsGetMock.mockImplementation(respond(404, ""));

    spawnMock.mockReset();
    // Default routed surface (#521): `cargo --version` succeeds (or fails
    // on demand), version probes answer from `versionProbeResults`, and any
    // other spawn — i.e. `cargo install` — exits immediately and cleanly.
    spawnMock.mockImplementation((command: string, args: string[] = []) =>
      routedSpawn(command, args, {
        install: () => {
          writeInstalledBinary();
          return new ImmediateChild(0) as unknown as ChildProcess;
        },
        cargoVersion: () => {
          if (cargoVersionFails) {
            return new SpawnErrorChild("cargo: command not found") as unknown as ChildProcess;
          }
          return new ImmediateChild(0, "cargo 1.0.0\n") as unknown as ChildProcess;
        },
        version: () =>
          new ImmediateChild(
            versionProbeExitCode,
            `stellar-canary ${versionProbeResults.shift() ?? "0.1.0"}\n`,
          ) as unknown as ChildProcess,
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalCargoHome === undefined) {
      delete process.env.CARGO_HOME;
    } else {
      process.env.CARGO_HOME = originalCargoHome;
    }
    if (originalRunnerTemp === undefined) {
      delete process.env.RUNNER_TEMP;
    } else {
      process.env.RUNNER_TEMP = originalRunnerTemp;
    }
    fs.rmSync(tempCargoHome, { recursive: true, force: true });
  });

  it("does not select a pre-existing binary from the shared Cargo bin directory", async () => {
    fs.writeFileSync(cargoBinaryPath(), "user binary");

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed).toEqual({ binaryPath: binaryPath(), version: "0.1.0" });
    // The shared Cargo binary is ignored and a private install is performed.
    expect(cargoInstallSpawned()).toBe(true);
    expect(cacheMocks.restoreCacheMock).not.toHaveBeenCalled();
  });

  it("emits a deprecation warning for an engine strictly older than 0.1.0 (#374)", async () => {
    writeInstalledBinary();
    versionProbeResults = ["0.0.9"];

    await ensureCanaryInstalled({ version: "0.0.9", tag: "v0.0.9", commitSha: "abc123" });

    expect(coreMocks.warningMock).toHaveBeenCalledTimes(1);
    expect(coreMocks.warningMock).toHaveBeenCalledWith(expect.stringContaining("older than 0.1.0"));
  });

  it("does not warn about the default engine version 0.1.1 (#374)", async () => {
    writeInstalledBinary();
    versionProbeResults = ["0.1.1"];

    await ensureCanaryInstalled({ version: "0.1.1", tag: "v0.1.1", commitSha: "abc123" });

    expect(coreMocks.warningMock).not.toHaveBeenCalled();
  });

  it("does not reuse an already-installed binary with a different version", async () => {
    writeInstalledBinary();
    // The first version probe (the already-installed binary) reports a
    // stale version; after reinstalling, the probe reports the requested one.
    versionProbeResults = ["0.0.9", "0.1.0"];

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed).toEqual({ binaryPath: binaryPath(), version: "0.1.0" });
    expect(installArgs()[0]).toBe("install");
  });

  it("installs via a spawned `cargo install` through the bounded runner", async () => {
    await ensureCanaryInstalled(RESOLVED);

    expect(installArgs()).toEqual([
      "install",
      "--git",
      CANARY_REPO_URL,
      "--locked",
      "--root",
      path.join(tempCargoHome, "stellar-canary-action"),
      "--rev",
      "abc123",
      "canary-cli",
    ]);
    // The install goes through the bounded runner, which spawns it directly
    // (no shell); every other helper process does too (#521).
    expect(coreMocks.warningMock).not.toHaveBeenCalled();
  });

  // #433: both cargo children (the `--version` probe and the source build)
  // run with exactly the filtered environment the caller supplies — never
  // `process.env`. `runCheck`'s own process-level proof lives in
  // runner.test.ts; this pins the wiring from ensureCanaryInstalled.
  it("runs the cargo version probe and cargo install with the supplied child environment", async () => {
    const childEnv = {
      PATH: process.env.PATH ?? "/usr/bin",
      CARGO_HOME: tempCargoHome,
      LD_LIBRARY_PATH: "/opt/lib",
    };

    await ensureCanaryInstalled(RESOLVED, 60_000, undefined, false, childEnv);

    const probe = spawnMock.mock.calls.find(
      (call) => call[0] === "cargo" && (call[1] as string[])[0] === "--version",
    );
    expect(probe?.[2]).toMatchObject({ env: childEnv });

    const install = spawnMock.mock.calls.find(
      (call) => call[0] === "cargo" && (call[1] as string[])[0] === "install",
    );
    expect(install?.[2]).toMatchObject({ env: childEnv });
  });

  it("installs with `--tag <tag>` and warns when the commit could not be resolved", async () => {
    await ensureCanaryInstalled({ ...RESOLVED, commitSha: undefined });

    expect(installArgs()).toEqual([
      "install",
      "--git",
      CANARY_REPO_URL,
      "--locked",
      "--root",
      path.join(tempCargoHome, "stellar-canary-action"),
      "--tag",
      "v0.1.0",
      "canary-cli",
    ]);
    expect(coreMocks.warningMock).toHaveBeenCalledWith(expect.stringContaining("installing from the tag directly"));
  });

  it("builds the cache key from the resolved pin and the runner platform", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);

    await ensureCanaryInstalled(RESOLVED);

    expect(cacheMocks.restoreCacheMock).toHaveBeenCalledWith(
      [binaryPath(), path.join(path.dirname(binaryPath()), "stellar-canary.sha256")],
      `stellar-canary-${process.platform}-${process.arch}-abc123`,
    );
    expect(cacheMocks.saveCacheMock).toHaveBeenCalledWith(
      [binaryPath(), path.join(path.dirname(binaryPath()), "stellar-canary.sha256")],
      `stellar-canary-${process.platform}-${process.arch}-abc123`,
    );
  });

  // #228: cacheKeyFor is private and zero-argument; its only real branch is
  // the `commitSha ?? tag` precedence. Pinned through the cache key it hands
  // to restore/save — the observable surface it drives — so a regression
  // that let the tag win could never slip through: two different commits
  // under a moving tag would silently share (and poison) one cache entry.
  it("prefers commitSha over tag for the cache key, even when both are present (#228)", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);

    // RESOLVED carries both a tag and a commitSha: the SHA must win.
    await ensureCanaryInstalled(RESOLVED);

    const expected = `stellar-canary-${process.platform}-${process.arch}-abc123`;
    const cachePaths = [binaryPath(), path.join(path.dirname(binaryPath()), "stellar-canary.sha256")];
    expect(cacheMocks.restoreCacheMock).toHaveBeenCalledWith(cachePaths, expected);
    expect(cacheMocks.saveCacheMock).toHaveBeenCalledWith(cachePaths, expected);
    // And the tag must not leak into either key at all.
    for (const call of [...cacheMocks.restoreCacheMock.mock.calls, ...cacheMocks.saveCacheMock.mock.calls]) {
      expect(call[1]).not.toContain("v0.1.0");
    }
  });

  it("falls back to the tag for the cache key when commitSha is absent (#228)", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);

    await ensureCanaryInstalled({ ...RESOLVED, commitSha: undefined });

    const expected = `stellar-canary-${process.platform}-${process.arch}-v0.1.0`;
    const cachePaths = [binaryPath(), path.join(path.dirname(binaryPath()), "stellar-canary.sha256")];
    expect(cacheMocks.restoreCacheMock).toHaveBeenCalledWith(cachePaths, expected);
    expect(cacheMocks.saveCacheMock).toHaveBeenCalledWith(cachePaths, expected);
  });

  it("ignores a cache hit whose binary has the wrong version", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
    cacheMocks.restoreCacheMock.mockImplementationOnce(async (paths: string[]) => {
      writeCachedFiles(paths);
      return "cache-key";
    });
    versionProbeResults = ["0.0.9", "0.1.0"];

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.version).toBe("0.1.0");
    expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("did not produce a matching"));
    expect(installArgs()[0]).toBe("install");
  });

  it("continues without the cache when restoring it fails", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
    cacheMocks.restoreCacheMock.mockRejectedValue(new Error("cache service unavailable"));

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.version).toBe("0.1.0");
    expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("Cache restore failed"));
    expect(installArgs()[0]).toBe("install");
  });

  it("rejects with InstallationFailedError when cargo is unavailable", async () => {
    cargoVersionFails = true;

    await expect(ensureCanaryInstalled(RESOLVED)).rejects.toThrow(InstallationFailedError);
    expect(cargoInstallSpawned()).toBe(false);

    try {
      await ensureCanaryInstalled(RESOLVED);
    } catch (error) {
      expect(error).toBeInstanceOf(InstallationFailedError);
      const message = (error as InstallationFailedError).message;
      expect(message).toContain("The `cargo` command was not found on this runner");
      expect(message).toContain("dtolnay/rust-toolchain");
    }
  });

  it("rejects when `cargo install` exits non-zero and includes stderr diagnostics in the error and log group", async () => {
    const stderrLines = Array.from({ length: 50 }, (_, i) => `cargo error line ${i + 1}`).join("\n");
    spawnMock.mockImplementation((command: string, args: string[] = []) =>
      routedSpawn(command, args, {
        install: () => new ImmediateChild(101, "compiling deps", stderrLines) as unknown as ChildProcess,
      }),
    );

    let caughtError: InstallationFailedError | undefined;
    try {
      await ensureCanaryInstalled(RESOLVED);
    } catch (err) {
      caughtError = err as InstallationFailedError;
    }

    expect(caughtError).toBeInstanceOf(InstallationFailedError);
    expect(caughtError?.message).toContain("`cargo install` exited with code 101");
    // Bounded to last 40 lines
    expect(caughtError?.message).toContain("cargo error line 50");
    expect(caughtError?.message).toContain("cargo error line 11");
    expect(caughtError?.message).not.toContain("cargo error line 10\n");
    expect(caughtError?.message).toContain("[... earlier output truncated ...]");
    expect(caughtError?.diagnostic).toBeDefined();

    // Checked that log blocks were printed
    expect(coreMocks.startGroupMock).toHaveBeenCalledWith("Cargo stdout");
    expect(coreMocks.startGroupMock).toHaveBeenCalledWith("Cargo stderr");
    expect(coreMocks.endGroupMock).toHaveBeenCalledTimes(2);
  });

  it("redacts secrets and removes ANSI escape sequences and control characters from cargo diagnostics", async () => {
    const dirtyStderr = [
      "\x1B[31;1merror[E0425]:\x1B[0m cannot find value `foo`\r",
      "failed with secret seed: SB3W52UQNPILTKJE752GYUDO7PXFYS7PBY4CL5NZW5DXRBG5G3EK7R3N\r",
      "attempted workflow command: ::error::malicious annotation\r",
    ].join("\n");
    spawnMock.mockImplementation((command: string, args: string[] = []) =>
      routedSpawn(command, args, {
        install: () => new ImmediateChild(101, "", dirtyStderr) as unknown as ChildProcess,
      }),
    );

    let caughtError: InstallationFailedError | undefined;
    try {
      await ensureCanaryInstalled(RESOLVED);
    } catch (err) {
      caughtError = err as InstallationFailedError;
    }

    expect(caughtError).toBeInstanceOf(InstallationFailedError);
    const msg = caughtError!.message;

    // ANSI stripped
    expect(msg).not.toContain("\x1B[31;1m");
    expect(msg).toContain("error[E0425]: cannot find value \\`foo\\`");
    // \r removed
    expect(msg).not.toContain("\r");
    // Seed redacted
    expect(msg).not.toContain("SB3W52UQNPILTKJE752GYUDO7PXFYS7PBY4CL5NZW5DXRBG5G3EK7R3N");
    expect(msg).toContain(REDACTED);
    // Command neutralized
    expect(msg).not.toContain("::error::");
    expect(msg).toContain("\\:\\:error\\:\\:");
  });

  it("caps cargo error diagnostic at 8 KiB and includes truncation notice", async () => {
    const hugeStderr = "error: " + "a".repeat(20_000);
    spawnMock.mockImplementation((command: string, args: string[] = []) =>
      routedSpawn(command, args, {
        install: () => new ImmediateChild(101, "", hugeStderr) as unknown as ChildProcess,
      }),
    );

    let caughtError: InstallationFailedError | undefined;
    try {
      await ensureCanaryInstalled(RESOLVED);
    } catch (err) {
      caughtError = err as InstallationFailedError;
    }

    expect(caughtError).toBeInstanceOf(InstallationFailedError);
    expect(caughtError?.diagnostic).toBeDefined();
    expect(Buffer.byteLength(caughtError!.diagnostic!, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(caughtError!.diagnostic).toContain("[... earlier output truncated ...]");
  });

  describe("install diagnostic limits (#513)", () => {
    const NOTICE = "[... earlier output truncated ...]\n";
    const stderrLines = (count: number): string[] =>
      Array.from({ length: count }, (_, i) => `cargo error line ${String(i + 1).padStart(3, "0")}`);

    async function installFailure(): Promise<InstallationFailedError> {
      try {
        await ensureCanaryInstalled(RESOLVED);
      } catch (error) {
        expect(error).toBeInstanceOf(InstallationFailedError);
        return error as InstallationFailedError;
      }
      throw new Error("expected the install to fail");
    }

    it("keeps exactly the last 40 of 100 stderr lines in the message and in the diagnostic", async () => {
      const lines = stderrLines(100);
      spawnMock.mockImplementation((command: string, args: string[] = []) =>
        routedSpawn(command, args, { install: () => new ImmediateChild(101, "", lines.join("\n")) as unknown as ChildProcess }),
      );

      const error = await installFailure();

      const expectedTail = `${NOTICE}${lines.slice(-40).join("\n")}`;
      expect(error.diagnostic).toBe(expectedTail);
      expect(error.message).toBe(
        `\`cargo install\` exited with code 101 while installing Protocol-Canary ${RESOLVED.version}. ` +
          `${ENGINE_ENV_PASSTHROUGH_HINT}\n\n${expectedTail}`,
      );
      expect(error.diagnostic).toContain("cargo error line 100");
      expect(error.diagnostic).toContain("cargo error line 061");
      expect(error.diagnostic).not.toContain("cargo error line 060");
    });

    it("does not truncate 40 stderr lines but truncates 41", async () => {
      const forty = stderrLines(40);
      spawnMock.mockImplementation((command: string, args: string[] = []) =>
        routedSpawn(command, args, { install: () => new ImmediateChild(101, "", forty.join("\n")) as unknown as ChildProcess }),
      );
      expect((await installFailure()).diagnostic).toBe(forty.join("\n"));

      const fortyOne = stderrLines(41);
      spawnMock.mockImplementation((command: string, args: string[] = []) =>
        routedSpawn(command, args, { install: () => new ImmediateChild(101, "", fortyOne.join("\n")) as unknown as ChildProcess }),
      );
      expect((await installFailure()).diagnostic).toBe(`${NOTICE}${fortyOne.slice(1).join("\n")}`);
    });

    it("keeps 8192 bytes of stderr whole and cuts 8193 to exactly 8192 bytes ending with the last character", async () => {
      spawnMock.mockImplementation((command: string, args: string[] = []) =>
        routedSpawn(command, args, { install: () => new ImmediateChild(101, "", "e".repeat(8192)) as unknown as ChildProcess }),
      );
      expect((await installFailure()).diagnostic).toBe("e".repeat(8192));

      spawnMock.mockImplementation((command: string, args: string[] = []) =>
        routedSpawn(command, args, { install: () => new ImmediateChild(101, "", `${"e".repeat(8192)}Z`) as unknown as ChildProcess }),
      );
      const diagnostic = (await installFailure()).diagnostic!;
      expect(Buffer.byteLength(diagnostic, "utf8")).toBe(8192);
      expect(diagnostic.startsWith(NOTICE)).toBe(true);
      expect(diagnostic.endsWith("eZ")).toBe(true);
    });

    it("applies the same limits when the install times out", async () => {
      const lines = stderrLines(100);
      spawnMock.mockImplementation((command: string, args: string[] = []) =>
        routedSpawn(command, args, { install: () => new HungChild(true, "", lines.join("\n")) as unknown as ChildProcess }),
      );

      let caught: InstallationFailedError | undefined;
      try {
        await ensureCanaryInstalled(RESOLVED, 20);
      } catch (error) {
        caught = error as InstallationFailedError;
      }

      expect(caught).toBeInstanceOf(InstallationFailedError);
      expect(caught?.message).toContain("timed out");
      expect(caught?.diagnostic).toBe(`${NOTICE}${lines.slice(-40).join("\n")}`);
    });
  });

  it("prints nothing new to log groups on successful cargo install", async () => {
    spawnMock.mockImplementation((command: string, args: string[] = []) =>
      routedSpawn(command, args, {
        install: () => {
          writeInstalledBinary();
          return new ImmediateChild(0) as unknown as ChildProcess;
        },
      }),
    );

    await ensureCanaryInstalled(RESOLVED);

    expect(coreMocks.startGroupMock).not.toHaveBeenCalled();
    expect(coreMocks.endGroupMock).not.toHaveBeenCalled();
  });

  it("rejects with CanaryNotFoundError when no working binary appears after install", async () => {
    versionProbeExitCode = 1;

    await expect(ensureCanaryInstalled(RESOLVED)).rejects.toThrow(CanaryNotFoundError);
  });

  it("does not touch the cache at all when the cache feature is unavailable", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(false);

    await ensureCanaryInstalled(RESOLVED);

    expect(cacheMocks.restoreCacheMock).not.toHaveBeenCalled();
    expect(cacheMocks.saveCacheMock).not.toHaveBeenCalled();
  });

  it("verifies an installed binary against its published checksum", async () => {
    writeInstalledBinary();
    mockPublishedChecksums(`${sha256(binaryPath())}  stellar-canary\n`);

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.binaryPath).toBe(binaryPath());
    expect(httpsGetMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 503 checksum manifest lookup and still verifies the checksum", async () => {
    writeInstalledBinary();
    let manifestCalls = 0;
    httpsGetMock.mockImplementation((url: string, _options: unknown, callback: (response: FakeResponse) => void) => {
      const request = new FakeRequest();
      if (url === `${CANARY_API_REPO_URL}/releases/tags/v${RESOLVED.version}`) {
        const response = new FakeResponse(200);
        callback(response);
        queueMicrotask(() => {
          response.emit("data", JSON.stringify({
            assets: [{ name: "SHA256SUMS", browser_download_url: "https://example.test/SHA256SUMS" }],
          }));
          response.emit("end");
        });
        return request;
      }
      manifestCalls += 1;
      if (manifestCalls === 1) {
        const response = new FakeResponse(503);
        queueMicrotask(() => callback(response));
        return request;
      }
      const response = new FakeResponse(200);
      callback(response);
      queueMicrotask(() => {
        response.emit("data", `${sha256(binaryPath())}  stellar-canary\n`);
        response.emit("end");
      });
      return request;
    });

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.binaryPath).toBe(binaryPath());
    expect(httpsGetMock).toHaveBeenCalledTimes(3);
    expect(manifestCalls).toBe(2);
    expect(coreMocks.warningMock).not.toHaveBeenCalled();
  });

  it("ignores an oversized checksum manifest rather than verifying its partial prefix (#500)", async () => {
    writeInstalledBinary();
    mockPublishedChecksums(`${"0".repeat(64)}  stellar-canary\n${" ".repeat(MAX_CHECKSUM_MANIFEST_BYTES)}`);
    const installed = await ensureCanaryInstalled(RESOLVED);
    expect(installed.binaryPath).toBe(binaryPath());
    expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("1048576-byte limit"));
  });

  it("throws InstallationFailedError when the installed binary does not match the published checksum", async () => {
    writeInstalledBinary();
    mockPublishedChecksums(`${"0".repeat(64)}  stellar-canary\n`);

    await expect(ensureCanaryInstalled(RESOLVED)).rejects.toThrow(InstallationFailedError);
  });

  it("falls back to commit/tag pinning when no checksum manifest is published", async () => {
    writeInstalledBinary();
    // beforeEach's default mock returns 404 for every request, i.e. the
    // release carries no checksum asset — the current upstream reality.

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.binaryPath).toBe(binaryPath());
    expect(cargoInstallSpawned()).toBe(false);
    expect(httpsGetMock).toHaveBeenCalledOnce();
    expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("status 404"));
  });

  it("handles a redirected release lookup without an unhandled rejection", async () => {
    writeInstalledBinary();
    httpsGetMock.mockImplementationOnce(respond(302, ""));

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.binaryPath).toBe(binaryPath());
    expect(httpsGetMock).toHaveBeenCalledOnce();
    expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("status 302"));
    expect(cargoInstallSpawned()).toBe(false);
  });

  it("handles checksum lookup request timeouts and logs the target URL", async () => {
    writeInstalledBinary();
    httpsGetMock.mockImplementation((() => simulateRequestTimeout()) as never);

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.binaryPath).toBe(binaryPath());
    expect(httpsGetMock).toHaveBeenCalledTimes(3);
    expect(coreMocks.debugMock).toHaveBeenCalledWith(
      expect.stringContaining("timed out fetching https://api.github.com/repos/StellarCanary/Protocol-Canary/releases/tags/v0.1.0"),
    );
    expect(cargoInstallSpawned()).toBe(false);
  });

  it("falls back when the release response is malformed JSON", async () => {
    writeInstalledBinary();
    httpsGetMock.mockImplementationOnce(respond(200, "{not valid JSON"));

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.binaryPath).toBe(binaryPath());
    expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("Could not look up a published checksum"));
    expect(cargoInstallSpawned()).toBe(false);
  });

  it("ignores malformed checksum manifest entries", async () => {
    writeInstalledBinary();
    httpsGetMock
      .mockImplementationOnce(
        respond(
          200,
          JSON.stringify({
            assets: [{ name: "SHA256SUMS", browser_download_url: "https://example.test/SHA256SUMS" }],
          }),
        ),
      )
      .mockImplementationOnce(respond(200, `not-a-digest  ${platformBinaryName()}\n${"a".repeat(63)}  other-binary\n`));

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.binaryPath).toBe(binaryPath());
    expect(httpsGetMock).toHaveBeenCalledTimes(2);
    expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("No published checksum manifest"));
    expect(cargoInstallSpawned()).toBe(false);
  });

  it("attaches Authorization header only to api.github.com and not to release asset downloads", async () => {
    writeInstalledBinary();
    httpsGetMock
      .mockImplementationOnce(
        respond(
          200,
          JSON.stringify({
            assets: [
              {
                name: "SHA256SUMS",
                browser_download_url: "https://github.com/StellarCanary/Protocol-Canary/releases/download/v0.1.0/SHA256SUMS",
              },
            ],
          }),
        ),
      )
      .mockImplementationOnce(
        respond(200, `9a3a45d01531a20e89ac6ae10b0b0beb0492acd7216a368aa062d1a5fecaf9cd  ${platformBinaryName()}\n`),
      );

    await ensureCanaryInstalled(RESOLVED, undefined, "my-secret-token");

    expect(httpsGetMock).toHaveBeenCalledTimes(2);
    const call1Headers = (httpsGetMock.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> };
    const call2Headers = (httpsGetMock.mock.calls[1] as unknown[])[1] as { headers: Record<string, string> };

    expect(call1Headers.headers.Authorization).toBe("Bearer my-secret-token");
    expect(call2Headers.headers.Authorization).toBeUndefined();
  });

  // #273: selectExpectedChecksum filters to stellar-canary-named entries,
  // tries a platform+arch match, then a platform-only match, and otherwise
  // falls back to a single unambiguous candidate. With several
  // stellar-canary entries for *other* platforms and none for this runner's,
  // every branch falls through and the lookup returns undefined — which must
  // degrade to commit/tag pinning exactly like the no-entries-at-all case,
  // not fail the install. This pins that specific fallthrough.
  it("falls back to commit/tag pinning when the manifest names only other platforms' binaries (#273)", async () => {
    writeInstalledBinary();
    // Pick two platforms this runner is definitively not on, so neither a
    // platform+arch nor a platform-only match can succeed on any runner OS
    // the suite executes on. Recompute the pair from the actual
    // process.platform so every OS is excluded, not just linux (the CI
    // matrix also runs windows-latest, where "win32" must not be picked).
    const otherPlatforms = (["darwin", "linux", "win32"] as const).filter(
      (platform) => platform !== process.platform,
    );
    const manifest = [
      `${"a".repeat(64)}  stellar-canary-${otherPlatforms[0]}-x64`,
      `${"b".repeat(64)}  stellar-canary-${otherPlatforms[1]}-arm64`,
      "",
    ].join("\n");
    mockPublishedChecksums(manifest);

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed).toEqual({ binaryPath: binaryPath(), version: "0.1.0" });
    expect(cargoInstallSpawned()).toBe(false);
    // The degradation is deliberate, not silent luck: it is logged at debug.
    expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("no entry for this platform"));
  });

  // #275: parseChecksumManifest documents tolerance for the standard
  // sha256sum output format — `#` comment lines and the `*` binary-mode
  // marker before the file name — but nothing exercised either. Pinned
  // through the observable outcome: a manifest mixing comments and a
  // *-prefixed binary-mode entry must yield exactly that entry, and its
  // digest must be the one verification enforces.
  describe("#275 comments and binary-mode markers", () => {
    it("verifies against a manifest with comment lines and a *-prefixed binary-mode entry", async () => {
      writeInstalledBinary();
      // Exactly what real publishing tools emit: a header comment, the
      // GNU coreutils binary-mode form `digest *filename`, and a trailing
      // blank line.
      mockPublishedChecksums(
        `# SHA256 checksums for Protocol-Canary 0.1.0\n` +
          `${sha256(binaryPath())} *${platformBinaryName()}\n` +
          `\n`,
      );

      const installed = await ensureCanaryInstalled(RESOLVED);

      // Parsing succeeded (the *-entry was found and matched, so no
      // "no usable entry" fallback) and the digest is enforced: the
      // matching binary verifies instead of failing or being skipped.
      expect(installed).toEqual({ binaryPath: binaryPath(), version: "0.1.0" });
    });

    it("rejects a tampered binary when only a *-prefixed binary-mode entry is published", async () => {
      writeInstalledBinary("not-the-published-binary");
      mockPublishedChecksums(
        `# generated by release tooling\n${"d".repeat(64)} *${platformBinaryName()}\n`,
      );

      // The quoted digest from the binary-mode line proves the entry was
      // parsed from that line (and not from some fallback), so a parser
      // regression that silently dropped *-entries would fail here.
      const error = await ensureCanaryInstalled(RESOLVED).then(
        () => {
          throw new Error("expected ensureCanaryInstalled to reject");
        },
        (rejection: unknown) => rejection,
      );
      expect(error).toBeInstanceOf(InstallationFailedError);
      expect((error as InstallationFailedError).message).toContain("d".repeat(64));
    });
  });

  // #274: selectExpectedChecksum prefers a platform+arch match but falls
  // back to a platform-only one when the manifest names binaries per
  // platform without distinguishing architecture (e.g. a single
  // stellar-canary-linux entry). Pinned through the observable outcome:
  // the platform-only entry's checksum must be the one selected, so the
  // binary whose hash matches it verifies and a differently-hashed binary
  // still fails. A regression in the matching order — e.g. dropping the
  // platform-only tier — would show up as this verification silently
  // becoming a no-op debug log instead.
  describe("#274 platform-only manifest entry", () => {
    /** The entry name the mock manifest carries: this runner's actual
     * platform with an arch suffix that is never the real process.arch, so
     * the name matches the platform-only tier but not platform+arch. */
    function platformOnlyName(): string {
      const otherArch = process.arch === "arm64" ? "armv7" : "arm64";
      return `stellar-canary-${process.platform}-${otherArch}`;
    }

    /** A digest that cannot equal any real SHA-256 of the tiny fixture
     * binary — used to prove which manifest entry verification used. */
    function unrelatedChecksum(): string {
      return "c".repeat(64);
    }

    it("selects the platform-only entry's checksum and uses it for verification", async () => {
      writeInstalledBinary();
      mockPublishedChecksums(`${sha256(binaryPath())}  ${platformOnlyName()}\n`);

      const installed = await ensureCanaryInstalled(RESOLVED);

      // Resolving proves the platform-only entry's checksum was selected
      // and matched the binary. On its own this could also pass if the
      // selection became a no-op (commit/tag pinning, no verification),
      // which is exactly what the next test rules out.
      expect(installed).toEqual({ binaryPath: binaryPath(), version: "0.1.0" });
    });

    it("fails verification against the platform-only entry when the binary differs", async () => {
      writeInstalledBinary("not-the-published-binary");
      mockPublishedChecksums(`${unrelatedChecksum()}  ${platformOnlyName()}\n`);

      // Capture the rejection and assert on it (the checksum mocks are
      // single-shot, so the install must run exactly once). The unrelated
      // digest in the failure message is the proof that the platform-only
      // entry — not some other fallback — was selected.
      const error = await ensureCanaryInstalled(RESOLVED).then(
        () => {
          throw new Error("expected ensureCanaryInstalled to reject");
        },
        (rejection: unknown) => rejection,
      );
      expect(error).toBeInstanceOf(InstallationFailedError);
      expect((error as InstallationFailedError).message).toContain(unrelatedChecksum());
    });
  });

  it("anchors installs and cache paths under RUNNER_TEMP and leaves CARGO_HOME/bin untouched", async () => {
    process.env.CARGO_HOME = tempCargoHome;
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);

    await ensureCanaryInstalled(RESOLVED);

    const expectedPath = binaryPath();
    const paths = [expectedPath, path.join(path.dirname(expectedPath), "stellar-canary.sha256")];
    expect(cacheMocks.restoreCacheMock).toHaveBeenCalledWith(paths, expect.any(String));
    expect(cacheMocks.saveCacheMock).toHaveBeenCalledWith(paths, expect.any(String));
    expect(installArgs()).toContain(path.join(tempCargoHome, "stellar-canary-action"));
    expect(fs.existsSync(cargoBinaryPath())).toBe(false);
    expect(osMocks.homedirMock).not.toHaveBeenCalled();
  });

  it("uses the Windows executable suffix inside its private root", async () => {
    await withPlatform("win32", async () => {
      const installed = await ensureCanaryInstalled(RESOLVED);
      expect(installed.binaryPath).toBe(path.join(tempCargoHome, "stellar-canary-action", "bin", "stellar-canary.exe"));
      expect(installArgs()).toContain(path.join(tempCargoHome, "stellar-canary-action"));
    });
  });

  // #224: binaryName is private and zero-argument; its only branch is the
  // process.platform check ("stellar-canary.exe" on win32, "stellar-canary"
  // elsewhere). Pinned through the cache-path contract the same way, with
  // the platform overridden so both branches are covered on any runner OS.
  it("names the binary stellar-canary.exe when the platform is win32 (#224)", async () => {
    // The saved cache path is the observation point; enable the cache so
    // saveToCache actually runs (beforeEach disables it).
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
    let savedPath: string | undefined;
    await withPlatform("win32", async () => {
      await ensureCanaryInstalled(RESOLVED);
      const call = cacheMocks.saveCacheMock.mock.calls.at(-1);
      savedPath = (call?.[0] as string[] | undefined)?.[0];
    });

    expect(savedPath).toBe(path.join(tempCargoHome, "stellar-canary-action", "bin", "stellar-canary.exe"));
  });

  it("names the binary stellar-canary (no .exe) on non-win32 platforms (#224)", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
    for (const platform of ["linux", "darwin", "freebsd", "openbsd"] as const) {
      let savedPath: string | undefined;
      await withPlatform(platform, async () => {
        await ensureCanaryInstalled(RESOLVED);
        const call = cacheMocks.saveCacheMock.mock.calls.at(-1);
        savedPath = (call?.[0] as string[] | undefined)?.[0];
      });

      expect(savedPath).toBe(path.join(tempCargoHome, "stellar-canary-action", "bin", "stellar-canary"));
    }
  });

  // #354: Test binary cache restoration, cache misses, executable permissions,
  // and corrupted/empty cache fallback
  describe("cache restoration and fallback (#354)", () => {
    async function fallsBackAfterInvalidBinary(contents: string): Promise<void> {
      cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
      cacheMocks.restoreCacheMock.mockImplementationOnce(async (paths: string[]) => {
        writeCachedFiles(paths, contents);
        return "cache-hit-key";
      });
      spawnMock.mockImplementation((command: string, args: string[] = []) =>
        routedSpawn(command, args, {
          version: () =>
            fs.readFileSync(command, "utf8") !== "fresh binary"
              ? (new ImmediateChild(1) as unknown as ChildProcess)
              : (new ImmediateChild(0, `stellar-canary ${RESOLVED.version}\n`) as unknown as ChildProcess),
          install: () => {
            const binary = binaryPath();
            fs.mkdirSync(path.dirname(binary), { recursive: true });
            fs.writeFileSync(binary, "fresh binary", { mode: 0o755 });
            return new ImmediateChild(0) as unknown as ChildProcess;
          },
        }),
      );

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed).toEqual({ binaryPath: binaryPath(), version: RESOLVED.version });
      expect(installArgs()[0]).toBe("install");
      expect(fs.readFileSync(binaryPath(), "utf8")).toBe("fresh binary");
      expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("did not produce a matching"));
    }

    it("restores a binary from cache when cache hit occurs", async () => {
      cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
      cacheMocks.restoreCacheMock.mockImplementationOnce(async (paths: string[]) => {
        writeCachedFiles(paths);
        const restoredBinary = paths[0];
        if (restoredBinary !== undefined) {
          fs.chmodSync(restoredBinary, 0o755);
        }
        return "cache-hit-key";
      });

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed).toEqual({ binaryPath: binaryPath(), version: RESOLVED.version });
      expect(cacheMocks.restoreCacheMock).toHaveBeenCalledTimes(1);
      expect(cacheMocks.saveCacheMock).not.toHaveBeenCalled();
      expect(coreMocks.infoMock).toHaveBeenCalledWith(expect.stringContaining("Restored stellar-canary"));
      if (process.platform !== "win32") {
        expect(fs.statSync(binaryPath()).mode & 0o777).toBe(0o755);
      }
    });

    it("falls back to cargo install on cache miss", async () => {
      cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
      cacheMocks.restoreCacheMock.mockResolvedValueOnce(undefined);

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed.version).toBe("0.1.0");
      expect(cacheMocks.restoreCacheMock).toHaveBeenCalledTimes(1);
      expect(cacheMocks.saveCacheMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalled();
    });

    it("warns but succeeds when saving an installed binary to cache fails", async () => {
      cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
      cacheMocks.saveCacheMock.mockRejectedValueOnce(new Error("cache quota exceeded"));

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed).toEqual({ binaryPath: binaryPath(), version: RESOLVED.version });
      expect(cacheMocks.saveCacheMock).toHaveBeenCalledOnce();
      expect(coreMocks.warningMock).toHaveBeenCalledWith("Cache save failed, ignoring: Error: cache quota exceeded");
      expect(spawnMock).toHaveBeenCalled();
    });

    it("falls back to cargo install when restored binary is not executable", async () => {
      cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
      cacheMocks.restoreCacheMock.mockImplementationOnce(async (paths: string[]) => {
        writeCachedFiles(paths);
        const binary = paths[0];
        if (binary === undefined) {
          throw new Error("cache restore did not receive a binary path");
        }
        fs.chmodSync(binary, 0o644);
        return "cache-hit-key";
      });
      // firstVersionProbeReturns: result for the version check after cache restore
      // The cached binary exists but is not executable, so the probe throws
      let probeCallCount = 0;
      spawnMock.mockImplementation((command: string, args: string[] = []) =>
        routedSpawn(command, args, {
          version: () => {
            probeCallCount++;
            if (probeCallCount === 1) {
              // First probe (cached binary) fails to spawn - not executable
              return new SpawnErrorChild("ENOENT") as unknown as ChildProcess;
            }
            // Second probe (after fresh install) succeeds
            return new ImmediateChild(0, "stellar-canary 0.1.0\n") as unknown as ChildProcess;
          },
          install: () => {
            writeInstalledBinary();
            return new ImmediateChild(0) as unknown as ChildProcess;
          },
        }),
      );

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed.version).toBe("0.1.0");
      expect(spawnMock).toHaveBeenCalled();
      expect(cacheMocks.saveCacheMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to cargo install when the restored binary is empty", async () => {
      await fallsBackAfterInvalidBinary("");
    });

    it("falls back to cargo install when the restored binary is corrupted", async () => {
      await fallsBackAfterInvalidBinary("corrupted binary");
    });

    it("falls back to cargo install when cache restore throws", async () => {
      cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
      cacheMocks.restoreCacheMock.mockRejectedValue(new Error("cache restore failed"));

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed.version).toBe("0.1.0");
      expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("Cache restore failed"));
      expect(spawnMock).toHaveBeenCalled();
    });

    it("verifies checksum after restoring from cache", async () => {
      cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
      cacheMocks.restoreCacheMock.mockImplementationOnce(async (paths: string[]) => {
        writeCachedFiles(paths, "binary");
        return "cache-hit-key";
      });
      const expectedDigest = crypto.createHash("sha256").update("binary").digest("hex");
      mockPublishedChecksums(`${expectedDigest}  stellar-canary\n`);

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed.version).toBe("0.1.0");
      expect(httpsGetMock).toHaveBeenCalledTimes(2);
    });

    it("rejects corrupted cached binary that fails checksum verification", async () => {
      cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
      cacheMocks.restoreCacheMock.mockImplementationOnce(async (paths: string[]) => {
        writeCachedFiles(paths, "tampered-binary");
        return "cache-hit-key";
      });
      mockPublishedChecksums(`${"a".repeat(64)}  stellar-canary\n`);

      await expect(ensureCanaryInstalled(RESOLVED)).rejects.toThrow(InstallationFailedError);
      expect(coreMocks.debugMock).not.toHaveBeenCalledWith(expect.stringContaining("Cache restore failed"));
    });

    it.each([
      ["a modified cached binary", "tampered"],
      ["a cache entry without a sidecar", "missing"],
      ["a cache entry with an invalid digest", "invalid"],
    ])("reinstalls after rejecting %s", async (_description, fault) => {
      cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
      cacheMocks.restoreCacheMock.mockImplementationOnce(async (paths: string[]) => {
        writeCachedFiles(paths, "cached binary");
        const binary = paths[0];
        const sidecar = paths[1];
        if (binary === undefined || sidecar === undefined) {
          throw new Error("cache restore did not receive the binary and digest sidecar paths");
        }
        if (fault === "tampered") {
          fs.writeFileSync(binary, "modified binary");
        } else if (fault === "missing") {
          fs.rmSync(sidecar);
        } else {
          fs.writeFileSync(sidecar, "not-a-sha256-digest\n");
        }
        return "cache-hit-key";
      });

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed.binaryPath).toBe(binaryPath());
      expect(spawnMock).toHaveBeenCalled();
      expect(fs.readFileSync(binaryPath(), "utf8")).toBe("binary");
      expect(coreMocks.warningMock).toHaveBeenCalledWith(
        expect.stringContaining("Discarding cached stellar-canary"),
      );
      if (fault === "tampered") {
        const warning = String(coreMocks.warningMock.mock.calls[0]?.[0]);
        expect(warning).toContain("sidecar:");
        expect(warning).toContain("binary:");
      }
    });
  });
});

describe("ensureCanaryInstalled install timeout (issue #65)", () => {
  let tempCargoHome: string;
  let originalCargoHome: string | undefined;
  let originalRunnerTemp: string | undefined;

  beforeEach(() => {
    tempCargoHome = fs.mkdtempSync(path.join(os.tmpdir(), "canary-cargo-home-"));
    fs.mkdirSync(path.join(tempCargoHome, "bin"), { recursive: true });
    originalCargoHome = process.env.CARGO_HOME;
    originalRunnerTemp = process.env.RUNNER_TEMP;
    process.env.CARGO_HOME = tempCargoHome;
    process.env.RUNNER_TEMP = tempCargoHome;

    cacheMocks.isFeatureAvailableMock.mockReset().mockReturnValue(false);
    coreMocks.infoMock.mockReset();
    coreMocks.debugMock.mockReset();
    coreMocks.warningMock.mockReset();

    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalCargoHome === undefined) {
      delete process.env.CARGO_HOME;
    } else {
      process.env.CARGO_HOME = originalCargoHome;
    }
    if (originalRunnerTemp === undefined) {
      delete process.env.RUNNER_TEMP;
    } else {
      process.env.RUNNER_TEMP = originalRunnerTemp;
    }
    fs.rmSync(tempCargoHome, { recursive: true, force: true });
  });

  it("terminates a hung install at the given bound instead of hanging indefinitely", async () => {
    // The child stays alive (a hung `cargo install`) but exits on SIGTERM.
    const hung = new HungChild(true);
    spawnMock.mockImplementation((command: string, args: string[] = []) =>
      routedSpawn(command, args, {
        install: () => hung as unknown as ChildProcess,
      }),
    );

    const pending = ensureCanaryInstalled(RESOLVED, 20);

    await expect(pending).rejects.toThrow(InstallationFailedError);
    await pending.catch((error: InstallationFailedError) => {
      expect(error.message).toContain("timed out");
      expect(error.message).toContain("cargo install");
    });
    expect(hung.signals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when the hung install ignores SIGTERM", async () => {
    vi.useFakeTimers();
    const hung = new HungChild(false);
    spawnMock.mockImplementation((command: string, args: string[] = []) =>
      routedSpawn(command, args, {
        install: () => hung as unknown as ChildProcess,
      }),
    );

    const pending = ensureCanaryInstalled(RESOLVED, CARGO_INSTALL_TIMEOUT_FLOOR_MS);
    // Attach the rejection handler before advancing the fake clock, so the
    // rejection is never momentarily unhandled when the timer fires.
    const rejected = expect(pending).rejects.toThrow(InstallationFailedError);
    // Fake timers drive runCheck's real timeout and SIGKILL-grace timers:
    // advancing one bound's worth fires the timeout (SIGTERM), arms the
    // grace timer, and then fires it too (SIGKILL) once the child ignores
    // SIGTERM.
    await vi.advanceTimersByTimeAsync(CARGO_INSTALL_TIMEOUT_FLOOR_MS + 5_000 + 1);
    vi.useRealTimers();

    await rejected;
    expect(hung.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not time out a prompt install", async () => {
    spawnMock.mockImplementation((command: string, args: string[] = []) =>
      routedSpawn(command, args, {
        install: () => {
          const binary = path.join(tempCargoHome, "stellar-canary-action", "bin", platformBinaryName());
          fs.mkdirSync(path.dirname(binary), { recursive: true });
          fs.writeFileSync(binary, "binary", { mode: 0o755 });
          return new ImmediateChild(0) as unknown as ChildProcess;
        },
      }),
    );

    const installed = await ensureCanaryInstalled(RESOLVED, CARGO_INSTALL_TIMEOUT_FLOOR_MS);

    expect(installed.version).toBe(RESOLVED.version);
  });
});

// ---------------------------------------------------------------------------
// #359 — install engine releases from prebuilt assets when they exist.
// ---------------------------------------------------------------------------

/** Overrides `process.arch` for the duration of `run`, mirroring
 * `withPlatform` above (configurable, non-writable property). */
async function withArch<T>(arch: string, run: () => Promise<T> | T): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "arch", { value: arch, configurable: true, enumerable: true, writable: false });
  try {
    return await run();
  } finally {
    if (original !== undefined) {
      Object.defineProperty(process, "arch", original);
    }
  }
}

describe("prebuilt release install (issue #359)", () => {
  it("maps every supported runner platform/arch to the engine release target triple", () => {
    expect(prebuiltTargetTriple("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
    expect(prebuiltTargetTriple("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
    expect(prebuiltTargetTriple("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(prebuiltTargetTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(prebuiltTargetTriple("win32", "x64")).toBe("x86_64-pc-windows-msvc");
  });

  it("throws a clear unsupported-platform error for pairs with no published target", () => {
    expect(() => prebuiltTargetTriple("linux", "arm")).toThrow(/Unsupported platform linux-arm/);
    expect(() => prebuiltTargetTriple("win32", "arm64")).toThrow(/Unsupported platform win32-arm64/);
    expect(() => prebuiltTargetTriple("freebsd", "x64")).toThrow(/Unsupported platform freebsd-x64/);
    expect(() => prebuiltTargetTriple("linux", "arm")).toThrow(/x86_64-unknown-linux-gnu/);
  });

  describe("inside ensureCanaryInstalled", () => {
    let tempCargoHome: string;
    let originalCargoHome: string | undefined;
    let originalRunnerTemp: string | undefined;
    let tempToolCache: string;
    let originalToolCache: string | undefined;
    /** Version strings fed to the spawn-mocked `stellar-canary version`
     * probes, mirroring the outer suite's mechanism. */
    let versionProbeResults: string[];
    let versionProbeExitCode: number;

    /** The release asset name the installer looks for on a linux-x64 runner;
     * every flow test pins platform/arch to linux-x64 so it is deterministic
     * on any dev machine or CI host. */
    const LINUX_X64_ASSET = `stellar-canary-${RESOLVED.version}-x86_64-unknown-linux-gnu.tar.gz`;
    const DOWNLOAD_URL = "https://example.test/prebuilt-download";
    const OBJECTS_URL = "https://objects.githubusercontent.com/signed-asset";
    const MANIFEST_URL = "https://example.test/SHA256SUMS";

    /** Builds a release body carrying the named assets. */
    function releaseBodyWith(assets: { name: string; url: string }[]): string {
      return JSON.stringify({
        assets: assets.map((asset) => ({ name: asset.name, browser_download_url: asset.url })),
      });
    }

    interface PrebuiltServeOptions {
      readonly releaseBody?: string;
      readonly manifestBody?: string | undefined;
      readonly archiveBytes?: Buffer;
      readonly redirectVia?: boolean;
    }

    /** URL-dispatching https mock serving the release API, the checksum
     * manifest, and the asset download (optionally via one redirect hop).
     * With `stopAfterDownload`, every request after the asset download
     * finishes answers 404 — used to pin the prebuilt stage down so a
     * cargo-fallback's later checksum lookup degrades like the outer
     * suite's default instead of re-serving this fixture. */
    function servePrebuiltRelease(options: PrebuiltServeOptions, stopAfterDownload = false): void {
      let downloadServed = false;
      httpsGetMock.mockImplementation(
        ((
          url: string,
          _opts: unknown,
          callback: (response: FakeResponse) => void,
        ): FakeRequest => {
          const request = new FakeRequest();
          const response = new FakeResponse(200);
          if (stopAfterDownload && downloadServed) {
            response.statusCode = 404;
            callback(response);
            queueMicrotask(() => response.emit("end"));
            return request;
          }
          if (url === `${CANARY_API_REPO_URL}/releases/tags/v${RESOLVED.version}`) {
            callback(response);
            queueMicrotask(() => {
              response.emit("data", options.releaseBody ?? "{}");
              response.emit("end");
            });
          } else if (url === MANIFEST_URL) {
            callback(response);
            queueMicrotask(() => {
              response.emit("data", options.manifestBody ?? "");
              response.emit("end");
            });
          } else if (url === DOWNLOAD_URL && options.redirectVia === true) {
            response.statusCode = 302;
            response.headers.location = OBJECTS_URL;
            callback(response);
            queueMicrotask(() => response.emit("end"));
          } else if (url === OBJECTS_URL || (url === DOWNLOAD_URL && options.redirectVia !== true)) {
            callback(response);
            queueMicrotask(() => {
              response.emit("data", options.archiveBytes ?? Buffer.alloc(0));
              response.emit("end");
              downloadServed = true;
            });
          } else {
            response.statusCode = 404;
            callback(response);
            queueMicrotask(() => response.emit("end"));
          }
          return request;
        }) as never,
      );
    }

    /** Spawn mock that understands `tar` extraction (simulated by `extract`,
     * which materializes the binary where a real untar would) and answers
     * the version probes from `versionProbeResults`. The real `tar` call is
     * supervised by the bounded runner (#521), so it arrives here as a
     * `tar` spawn; a throwing `extract` becomes a spawn failure. */
    function mockSpawnWithFakeTar(extract: (archivePath: string, destDir: string) => void): void {
      spawnMock.mockImplementation((command: string, args: string[] = []) =>
        routedSpawn(command, args, {
          tar: (tarArgs) => {
            try {
              extract(tarArgs[1] as string, tarArgs[3] as string);
              return new ImmediateChild(0) as unknown as ChildProcess;
            } catch (error) {
              return new SpawnErrorChild(error instanceof Error ? error.message : String(error)) as unknown as ChildProcess;
            }
          },
          install: () => {
            const binary = prebuiltBinaryPath();
            fs.mkdirSync(path.dirname(binary), { recursive: true });
            fs.writeFileSync(binary, "installed binary", { mode: 0o755 });
            return new ImmediateChild(0) as unknown as ChildProcess;
          },
          version: () =>
            new ImmediateChild(
              versionProbeExitCode,
              `stellar-canary ${versionProbeResults.shift() ?? "0.1.0"}\n`,
            ) as unknown as ChildProcess,
        }),
      );
    }

    /** The default fake extraction: a flat layout with the binary directly
     * under the destination directory. */
    function flatExtract(archivePath: string, destDir: string): void {
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, "stellar-canary"), `extracted-from-${path.basename(archivePath)}`);
    }

    function prebuiltBinaryPath(): string {
      return path.join(tempCargoHome, "stellar-canary-action", "bin", "stellar-canary");
    }

    beforeEach(() => {
      tempCargoHome = fs.mkdtempSync(path.join(os.tmpdir(), "canary-prebuilt-cargo-home-"));
      fs.mkdirSync(path.join(tempCargoHome, "bin"), { recursive: true });
      originalCargoHome = process.env.CARGO_HOME;
      originalRunnerTemp = process.env.RUNNER_TEMP;
      process.env.CARGO_HOME = tempCargoHome;
      process.env.RUNNER_TEMP = tempCargoHome;

      tempToolCache = fs.mkdtempSync(path.join(os.tmpdir(), "canary-prebuilt-toolcache-"));
      originalToolCache = process.env.RUNNER_TOOL_CACHE;
      process.env.RUNNER_TOOL_CACHE = tempToolCache;

      versionProbeResults = [];
      versionProbeExitCode = 0;

      cacheMocks.isFeatureAvailableMock.mockReset().mockReturnValue(false);
      cacheMocks.restoreCacheMock.mockReset().mockResolvedValue(undefined);
      cacheMocks.saveCacheMock.mockReset().mockResolvedValue(undefined);
      osMocks.homedirMock.mockReset().mockReturnValue(FAKE_HOME);
      coreMocks.infoMock.mockReset();
      coreMocks.debugMock.mockReset();
      coreMocks.warningMock.mockReset();
      coreMocks.addPathMock.mockReset();

      httpsGetMock.mockReset();
      httpsGetMock.mockImplementation(respond(404, ""));

      spawnMock.mockReset();
      // Same default spawn surface as the outer suite (#521): probes answer
      // from `versionProbeResults` and everything else exits cleanly.
      spawnMock.mockImplementation((command: string, args: string[] = []) =>
        routedSpawn(command, args, {
          install: () => {
            const binary = prebuiltBinaryPath();
            fs.mkdirSync(path.dirname(binary), { recursive: true });
            fs.writeFileSync(binary, "installed binary", { mode: 0o755 });
            return new ImmediateChild(0) as unknown as ChildProcess;
          },
          version: () =>
            new ImmediateChild(
              versionProbeExitCode,
              `stellar-canary ${versionProbeResults.shift() ?? "0.1.0"}\n`,
            ) as unknown as ChildProcess,
        }),
      );
    });

    afterEach(() => {
      if (originalCargoHome === undefined) {
        delete process.env.CARGO_HOME;
      } else {
        process.env.CARGO_HOME = originalCargoHome;
      }
      if (originalRunnerTemp === undefined) {
        delete process.env.RUNNER_TEMP;
      } else {
        process.env.RUNNER_TEMP = originalRunnerTemp;
      }
      if (originalToolCache === undefined) {
        delete process.env.RUNNER_TOOL_CACHE;
      } else {
        process.env.RUNNER_TOOL_CACHE = originalToolCache;
      }
      fs.rmSync(tempCargoHome, { recursive: true, force: true });
      fs.rmSync(tempToolCache, { recursive: true, force: true });
    });

    it("installs the checksum-verified prebuilt asset and skips the source build", async () => {
      const archiveBytes = Buffer.from("fake-tar.gz-payload");
      servePrebuiltRelease({
        releaseBody: releaseBodyWith([
          { name: LINUX_X64_ASSET, url: DOWNLOAD_URL },
          { name: "SHA256SUMS", url: MANIFEST_URL },
        ]),
        manifestBody: `${crypto.createHash("sha256").update(archiveBytes).digest("hex")}  ${LINUX_X64_ASSET}\n`,
        archiveBytes,
      });
      mockSpawnWithFakeTar(flatExtract);

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed).toEqual({ binaryPath: prebuiltBinaryPath(), version: "0.1.0" });
      expect(cargoInstallSpawned()).toBe(false);
      expect(coreMocks.addPathMock).not.toHaveBeenCalled();
      expect(coreMocks.infoMock).toHaveBeenCalledWith(
        expect.stringContaining(`prebuilt release asset ${LINUX_X64_ASSET}`),
      );
      expect(cacheMocks.saveCacheMock).not.toHaveBeenCalled();
    });

    it("follows the CDN redirect when downloading the release asset", async () => {
      const archiveBytes = Buffer.from("redirected-payload");
      servePrebuiltRelease({
        releaseBody: releaseBodyWith([
          { name: LINUX_X64_ASSET, url: DOWNLOAD_URL },
          { name: "SHA256SUMS", url: MANIFEST_URL },
        ]),
        manifestBody: `${crypto.createHash("sha256").update(archiveBytes).digest("hex")}  ${LINUX_X64_ASSET}\n`,
        archiveBytes,
        redirectVia: true,
      });
      mockSpawnWithFakeTar(flatExtract);

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.binaryPath).toBe(prebuiltBinaryPath());
      expect(cargoInstallSpawned()).toBe(false);
    });

    it("copies a nested archive binary into the Action-owned install root", async () => {
      const archiveBytes = Buffer.from("nested-layout");
      servePrebuiltRelease({
        releaseBody: releaseBodyWith([
          { name: LINUX_X64_ASSET, url: DOWNLOAD_URL },
          { name: "SHA256SUMS", url: MANIFEST_URL },
        ]),
        manifestBody: `${crypto.createHash("sha256").update(archiveBytes).digest("hex")}  ${LINUX_X64_ASSET}\n`,
        archiveBytes,
      });
      mockSpawnWithFakeTar((archive, dest) => {
        const nested = path.join(dest, `stellar-canary-${RESOLVED.version}-x86_64-unknown-linux-gnu`, "bin");
        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(path.join(nested, "stellar-canary"), `extracted-from-${path.basename(archive)}`);
      });

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed).toEqual({ binaryPath: prebuiltBinaryPath(), version: "0.1.0" });
      expect(fs.existsSync(path.join(path.dirname(prebuiltBinaryPath()), "stellar-canary.sha256"))).toBe(true);
      expect(coreMocks.addPathMock).not.toHaveBeenCalled();
    });

    it("rejects with InstallationFailedError when the asset hash does not match the published checksum", async () => {
      servePrebuiltRelease({
        releaseBody: releaseBodyWith([
          { name: LINUX_X64_ASSET, url: DOWNLOAD_URL },
          { name: "SHA256SUMS", url: MANIFEST_URL },
        ]),
        manifestBody: `${"f".repeat(64)}  ${LINUX_X64_ASSET}\n`,
        archiveBytes: Buffer.from("tampered-payload"),
      });
      mockSpawnWithFakeTar(flatExtract);

      const error = await withPlatform("linux", () =>
        withArch("x64", async () =>
          ensureCanaryInstalled(RESOLVED).then(
            () => {
              throw new Error("expected ensureCanaryInstalled to reject");
            },
            (rejection: unknown) => rejection,
          ),
        ),
      );
      expect(error).toBeInstanceOf(InstallationFailedError);
      expect((error as InstallationFailedError).message).toContain("f".repeat(64));
      expect(cargoInstallSpawned()).toBe(false);
    });

    it("falls back to cargo install when the release carries no asset for this target", async () => {
      servePrebuiltRelease({
        releaseBody: releaseBodyWith([
          { name: `stellar-canary-${RESOLVED.version}-x86_64-unknown-freebsd.tar.gz`, url: DOWNLOAD_URL },
          { name: "SHA256SUMS", url: MANIFEST_URL },
        ]),
      });

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.version).toBe("0.1.0");
      expect(coreMocks.debugMock).toHaveBeenCalledWith(
        expect.stringContaining("no prebuilt stellar-canary asset for target x86_64-unknown-linux-gnu"),
      );
      expect(spawnMock).toHaveBeenCalled();
    });

    it("falls back to cargo install when the prebuilt asset download returns HTTP 404", async () => {
      const assetName = LINUX_X64_ASSET;
      const downloadUrl = "https://example.test/missing-prebuilt-asset";

      httpsGetMock
        .mockImplementationOnce(
          respond(
            200,
            JSON.stringify({
              assets: [
                { name: assetName, browser_download_url: downloadUrl },
                { name: "SHA256SUMS", browser_download_url: MANIFEST_URL },
              ],
            }),
          ),
        )
        .mockImplementationOnce(respond(200, `${"0".repeat(64)}  ${assetName}\n`))
        .mockImplementationOnce(respond(404, ""));

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.version).toBe("0.1.0");
      expect(
        coreMocks.warningMock.mock.calls.some(
          (call) =>
            String(call[0]).includes(assetName) &&
            String(call[0]).includes("returned status 404") &&
            String(call[0]).includes("falling back to a source install"),
        ),
      ).toBe(true);
      expect(spawnMock).toHaveBeenCalled();
    });

    it("falls back to cargo install when the prebuilt asset has no published checksum manifest", async () => {
      servePrebuiltRelease({
        releaseBody: releaseBodyWith([{ name: LINUX_X64_ASSET, url: DOWNLOAD_URL }]),
      });

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.version).toBe("0.1.0");
      expect(coreMocks.warningMock).toHaveBeenCalledWith(
        expect.stringContaining("no published checksum manifest"),
      );
      expect(spawnMock).toHaveBeenCalled();
    });

    it("falls back to cargo install when the prebuilt binary reports the wrong version", async () => {
      const archiveBytes = Buffer.from("wrong-version-payload");
      versionProbeResults = ["0.0.9"];
      mockSpawnWithFakeTar(flatExtract);
      servePrebuiltRelease(
        {
          releaseBody: releaseBodyWith([
            { name: LINUX_X64_ASSET, url: DOWNLOAD_URL },
            { name: "SHA256SUMS", url: MANIFEST_URL },
          ]),
          manifestBody: `${crypto.createHash("sha256").update(archiveBytes).digest("hex")}  ${LINUX_X64_ASSET}\n`,
          archiveBytes,
        },
        true,
      );

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.binaryPath).toBe(prebuiltBinaryPath());
      expect(coreMocks.warningMock).toHaveBeenCalledWith(expect.stringContaining("reports version 0.0.9"));
      expect(spawnMock).toHaveBeenCalled();
    });

    it("skips the prebuilt path on an unsupported arch with a clear log and still installs from source", async () => {
      const installed = await withPlatform("linux", () => withArch("arm", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.version).toBe("0.1.0");
      expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("Unsupported platform linux-arm"));
      expect(spawnMock).toHaveBeenCalled();
    });

    describe("issue #509 — secure prebuilt extraction & binary discovery", () => {
      it("rejects archives with symlinks in the extracted contents", async () => {
        const archiveBytes = Buffer.from("symlink-payload");
        servePrebuiltRelease(
          {
            releaseBody: releaseBodyWith([
              { name: LINUX_X64_ASSET, url: DOWNLOAD_URL },
              { name: "SHA256SUMS", url: MANIFEST_URL },
            ]),
            manifestBody: `${crypto.createHash("sha256").update(archiveBytes).digest("hex")}  ${LINUX_X64_ASSET}\n`,
            archiveBytes,
          },
          true,
        );

        mockSpawnWithFakeTar((_archive, dest) => {
          fs.mkdirSync(dest, { recursive: true });
          fs.writeFileSync(path.join(dest, "real-binary"), "executable");
          try {
            fs.symlinkSync("real-binary", path.join(dest, "stellar-canary"));
          } catch {
            // fall back if symlinks not supported on test host
          }
        });

        const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

        expect(installed.binaryPath).toBe(prebuiltBinaryPath());
        expect(coreMocks.warningMock).toHaveBeenCalledWith(
          expect.stringContaining("contains invalid or unsafe entries"),
        );
        expect(spawnMock).toHaveBeenCalled();
      });

      it("rejects archives where stellar-canary is a directory instead of a regular file", async () => {
        const archiveBytes = Buffer.from("dir-payload");
        servePrebuiltRelease(
          {
            releaseBody: releaseBodyWith([
              { name: LINUX_X64_ASSET, url: DOWNLOAD_URL },
              { name: "SHA256SUMS", url: MANIFEST_URL },
            ]),
            manifestBody: `${crypto.createHash("sha256").update(archiveBytes).digest("hex")}  ${LINUX_X64_ASSET}\n`,
            archiveBytes,
          },
          true,
        );

        mockSpawnWithFakeTar((_archive, dest) => {
          fs.mkdirSync(path.join(dest, "stellar-canary"), { recursive: true });
        });

        const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

        expect(installed.binaryPath).toBe(prebuiltBinaryPath());
        expect(coreMocks.warningMock).toHaveBeenCalledWith(
          expect.stringContaining("contains invalid or unsafe entries"),
        );
        expect(spawnMock).toHaveBeenCalled();
      });

      it("rejects archives with multiple stellar-canary binaries", async () => {
        const archiveBytes = Buffer.from("duplicate-payload");
        servePrebuiltRelease(
          {
            releaseBody: releaseBodyWith([
              { name: LINUX_X64_ASSET, url: DOWNLOAD_URL },
              { name: "SHA256SUMS", url: MANIFEST_URL },
            ]),
            manifestBody: `${crypto.createHash("sha256").update(archiveBytes).digest("hex")}  ${LINUX_X64_ASSET}\n`,
            archiveBytes,
          },
          true,
        );

        mockSpawnWithFakeTar((_archive, dest) => {
          fs.mkdirSync(path.join(dest, "dir1"), { recursive: true });
          fs.mkdirSync(path.join(dest, "dir2"), { recursive: true });
          fs.writeFileSync(path.join(dest, "dir1", "stellar-canary"), "bin1");
          fs.writeFileSync(path.join(dest, "dir2", "stellar-canary"), "bin2");
        });

        const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

        expect(installed.binaryPath).toBe(prebuiltBinaryPath());
        expect(coreMocks.warningMock).toHaveBeenCalledWith(
          expect.stringContaining("contains multiple stellar-canary executables"),
        );
        expect(spawnMock).toHaveBeenCalled();
      });

      it("falls back to source install and preserves previous installation when extraction fails", async () => {
        const archiveBytes = Buffer.from("extract-fail-payload");
        servePrebuiltRelease(
          {
            releaseBody: releaseBodyWith([
              { name: LINUX_X64_ASSET, url: DOWNLOAD_URL },
              { name: "SHA256SUMS", url: MANIFEST_URL },
            ]),
            manifestBody: `${crypto.createHash("sha256").update(archiveBytes).digest("hex")}  ${LINUX_X64_ASSET}\n`,
            archiveBytes,
          },
          true,
        );

        mockSpawnWithFakeTar((_archive, _dest) => {
          // Simulate tar failure by throwing
          throw new Error("tar exit code 1");
        });

        const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

        expect(installed.binaryPath).toBe(prebuiltBinaryPath());
        expect(coreMocks.warningMock).toHaveBeenCalledWith(
          expect.stringContaining("Could not extract the prebuilt Protocol-Canary asset"),
        );
        expect(spawnMock).toHaveBeenCalled();
      });
    });
  });
});

describe("verified fixture-pack caching (#345)", () => {
  const DIGEST = `sha256:${"a".repeat(64)}`;
  const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
  const MARKER = ".stellar-canary-pack.json";
  let packDir: string;

  beforeEach(() => {
    packDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-pack-cache-"));
    // The cache layer must not leave a directory behind at the exact path
    // under test; each test creates what it needs inside it.
    fs.rmSync(packDir, { recursive: true, force: true });

    cacheMocks.isFeatureAvailableMock.mockReset().mockReturnValue(true);
    cacheMocks.restoreCacheMock.mockReset().mockResolvedValue(undefined);
    cacheMocks.saveCacheMock.mockReset().mockResolvedValue(undefined);
    coreMocks.infoMock.mockReset();
    coreMocks.debugMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(packDir, { recursive: true, force: true });
  });

  it("builds a deterministic key from the protocol and canonical digest", () => {
    expect(packCacheKey(28, DIGEST)).toBe(`stellar-canary-pack-28-${DIGEST}`);
    expect(packCacheKey(28, DIGEST)).toBe(packCacheKey(28, DIGEST));
    // A different protocol or digest must never share an entry.
    expect(packCacheKey(29, DIGEST)).not.toBe(packCacheKey(28, DIGEST));
    expect(packCacheKey(28, OTHER_DIGEST)).not.toBe(packCacheKey(28, DIGEST));
  });

  it("rejects a non-canonical digest or invalid protocol instead of building a loose key", () => {
    for (const digest of ["abc", `sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(63)}`, ""]) {
      expect(() => packCacheKey(28, digest)).toThrow(InvalidInputError);
    }
    for (const protocol of [-1, 1.5, Number.NaN]) {
      expect(() => packCacheKey(protocol, DIGEST)).toThrow(InvalidInputError);
    }
  });

  it("skips download and extraction on a valid cache hit", async () => {
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, MARKER), JSON.stringify({ protocol: 28, packDigest: DIGEST }));
    cacheMocks.restoreCacheMock.mockResolvedValue(`stellar-canary-pack-28-${DIGEST}`);
    const download = vi.fn();

    const outcome = await ensureVerifiedPack({ protocol: 28, packDigest: DIGEST, directory: packDir, download });

    expect(outcome).toBe("cache-hit");
    expect(download).not.toHaveBeenCalled();
    expect(cacheMocks.restoreCacheMock).toHaveBeenCalledWith([packDir], `stellar-canary-pack-28-${DIGEST}`);
    // A hit never re-saves the entry.
    expect(cacheMocks.saveCacheMock).not.toHaveBeenCalled();
    expect(coreMocks.infoMock).toHaveBeenCalledWith(expect.stringContaining("protocol 28 from cache"));
  });

  it("downloads and saves on a cache miss, writing the provenance marker", async () => {
    const download = vi.fn(async (directory: string) => {
      fs.writeFileSync(path.join(directory, "fixture.json"), "{}");
    });

    const outcome = await ensureVerifiedPack({ protocol: 28, packDigest: DIGEST, directory: packDir, download });

    expect(outcome).toBe("downloaded");
    expect(download).toHaveBeenCalledWith(packDir);
    expect(fs.readFileSync(path.join(packDir, MARKER), "utf8")).toBe(
      `${JSON.stringify({ protocol: 28, packDigest: DIGEST })}\n`,
    );
    expect(fs.readFileSync(path.join(packDir, "fixture.json"), "utf8")).toBe("{}");
    expect(cacheMocks.saveCacheMock).toHaveBeenCalledWith([packDir], `stellar-canary-pack-28-${DIGEST}`);
  });

  it("falls back to a fresh download when cache restore throws", async () => {
    cacheMocks.restoreCacheMock.mockRejectedValue(new Error("cache service unavailable"));
    const download = vi.fn(async () => undefined);

    const outcome = await ensureVerifiedPack({ protocol: 28, packDigest: DIGEST, directory: packDir, download });

    expect(outcome).toBe("downloaded");
    expect(download).toHaveBeenCalledTimes(1);
    expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("cache restore failed"));
  });

  it("discards a cached directory whose marker does not match the requested digest", async () => {
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, MARKER), JSON.stringify({ protocol: 28, packDigest: OTHER_DIGEST }));
    fs.writeFileSync(path.join(packDir, "corrupt-fixture.json"), "{}");
    cacheMocks.restoreCacheMock.mockResolvedValue(`stellar-canary-pack-28-${DIGEST}`);
    const download = vi.fn(async (directory: string) => {
      // The stale file must be gone before the fresh download runs.
      expect(fs.existsSync(path.join(directory, "corrupt-fixture.json"))).toBe(false);
    });

    const outcome = await ensureVerifiedPack({ protocol: 28, packDigest: DIGEST, directory: packDir, download });

    expect(outcome).toBe("downloaded");
    expect(download).toHaveBeenCalledTimes(1);
    expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("failed provenance validation"));
  });

  it("treats a restored directory without a provenance marker as corrupt", async () => {
    fs.mkdirSync(packDir, { recursive: true });
    cacheMocks.restoreCacheMock.mockResolvedValue(`stellar-canary-pack-28-${DIGEST}`);
    const download = vi.fn(async () => undefined);

    const outcome = await ensureVerifiedPack({ protocol: 28, packDigest: DIGEST, directory: packDir, download });

    expect(outcome).toBe("downloaded");
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("does not fail the run when saving to the cache fails", async () => {
    cacheMocks.saveCacheMock.mockRejectedValue(new Error("reserve cache failed"));
    const download = vi.fn(async () => undefined);

    const outcome = await ensureVerifiedPack({ protocol: 28, packDigest: DIGEST, directory: packDir, download });

    expect(outcome).toBe("downloaded");
    expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("cache save failed"));
  });

  it("downloads without touching the cache service when caching is unavailable", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(false);
    const download = vi.fn(async () => undefined);

    const outcome = await ensureVerifiedPack({ protocol: 28, packDigest: DIGEST, directory: packDir, download });

    expect(outcome).toBe("downloaded");
    expect(download).toHaveBeenCalledTimes(1);
    expect(cacheMocks.restoreCacheMock).not.toHaveBeenCalled();
    expect(cacheMocks.saveCacheMock).not.toHaveBeenCalled();
  });

  it("propagates a failed download so a missing pack is never silently accepted", async () => {
    const download = vi.fn(async () => {
      throw new Error("checksum mismatch");
    });

    await expect(
      ensureVerifiedPack({ protocol: 28, packDigest: DIGEST, directory: packDir, download }),
    ).rejects.toThrow("checksum mismatch");
    expect(cacheMocks.saveCacheMock).not.toHaveBeenCalled();
  });
});

describe("bounded HTTP downloads (#500)", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-http-limit-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); httpsGetMock.mockReset(); });

  function stream(chunks: Buffer[], headers: Record<string, string> = {}, ending = "end") {
    const response = new FakeResponse(200);
    response.headers = headers;
    const request = new FakeRequest();
    const destroyResponse = vi.spyOn(response, "destroy");
    const destroyRequest = vi.spyOn(request, "destroy");
    let delivered = 0;
    httpsGetMock.mockImplementationOnce((_url, _options, callback) => {
      callback(response);
      queueMicrotask(() => {
        for (const chunk of chunks) {
          if (destroyResponse.mock.calls.length > 0) break;
          delivered++;
          response.emit("data", chunk);
        }
        if (destroyResponse.mock.calls.length === 0) response.emit(ending);
      });
      return request;
    });
    return { response, destroyResponse, destroyRequest, delivered: () => delivered };
  }

  it.each([MAX_API_RESPONSE_BYTES, MAX_CHECKSUM_MANIFEST_BYTES])("accepts exactly %i bytes and preserves split UTF-8", async (limit) => {
    const bytes = Buffer.from("é" + "x".repeat(limit - 2));
    stream([bytes.subarray(0, 1), bytes.subarray(1)], { "content-length": String(limit) });
    const text = await httpsGetText("https://example.test/body", undefined, limit);
    expect(Buffer.byteLength(text)).toBe(limit);
    expect(text.startsWith("é")).toBe(true);
  });

  it.each(["header", "stream", "lying header"])("rejects oversized text via %s and destroys both streams", async (kind) => {
    const limit = MAX_CHECKSUM_MANIFEST_BYTES;
    const state = stream([Buffer.alloc(limit), Buffer.from("x"), Buffer.from("unused")],
      kind === "header" ? { "content-length": String(limit + 1) } : kind === "lying header" ? { "content-length": "1" } : {});
    await expect(httpsGetText("https://example.test/body", undefined, limit)).rejects.toThrow(`example.test exceeds the ${limit}-byte limit`);
    expect(state.delivered()).toBe(kind === "header" ? 0 : 2);
    expect(state.destroyResponse).toHaveBeenCalled();
    expect(state.destroyRequest).toHaveBeenCalled();
  });

  it.each(["aborted", "close", "end"])("rejects incomplete text on %s", async (ending) => {
    stream([Buffer.from("partial")], { "content-length": "100" }, ending);
    await expect(httpsGetText("https://example.test/body", undefined)).rejects.toThrow();
  });

  it("writes exactly the asset byte limit", async () => {
    stream([Buffer.alloc(MAX_RELEASE_ASSET_BYTES)], { "content-length": String(MAX_RELEASE_ASSET_BYTES) });
    const dest = path.join(dir, "asset");
    await httpsGetFile("https://example.test/asset", dest, 5);
    expect(fs.statSync(dest).size).toBe(MAX_RELEASE_ASSET_BYTES);
  });

  it.each(["header", "stream", "lying header", "aborted", "close", "short"])("removes the partial file on %s rejection", async (kind) => {
    const over = kind === "stream" || kind === "lying header";
    const state = stream(over ? [Buffer.alloc(MAX_RELEASE_ASSET_BYTES), Buffer.from("x"), Buffer.from("unused")] : [Buffer.from("partial")],
      kind === "header" ? { "content-length": String(MAX_RELEASE_ASSET_BYTES + 1) } : kind === "short" || kind === "lying header" ? { "content-length": "100" } : {},
      kind === "aborted" || kind === "close" ? kind : "end");
    const dest = path.join(dir, "asset");
    await expect(httpsGetFile("https://example.test/asset", dest, 5)).rejects.toThrow();
    expect(fs.existsSync(dest)).toBe(false);
    expect(state.destroyRequest).toHaveBeenCalled();
    if (kind === "header") expect(state.delivered()).toBe(0);
    if (over) expect(state.delivered()).toBe(2);
  });

  it("removes the destination after a write error", async () => {
    stream([Buffer.from("partial")]);
    const dest = path.join(dir, "asset");
    const actual = (await vi.importActual<typeof fs>("node:fs")).createWriteStream;
    const spy = vi.mocked(fs.createWriteStream).mockImplementationOnce((...args) => {
      const file = actual(...args);
      file.once("open", () => file.destroy(new Error("disk full")));
      return file;
    });
    try {
      await expect(httpsGetFile("https://example.test/asset", dest, 5)).rejects.toThrow("disk full");
      expect(fs.existsSync(dest)).toBe(false);
    } finally { spy.mockImplementation(actual); }
  });

  it.each(["release", "manifest", "asset"])("keeps the existing prebuilt fallback for an oversized %s", async (stage) => {
    const assetName = `stellar-canary-${RESOLVED.version}-${prebuiltTargetTriple(process.platform, process.arch)}.tar.gz`;
    if (stage === "release") {
      stream([], { "content-length": String(MAX_API_RESPONSE_BYTES + 1) });
    } else {
      stream([Buffer.from(JSON.stringify({ assets: [
        { name: assetName, browser_download_url: "https://example.test/asset" },
        { name: "SHA256SUMS", browser_download_url: "https://example.test/manifest" },
      ] }))]);
      if (stage === "manifest") {
        stream([], { "content-length": String(MAX_CHECKSUM_MANIFEST_BYTES + 1) });
      } else {
        stream([Buffer.from(`${"0".repeat(64)}  ${assetName}`)]);
        stream([], { "content-length": String(MAX_RELEASE_ASSET_BYTES + 1) });
      }
    }
    spawnMock.mockClear();
    await expect(installPrebuiltRelease(RESOLVED)).resolves.toBeUndefined();
    // The oversized response is rejected before extraction, so `tar` never runs.
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("applies the asset limit after a redirect", async () => {
    httpsGetMock.mockImplementationOnce((_url, _options, callback) => {
      const response = new FakeResponse(302);
      response.headers.location = "https://cdn.test/asset";
      queueMicrotask(() => callback(response));
      return new FakeRequest();
    });
    stream([], { "content-length": String(MAX_RELEASE_ASSET_BYTES + 1) });
    const dest = path.join(dir, "asset");
    await expect(httpsGetFile("https://example.test/asset", dest, 5)).rejects.toThrow("cdn.test");
    expect(fs.existsSync(dest)).toBe(false);
  });
});
