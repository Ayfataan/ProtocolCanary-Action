// @ts-check
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Parses an allow-list text file contents into a Set of allowed file names.
 * Strips comments (lines starting with '#') and ignores blank lines.
 *
 * @param {string} content
 * @returns {Set<string>}
 */
export function parseAllowlist(content) {
  const allowed = new Set();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    allowed.add(trimmed);
  }
  return allowed;
}

/**
 * Pure comparison logic: finds any files that are not in the allowed list,
 * filtering only root files (files without a directory part / path separator).
 * Returns unexpected root file names sorted in stable lexicographical order.
 *
 * @param {readonly string[]} files
 * @param {Set<string> | readonly string[]} allowed
 * @returns {string[]}
 */
export function findUnexpectedRootFiles(files, allowed) {
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  const unexpected = [];

  for (const file of files) {
    // Normalise any backslashes (e.g. Windows paths) to forward slashes
    const normalized = file.replace(/\\/g, "/");
    // Only check root files: entries with no directory part
    if (normalized.includes("/")) {
      continue;
    }
    if (normalized.trim() === "") {
      continue;
    }
    if (!allowedSet.has(normalized)) {
      unexpected.push(normalized);
    }
  }

  return unexpected.sort();
}

/**
 * Finds entries in the allow-list that are no longer tracked in the root files.
 * Non-fatal informational check.
 *
 * @param {readonly string[]} rootFiles
 * @param {Set<string> | readonly string[]} allowed
 * @returns {string[]}
 */
export function findStaleAllowlistEntries(rootFiles, allowed) {
  const allowedList = allowed instanceof Set ? Array.from(allowed) : allowed;
  const rootSet = new Set(
    rootFiles
      .map((f) => f.replace(/\\/g, "/"))
      .filter((f) => !f.includes("/") && f.trim() !== ""),
  );
  const stale = [];
  for (const item of allowedList) {
    if (!rootSet.has(item)) {
      stale.push(item);
    }
  }
  return stale.sort();
}

/**
 * Queries git for all tracked files in the repository.
 * Uses `git ls-files -z` to safely handle file names with unusual characters.
 *
 * @param {string} [repoRoot]
 * @returns {string[]}
 */
export function getTrackedFiles(repoRoot) {
  const cwd = repoRoot ?? process.cwd();
  try {
    const output = execFileSync("git", ["ls-files", "-z"], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.split("\0").filter((f) => f.length > 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to list tracked files via git ls-files: ${message}`);
  }
}

/**
 * Main entry point for the CLI guard.
 *
 * @param {string} [repoRoot]
 * @param {string} [allowlistPath]
 * @returns {number}
 */
export function runRootGuard(repoRoot, allowlistPath) {
  const root = repoRoot ?? process.cwd();
  const allowlistFile =
    allowlistPath ?? path.join(root, "scripts", "root-allowlist.txt");

  if (!fs.existsSync(allowlistFile)) {
    console.error(`Root allow-list file not found: ${allowlistFile}`);
    return 1;
  }

  const allowlistContent = fs.readFileSync(allowlistFile, "utf8");
  const allowed = parseAllowlist(allowlistContent);
  const trackedFiles = getTrackedFiles(root);

  const unexpected = findUnexpectedRootFiles(trackedFiles, allowed);
  const stale = findStaleAllowlistEntries(trackedFiles, allowed);

  if (stale.length > 0) {
    console.warn("Note: The following allow-list entries are no longer tracked in the root:");
    for (const item of stale) {
      console.warn(`  - ${item}`);
    }
  }

  if (unexpected.length > 0) {
    console.error("Error: Found unexpected tracked files in the repository root:");
    for (const file of unexpected) {
      console.error(`  - ${file}`);
    }
    console.error(
      "\nTo fix this:\n" +
        "  1. Move the file into an appropriate subdirectory (e.g. docs/, scripts/, tests/), or\n" +
        "  2. If the file legitimately belongs in the repository root, add it to scripts/root-allowlist.txt.",
    );
    return 1;
  }

  console.log("All tracked root files match the allow-list.");
  return 0;
}

// CLI execution check
const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectExecution) {
  const exitCode = runRootGuard();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
