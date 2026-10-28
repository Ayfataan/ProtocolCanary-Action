import type { ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type * as fsModule from "node:fs";
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
  startGroupMock: vi.fn(),
  endGroupMock: vi.fn(),
  addPathMock: vi.fn(),
}));

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
const httpsGetMock = vi.hoisted(() => vi.fn());
const osMocks = vi.hoisted(() => ({ homedirMock: vi.fn() }));
const fsMocks = vi.hoisted(() => ({ createReadStreamMock: vi.fn() }));

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

vi.mock("@actions/exec", () => ({
  exec: execMock,
}));

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

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fsModule>();
  return {
    ...actual,
    createReadStream: (pathLike: fs.PathLike, options?: unknown) => {
      const custom = fsMocks.createReadStreamMock(pathLike, options);
      if (custom !== undefined) {
        return custom;
      }
      return actual.createReadStream(pathLike, options as never);
    },
  };
});

import { ensureCanaryInstalled } from "../../src/canary";
import { InstallationFailedError } from "../../src/errors";
import type { ResolvedVersion } from "../../src/version";
import { CANARY_API_REPO_URL } from "../../src/version";

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

class FakeResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string> = {};
  constructor(statusCode: number) {
    super();
    this.statusCode = statusCode;
  }
  setEncoding(): void {}
  resume(): void {}
  destroy(): void {}
}

class FakeRequest extends EventEmitter {
  destroy(error?: Error): void {
    if (error) {
      this.emit("error", error);
    }
  }
}

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


