import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const ACTION_YML = fs.readFileSync(path.resolve(__dirname, "../../action.yml"), "utf8");

describe("action.yml expressions", () => {
  // The runner evaluates `${{ ... }}` anywhere in action.yml, including inside
  // `description:` text, where the `github` context is not available. A literal
  // `${{ github.token }}` in a description therefore makes the runner refuse to
  // load the whole Action ("Unrecognized named-value: 'github'"). Only input
  // `default:` values may carry an expression.
  it("uses expressions only in input defaults, never in descriptions", () => {
    const offenders = ACTION_YML.split(/\r?\n/)
      .map((text, index) => ({ line: index + 1, text }))
      .filter(({ text }) => text.includes("${{") && !/^\s*default:\s/.test(text));

    expect(offenders).toEqual([]);
  });

  it("does not use github context in an action input default", () => {
    expect(ACTION_YML).not.toMatch(/^\s*default:.*\$\{\{\s*github\./m);
    expect(ACTION_YML).toMatch(/github-token:[\s\S]*?required:\s*false/m);
  });
});
