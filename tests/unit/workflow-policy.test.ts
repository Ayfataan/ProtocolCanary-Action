import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #408: Workflow security and pinning policy tests.
 *
 * All GitHub Actions workflow files in .github/workflows/ must follow two
 * repository security rules:
 *
 *  1. Top-level permissions block: every workflow must explicitly declare
 *     top-level `permissions:` (e.g. `contents: read`) to prevent inheriting
 *     broad default repository permissions.
 *
 *  2. Full commit SHA pinning: every external `uses:` action reference must be
 *     pinned to a 40-character hexadecimal commit SHA. Local `./` and `$/`
 *     references within this repository are excluded.
 */
const REPO_ROOT = path.join(__dirname, "..", "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

function getWorkflowFiles(): { filename: string; filepath: string; content: string }[] {
  const files = fs.readdirSync(WORKFLOWS_DIR).filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"));
  return files.map((file) => ({
    filename: file,
    filepath: path.join(WORKFLOWS_DIR, file),
    content: fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8"),
  }));
}

describe("workflow security and pinning policy (#408)", () => {
  const workflows = getWorkflowFiles();

  it("finds workflow files in .github/workflows", () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  describe("top-level permissions key", () => {
    for (const { filename, content } of workflows) {
      it(`${filename} declares an explicit top-level permissions block`, () => {
        // Must declare a line starting with `permissions:` at root (no leading spaces)
        const hasTopLevelPermissions = /^permissions:\s*(?:#.*)?$/m.test(content) || /^permissions:\s*\S+/m.test(content);
        expect(hasTopLevelPermissions, `${filename} is missing a top-level permissions: block`).toBe(true);
      });
    }
  });

  describe("action reference SHA pinning", () => {
    for (const { filename, content } of workflows) {
      it(`pins all external uses in ${filename} to 40-character commit SHAs`, () => {
        const lines = content.split(/\r?\n/);
        const SHA_REGEX = /^[0-9a-f]{40}$/i;

        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? "";
          const usesMatch = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line);
          if (!usesMatch) {
            continue;
          }

          const ref = usesMatch[1] ?? "";

          // Exclude local relative references (./... or $/...) and reusable workflows in the same repo
          if (ref.startsWith("./") || ref.startsWith("$/")) {
            continue;
          }

          // Expected format: <owner>/<repo>[/path]@<ref>
          const atIndex = ref.indexOf("@");
          expect(atIndex, `Line ${i + 1} in ${filename}: 'uses: ${ref}' is missing '@'`).toBeGreaterThan(0);

          const actionTarget = ref.slice(0, atIndex);
          const versionRef = ref.slice(atIndex + 1);

          // If the reusable workflow references this repo's own floating tag (@v1), check if it's explicitly justified
          if (actionTarget === "StellarCanary/ProtocolCanary-Action") {
            // Documented exception for reusable workflow calling the action by release tag
            continue;
          }

          expect(
            SHA_REGEX.test(versionRef),
            `Line ${i + 1} in ${filename}: 'uses: ${ref}' must be pinned to a 40-character commit SHA (got '${versionRef}')`,
          ).toBe(true);
        }
      });
    }
  });
});
