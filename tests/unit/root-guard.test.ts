import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Import directly from the ESM script
import {
  findStaleAllowlistEntries,
  findUnexpectedRootFiles,
  getTrackedFiles,
  parseAllowlist,
  runRootGuard,
} from "../../scripts/check-root-files.mjs";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "check-root-files.mjs");
const ALLOWLIST_PATH = path.join(REPO_ROOT, "scripts", "root-allowlist.txt");

describe("root guard - pure logic", () => {
  describe("parseAllowlist", () => {
    it("parses filenames and ignores blank lines and comments", () => {
      const content = `
# Comment line
README.md

package.json
# Another comment
.gitignore
  # indented comment
action.yml  
`;
      const allowed = parseAllowlist(content);
      expect(allowed).toBeInstanceOf(Set);
      expect(Array.from(allowed).sort()).toEqual([
        ".gitignore",
        "README.md",
        "action.yml",
        "package.json",
      ]);
    });

    it("handles empty allow-list content", () => {
      expect(Array.from(parseAllowlist("")).length).toBe(0);
      expect(Array.from(parseAllowlist("# only comments\n# second comment")).length).toBe(0);
    });
  });

  describe("findUnexpectedRootFiles", () => {
    it("returns empty array when all root files are allowed", () => {
      const files = ["README.md", "package.json", "src/index.ts", "tests/foo.test.ts"];
      const allowed = new Set(["README.md", "package.json"]);
      expect(findUnexpectedRootFiles(files, allowed)).toEqual([]);
    });

    it("reports a single stray root file by name", () => {
      const files = ["README.md", "package.json", "stray.txt", "src/index.ts"];
      const allowed = new Set(["README.md", "package.json"]);
      expect(findUnexpectedRootFiles(files, allowed)).toEqual(["stray.txt"]);
    });

    it("reports several strays in stable lexicographical order", () => {
      const files = ["z.md", "a.txt", "m.json", "README.md", "src/deep/file.ts"];
      const allowed = new Set(["README.md"]);
      expect(findUnexpectedRootFiles(files, allowed)).toEqual(["a.txt", "m.json", "z.md"]);
    });

    it("ignores files in subdirectories even if they are not in the allow-list", () => {
      const files = [
        "README.md",
        "docs/guide.md",
        "scripts/build.mjs",
        ".github/workflows/ci.yml",
        "nested/dir/deep/file.txt",
      ];
      const allowed = new Set(["README.md"]);
      expect(findUnexpectedRootFiles(files, allowed)).toEqual([]);
    });

    it("normalises Windows backslashes so nested Windows paths are ignored", () => {
      const files = ["README.md", "docs\\guide.md", "src\\sub\\file.ts", "stray.log"];
      const allowed = new Set(["README.md"]);
      expect(findUnexpectedRootFiles(files, allowed)).toEqual(["stray.log"]);
    });

    it("handles empty file list and empty allow list", () => {
      expect(findUnexpectedRootFiles([], new Set())).toEqual([]);
      expect(findUnexpectedRootFiles(["stray.md"], new Set())).toEqual(["stray.md"]);
      expect(findUnexpectedRootFiles([], new Set(["README.md"]))).toEqual([]);
    });

    it("accepts an array for allowed in addition to a Set", () => {
      const files = ["README.md", "other.md"];
      expect(findUnexpectedRootFiles(files, ["README.md"])).toEqual(["other.md"]);
    });
  });

  describe("findStaleAllowlistEntries", () => {
    it("reports allow-list entries that do not exist among root tracked files", () => {
      const rootFiles = ["README.md", "package.json"];
      const allowed = ["README.md", "package.json", "OLD_FILE.md", "REMOVED.txt"];
      expect(findStaleAllowlistEntries(rootFiles, allowed)).toEqual(["OLD_FILE.md", "REMOVED.txt"]);
    });

    it("returns empty when all allow-list entries exist", () => {
      const rootFiles = ["README.md", "package.json", "src/foo.ts"];
      const allowed = ["README.md", "package.json"];
      expect(findStaleAllowlistEntries(rootFiles, allowed)).toEqual([]);
    });
  });
});

