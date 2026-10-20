import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #371: the integration guide must ship complete, valid YAML examples for
 * single-repo, matrix, and monorepo setups, documented inputs/outputs, and a
 * README link — without recreating the file that #366 already shipped.
 *
 * The shipped markdown is the unit under test: every fenced `yaml` block of
 * `docs/reusable-workflow.md` is extracted verbatim and pushed through the
 * structural validator below, and every `uses:` reference to this repository
 * must resolve to a workflow file that actually ships in it. The validator is
 * proven non-vacuous by negative fixtures (tab indentation, unbalanced quotes
 * and brackets, duplicate keys, orphan indentation, non-mapping lines) so a
 * documentation regression fails `npm test`.
 */
const REPO_ROOT = path.join(__dirname, "..", "..");
const DOC_PATH = path.join(REPO_ROOT, "docs", "reusable-workflow.md");

function docText(): string {
  if (!fs.existsSync(DOC_PATH)) {
    throw new Error(`Missing shipped doc: ${DOC_PATH}`);
  }
  // Windows runners check text files out with CRLF endings (the runner's git
  // applies core.autocrlf=true; .gitattributes pins LF only for *.ts). The
  // guide's structure is the unit under test, not the checkout's line
  // endings, so normalise to the stored LF form before any regex runs.
  return fs.readFileSync(DOC_PATH, "utf8").replace(/\r\n/g, "\n");
}

function yamlBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => (m[1] ?? "").trimEnd() + "\n");
}