describe("prebuilt release install failure paths (#495)", () => {
  let tempCargoHome: string;
  let originalCargoHome: string | undefined;
  let originalRunnerTemp: string | undefined;
  let tempToolCache: string;
  let originalToolCache: string | undefined;

  const RESOLVED: ResolvedVersion = { version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" };
  const LINUX_X64_ASSET = `stellar-canary-${RESOLVED.version}-x86_64-unknown-linux-gnu.tar.gz`;
  const DOWNLOAD_URL = "https://example.test/prebuilt-download";
  const MANIFEST_URL = "https://example.test/SHA256SUMS";
  const archiveBytes = Buffer.from("test-archive-payload");
  const manifest = `${crypto.createHash("sha256").update(archiveBytes).digest("hex")}  ${LINUX_X64_ASSET}\n`;

  function installedBinaryPath(): string {
    return path.join(tempCargoHome, "stellar-canary-action", "bin", "stellar-canary");
  }

  function releaseBody(): string {
    return JSON.stringify({
      assets: [
        { name: LINUX_X64_ASSET, browser_download_url: DOWNLOAD_URL },
        { name: "SHA256SUMS", browser_download_url: MANIFEST_URL },
      ],
    });
  }

  let customTarExtract: ((archivePath: string, destDir: string) => void) | undefined;
  let tarFailsToStart = false;
  let tarExitCode = 0;

  function cargoInstallSpawned(): boolean {
    return spawnMock.mock.calls.some(
      (call) => call[0] === "cargo" && Array.isArray(call[1]) && (call[1] as string[])[0] === "install",
    );
  }

  function flatExtract(archivePath: string, destDir: string): void {
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, "stellar-canary"), `extracted-from-${path.basename(archivePath)}`);
  }

  function getStagingDirs(): string[] {
    return fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("protocolcanary-prebuilt-"));
  }

  function assertNeverExecutedDownloadedFiles(): void {
    for (const call of execMock.mock.calls) {
      const cmd = String(call[0]);
      expect(cmd).not.toContain("protocolcanary-prebuilt-");
    }
    for (const call of spawnMock.mock.calls) {
      const cmd = String(call[0]);
      expect(cmd).not.toContain("protocolcanary-prebuilt-");
      if (Array.isArray(call[1])) {
        for (const arg of call[1] as string[]) {
          if (cmd !== "tar") {
            expect(arg).not.toContain("protocolcanary-prebuilt-");
          }
        }
      }
    }
  }

  interface ServeOptions {
    readonly releaseBody?: string | undefined;
    readonly manifestBody?: string | undefined;
    readonly onDownload?: ((res: FakeResponse, req: FakeRequest, callback: (res: FakeResponse) => void) => void) | undefined;
  }

  function serveRelease(options: ServeOptions): void {
    let stopServingAfterDownload = false;
    httpsGetMock.mockImplementation(((url: string, _opts: unknown, callback: (res: FakeResponse) => void) => {
      const req = new FakeRequest();
      const res = new FakeResponse(200);

      if (stopServingAfterDownload) {
        res.statusCode = 404;
        callback(res);
        queueMicrotask(() => res.emit("end"));
        return req;
      }

      if (url === `${CANARY_API_REPO_URL}/releases/tags/v${RESOLVED.version}`) {
        callback(res);
        queueMicrotask(() => {
          res.emit("data", options.releaseBody ?? releaseBody());
          res.emit("end");
        });
      } else if (url === MANIFEST_URL) {
        callback(res);
        queueMicrotask(() => {
          res.emit("data", options.manifestBody ?? manifest);
          res.emit("end");
        });
      } else if (url === DOWNLOAD_URL || url.startsWith("https://example.test/redirect-")) {
        stopServingAfterDownload = true;
        if (options.onDownload) {
          options.onDownload(res, req, callback);
        } else {
          callback(res);
          queueMicrotask(() => {
            res.emit("data", archiveBytes);
            res.emit("end");
          });
        }
      } else {
        res.statusCode = 404;
        callback(res);
        queueMicrotask(() => res.emit("end"));
      }
      return req;
    }) as never);
  }

  beforeEach(() => {
    tempCargoHome = fs.mkdtempSync(path.join(os.tmpdir(), "canary-failures-cargo-home-"));
    fs.mkdirSync(path.join(tempCargoHome, "bin"), { recursive: true });
    originalCargoHome = process.env.CARGO_HOME;
    originalRunnerTemp = process.env.RUNNER_TEMP;
    process.env.CARGO_HOME = tempCargoHome;
    process.env.RUNNER_TEMP = tempCargoHome;

    tempToolCache = fs.mkdtempSync(path.join(os.tmpdir(), "canary-failures-toolcache-"));
    originalToolCache = process.env.RUNNER_TOOL_CACHE;
    process.env.RUNNER_TOOL_CACHE = tempToolCache;

    cacheMocks.isFeatureAvailableMock.mockReset().mockReturnValue(false);
    cacheMocks.restoreCacheMock.mockReset().mockResolvedValue(undefined);
    cacheMocks.saveCacheMock.mockReset().mockResolvedValue(undefined);
    osMocks.homedirMock.mockReset().mockReturnValue(tempCargoHome);
    coreMocks.infoMock.mockReset();
    coreMocks.debugMock.mockReset();
    coreMocks.warningMock.mockReset();
    coreMocks.addPathMock.mockReset();
    fsMocks.createReadStreamMock.mockReset().mockReturnValue(undefined);

    httpsGetMock.mockReset();
    execMock.mockReset();
    spawnMock.mockReset();
    customTarExtract = flatExtract;
    tarFailsToStart = false;
    tarExitCode = 0;

    spawnMock.mockImplementation((command: string, args: readonly string[] = []) => {
      if (command === "cargo" && args[0] === "--version") {
        return new ImmediateChild(0, "cargo 1.0.0\n") as unknown as ChildProcess;
      }
      if (command === "cargo" && args[0] === "install") {
        const binary = installedBinaryPath();
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.writeFileSync(binary, "cargo-installed-binary", { mode: 0o755 });
        return new ImmediateChild(0) as unknown as ChildProcess;
      }
      if (command === "tar") {
        if (tarFailsToStart) {
          return new SpawnErrorChild("ENOENT: tar not found") as unknown as ChildProcess;
        }
        if (tarExitCode !== 0) {
          return new ImmediateChild(tarExitCode) as unknown as ChildProcess;
        }
        if (customTarExtract) {
          try {
            customTarExtract(args[1] as string, args[3] as string);
          } catch {
            return new ImmediateChild(1) as unknown as ChildProcess;
          }
        }
        return new ImmediateChild(0) as unknown as ChildProcess;
      }
      if (args[0] === "version" || args.includes("version")) {
        return new ImmediateChild(0, "stellar-canary 0.1.0\n") as unknown as ChildProcess;
      }
      return new ImmediateChild(0) as unknown as ChildProcess;
    });
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
    for (const dir of getStagingDirs()) {
      try {
        fs.rmSync(path.join(os.tmpdir(), dir), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  describe("httpsGetFile download failure branches", () => {
    it("falls back to cargo install on a 3xx response without a Location header", async () => {
      serveRelease({
        onDownload: (res, _req, callback) => {
          res.statusCode = 302;
          callback(res);
          queueMicrotask(() => res.emit("end"));
        },
      });

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.binaryPath).toBe(installedBinaryPath());
      expect(coreMocks.warningMock).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`Failed to download the prebuilt Protocol-Canary asset ${LINUX_X64_ASSET}`)),
      );
      expect(coreMocks.warningMock).toHaveBeenCalledWith(expect.stringContaining("no followable Location header"));
      expect(spawnMock).toHaveBeenCalled();
      assertNeverExecutedDownloadedFiles();
      expect(getStagingDirs()).toEqual([]);
    });

    it("falls back to cargo install on a redirect to an invalid URL", async () => {
      serveRelease({
        onDownload: (res, _req, callback) => {
          res.statusCode = 302;
          res.headers.location = "http://[invalid-host";
          callback(res);
          queueMicrotask(() => res.emit("end"));
        },
      });

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.binaryPath).toBe(installedBinaryPath());
      expect(coreMocks.warningMock).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`Failed to download the prebuilt Protocol-Canary asset ${LINUX_X64_ASSET}`)),
      );
      expect(coreMocks.warningMock).toHaveBeenCalledWith(expect.stringContaining("invalid redirect target"));
      expect(spawnMock).toHaveBeenCalled();
      assertNeverExecutedDownloadedFiles();
      expect(getStagingDirs()).toEqual([]);
    });

    it("falls back to cargo install when the redirect limit is exhausted", async () => {
      let redirectCount = 0;
      serveRelease({
        onDownload: (res, _req, callback) => {
          redirectCount += 1;
          res.statusCode = 302;
          res.headers.location = `https://example.test/redirect-${redirectCount}`;
          callback(res);
          queueMicrotask(() => res.emit("end"));
        },
      });

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.binaryPath).toBe(installedBinaryPath());
      expect(coreMocks.warningMock).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`Failed to download the prebuilt Protocol-Canary asset ${LINUX_X64_ASSET}`)),
      );
      expect(spawnMock).toHaveBeenCalled();
      assertNeverExecutedDownloadedFiles();
      expect(getStagingDirs()).toEqual([]);
    });

    it("falls back to cargo install on a final status other than 200", async () => {
      serveRelease({
        onDownload: (res, _req, callback) => {
          res.statusCode = 500;
          callback(res);
          queueMicrotask(() => res.emit("end"));
        },
      });

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.binaryPath).toBe(installedBinaryPath());
      expect(coreMocks.warningMock).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`Failed to download the prebuilt Protocol-Canary asset ${LINUX_X64_ASSET}`)),
      );
      expect(coreMocks.warningMock).toHaveBeenCalledWith(expect.stringContaining("GitHub returned status 500"));
      expect(spawnMock).toHaveBeenCalled();
      assertNeverExecutedDownloadedFiles();
      expect(getStagingDirs()).toEqual([]);
    });

    it("falls back to cargo install on a response stream error", async () => {
      serveRelease({
        onDownload: (res, _req, callback) => {
          callback(res);
          queueMicrotask(() => {
            res.emit("error", new Error("simulated transport reset"));
          });
        },
      });

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.binaryPath).toBe(installedBinaryPath());
      expect(coreMocks.warningMock).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`Failed to download the prebuilt Protocol-Canary asset ${LINUX_X64_ASSET}`)),
      );
      expect(coreMocks.warningMock).toHaveBeenCalledWith(expect.stringContaining("simulated transport reset"));
      expect(spawnMock).toHaveBeenCalled();
      assertNeverExecutedDownloadedFiles();
      expect(getStagingDirs()).toEqual([]);
    });

    it("falls back to cargo install on a request timeout", async () => {
      serveRelease({
        onDownload: (_res, req) => {
          queueMicrotask(() => {
            req.emit("timeout");
          });
        },
      });

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.binaryPath).toBe(installedBinaryPath());
      expect(coreMocks.warningMock).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`Failed to download the prebuilt Protocol-Canary asset ${LINUX_X64_ASSET}`)),
      );
      expect(coreMocks.warningMock).toHaveBeenCalledWith(expect.stringContaining("timed out downloading"));
      expect(spawnMock).toHaveBeenCalled();
      assertNeverExecutedDownloadedFiles();
      expect(getStagingDirs()).toEqual([]);
    });
  });

  describe("extractPrebuiltArchive failure branches", () => {
    it("falls back to cargo install when tar cannot start", async () => {
      serveRelease({});
      tarFailsToStart = true;

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.binaryPath).toBe(installedBinaryPath());
      expect(coreMocks.warningMock).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`Could not extract the prebuilt Protocol-Canary asset ${LINUX_X64_ASSET}`)),
      );
      expect(coreMocks.warningMock).toHaveBeenCalledWith(expect.stringContaining("Failed to start `tar`"));
      expect(cargoInstallSpawned()).toBe(true);
      assertNeverExecutedDownloadedFiles();
      expect(getStagingDirs()).toEqual([]);
    });

    it("falls back to cargo install when tar exits non-zero", async () => {
      serveRelease({});
      tarExitCode = 2;

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.binaryPath).toBe(installedBinaryPath());
      expect(coreMocks.warningMock).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`Could not extract the prebuilt Protocol-Canary asset ${LINUX_X64_ASSET}`)),
      );
      expect(coreMocks.warningMock).toHaveBeenCalledWith(expect.stringContaining("`tar -xf` exited with code 2"));
      expect(cargoInstallSpawned()).toBe(true);
      assertNeverExecutedDownloadedFiles();
      expect(getStagingDirs()).toEqual([]);
    });
  });

  describe("findExtractedBinary and installPrebuiltRelease failure branches", () => {
    it("locates the executable when nested deeply inside subdirectories", async () => {
      serveRelease({});
      customTarExtract = (_archive, dest) => {
        const deepDir = path.join(dest, "top-dir", "nested-sub", "bin");
        fs.mkdirSync(deepDir, { recursive: true });
        fs.writeFileSync(path.join(deepDir, "stellar-canary"), "nested-binary");
      };

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.version).toBe("0.1.0");
      expect(installed.binaryPath).toBe(installedBinaryPath());
      expect(fs.readFileSync(installed.binaryPath, "utf8")).toBe("nested-binary");
      expect(cargoInstallSpawned()).toBe(false);
    });

    it("falls back to cargo install when the checksum manifest cannot be fetched", async () => {
      serveRelease({
        manifestBody: undefined,
      });
      const defaultImpl = httpsGetMock.getMockImplementation()!;
      httpsGetMock.mockImplementation(((url: string, opts: unknown, cb: (res: FakeResponse) => void) => {
        if (url === MANIFEST_URL) {
          const req = new FakeRequest();
          const res = new FakeResponse(500);
          cb(res);
          queueMicrotask(() => res.emit("end"));
          return req;
        }
        return defaultImpl(url, opts, cb);
      }) as never);

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.binaryPath).toBe(installedBinaryPath());
      expect(coreMocks.debugMock).toHaveBeenCalledWith(
        expect.stringContaining(`Could not fetch the checksum manifest for ${LINUX_X64_ASSET}`),
      );
      expect(cargoInstallSpawned()).toBe(true);
    });

    it("falls back to cargo install when the manifest has no entry for the asset", async () => {
      serveRelease({
        manifestBody: `${"a".repeat(64)}  other-asset.tar.gz\n`,
      });

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.binaryPath).toBe(installedBinaryPath());
      expect(coreMocks.warningMock).toHaveBeenCalledWith(
        expect.stringContaining(`has no entry for ${LINUX_X64_ASSET}`),
      );
      expect(cargoInstallSpawned()).toBe(true);
    });

    it("falls back to cargo install when hashing the downloaded file fails", async () => {
      serveRelease({});

      fsMocks.createReadStreamMock.mockImplementationOnce((pathLike: string) => {
        if (typeof pathLike === "string" && pathLike.includes(LINUX_X64_ASSET)) {
          const stream = new PassThrough();
          queueMicrotask(() => stream.emit("error", new Error("simulated I/O read failure")));
          return stream;
        }
        return undefined;
      });

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.binaryPath).toBe(installedBinaryPath());
      expect(coreMocks.warningMock).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`Could not hash the downloaded asset ${LINUX_X64_ASSET}`)),
      );
      expect(cargoInstallSpawned()).toBe(true);
      assertNeverExecutedDownloadedFiles();
      expect(getStagingDirs()).toEqual([]);
    });

    it("falls back to cargo install when the extracted archive holds no executable", async () => {
      serveRelease({});

      // Extract archive with no executable
      customTarExtract = (_archive, dest) => {
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, "README.txt"), "no executable here");
      };

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.binaryPath).toBe(installedBinaryPath());
      expect(coreMocks.warningMock).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`contains no stellar-canary executable`)),
      );
      expect(coreMocks.warningMock).toHaveBeenCalledWith(expect.stringContaining(LINUX_X64_ASSET));
      expect(cargoInstallSpawned()).toBe(true);
      assertNeverExecutedDownloadedFiles();
      expect(getStagingDirs()).toEqual([]);
    });

    it("throws InstallationFailedError on checksum mismatch and saves nothing to cache", async () => {
      serveRelease({
        manifestBody: `${"e".repeat(64)}  ${LINUX_X64_ASSET}\n`,
      });

      await expect(
        withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED))),
      ).rejects.toThrow(InstallationFailedError);

      expect(cacheMocks.saveCacheMock).not.toHaveBeenCalled();
      expect(cargoInstallSpawned()).toBe(false);
      expect(getStagingDirs()).toEqual([]);
    });
  });
});
