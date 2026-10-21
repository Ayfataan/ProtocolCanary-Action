/**
 * Pure comparison logic: finds any files that are not in the allowed list,
 * filtering only root files (files without a directory part / path separator).
 * Returns unexpected root file names sorted in stable lexicographical order.
 */
export function findUnexpectedRootFiles(
  files: readonly string[],
  allowed: ReadonlySet<string> | readonly string[],
): string[];

/**
 * Parses an allow-list text file contents into a Set of allowed file names.
 * Strips comments (lines starting with '#') and ignores blank lines.
 */
export function parseAllowlist(content: string): Set<string>;

/**
 * Finds entries in the allow-list that are no longer tracked in the root files.
 * Non-fatal informational check.
 */
export function findStaleAllowlistEntries(
  rootFiles: readonly string[],
  allowed: ReadonlySet<string> | readonly string[],
): string[];

/**
 * Queries git for all tracked files in the repository.
 * Uses `git ls-files -z` to safely handle file names with unusual characters.
 */
export function getTrackedFiles(repoRoot?: string): string[];

/**
 * Main entry point for the CLI guard.
 */
export function runRootGuard(repoRoot?: string, allowlistPath?: string): number;
