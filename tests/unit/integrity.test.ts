/**
 * Negative integrity tests (issue #375) and the fail-closed behaviour of the
 * optional strict-integrity policy (issue #372) at the engine-installation
 * boundary.
 *
 * Scope note, kept honest to what this Action actually is: there is no
 * fixture-pack `DownloadManager` on `main` yet — that pipeline is issue #338,
 * still unmerged — so the "spoofed redirect" and "tampered artifact" security
 * boundaries these tests pin are the ones the Action really enforces today:
 * the published-checksum verification chain in `src/canary.ts`
 * (`ensureCanaryInstalled` → `verifyInstalledBinary` → `httpsGetText`).
 * Accordingly these tests assert the repo's real error taxonomy
 * ({@link InstallationFailedError}, `code: "InstallationFailed"`), not the
 * `SecurityPolicyError` the issue drafted against the unbuilt downloader.
 *
 * The mocking scaffold mirrors `canary.test.ts` deliberately (same module
 * mocks, same fake-HTTP machinery) so every request is offline and the suite
 * is deterministic on all three CI platforms.
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import type * as osModule from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  isFeatureAvailableMock: vi.fn(),
  restoreCacheMock: vi.fn(),
  saveCacheMock: vi.fn(),
}));

const coreMocks = vi.hoisted(() => ({
  infoMock: vi.fn(),
  debugMock: vi.fn(),
  warningMock: vi.fn(),
}));

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
const httpsGetMock = vi.hoisted(() => vi.fn());
const osMocks = vi.hoisted(() => ({ homedirMock: vi.fn() }));

vi.mock("@actions/cache", () => ({
  isFeatureAvailable: cacheMocks.isFeatureAvailableMock,
  restoreCache: cacheMocks.restoreCacheMock,
  saveCache: cacheMocks.saveCacheMock,
}));

vi.mock("@actions/core", () => ({
  info: coreMocks.infoMock,
  debug: coreMocks.debugMock,
  warning: coreMocks.warningMock,
}));

// #521: the version probes, `cargo --version` and `tar` all run through the
// bounded runner (src/runner.ts), which spawns directly — @actions/exec is
// no longer involved in the install chain.
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

import { InstallationFailedError } from "../../src/errors";
import { ensureCanaryInstalled } from "../../src/canary";
import type { ResolvedVersion } from "../../src/version";

const RESOLVED: ResolvedVersion = { version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" };

/** A spawn result that closes immediately with the given exit code,
 * emitting any captured output first (the bounded runner supervises the
 * version probes too since #521, so they need stdout to parse). */
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
    // setImmediate, not queueMicrotask: the bounded runner attaches the
    // stdout `data` listener right after spawn, and the stream schedules
    // its buffered-data emission as a microtask — queued *after* this
    // constructor's own microtask. A microtask close would therefore fire
    // first and the captured stdout would come back empty (#521). A macrotask
    // always runs after every pending microtask.
    setImmediate(() => this.emit("close", exitCode, null));
  }

  kill(): boolean {
    return true;
  }
}

