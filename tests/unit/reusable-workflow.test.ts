import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #366: structural validation for the maintained reusable workflow.
 *
 * The repository has no YAML parser dependency (and adding one would change
 * the lockfile for a single test), so this test validates the workflow with a
 * small indentation-aware reader. It fails closed: an input without a
 * workflow_call-legal `type`, an output without a value, or a `permissions`
 * block that grants more than `contents: read` all fail the suite under
 * `npm test`.
 */
const WORKFLOW_PATH = path.join(__dirname, "..", "..", ".github", "workflows", "reusable-canary-check.yml");
const SOURCE = fs.readFileSync(WORKFLOW_PATH, "utf8");
const LINES = SOURCE.split(/\r?\n/);

/** Types accepted by the `workflow_call` input schema. */
const WORKFLOW_CALL_INPUT_TYPES = new Set(["string", "number", "boolean"]);

interface Block {
  readonly name: string;
  readonly lines: readonly string[];
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Collects `key:` blocks at exactly `parentIndent`, keeping each block's own
 * (still indented) lines for recursive inspection. */
function collectChildren(lines: readonly string[], parentIndent: number): Block[] {
  const children: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || indentOf(line) !== parentIndent || !trimmed.endsWith(":")) {
      index += 1;
      continue;
    }
    const block: string[] = [];
    let next = index + 1;
    while (next < lines.length) {
      const candidate = lines[next] ?? "";
      if (candidate.trim() !== "" && indentOf(candidate) <= parentIndent) {
        break;
      }
      block.push(candidate);
      next += 1;
    }
    children.push({ name: trimmed.slice(0, -1), lines: block });
    index = next;
  }
  return children;
}

/** Reads the scalar `key: value` fields inside a block. */
function fieldsOf(lines: readonly string[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of lines) {
    const match = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match !== null) {
      fields.set(match[1] ?? "", (match[2] ?? "").trim());
    }
  }
  return fields;
}

function topLevel(): Block[] {
  return collectChildren(LINES, 0);
}

function child(blocks: readonly Block[], name: string): Block {
  const found = blocks.find((block) => block.name === name);
  if (found === undefined) {
    throw new Error(`Workflow is missing the "${name}" block.`);
  }
  return found;
}

const TOP = topLevel();
const WORKFLOW_CALL = child(collectChildren(child(TOP, "on").lines, 2), "workflow_call");
const WORKFLOW_CALL_CHILDREN = collectChildren(WORKFLOW_CALL.lines, 4);
const INPUTS = collectChildren(child(WORKFLOW_CALL_CHILDREN, "inputs").lines, 6);
const OUTPUTS = collectChildren(child(WORKFLOW_CALL_CHILDREN, "outputs").lines, 6);
const JOB = child(collectChildren(child(TOP, "jobs").lines, 2), "canary");

describe("reusable-canary-check workflow (#366)", () => {
  it("is declared as a reusable workflow_call workflow", () => {
    const triggers = collectChildren(child(TOP, "on").lines, 2).map((block) => block.name);
    expect(triggers).toEqual(["workflow_call"]);
    expect(WORKFLOW_CALL.lines.length).toBeGreaterThan(0);
  });

  it("declares the documented typed inputs", () => {
    expect(INPUTS.map((input) => input.name)).toEqual([
      "project-root",
      "protocol",
      "fixtures-version",
      "fail-on-warning",
      "baseline-report",
    ]);

    for (const input of INPUTS) {
      const fields = fieldsOf(input.lines);
      const type = fields.get("type");
      expect(type, `input "${input.name}" must declare a type`).toBeDefined();
      expect(
        WORKFLOW_CALL_INPUT_TYPES.has(type ?? ""),
        `input "${input.name}" declares "${type}", which the workflow_call schema does not accept`,
      ).toBe(true);
      expect(fields.get("required"), `input "${input.name}" must declare required`).toBeDefined();
      expect(fields.get("default"), `input "${input.name}" must declare a default`).toBeDefined();
    }
  });

  it("applies sensible defaults", () => {
    const defaults = new Map(INPUTS.map((input) => [input.name, fieldsOf(input.lines).get("default") ?? ""]));
    expect(defaults.get("project-root")).toBe('"."');
    expect(defaults.get("protocol")).toBe("28");
    expect(defaults.get("fixtures-version")).toBe('""');
    expect(defaults.get("fail-on-warning")).toBe("false");
    expect(defaults.get("baseline-report")).toBe('""');
  });

  it("exposes report-path, diff-verdict and exit-code outputs wired to the job", () => {
    expect(OUTPUTS.map((output) => output.name)).toEqual(["report-path", "diff-verdict", "exit-code"]);
    for (const output of OUTPUTS) {
      expect(fieldsOf(output.lines).get("value"), `output "${output.name}" needs a value`).toContain(
        "jobs.canary.outputs.",
      );
    }
  });

  it("enforces read-only permissions at the workflow and job level", () => {
    const workflowPermissions = fieldsOf(child(TOP, "permissions").lines);
    expect([...workflowPermissions.entries()]).toEqual([["contents", "read"]]);

    const jobPermissions = fieldsOf(child(collectChildren(JOB.lines, 4), "permissions").lines);
    expect([...jobPermissions.entries()]).toEqual([["contents", "read"]]);

    // No step anywhere may request anything beyond contents: read.
    for (const line of LINES) {
      if (/^\s*(contents|actions|checks|issues|packages|pull-requests|statuses|security-events):/.test(line)) {
        expect(line.trim()).toBe("contents: read");
      }
    }
  });

  it("passes the declared inputs through to the Action", () => {
    expect(SOURCE).toContain("uses: StellarCanary/ProtocolCanary-Action@v1");
    expect(SOURCE).toContain("protocol: ${{ inputs.protocol }}");
    expect(SOURCE).toContain("fixtures-dir: ${{ steps.paths.outputs.fixtures-dir }}");
    expect(SOURCE).toContain("fixtures-pack-version: ${{ inputs.fixtures-version }}");
    expect(SOURCE).toContain("FAIL_ON_WARNING: ${{ inputs.fail-on-warning }}");
    expect(SOURCE).toContain("BASELINE_REPORT: ${{ inputs.baseline-report }}");
  });
});
