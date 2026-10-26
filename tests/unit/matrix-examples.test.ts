import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/**
 * #367 / #368: structural validation of the example matrix workflows and a
 * real execution test of the aggregation script embedded in
 * matrix-aggregation.yml. Like reusable-workflow.test.ts (#366), the repo has
 * no YAML parser dependency, so validation uses a small indentation-aware
 * line reader. The embedded script is extracted verbatim from the workflow
 * source and executed with `node`, so the tested code is exactly the shipped
 * code.
 */
const CHECK_PATH = path.join(
  __dirname,
  "..",
  "..",
  ".github",
  "workflows",
  "examples",
  "matrix-check.yml",
);
const AGGREGATION_PATH = path.join(
  __dirname,
  "..",
  "..",
  ".github",
  "workflows",
  "examples",
  "matrix-aggregation.yml",
);
const CHECK_SOURCE = fs.readFileSync(CHECK_PATH, "utf8");
const AGGREGATION_SOURCE = fs.readFileSync(AGGREGATION_PATH, "utf8");

/** Collects upload-artifact step names and returns the literal (not
 * matrix-templated) ones that appear more than once — i.e. names that would
 * overwrite each other across parallel matrix legs. */
function duplicateUploadArtifactNames(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const names: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!/uses:\s*actions\/upload-artifact@/.test(line)) {
      continue;
    }
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next] ?? "";
      if (/uses:/.test(candidate)) {
        break;
      }
      const match = /^\s*name:\s*(.+)$/.exec(candidate);
      if (match !== null) {
        names.push((match[1] ?? "").trim());
        break;
      }
    }
  }
  const literal = names.filter((name) => !name.includes("matrix."));
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of literal) {
    if (seen.has(name)) {
      duplicates.add(name);
    }
    seen.add(name);
  }
  return [...duplicates];
}

