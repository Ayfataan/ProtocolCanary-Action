import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Result of {@link freshBuild}: the generated bundle and source map, plus
 * the temporary directory they live in (the caller removes it with
 * `cleanup` when the assertions are done).
 */
export interface FreshBuildResult {
  /** Absolute path to the freshly generated `dist/index.js`. */
  readonly bundlePath: string;
  /** Absolute path to the freshly generated `dist/index.js.map`. */
  readonly mapPath: string;
  /** Absolute path to the temporary build directory. Remove it with `cleanup`. */
  readonly tmpDir: string;
  /** Removes the temporary build directory and everything in it. */
  readonly cleanup: () => void;
}

/**
 * Builds the bundle in a temporary directory and returns the paths of the
 * generated bundle and source map. The temporary directory is removed by
 * `cleanup` (and also when the build fails). Throws with the build output
 * if the build fails — it never hangs.
 *
 * `srcDir` overrides the source directory copied into the temp build; it is
 * used by the guard tests to prove a broken build fails loudly.
 */
export function freshBuild(options: { srcDir?: string } = {}): FreshBuildResult {
  const repoRoot = path.resolve(__dirname, "../..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-guard-build-"));
  const cleanup = (): void => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  try {
    const srcDir = options.srcDir ?? path.join(repoRoot, "src");
    fs.cpSync(srcDir, path.join(tmpDir, "src"), { recursive: true });
    fs.cpSync(path.join(repoRoot, "scripts"), path.join(tmpDir, "scripts"), { recursive: true });
    fs.cpSync(path.join(repoRoot, "package.json"), path.join(tmpDir, "package.json"));
    fs.cpSync(path.join(repoRoot, "tsconfig.json"), path.join(tmpDir, "tsconfig.json"));
    fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(tmpDir, "node_modules"), "junction");

    const bundlePath = path.join(tmpDir, "dist", "index.js");
    const mapPath = path.join(tmpDir, "dist", "index.js.map");

    try {
      execFileSync(process.execPath, [path.join(tmpDir, "scripts", "build.mjs")], {
        cwd: tmpDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 50 * 1024 * 1024,
        timeout: 120_000,
      });
    } catch (error) {
      const stdout = streamOf(error, "stdout");
      const stderr = streamOf(error, "stderr");
      cleanup();
      throw new Error(
        `Fresh build in ${tmpDir} failed:\n${stdout}${stderr}\n${String(error)}`,
      );
    }

    if (!fs.existsSync(bundlePath) || !fs.existsSync(mapPath)) {
      cleanup();
      throw new Error(`Fresh build did not produce ${bundlePath} and ${mapPath}`);
    }

    return { bundlePath, mapPath, tmpDir, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Reads a `stdout`/`stderr` string off a caught value of any type. */
function streamOf(error: unknown, key: "stdout" | "stderr"): string {
  if (typeof error === "object" && error !== null && key in error) {
    const value = (error as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}