class FakeResponse extends EventEmitter {
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
function respond(statusCode: number, body: string, headers: Record<string, string> = {}): any {
  return (_url: string, _options: unknown, callback: (response: FakeResponse) => void) => {
    const response = new FakeResponse(statusCode);
    response.headers = headers;
    const request = new FakeRequest();
    callback(response);
    queueMicrotask(() => {
      response.emit("data", body);
      response.emit("end");
    });
    return request;
  };
}

/**
 * Fake transport that behaves like Node's `https.get` about schemes: a
 * plain `http://` target can never complete a TLS handshake, so the request
 * errors out. Used to prove the Action unconditionally rejects unencrypted
 * manifest/redirect targets (issue #375 "Negative testing").
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function httpsOnlyTransport(): any {
  return (url: string, _options: unknown, callback: (response: FakeResponse) => void) => {
    if (url.startsWith("http://")) {
      const request = new FakeRequest();
      queueMicrotask(() => request.emit("error", new Error(`ERR_INVALID_SCHEME: ${url}`)));
      return request;
    }
    return respond(404, "")(url, _options, callback);
  };
}

/** Release JSON whose only checksum asset points at the given URL. */
function releaseWithAsset(assetUrl: string): string {
  return JSON.stringify({
    assets: [{ name: "SHA256SUMS", browser_download_url: assetUrl }],
  });
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** All URLs the Action actually requested, in order. */
function requestedUrls(): string[] {
  return httpsGetMock.mock.calls.map((call) => String(call[0]));
}

describe("tamper detection and spoofed redirects (issue #375)", () => {
  let tempCargoHome: string;
  let originalCargoHome: string | undefined;
  let originalRunnerTemp: string | undefined;

  function binaryPath(): string {
    return path.join(
      tempCargoHome,
      "stellar-canary-action",
      "bin",
      process.platform === "win32" ? "stellar-canary.exe" : "stellar-canary",
    );
  }

  function writeInstalledBinary(contents: string): void {
    const binary = binaryPath();
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, contents);
    fs.writeFileSync(path.join(path.dirname(binary), "stellar-canary.sha256"), `${sha256(contents)}\n`, {
      mode: 0o600,
    });
  }

  beforeEach(() => {
    tempCargoHome = fs.mkdtempSync(path.join(os.tmpdir(), "canary-integrity-"));
    fs.mkdirSync(path.join(tempCargoHome, "bin"), { recursive: true });
    originalCargoHome = process.env.CARGO_HOME;
    originalRunnerTemp = process.env.RUNNER_TEMP;
    process.env.CARGO_HOME = tempCargoHome;
    process.env.RUNNER_TEMP = tempCargoHome;

    cacheMocks.isFeatureAvailableMock.mockReset().mockReturnValue(true);
    cacheMocks.restoreCacheMock.mockReset().mockResolvedValue(undefined);
    cacheMocks.saveCacheMock.mockReset().mockResolvedValue(undefined);
    osMocks.homedirMock.mockReset().mockReturnValue(path.join(os.tmpdir(), "canary-integrity-not-the-real-home"));
    coreMocks.infoMock.mockReset();
    coreMocks.debugMock.mockReset();
    coreMocks.warningMock.mockReset();

    spawnMock.mockReset();
    // Default routed surface (#521): `cargo --version` succeeds, the version
    // probes report the requested version, and any other spawn (i.e.
    // `cargo install`) exits immediately and cleanly.
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "cargo" && args[0] === "--version") {
        return new ImmediateChild(0, "cargo 1.0.0\n") as unknown as ChildProcess;
      }
      if (args[0] === "version") {
        return new ImmediateChild(0, "stellar-canary 0.1.0\n") as unknown as ChildProcess;
      }
      return new ImmediateChild(0) as unknown as ChildProcess;
    });

    httpsGetMock.mockReset();
    httpsGetMock.mockImplementation(respond(404, ""));
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
    fs.rmSync(tempCargoHome, { recursive: true, force: true });
  });

  it("aborts immediately when a single byte of the installed binary differs from the published checksum", async () => {
    // The published manifest describes "binary"; the on-disk file is
    // "binarey" — a one-byte tamper. Verification must refuse the binary.
    writeInstalledBinary("binarey");
    httpsGetMock
      .mockImplementationOnce(
        respond(
          200,
          JSON.stringify({
            assets: [{ name: "SHA256SUMS", browser_download_url: "https://example.test/SHA256SUMS" }],
          }),
        ),
      )
      .mockImplementationOnce(respond(200, `${sha256("binary")}  stellar-canary\n`));

    await expect(ensureCanaryInstalled(RESOLVED)).rejects.toThrow(/Checksum verification failed/);
    expect(httpsGetMock).toHaveBeenCalledTimes(2);
  });

  it("refuses a truncated (partial) binary and never persists it into the shared Actions cache", async () => {
    // Fresh-install path: the manifest describes the full payload, but the
    // binary on disk is a truncated remnant of it.
    const full = "full-canary-payload";
    httpsGetMock
      // No prebuilt release asset for this platform: the install falls through
      // to the `cargo install` path under test.
      .mockImplementationOnce(respond(404, ""))
      .mockImplementationOnce(
        respond(
          200,
          JSON.stringify({
            assets: [{ name: "SHA256SUMS", browser_download_url: "https://example.test/SHA256SUMS" }],
          }),
        ),
      )
      .mockImplementationOnce(respond(200, `${sha256(full)}  stellar-canary\n`));

    // Install "succeeds" but leaves a truncated file behind.
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "cargo" && args[0] === "--version") {
        return new ImmediateChild(0, "cargo 1.0.0\n") as unknown as ChildProcess;
      }
      if (args[0] === "version") {
        return new ImmediateChild(0, "stellar-canary 0.1.0\n") as unknown as ChildProcess;
      }
      fs.writeFileSync(binaryPath(), full.slice(0, 5));
      return new ImmediateChild(0) as unknown as ChildProcess;
    });

    await expect(ensureCanaryInstalled(RESOLVED)).rejects.toThrow(InstallationFailedError);
    expect(cacheMocks.saveCacheMock).not.toHaveBeenCalled();
    expect(coreMocks.debugMock.mock.calls.flat().join(" ")).not.toContain("Verified stellar-canary");
  });

  it("never follows a spoofed redirect to a non-allowlisted domain during checksum lookup", async () => {
    writeInstalledBinary("binary");
    // Release lookup OK; manifest fetch answers 302 -> evil.example.
    httpsGetMock
      .mockImplementationOnce(respond(200, releaseWithAsset("https://example.test/SHA256SUMS")))
      .mockImplementationOnce(respond(302, "", { location: "https://evil.example.com/SHA256SUMS" }));

    // Default (non-strict) policy: the redirect is refused, the manifest is
    // treated as unavailable, and the run degrades to commit/tag pinning.
    const installed = await ensureCanaryInstalled(RESOLVED);
    expect(installed.binaryPath).toBe(binaryPath());

    // The critical boundary: no request was EVER issued to the redirect
    // target — Node's https.get does not follow redirects and the Action
    // never re-issues one itself (D-11: redirect policy unresolved, so no
    // redirect at all is followed).
    const urls = requestedUrls();
    expect(urls).toHaveLength(2);
    expect(urls.some((url) => url.includes("evil.example.com"))).toBe(false);
    expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("status 302"));
  });

  it("rejects an unencrypted http:// manifest target unconditionally", async () => {
    writeInstalledBinary("binary");
    httpsGetMock.mockReset().mockImplementation(httpsOnlyTransport());
    // A release whose checksum asset is served over plain http.
    httpsGetMock.mockImplementationOnce(
      respond(200, releaseWithAsset("http://example.test/SHA256SUMS")),
    );
    // Subsequent manifest request goes through the scheme-refusing transport.

    const installed = await ensureCanaryInstalled(RESOLVED);
    expect(installed.binaryPath).toBe(binaryPath());
    // The http manifest was never trusted: verification degraded to pinning.
    expect(coreMocks.debugMock).toHaveBeenCalledWith(
      expect.stringContaining("Could not look up a published checksum"),
    );
    expect(coreMocks.infoMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Verified stellar-canary"),
    );
  });

  it("treats a malformed checksum manifest as unverifiable, not as a pass", async () => {
    writeInstalledBinary("binary");
    httpsGetMock
      .mockImplementationOnce(respond(200, releaseWithAsset("https://example.test/SHA256SUMS")))
      .mockImplementationOnce(respond(200, "not-a-digest-at-all  stellar-canary\n"));

    const installed = await ensureCanaryInstalled(RESOLVED);
    expect(installed.binaryPath).toBe(binaryPath());
    expect(coreMocks.infoMock).not.toHaveBeenCalledWith(expect.stringContaining("Verified stellar-canary"));
  });
});

