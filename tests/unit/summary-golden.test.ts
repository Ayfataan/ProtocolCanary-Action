import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { renderExecutionFailureMarkdown, renderSummaryMarkdown } from "../../src/summary";
import { executionFailure, goldenReports } from "../helpers/golden-reports";

const GOLDEN_DIR = path.join(__dirname, "..", "golden");
const UPDATE_COMMAND = "UPDATE_GOLDEN=1 npx vitest run tests/unit/summary-golden.test.ts";

const goldenCases = [
  ...goldenReports.map(({ name, report }) => ({
    name,
    render: () => renderSummaryMarkdown(report),
  })),
  {
    name: executionFailure.name,
    render: () =>
      renderExecutionFailureMarkdown(executionFailure.reason, executionFailure.diagnostic),
  },
];

function lineDiff(expected: string, actual: string): string {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  let firstDifference = 0;
  while (
    firstDifference < expectedLines.length &&
    expectedLines[firstDifference] === actualLines[firstDifference]
  ) {
    firstDifference++;
  }
  const start = Math.max(0, firstDifference - 2);
  const end = firstDifference + 4;
  const lines: string[] = [];
  for (let index = start; index < Math.min(end, expectedLines.length, actualLines.length); index++) {
    if (expectedLines[index] === actualLines[index]) {
      lines.push(` ${expectedLines[index]}`);
    } else {
      lines.push(`-${expectedLines[index] ?? ""}`, `+${actualLines[index] ?? ""}`);
    }
  }
  for (let index = expectedLines.length; index < actualLines.length; index++) {
    lines.push(`+${actualLines[index]}`);
  }
  for (let index = actualLines.length; index < expectedLines.length; index++) {
    lines.push(`-${expectedLines[index]}`);
  }
  return `@@ line ${String(firstDifference + 1)} @@\n${lines.join("\n")}`;
}

describe("summary golden files", () => {
  for (const sample of goldenCases) {
    it(`matches ${sample.name}.md`, () => {
      const filePath = path.join(GOLDEN_DIR, `${sample.name}.md`);
      const actual = sample.render();

      if (process.env.UPDATE_GOLDEN === "1") {
        fs.mkdirSync(GOLDEN_DIR, { recursive: true });
        fs.writeFileSync(filePath, actual, "utf8");
      } else if (!fs.existsSync(filePath)) {
        throw new Error(`Missing ${sample.name}.md. Update summaries with: ${UPDATE_COMMAND}`);
      }

      const expected = fs.readFileSync(filePath, "utf8");
      expect(actual, `Summary differs for ${sample.name}.md:\n${lineDiff(expected, actual)}\n` +
        `If this change is intentional, run: ${UPDATE_COMMAND}`).toBe(expected);
    });
  }
});