/** Structural validator for the workflow-YAML subset the guide uses. */
function validateWorkflowYaml(text: string): string[] {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  const stack: Array<{ indent: number; keyPath: string }> = [{ indent: -1, keyPath: "" }];
  const seenKeys = new Set<string>();
  let blockScalarIndent = -1; // >= 0 while inside a `key: |` block body
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const n = index + 1;
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (blockScalarIndent >= 0) {
      if (indent > blockScalarIndent) {
        continue; // block scalar bodies are free text
      }
      blockScalarIndent = -1;
    }
    if (indent === 0 && !/^[A-Za-z0-9_"'/-]/.test(line)) {
      errors.push(`line ${n}: not a mapping key, list item, or comment: ${line.trim()}`);
      continue;
    }
    if (/\t/.test(line.slice(0, indent))) {
      errors.push(`line ${n}: tab characters are not allowed for indentation`);
      continue;
    }
    const trimmed = line.trimStart();
    const item = trimmed.startsWith("- ") || trimmed === "-";
    const content = item ? trimmed.slice(2).trim() : trimmed;
    const itemOffset = item ? indent + 2 : indent;

    // Balanced quoting and flow collections (comment-stripped scan).
    let inQuote: string | null = null;
    let opens = 0;
    let closes = 0;
    for (const ch of content) {
      if (inQuote !== null) {
        if (ch === inQuote) {
          inQuote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (ch === "[") {
        opens += 1;
      } else if (ch === "]") {
        closes += 1;
      } else if (ch === "{") {
        opens += 1;
      } else if (ch === "}") {
        closes += 1;
      }
    }
    if (inQuote !== null) {
      errors.push(`line ${n}: unbalanced quote in "${trimmed}"`);
    }
    if (opens !== closes) {
      errors.push(`line ${n}: unbalanced flow collection brackets in "${trimmed}"`);
    }

    if (item) {
      if (content === "") {
        continue;
      }
      if (!/^[A-Za-z0-9_"'/-]/.test(content) && !/^[\[{]/.test(content)) {
        errors.push(`line ${n}: malformed list item "${trimmed}"`);
      }
      continue;
    }

    const keyMatch = /^([^:#]+):(?:[ ](\S.*))?$/.exec(content);
    if (keyMatch === null) {
      errors.push(`line ${n}: expected "key: value" or "key:" but found "${trimmed}"`);
      continue;
    }
    const key = (keyMatch[1] ?? "").trim();
    const value = (keyMatch[2] ?? "").trim();
    if (key === "" || /\s/.test(key)) {
      errors.push(`line ${n}: "${trimmed}" is not a mapping entry`);
      continue;
    }
    while (stack.length > 1 && (stack[stack.length - 1]?.indent ?? -1) >= itemOffset) {
      stack.pop();
    }
    const parentPath = stack[stack.length - 1]?.keyPath ?? "";
    const bareKey = key.replace(/^"|"$/g, "");
    const scopeId = `${parentPath}|${itemOffset}`;
    const fullId = `${scopeId}|${bareKey}`;
    if (seenKeys.has(fullId)) {
      errors.push(`line ${n}: duplicate key "${bareKey}" in the same mapping`);
    }
    seenKeys.add(fullId);
    stack.push({ indent: itemOffset, keyPath: `${parentPath}/${bareKey}` });
    if (/^[|>][-+]?$/.test(value)) {
      blockScalarIndent = itemOffset;
    }
  }
  return errors;
}

/** Every repo-internal `uses:` reference in an example must resolve to a file
 * that ships in this repository. */
function usesReferences(block: string): string[] {
  return [...block.matchAll(/uses:\s*StellarCanary\/ProtocolCanary-Action\/([^\s@]+)@/g)].map((m) => m[1] ?? "");
}

describe("reusable-workflow.md integration guide (#371)", () => {
  it("still carries the #366 content — this issue extends the guide, not recreates it", () => {
    const text = docText();
    for (const fragment of [
      "## Inputs",
      "## Outputs",
      "project-root",
      "fail-on-warning",
      "baseline-report",
      "diff-verdict",
    ]) {
      expect(text, `guide must still document "${fragment}"`).toContain(fragment);
    }
    expect(text.startsWith("# Reusable Protocol Canary workflow"), "guide extended in place, not replaced").toBe(true);
  });

  it("every fenced YAML block of the shipped guide passes structural validation", () => {
    const blocks = yamlBlocks(docText());
    expect(blocks.length, "guide must ship YAML examples").toBeGreaterThanOrEqual(4);
    for (const [index, block] of blocks.entries()) {
      const errors = validateWorkflowYaml(block);
      expect(errors, `yaml example ${index} is invalid:\n${errors.join("\n")}\n---\n${block}`).toEqual([]);
    }
  });

  it("ships a complete matrix example calling the reusable workflow", () => {
    const blocks = yamlBlocks(docText());
    const matrix = blocks.filter((b) => /matrix:/.test(b));
    expect(matrix.length, "guide must contain at least one matrix example").toBeGreaterThan(0);
    for (const block of matrix) {
      expect(block).toContain("reusable-canary-check.yml");
      expect(block).toContain("strategy:");
      expect(validateWorkflowYaml(block)).toEqual([]);
    }
  });

  it("ships a complete monorepo example using project-root per package", () => {
    const blocks = yamlBlocks(docText());
    const monorepo = blocks.filter((b) => /project-root:\s*\$\{\{/.test(b) || /project-root:\s*(packages|services|apps)\//.test(b));
    expect(monorepo.length, "guide must contain at least one monorepo example").toBeGreaterThan(0);
    for (const block of monorepo) {
      expect(block).toContain("reusable-canary-check.yml");
      expect(validateWorkflowYaml(block)).toEqual([]);
    }
  });

  it("ships a PR gating example consuming the documented outputs", () => {
    const blocks = yamlBlocks(docText());
    const gating = blocks.filter((b) => /needs:/.test(b) && /exit-code/.test(b));
    expect(gating.length, "guide must contain a PR gating example using needs + outputs").toBeGreaterThan(0);
    for (const block of gating) {
      expect(validateWorkflowYaml(block)).toEqual([]);
    }
  });

  it("all repo-internal uses: references resolve to workflows that ship in this repository", () => {
    let checked = 0;
    for (const block of yamlBlocks(docText())) {
      for (const ref of usesReferences(block)) {
        checked += 1;
        expect(
          fs.existsSync(path.join(REPO_ROOT, ref)),
          `documentation references ${ref}, which does not exist in the repository`,
        ).toBe(true);
      }
    }
    expect(checked, "the guide must carry repo-internal uses: references to check").toBeGreaterThan(0);
  });

  it("the YAML validator is not vacuous: malformed examples are rejected", () => {
    const rejects: Array<[string, string]> = [
      ["tab-indented mapping", 'jobs:\n\tcanary:\n\t\tuses: x\n'],
      ["unclosed quote", 'with:\n  fixtures-version: "v1.2.0\n'],
      ["unbalanced bracket", "protocol: [27, 28\n"],
      ["duplicate key", "permissions:\n  contents: read\n  contents: read\n"],
      ["orphan scalar line", "this is not yaml at all\n"],
      ["empty key name", ":value\n"],
    ];
    for (const [name, sample] of rejects) {
      expect(validateWorkflowYaml(sample), `validator must reject ${name}`).not.toEqual([]);
    }
    // And it must accept a well-formed example, so rejection isn't just "always error".
    expect(
      validateWorkflowYaml('name: ok\non:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  canary:\n    uses: "o/r/.github/workflows/x.yml@v1"\n    with:\n      protocol: 28\n'),
    ).toEqual([]);
    // The path-stack must distinguish same-indent keys under different parents.
    expect(
      validateWorkflowYaml('jobs:\n  canary:\n    strategy:\n      matrix:\n        protocol: [28]\n    with:\n      protocol: ${{ matrix.protocol }}\n'),
    ).toEqual([]);
  });

  it("the README links to the integration guide", () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).toContain("docs/reusable-workflow.md");
  });
});
