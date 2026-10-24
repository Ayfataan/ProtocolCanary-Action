import type * as actionsCore from "@actions/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #521: the version probe, the `tar` extraction and the `cargo --version`
// probe are bounded. Unlike tests/unit/canary.test.ts (which asserts the
// wiring against mocked children), these tests exercise the bounds against
// REAL child processes that spawn and then never exit, so the timeout,
// the termination, and the resulting error/warning are the production
// code paths end to end. The stand-in is a Node script so it runs on the
// Windows, macOS and Linux runners; no test here sleeps longer than about
// two seconds.

const { warningMock } = vi.hoisted(() => ({ warningMock: vi.fn() }));

// Partial mock per CONTRIBUTING.md: only `warning` is overridden, so the
// rest of @actions/core keeps working through the real module.
vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof actionsCore>();
  return { ...actual, warning: warningMock };
});

import {
  CARGO_PROBE_TIMEOUT_MS,
  TAR_EXTRACTION_TIMEOUT_MS,
  VERSION_PROBE_TIMEOUT_MS,
  ensureCargoAvailable,
  extractPrebuiltArchive,
  getInstalledVersion,
} from "../../src/canary";
import { InstallationFailedError } from "../../src/errors";

/** Injected bound so a hanging stand-in resolves fast; every assertion
 * below tolerates at most a couple of seconds of wall time. */
const SHORT_BOUND_MS = 600;

/** Stand-in child body: records its PID (so the test can assert the child
 * is gone after the timeout) and then either answers and exits, or hangs
 * forever. Behaviour is selected through STANDIN_MODE. */
const STANDIN_SOURCE = [
  'const fs = require("node:fs");',
  'const pidFile = process.env.STANDIN_PID_FILE;',
  'if (pidFile) { fs.writeFileSync(pidFile, String(process.pid)); }',
  'const mode = process.env.STANDIN_MODE ?? "hang";',
  'if (mode === "print") { process.stdout.write("stellar-canary 0.1.0\\n"); process.exit(0); }',
  'if (mode === "fail") { process.exit(1); }',
  "setInterval(() => {}, 1000); // never exits",
].join("\n");

/** Waits until the process no longer exists (or the deadline passes). */
async function waitForChildGone(pid: number, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() - start >= deadlineMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The recorded stand-in PID, or undefined when the child never wrote it. */
function standinPid(): number | undefined {
  try {
    return Number(fs.readFileSync(pidFile, "utf8"));
  } catch {
    return undefined;
  }
}

let tempDir: string;
let standinPath: string;
let pidFile: string;
let savedPath: string | undefined;
let savedMode: string | undefined;
let savedPidFile: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-bounds-"));
  standinPath = path.join(tempDir, "stand-in.cjs");
  fs.writeFileSync(standinPath, `${STANDIN_SOURCE}\n`);
  pidFile = path.join(tempDir, "standin.pid");
  savedPath = process.env.PATH;
  savedMode = process.env.STANDIN_MODE;
  savedPidFile = process.env.STANDIN_PID_FILE;
  process.env.STANDIN_PID_FILE = pidFile;
  process.env.STANDIN_MODE = "hang";
  warningMock.mockReset();
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedMode === undefined) delete process.env.STANDIN_MODE;
  else process.env.STANDIN_MODE = savedMode;
  if (savedPidFile === undefined) delete process.env.STANDIN_PID_FILE;
  else process.env.STANDIN_PID_FILE = savedPidFile;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Puts a shim named `name` on PATH that runs the stand-in script. Works
 * wherever a PATH-resolved command can be an executable script (Linux and
 * macOS); Windows resolves only real executables by name, so the shim
 * tests below skip there with a visible reason. */
function installShim(name: "tar" | "cargo"): void {
  fs.writeFileSync(path.join(tempDir, name), `#!/usr/bin/env node\n${STANDIN_SOURCE}\n`, { mode: 0o755 });
  process.env.PATH = `${tempDir}${path.delimiter}${savedPath ?? ""}`;
}