describe("root guard - git-backed integration", () => {
  const tempDirs: string[] = [];

  function createTempGitRepo(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "root-guard-test-"));
    tempDirs.push(tempDir);

    // Initialise git repository with clean local config independent of global config
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: tempDir,
      stdio: "ignore",
    });

    return tempDir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
    tempDirs.length = 0;
  });

  it("lists tracked files using git ls-files -z via getTrackedFiles", () => {
    const repo = createTempGitRepo();
    fs.writeFileSync(path.join(repo, "root1.txt"), "hello");
    fs.mkdirSync(path.join(repo, "sub"));
    fs.writeFileSync(path.join(repo, "sub", "child.txt"), "world");

    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repo, stdio: "ignore" });

    const tracked = getTrackedFiles(repo);
    expect(tracked).toContain("root1.txt");
    expect(tracked).toContain("sub/child.txt");
  });

  it("fails CLI invocation with non-zero exit code when stray root file is present", () => {
    const repo = createTempGitRepo();
    fs.writeFileSync(path.join(repo, "allowed.txt"), "ok");
    fs.mkdirSync(path.join(repo, "nested"));
    fs.writeFileSync(path.join(repo, "nested", "ignored.txt"), "nested ok");
    fs.writeFileSync(path.join(repo, "stray-root.txt"), "unexpected!");

    const allowlistDir = path.join(repo, "scripts");
    fs.mkdirSync(allowlistDir);
    fs.writeFileSync(path.join(allowlistDir, "root-allowlist.txt"), "allowed.txt\n");

    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "commit with stray"], { cwd: repo, stdio: "ignore" });

    let exitCode = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [SCRIPT_PATH], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      const procErr = err as { status?: number; stderr?: string };
      exitCode = procErr.status ?? 1;
      stderr = procErr.stderr ?? "";
    }

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("stray-root.txt");
    expect(stderr).not.toContain("nested/ignored.txt");
  });

  it("succeeds with exit 0 on a clean repository where all root files are allowed", () => {
    const repo = createTempGitRepo();
    fs.writeFileSync(path.join(repo, "README.md"), "# Hello");
    fs.mkdirSync(path.join(repo, "docs"));
    fs.writeFileSync(path.join(repo, "docs", "guide.md"), "Documentation");

    const allowlistDir = path.join(repo, "scripts");
    fs.mkdirSync(allowlistDir);
    fs.writeFileSync(path.join(allowlistDir, "root-allowlist.txt"), "README.md\n");

    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "clean commit"], { cwd: repo, stdio: "ignore" });

    const result = execFileSync(process.execPath, [SCRIPT_PATH], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    expect(result).toContain("All tracked root files match the allow-list.");
  });

  it("handles runRootGuard directly with paths", () => {
    const repo = createTempGitRepo();
    fs.writeFileSync(path.join(repo, "file.txt"), "content");
    const allowlist = path.join(repo, "custom-allowlist.txt");
    // custom-allowlist.txt is also in the root and tracked, so include it or put it in a subdir
    fs.writeFileSync(allowlist, "file.txt\ncustom-allowlist.txt\n");

    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "ok"], { cwd: repo, stdio: "ignore" });

    expect(runRootGuard(repo, allowlist)).toBe(0);

    // Now add unexpected file
    fs.writeFileSync(path.join(repo, "bad.txt"), "bad");
    execFileSync("git", ["add", "bad.txt"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "bad"], { cwd: repo, stdio: "ignore" });

    expect(runRootGuard(repo, allowlist)).toBe(1);
  });
});

describe("real repository allow-list verification", () => {
  it("real allow-list matches the real repository with zero unexpected root files", () => {
    const trackedFiles = getTrackedFiles(REPO_ROOT);
    const allowlistContent = fs.readFileSync(ALLOWLIST_PATH, "utf8");
    const allowed = parseAllowlist(allowlistContent);

    const unexpected = findUnexpectedRootFiles(trackedFiles, allowed);
    expect(unexpected).toEqual([]);
  });

  it("has no stale allow-list entries in the real repository", () => {
    const trackedFiles = getTrackedFiles(REPO_ROOT);
    const allowlistContent = fs.readFileSync(ALLOWLIST_PATH, "utf8");
    const allowed = parseAllowlist(allowlistContent);

    const stale = findStaleAllowlistEntries(trackedFiles, allowed);
    expect(stale).toEqual([]);
  });
});