describe("strict-integrity fail-closed policy at the verification boundary (issue #372)", () => {
  let tempCargoHome: string;
  let originalCargoHome: string | undefined;
  let originalRunnerTemp: string | undefined;

  function binaryPath(): string {
    return path.join(
      tempCargoHome,
      "stellar-canary-action",
      "bin",
      process.platform === "win32" ? "stellar-canary.exe" : "stellar-canary",
    );
  }

  function writeInstalledBinary(contents: string): void {
    const binary = binaryPath();
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, contents);
    fs.writeFileSync(path.join(path.dirname(binary), "stellar-canary.sha256"), `${sha256(contents)}\n`, {
      mode: 0o600,
    });
  }

  beforeEach(() => {
    tempCargoHome = fs.mkdtempSync(path.join(os.tmpdir(), "canary-strict-"));
    fs.mkdirSync(path.join(tempCargoHome, "bin"), { recursive: true });
    originalCargoHome = process.env.CARGO_HOME;
    originalRunnerTemp = process.env.RUNNER_TEMP;
    process.env.CARGO_HOME = tempCargoHome;
    process.env.RUNNER_TEMP = tempCargoHome;

    cacheMocks.isFeatureAvailableMock.mockReset().mockReturnValue(false);
    cacheMocks.restoreCacheMock.mockReset().mockResolvedValue(undefined);
    cacheMocks.saveCacheMock.mockReset().mockResolvedValue(undefined);
    osMocks.homedirMock.mockReset().mockReturnValue(path.join(os.tmpdir(), "canary-strict-not-the-real-home"));
    coreMocks.infoMock.mockReset();
    coreMocks.debugMock.mockReset();
    coreMocks.warningMock.mockReset();

    spawnMock.mockReset();
    // Default routed surface (#521): `cargo --version` succeeds, the version
    // probes report the requested version, and any other spawn (i.e.
    // `cargo install`) exits immediately and cleanly.
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "cargo" && args[0] === "--version") {
        return new ImmediateChild(0, "cargo 1.0.0\n") as unknown as ChildProcess;
      }
      if (args[0] === "version") {
        return new ImmediateChild(0, "stellar-canary 0.1.0\n") as unknown as ChildProcess;
      }
      return new ImmediateChild(0) as unknown as ChildProcess;
    });

    httpsGetMock.mockReset();
    httpsGetMock.mockImplementation(respond(404, ""));
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
    fs.rmSync(tempCargoHome, { recursive: true, force: true });
  });

  it("aborts immediately when no checksum manifest is published at all", async () => {
    writeInstalledBinary("binary");

    await expect(ensureCanaryInstalled(RESOLVED, 60_000, undefined, true)).rejects.toThrow(
      /strict-integrity.*no published checksum manifest/s,
    );
  });

  it("aborts when the manifest has no entry for this platform", async () => {
    writeInstalledBinary("binary");
    httpsGetMock
      .mockImplementationOnce(respond(200, releaseWithAsset("https://example.test/SHA256SUMS")))
      .mockImplementationOnce(respond(200, `${"a".repeat(64)}  some-other-tool\n`));

    await expect(ensureCanaryInstalled(RESOLVED, 60_000, undefined, true)).rejects.toThrow(/strict-integrity.*no entry/s);
  });

  it("aborts when the checksum lookup is redirected (unverifiable under D-11)", async () => {
    writeInstalledBinary("binary");
    httpsGetMock
      .mockImplementationOnce(respond(200, releaseWithAsset("https://example.test/SHA256SUMS")))
      .mockImplementationOnce(respond(302, "", { location: "https://evil.example.com/SHA256SUMS" }));

    await expect(ensureCanaryInstalled(RESOLVED, 60_000, undefined, true)).rejects.toThrow(/strict-integrity/s);
    const urls = requestedUrls();
    expect(urls.some((url) => url.includes("evil.example.com"))).toBe(false);
  });

  it("aborts before caching or completing when the checksum does not match", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
    writeInstalledBinary("tampered");
    httpsGetMock
      .mockImplementationOnce(respond(200, releaseWithAsset("https://example.test/SHA256SUMS")))
      .mockImplementationOnce(respond(200, `${sha256("pristine")}  stellar-canary\n`));

    await expect(ensureCanaryInstalled(RESOLVED, 60_000, undefined, true)).rejects.toThrow(/Checksum verification failed/);
    expect(cacheMocks.saveCacheMock).not.toHaveBeenCalled();
  });

  it("succeeds when the published checksum verifies", async () => {
    writeInstalledBinary("binary");
    httpsGetMock
      .mockImplementationOnce(respond(200, releaseWithAsset("https://example.test/SHA256SUMS")))
      .mockImplementationOnce(respond(200, `${sha256("binary")}  stellar-canary\n`));

    const installed = await ensureCanaryInstalled(RESOLVED, 60_000, undefined, true);
    expect(installed.binaryPath).toBe(binaryPath());
    expect(coreMocks.infoMock).toHaveBeenCalledWith(expect.stringContaining("Verified stellar-canary"));
  });

  it("preserves default (non-strict) behaviour: a missing manifest degrades to commit/tag pinning", async () => {
    writeInstalledBinary("binary");

    const installed = await ensureCanaryInstalled(RESOLVED);
    expect(installed.binaryPath).toBe(binaryPath());
    expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("status 404"));
  });
});