describe("example matrix-check workflow (#367)", () => {
  it("declares a collision-safe parallel matrix of project roots", () => {
    expect(CHECK_SOURCE).toContain("strategy:");
    expect(CHECK_SOURCE).toContain("fail-fast: false");
    expect(CHECK_SOURCE).toContain("matrix:");

    const targets = [...CHECK_SOURCE.matchAll(/- target:\s*(\S+)/g)].map((m) => m[1]);
    const roots = [...CHECK_SOURCE.matchAll(/project-root:\s*(\S+)/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThanOrEqual(2);
    expect(roots.length).toBe(targets.length);
    expect(new Set(targets).size).toBe(targets.length);
    expect(new Set(roots).size).toBe(roots.length);
  });

  it("gives every leg a matrix-templated, collision-free artifact name", () => {
    expect(CHECK_SOURCE).toContain("name: report-${{ matrix.target }}");
    expect(duplicateUploadArtifactNames(CHECK_SOURCE)).toEqual([]);
  });

  it("disables the Action's fixed-name report upload to avoid cross-leg overwrites", () => {
    expect(CHECK_SOURCE).toContain('upload-report: "false"');
  });

  it("fails validation when matrix jobs declare duplicate literal artifact names (negative test)", () => {
    const colliding = [
      "jobs:",
      "  payments-leg:",
      "    steps:",
      "      - uses: actions/upload-artifact@v4",
      "        with:",
      "          name: report-payments",
      "  ledger-leg:",
      "    steps:",
      "      - uses: actions/upload-artifact@v4",
      "        with:",
      "          name: report-payments",
    ].join("\n");
    expect(duplicateUploadArtifactNames(colliding)).toEqual(["report-payments"]);

    // The same file made collision-free by templating the name per matrix
    // target must pass — the check keys on literal duplicates only.
    const fixed = colliding.replaceAll("name: report-payments", "name: report-${{ matrix.target }}");
    expect(duplicateUploadArtifactNames(fixed)).toEqual([]);
  });
});

describe("example matrix-aggregation workflow (#368)", () => {
  it("aggregates with always() after the matrix and downloads every report artifact", () => {
    expect(AGGREGATION_SOURCE).toContain("needs: canary-matrix");
    expect(AGGREGATION_SOURCE).toContain("if: always()");
    expect(AGGREGATION_SOURCE).toContain("uses: actions/download-artifact@v4");
    expect(AGGREGATION_SOURCE).toContain("pattern: report-*");
    expect(AGGREGATION_SOURCE).toContain("merge-multiple: false");
    expect(AGGREGATION_SOURCE).toContain("EXPECTED_TARGETS:");
    expect(AGGREGATION_SOURCE).toContain("GITHUB_STEP_SUMMARY");
    expect(duplicateUploadArtifactNames(AGGREGATION_SOURCE)).toEqual([]);
  });

  /** Pulls the heredoc body of the embedded `node - <<'NODE'` step out of
   * the workflow source, so the test runs exactly what ships. */
  function extractAggregationScript(source: string): string {
    const lines = source.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === "node - <<'NODE'");
    expect(start, "workflow must embed the aggregation script via `node - <<'NODE'`").toBeGreaterThan(-1);
    const end = lines.findIndex((line, index) => index > start && line.trim() === "NODE");
    expect(end, "the embedded script must close with a NODE heredoc terminator").toBeGreaterThan(start);
    return lines.slice(start + 1, end).join("\n");
  }

  function runAggregation(fixture: (reportsDir: string) => void): string {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-agg-"));
    try {
      const reportsDir = path.join(workspace, "matrix-reports");
      fs.mkdirSync(reportsDir, { recursive: true });
      fixture(reportsDir);

      const scriptPath = path.join(workspace, "aggregate.cjs");
      fs.writeFileSync(scriptPath, extractAggregationScript(AGGREGATION_SOURCE));
      const summaryPath = path.join(workspace, "summary.md");

      execFileSync(
        process.execPath,
        [scriptPath],
        {
          cwd: workspace,
          env: {
            ...process.env,
            EXPECTED_TARGETS: "payments ledger escrow",
            REPORTS_DIR: reportsDir,
            GITHUB_STEP_SUMMARY: summaryPath,
          },
        },
      );
      return fs.readFileSync(summaryPath, "utf8");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }

  it("renders a consolidated table and highlights a missing target instead of crashing", () => {
    const summary = runAggregation((reportsDir) => {
      const payments = path.join(reportsDir, "report-payments");
      fs.mkdirSync(payments, { recursive: true });
      fs.writeFileSync(path.join(payments, "canary-status-payments.txt"), "target=payments\nstatus=pass\n");

      const ledger = path.join(reportsDir, "report-ledger");
      fs.mkdirSync(ledger, { recursive: true });
      fs.writeFileSync(
        path.join(ledger, "report.json"),
        JSON.stringify({
          status: "fail",
          results: [{ status: "pass" }, { status: "fail" }, { status: "error" }],
        }),
      );
      // report-escrow/ intentionally absent: the leg never uploaded.
    });

    expect(summary).toContain("| Target | Status | Passed | Warnings | Failures | Errors |");
    expect(summary).toContain("| payments | pass |");
    expect(summary).toContain("| ledger | fail | 1 | 0 | 1 | 1 |");
    expect(summary).toContain("| escrow | **missing** (no report for this target) |");
  });

  it("marks an unparseable report invalid without crashing (negative test)", () => {
    const summary = runAggregation((reportsDir) => {
      const payments = path.join(reportsDir, "report-payments");
      fs.mkdirSync(payments, { recursive: true });
      fs.writeFileSync(path.join(payments, "report.json"), "{ not valid json");
    });

    expect(summary).toContain("| payments | invalid |");
    expect(summary).toContain("**missing**");
  });

  it("aggregates successfully even when every expected artifact is missing", () => {
    const summary = runAggregation(() => {
      /* no artifacts at all */
    });
    expect(summary).toContain("**missing**");
    expect(summary).toContain("| payments | **missing**");
  });
});
