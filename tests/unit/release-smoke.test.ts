import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #407: Tests for release workflow post-release smoke test job and dispatch contract.
 */
const REPO_ROOT = path.join(__dirname, "..", "..");
const RELEASE_WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "release.yml");
const SOURCE = fs.readFileSync(RELEASE_WORKFLOW_PATH, "utf8");

describe("release workflow post-release smoke test (#407)", () => {
  it("defines workflow_dispatch trigger with release_tag input", () => {
    expect(SOURCE).toMatch(/workflow_dispatch:\s*\r?\n\s+inputs:\s*\r?\n\s+release_tag:/);
  });

  it("declares release job with conditional execution on tag push", () => {
    expect(SOURCE).toMatch(/jobs:\s*\r?\n\s+release:\s*\r?\n\s+name: verify and publish\s*\r?\n\s+if: github\.event_name == 'push'/);
  });

  it("declares smoke-test job that depends on release job", () => {
    expect(SOURCE).toMatch(/smoke-test:\s*\r?\n\s+name: smoke test\s*\r?\n\s+needs:\s*\[release\]/);
  });

  it("runs smoke test after successful release or upon manual workflow_dispatch with release_tag", () => {
    expect(SOURCE).toContain("if: always() && (needs.release.result == 'success' || (github.event_name == 'workflow_dispatch' && inputs.release_tag != ''))");
  });

  it("checks out the target release tag of the Action and uses the pinned commit for checkout", () => {
    expect(SOURCE).toContain("repository: StellarCanary/ProtocolCanary-Action");
    expect(SOURCE).toContain("ref: ${{ steps.resolve-tag.outputs.tag }}");
    expect(SOURCE).toContain("path: .published-action");
    expect(SOURCE).toContain("persist-credentials: false");
  });

  it("runs the Action against the offline fixture directory and pinned engine version", () => {
    expect(SOURCE).toContain("uses: ./.published-action");
    expect(SOURCE).toContain("config: tests/fixtures/real-engine/offline.stellar-canary.toml");
    expect(SOURCE).toContain("fixtures-dir: tests/fixtures/real-engine/fixtures");
    expect(SOURCE).toContain('version: "0.1.1"');
    expect(SOURCE).toContain("protocol: 28");
    expect(SOURCE).toContain('allow-empty: "false"');
  });

  it("verifies outputs (status == 'pass', passed > 0, report file exists)", () => {
    expect(SOURCE).toContain("STATUS: ${{ steps.canary.outputs.status }}");
    expect(SOURCE).toContain("PASSED: ${{ steps.canary.outputs.passed }}");
    expect(SOURCE).toContain("REPORT: ${{ steps.canary.outputs.report }}");
    expect(SOURCE).toContain('[ "$STATUS" != "pass" ]');
    expect(SOURCE).toContain('[ "$PASSED" -le 0 ]');
    expect(SOURCE).toContain('[ ! -f "$REPORT" ]');
  });

  it("all third-party actions in release.yml are pinned to 40-character commit SHAs", () => {
    const lines = SOURCE.split(/\r?\n/);
    const SHA_REGEX = /^[0-9a-f]{40}$/i;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const match = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line);
      if (!match) continue;

      const ref = match[1] ?? "";
      if (ref.startsWith("./") || ref.startsWith("$/")) continue;

      const atIdx = ref.indexOf("@");
      expect(atIdx, `Line ${i + 1}: uses '${ref}' is missing '@'`).toBeGreaterThan(0);

      const target = ref.slice(0, atIdx);
      const version = ref.slice(atIdx + 1);

      if (target === "StellarCanary/ProtocolCanary-Action") {
        continue;
      }

      expect(SHA_REGEX.test(version), `Line ${i + 1}: uses '${ref}' must be pinned to a 40-char SHA`).toBe(true);
    }
  });
});
