import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error scripts/verify-release-tag.mjs is an ES module script without a separate .d.ts
import { verifyReleaseTag } from "../../scripts/verify-release-tag.mjs";

describe("verifyReleaseTag helper (#406)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-release-tag-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupFixture(pkgVersion: string, changelogText: string) {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test-pkg", version: pkgVersion }));
    fs.writeFileSync(path.join(tmpDir, "CHANGELOG.md"), changelogText);
  }

  it("passes when the release tag matches package.json and CHANGELOG.md", () => {
    setupFixture(
      "1.2.3",
      `# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-10-20\n\n- Fix something\n\n## [1.2.2]\n`,
    );

    const result = verifyReleaseTag("v1.2.3", tmpDir);
    expect(result).toEqual({ tag: "v1.2.3", version: "1.2.3" });
  });

  it("passes when CHANGELOG.md heading has no date", () => {
    setupFixture(
      "0.1.1",
      `# Changelog\n\n## [Unreleased]\n\n## [0.1.1]\n\n- Some change\n`,
    );

    const result = verifyReleaseTag("v0.1.1", tmpDir);
    expect(result).toEqual({ tag: "v0.1.1", version: "0.1.1" });
  });

  it("fails with a clear error when tag version differs from package.json", () => {
    setupFixture(
      "1.2.2",
      `# Changelog\n\n## [Unreleased]\n\n## [1.2.3]\n`,
    );

    expect(() => verifyReleaseTag("v1.2.3", tmpDir)).toThrowError(
      /Release tag version mismatch: tag "v1\.2\.3" specifies version "1\.2\.3", but package\.json declares "1\.2\.2"/,
    );
  });

  it("fails with a message naming the missing heading when CHANGELOG.md is missing an entry", () => {
    setupFixture(
      "1.2.3",
      `# Changelog\n\n## [Unreleased]\n\n## [1.2.2]\n\n- Old change\n`,
    );

    expect(() => verifyReleaseTag("v1.2.3", tmpDir)).toThrowError(
      /CHANGELOG\.md has no release heading for version "1\.2\.3"\. Expected heading "## \[1\.2\.3\]"/,
    );
  });

  describe("malformed tag rejection", () => {
    const invalidTags = [
      "",
      "   ",
      "1.2.3",           // missing leading 'v'
      "v1.2",            // missing patch version
      "v1.2.3.4",        // 4 components
      "v1.2.3-rc.1",     // pre-release suffix
      "v1.2.3+build.1",  // build metadata
      "latest",
      "release-1.2.3",
    ];

    for (const tag of invalidTags) {
      it(`rejects invalid tag "${tag}"`, () => {
        setupFixture("1.2.3", `# Changelog\n\n## [1.2.3]\n`);
        expect(() => verifyReleaseTag(tag, tmpDir)).toThrow();
      });
    }
  });

  it("fails when package.json does not exist", () => {
    fs.writeFileSync(path.join(tmpDir, "CHANGELOG.md"), `## [1.0.0]\n`);
    expect(() => verifyReleaseTag("v1.0.0", tmpDir)).toThrowError(/package\.json not found/);
  });

  it("fails when CHANGELOG.md does not exist", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    expect(() => verifyReleaseTag("v1.0.0", tmpDir)).toThrowError(/CHANGELOG\.md not found/);
  });
});
