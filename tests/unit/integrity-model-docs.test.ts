/**
 * Documentation gate for issue #376 (Security Model, Integrity Guarantees,
 * and Trust Boundaries).
 *
 * The document deliberately lives at `docs/integrity-model.md`, not at the
 * `docs/security-model.md` path named in the issue: that path is created by
 * open PR #461 (its fork-PR threat model, asserted by
 * `tests/unit/fork-boundary.test.ts`), and two unmerged PRs adding the same
 * path with different content is the one collision no later rebase resolves
 * without deleting a maintainer's text. The two documents are siblings on
 * different axes and cross-reference each other.
 *
 * Tests here keep the document honest: the required topics must be present,
 * the stated facts about D-07/D-11 must not overstate, every relative link
 * must resolve on disk (issue #376 "Negative testing: verify all
 * documentation links resolve cleanly"), and SECURITY.md must point at it.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(__dirname, "..", "..");
const DOC_PATH = path.join(REPO_ROOT, "docs", "integrity-model.md");

function doc(): string {
  return fs.readFileSync(DOC_PATH, "utf8");
}

/** Relative (non-anchor, non-URL) link targets inside the document. */
function relativeLinkTargets(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1] ?? "";
    if (/^(https?:|mailto:|#)/.test(target)) {
      continue;
    }
    targets.push(target.split("#")[0] ?? "");
  }
  return targets.filter((target) => target !== "");
}

describe("docs/integrity-model.md (issue #376)", () => {
  it("exists", () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
  });

  it("documents the strict-integrity policy introduced by #372", () => {
    const contents = doc();
    expect(contents).toContain("strict-integrity");
    expect(contents).toContain("fail closed");
    // The default must be stated honestly: compatibility-preserving false.
    expect(contents).toMatch(/default(?:s)? (?:to )?`?false/i);
  });

  it("records D-07 and D-11 at their true status without overstating", () => {
    const contents = doc();
    expect(contents).toContain("D-07");
    expect(contents).toContain("D-11");
    // Checksums are data integrity, never author authenticity.
    expect(contents).toMatch(/not.*proof of.*authenticit/i);
    // Redirect policy is unresolved, not "allowlisted".
    expect(contents).toMatch(/redirect.*(unresolved|blocked|not \(yet\)? follow)/i);
  });

  it("documents least-privilege workflow permissions and the fork PR trust boundary (#369)", () => {
    const contents = doc();
    expect(contents).toMatch(/least[- ]privilege/i);
    expect(contents).toMatch(/fork PR/i);
  });

  it("contains a threat model section", () => {
    expect(doc()).toMatch(/^##.*threat model/im);
  });

  it("links only to files that exist in the repository", () => {
    for (const target of relativeLinkTargets(doc())) {
      const resolved = path.resolve(path.dirname(DOC_PATH), target);
      expect(
        fs.existsSync(resolved),
        `broken relative link in docs/integrity-model.md -> ${target}`,
      ).toBe(true);
    }
  });

  it("is linked from SECURITY.md", () => {
    const security = fs.readFileSync(path.join(REPO_ROOT, "SECURITY.md"), "utf8");
    expect(security).toContain("docs/integrity-model.md");
  });
});
