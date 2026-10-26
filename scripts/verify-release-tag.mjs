#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

/**
 * Validates a release tag against package.json version and CHANGELOG.md headings.
 *
 * Rules:
 *  1. Tag must strictly match `vX.Y.Z` (semantic versioning, pre-releases rejected).
 *  2. Tag version `X.Y.Z` must exactly equal `package.json`'s `version`.
 *  3. CHANGELOG.md must contain a version heading for `## [X.Y.Z]` (optionally followed by date).
 */
export function verifyReleaseTag(tag, rootDir = process.cwd()) {
  if (!tag || typeof tag !== "string" || tag.trim() === "") {
    throw new Error("Release tag is required and cannot be empty.");
  }

  const trimmedTag = tag.trim();

  // Strict SemVer regex for release tags: vMAJOR.MINOR.PATCH
  // Pre-release suffixes (e.g. -rc.1) and missing 'v' prefixes are rejected.
  const tagMatch = /^v([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(trimmedTag);
  if (!tagMatch) {
    throw new Error(
      `Malformed release tag "${trimmedTag}". Tags must follow the exact format "vX.Y.Z" (e.g. "v1.2.3"). Pre-release suffixes and missing 'v' prefixes are not allowed.`,
    );
  }

  const tagVersion = trimmedTag.slice(1); // strip leading 'v'

  // 1. Verify against package.json
  const packageJsonPath = path.resolve(rootDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found at ${packageJsonPath}`);
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse package.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (pkg.version !== tagVersion) {
    throw new Error(
      `Release tag version mismatch: tag "${trimmedTag}" specifies version "${tagVersion}", but package.json declares "${pkg.version}".`,
    );
  }

  // 2. Verify against CHANGELOG.md
  const changelogPath = path.resolve(rootDir, "CHANGELOG.md");
  if (!fs.existsSync(changelogPath)) {
    throw new Error(`CHANGELOG.md not found at ${changelogPath}`);
  }

  const changelogContent = fs.readFileSync(changelogPath, "utf8");

  // Matches headings like:
  // ## [0.1.1]
  // ## [0.1.1] - 2026-10-20
  // ## 0.1.1
  const escapedVersion = tagVersion.replace(/\./g, "\\.");
  const headingRegex = new RegExp(`^##\\s+(?:\\[${escapedVersion}\\]|${escapedVersion})(?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`, "m");

  if (!headingRegex.test(changelogContent)) {
    throw new Error(
      `CHANGELOG.md has no release heading for version "${tagVersion}". Expected heading "## [${tagVersion}]" (with optional date " - YYYY-MM-DD").`,
    );
  }

  return { tag: trimmedTag, version: tagVersion };
}

// When executed directly as CLI
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const tag = process.argv[2] || process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
  try {
    const result = verifyReleaseTag(tag);
    console.log(`✅ Release tag "${result.tag}" matches package.json ("${result.version}") and CHANGELOG.md.`);
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