// On win32 a PATH shim cannot be spawned by bare name (`tar`/`cargo` resolve
// to real executables or nothing, never a script), so the shim-driven tests
// are POSIX-only — the same platform gating tests/unit/runner.test.ts uses
// for its Unix-signal behaviour. The timeout code path itself is shared.
const itShim = process.platform === "win32" ? it.skip : it;

describe("documented helper-process bounds (#521)", () => {
  it("ships a 30s bound for both version probes and a 5-minute bound for tar", () => {
    expect(VERSION_PROBE_TIMEOUT_MS).toBe(30_000);
    expect(CARGO_PROBE_TIMEOUT_MS).toBe(30_000);
    expect(TAR_EXTRACTION_TIMEOUT_MS).toBe(5 * 60_000);
  });
});

describe("getInstalledVersion bounds (#521)", () => {
  it("terminates a probe that never exits, warns naming it, and returns undefined", async () => {
    // On every platform the stand-in runs through `node` with its path as a
    // leading argv element (the renderJUnitReport pattern), so the exact
    // same test runs on the Windows, macOS and Linux runners.
    const started = Date.now();
    const version = await getInstalledVersion(process.execPath, SHORT_BOUND_MS, [standinPath]);

    expect(version).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(warningMock).toHaveBeenCalledTimes(1);
    const warningText = String(warningMock.mock.calls[0]?.[0]);
    expect(warningText).toContain(process.execPath);
    expect(warningText).toContain("did not finish within");

    // The child must actually be gone, not merely abandoned.
    const pid = standinPid();
    expect(pid, "the stand-in recorded its PID").toBeDefined();
    await expect(waitForChildGone(pid as number, 2_000)).resolves.toBe(true);
  });

  it("still yields the reported version when the probe prints and exits 0", async () => {
    process.env.STANDIN_MODE = "print";

    const version = await getInstalledVersion(process.execPath, SHORT_BOUND_MS, [standinPath]);

    expect(version).toBe("0.1.0");
    expect(warningMock).not.toHaveBeenCalled();
  });

  it("still returns undefined when the probe exits non-zero", async () => {
    process.env.STANDIN_MODE = "fail";

    const version = await getInstalledVersion(process.execPath, SHORT_BOUND_MS, [standinPath]);

    expect(version).toBeUndefined();
    expect(warningMock).not.toHaveBeenCalled();
  });
});

describe("extractPrebuiltArchive bounds (#521)", () => {
  itShim("terminates a tar that never exits and fails with an error naming the bound", async () => {
    installShim("tar");
    const archivePath = path.join(tempDir, "asset.tar.gz");
    fs.writeFileSync(archivePath, "not really an archive");
    const destDir = path.join(tempDir, "extracted");

    const error = await captureError(extractPrebuiltArchive(archivePath, destDir, SHORT_BOUND_MS));

    expect(error).toBeInstanceOf(InstallationFailedError);
    expect((error as InstallationFailedError).message).toContain("did not finish within");
    // A partially extracted directory must never be left usable.
    expect(fs.readdirSync(destDir)).toEqual([]);
    const pid = standinPid();
    expect(pid, "the stand-in recorded its PID").toBeDefined();
    await expect(waitForChildGone(pid as number, 2_000)).resolves.toBe(true);
  });
});

describe("ensureCargoAvailable bounds (#521)", () => {
  itShim("fails with the cargo-not-available error when the probe never exits, naming the bound", async () => {
    installShim("cargo");

    const error = await captureError(ensureCargoAvailable(SHORT_BOUND_MS));

    expect(error).toBeInstanceOf(InstallationFailedError);
    const message = (error as InstallationFailedError).message;
    expect(message).toContain("The `cargo` command was not found on this runner");
    expect(message).toContain("did not finish within");
    const pid = standinPid();
    expect(pid, "the stand-in recorded its PID").toBeDefined();
    await expect(waitForChildGone(pid as number, 2_000)).resolves.toBe(true);
  });

  itShim("treats a cargo probe that exits non-zero as unavailable", async () => {
    installShim("cargo");
    process.env.STANDIN_MODE = "fail";

    const error = await captureError(ensureCargoAvailable(SHORT_BOUND_MS));

    expect(error).toBeInstanceOf(InstallationFailedError);
    expect((error as InstallationFailedError).message).toContain("exited with code 1");
  });
});
