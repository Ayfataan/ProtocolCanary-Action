import { describe, expect, it } from "vitest";

import type { CanaryReport, CanaryResult } from "../../src/output";
import { SUMMARY_BYTE_LIMIT, TRUNCATION_NOTICE, renderExecutionFailureMarkdown, renderSummaryMarkdown } from "../../src/summary";
import { report, result } from "./helpers";

describe("renderSummaryMarkdown", () => {
  it("renders a passing report", () => {
    const markdown = renderSummaryMarkdown(
      report({
        status: "pass",
        counts: { total: 3, passed: 3, failed: 0, warnings: 0, errors: 0, skipped: 0 },
        results: [
          result({ testId: "a", surface: "xdr", fixtureId: "a" }),
          result({ testId: "b", surface: "rpc", fixtureId: "b" }),
          result({ testId: "c", surface: "soroban", fixtureId: "c" }),
        ],
      }),
    );

    expect(markdown).toContain("## Stellar Protocol Canary");
    expect(markdown).toContain("Protocol: 28");
    expect(markdown).toContain("✅ **PASS**");
    expect(markdown).toContain("3/3 applicable checks passed.");
    expect(markdown).toContain("| XDR | ✅ PASS (1/1) |");
    expect(markdown).not.toContain("#### Failures");
  });

  it("renders a failing report with the failing test id and details", () => {
    const markdown = renderSummaryMarkdown(
      report({
        status: "fail",
        counts: { total: 1, passed: 0, failed: 1, warnings: 0, errors: 0, skipped: 0 },
        results: [
          result({
            testId: "p28-xdr-cap83-001",
            surface: "xdr",
            status: "fail",
            summary: "could not satisfy the compatibility assertion",
            details: "byte 12 differs",
            fixtureId: "p28-xdr-cap83-001",
          }),
        ],
      }),
    );

    expect(markdown).toContain("❌ **NOT READY**");
    expect(markdown).toContain("#### Failures");
    expect(markdown).toContain("p28-xdr-cap83-001");
    expect(markdown).toContain("byte 12 differs");
    expect(markdown).toContain("| XDR | ❌ FAIL (0/1) |");
  });

  it("omits a surface row entirely when no results exist for it (offline run)", () => {
    const markdown = renderSummaryMarkdown(
      report({
        status: "pass",
        counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
        results: [result({ testId: "a", surface: "xdr", fixtureId: "a" })],
      }),
    );
    expect(markdown).not.toContain("| RPC |");
    expect(markdown).not.toContain("| Soroban |");
  });

  it("omits rows for every surface with no matching results, covering all three surfaces", () => {
    // The mirror permutation of the offline-run case: only soroban has
    // results, so surfaceRowLabel must return undefined for both xdr and
    // rpc, and neither may be rendered as an empty pass.
    const markdown = renderSummaryMarkdown(
      report({
        status: "pass",
        counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
        results: [result({ testId: "s", surface: "soroban", fixtureId: "s" })],
      }),
    );
    expect(markdown).toContain("| Soroban | ✅ PASS (1/1) |");
    expect(markdown).not.toContain("| XDR |");
    expect(markdown).not.toContain("| RPC |");
  });

  it("keeps the surface table ordered xdr, rpc, soroban when results arrive shuffled", () => {
    // Deliberately unordered: soroban and rpc before xdr, so this cannot
    // pass merely by echoing the order of `report.results`.
    const markdown = renderSummaryMarkdown(
      report({
        status: "pass",
        counts: { total: 3, passed: 3, failed: 0, warnings: 0, errors: 0, skipped: 0 },
        results: [
          result({ testId: "soroban-one", surface: "soroban", fixtureId: "soroban-one" }),
          result({ testId: "rpc-one", surface: "rpc", fixtureId: "rpc-one" }),
          result({ testId: "xdr-one", surface: "xdr", fixtureId: "xdr-one" }),
        ],
      }),
    );

    const surfaceRows = [...markdown.matchAll(/^\| (XDR|RPC|Soroban) \|/gm)].map((match) => match[1]);
    expect(surfaceRows).toEqual(["XDR", "RPC", "Soroban"]);
  });

  it("lists skipped fixtures in a collapsible section when present", () => {
    const markdown = renderSummaryMarkdown(
      report({
        skipped: [{ fixtureId: "p27-xdr-legacy", surface: "xdr", reason: "fixture targets protocol 27, this run targets protocol 28" }],
      }),
    );
    expect(markdown).toContain("<details><summary>Skipped fixtures</summary>");
    expect(markdown).toContain("p27-xdr-legacy");
  });

  it("omits the skipped-fixtures section when skipped is an empty array (#264)", () => {
    const markdown = renderSummaryMarkdown(
      report({
        skipped: [],
      }),
    );
    expect(markdown).not.toContain("<details><summary>Skipped fixtures</summary>");
    expect(markdown).not.toContain("Skipped fixtures");
    expect(markdown).not.toContain("</details>");
  });

  it("renders the network name with the observed protocol suffix when both are present", () => {
    // `network` is populated whenever a network/rpc-url is used (see the
    // example workflows), so this branch is not an edge case: the
    // "— observed protocol N" suffix is the part most likely to regress
    // silently.
    const markdown = renderSummaryMarkdown(
      report({
        network: { name: "testnet", observedProtocol: 28 },
        results: [result({ testId: "a", surface: "rpc", fixtureId: "a" })],
      }),
    );

    expect(markdown).toContain("Network: testnet — observed protocol 28");
  });

  it("renders the network name without the suffix when observedProtocol is absent", () => {
    const markdown = renderSummaryMarkdown(
      report({
        network: { name: "testnet" },
        results: [result({ testId: "a", surface: "rpc", fixtureId: "a" })],
      }),
    );

    expect(markdown).toContain("Network: testnet\n");
    expect(markdown).not.toContain("observed protocol");
  });

  it("omits the network line entirely when the report has no network", () => {
    const markdown = renderSummaryMarkdown(report({}));
    expect(markdown).not.toContain("Network:");
  });

  it("never fabricates a result: an empty results array renders as a trivial pass with no surface rows", () => {
    const markdown = renderSummaryMarkdown(report({ status: "pass" }));
    expect(markdown).not.toContain("| XDR |");
    expect(markdown).not.toContain("| RPC |");
    expect(markdown).not.toContain("| Soroban |");
    expect(markdown).toContain("0/0 applicable checks passed.");
  });

  // notablyList(report, ["fail", "error"]) drives the Failures section and
  // notablyList(report, ["warning"]) the Warnings section; these tests pin
  // the status filter between them. A regression that let any status through
  // would either duplicate an entry into the wrong section or invent a
  // Failures/Warnings heading for a report that has none.
  it("lists every non-passing status under Failures and nothing else (#188)", () => {
    const markdown = renderSummaryMarkdown(
      report([
        result({ testId: "xdr-pass", surface: "xdr", status: "pass", summary: "ok", fixtureId: "xdr-pass" }),
        result({ testId: "rpc-warn", surface: "rpc", status: "warning", summary: "slow reply", fixtureId: "rpc-warn" }),
        result({ testId: "xdr-fail", surface: "xdr", status: "fail", summary: "mismatch", fixtureId: "xdr-fail" }),
        result({ testId: "rpc-error", surface: "rpc", status: "error", summary: "connection refused", fixtureId: "rpc-error" }),
      ]),
    );

    const failures = markdown.slice(markdown.indexOf("#### Failures"), markdown.indexOf("#### Warnings"));
    expect(markdown).toContain("#### Failures");
    expect(failures).toContain("`xdr-fail` (xdr) — mismatch");
    expect(failures).toContain("`rpc-error` (rpc) — connection refused");
    // The filter is exact: passing and warning results stay out of Failures.
    expect(failures).not.toContain("xdr-pass");
    expect(failures).not.toContain("rpc-warn");
  });

  it("lists warnings under Warnings and keeps them out of Failures (#188)", () => {
    const markdown = renderSummaryMarkdown(
      report([
        result({ testId: "xdr-warn", surface: "xdr", status: "warning", summary: "deprecated field", fixtureId: "xdr-warn" }),
        result({ testId: "xdr-fail", surface: "xdr", status: "fail", summary: "mismatch", fixtureId: "xdr-fail" }),
      ]),
    );

    const warnings = markdown.slice(markdown.indexOf("#### Warnings"));
    expect(markdown).toContain("#### Warnings");
    expect(warnings).toContain("`xdr-warn` (xdr) — deprecated field");
    expect(warnings).not.toContain("xdr-fail");
    // Conversely the failure must not leak into Warnings either.
    const failures = markdown.slice(markdown.indexOf("#### Failures"), markdown.indexOf("#### Warnings"));
    expect(failures).toContain("xdr-fail");
    expect(failures).not.toContain("xdr-warn");
  });

  it("omits the Warnings section when no warning-status result exists (#188)", () => {
    const markdown = renderSummaryMarkdown(
      report([
        result({ testId: "a", surface: "xdr", status: "pass", summary: "ok", fixtureId: "a" }),
        result({ testId: "b", surface: "rpc", status: "fail", summary: "mismatch", fixtureId: "b" }),
      ]),
    );

    expect(markdown).toContain("#### Failures");
    expect(markdown).not.toContain("#### Warnings");
  });

  it("omits the Failures section when only pass and warning results exist (#188)", () => {
    const markdown = renderSummaryMarkdown(
      report([
        result({ testId: "a", surface: "xdr", status: "pass", summary: "ok", fixtureId: "a" }),
        result({ testId: "b", surface: "rpc", status: "warning", summary: "slow reply", fixtureId: "b" }),
      ]),
    );

    expect(markdown).toContain("#### Warnings");
    expect(markdown).not.toContain("#### Failures");
  });
});

/**
 * #334: GitHub rejects an oversized job-summary append outright (HTTP 413),
 * losing the whole summary rather than degrading it. These tests pin the
 * bound, the priority order used to stay under it, and the fact that the
 * result is deterministic.
 */
describe("renderSummaryMarkdown size limit (#334)", () => {
  const utf8 = (text: string): number => Buffer.byteLength(text, "utf8");

  /** A report whose single failing result's summary is `pad` ASCII
   * characters. The rendered size moves one byte per added character, which
   * is what lets the boundary tests below land on an exact byte count. */
  function paddedFailure(pad: number, summaryChar = "x"): CanaryReport {
    return report({
      status: "fail",
      counts: { total: 1, passed: 0, failed: 1, warnings: 0, errors: 0, skipped: 0 },
      results: [
        result({
          testId: "p28-xdr-cap83-001",
          surface: "xdr",
          fixtureId: "p28-xdr-cap83-001",
          status: "fail",
          summary: summaryChar.repeat(pad),
        }),
      ],
    });
  }

  /** Padding that makes the rendered Markdown exactly `targetBytes` UTF-8
   * bytes long, derived from a one-character probe rather than hard-coded so
   * it survives edits to the surrounding Markdown. */
  function paddingForExactSize(targetBytes: number): number {
    const probeBytes = utf8(renderSummaryMarkdown(paddedFailure(1)));
    expect(probeBytes).toBeLessThan(SUMMARY_BYTE_LIMIT);
    return 1 + (targetBytes - probeBytes);
  }

  /** Many large failing results, so the report's rendered size is dominated by
   * detail the truncation has to cut. */
  function manyFailures(approximateBytes: number): CanaryResult[] {
    const perResult = 6144;
    const count = Math.max(1, Math.ceil(approximateBytes / perResult));
    return Array.from({ length: count }, (_unused, index) =>
      result({
        testId: `p28-xdr-cap${String(index)}-001`,
        surface: "xdr",
        fixtureId: `p28-xdr-cap${String(index)}-001`,
        status: index % 7 === 0 ? "error" : "fail",
        summary: `mismatch at byte ${String(index)} — ${"x".repeat(4096)}`,
        details: `diff for check ${String(index)}:\n${"y".repeat(2048)}`,
      }),
    );
  }

  // ---- Normal (under the limit) ------------------------------------------------

  it("leaves an ordinary report untouched and adds no truncation notice", () => {
    const markdown = renderSummaryMarkdown(
      report({
        status: "fail",
        counts: { total: 2, passed: 0, failed: 1, warnings: 1, errors: 0, skipped: 1 },
        results: [
          result({ testId: "a", surface: "xdr", fixtureId: "a", status: "fail", summary: "mismatch" }),
          result({ testId: "b", surface: "rpc", fixtureId: "b", status: "warning", summary: "slow" }),
        ],
        skipped: [{ fixtureId: "p27-xdr-legacy", surface: "xdr", reason: "targets protocol 27" }],
      }),
    );

    expect(markdown).not.toContain(TRUNCATION_NOTICE);
    expect(markdown).toContain("#### Failures");
    expect(markdown).toContain("#### Warnings");
    expect(markdown).toContain("Skipped fixtures");
    expect(utf8(markdown)).toBeLessThan(SUMMARY_BYTE_LIMIT);
  });

  // ---- Exact boundary ----------------------------------------------------------

  it("publishes a report that lands exactly one byte under the limit untruncated", () => {
    // The limit is inclusive of everything below it: a payload at exactly
    // SUMMARY_BYTE_LIMIT - 1 must be published whole, with no notice, or the
    // truncation would trigger a byte early.
    const markdown = renderSummaryMarkdown(paddedFailure(paddingForExactSize(SUMMARY_BYTE_LIMIT - 1)));

    expect(utf8(markdown)).toBe(SUMMARY_BYTE_LIMIT - 1);
    expect(markdown).not.toContain(TRUNCATION_NOTICE);
    expect(markdown).toContain("#### Failures");
  });

  it("truncates a report that lands exactly on the limit", () => {
    // The mirror of the case above: one byte over, so the ceiling is not
    // off-by-one in the permissive direction either.
    const markdown = renderSummaryMarkdown(paddedFailure(paddingForExactSize(SUMMARY_BYTE_LIMIT)));

    expect(utf8(markdown)).toBeLessThan(SUMMARY_BYTE_LIMIT);
    expect(markdown).toContain(TRUNCATION_NOTICE);
  });

  // ---- Oversized ---------------------------------------------------------------

  for (const [label, approximateBytes] of [
    ["2 MiB", 2 * 1024 * 1024],
    ["5 MiB", 5 * 1024 * 1024],
  ] as const) {
    it(`bounds a ${label} report strictly under 1,000,000 bytes while keeping the verdict`, () => {
      const results = manyFailures(approximateBytes);
      const markdown = renderSummaryMarkdown(
        report({
          status: "fail",
          counts: { total: results.length, passed: 0, failed: results.length, warnings: 0, errors: 0, skipped: 0 },
          results,
        }),
      );

      // The whole point of the issue: never send an oversized payload.
      expect(utf8(markdown)).toBeLessThan(SUMMARY_BYTE_LIMIT);
      expect(utf8(markdown)).toBeLessThanOrEqual(1_000_000);

      // The totals and the verdict survive verbatim — a clipped summary still
      // answers "did it pass, and how much ran".
      expect(markdown).toContain("### Result");
      expect(markdown).toContain("❌ **NOT READY**");
      expect(markdown).toContain(`${String(0)}/${String(results.length)} applicable checks passed.`);

      // As do the high-priority regressions, from the front of the report.
      expect(markdown).toContain("#### Failures");
      expect(markdown).toContain("- `p28-xdr-cap0-001` (xdr) — mismatch at byte 0 — ");

      // And the truncation is announced, once, at the end.
      expect(markdown.split(TRUNCATION_NOTICE)).toHaveLength(2);
      expect(markdown.endsWith(TRUNCATION_NOTICE)).toBe(true);
    });
  }

  it("counts UTF-8 bytes rather than characters", () => {
    // "→" is three UTF-8 bytes. A summary built from it has far fewer
    // characters than bytes, so a limit applied to `String.length` would let
    // this payload through — and GitHub would reject it.
    const markdown = renderSummaryMarkdown(
      paddedFailure(Math.ceil((SUMMARY_BYTE_LIMIT + 50_000) / 3), "→"),
    );

    expect(markdown).toContain(TRUNCATION_NOTICE);
    expect(utf8(markdown)).toBeLessThan(SUMMARY_BYTE_LIMIT);
    // The character count alone is comfortably under the limit, which is the
    // point: only a byte-based measure could have caught this.
    expect([...markdown].length).toBeLessThan(SUMMARY_BYTE_LIMIT);
  });

  it("never cuts an entry in half: every rendered bullet is a verbatim source entry", () => {
    const results = manyFailures(2 * 1024 * 1024);
    const markdown = renderSummaryMarkdown(report({ status: "fail", results }));

    const sourceBullets = new Set(
      results.map((r) => `- \`${r.testId}\` (${r.surface}) — ${r.summary}`),
    );
    const renderedBullets = markdown.split("\n").filter((line) => line.startsWith("- `"));

    expect(renderedBullets.length).toBeGreaterThan(0);
    for (const bullet of renderedBullets) {
      expect(sourceBullets.has(bullet)).toBe(true);
    }
  });

  it("keeps a partially included section well formed, with balanced <details> tags", () => {
    // Cheap failures plus an enormous skipped-fixture list: the skipped section
    // is the one that gets clipped, so its collapsible wrapper must still be
    // opened and closed exactly once each.
    const markdown = renderSummaryMarkdown(
      report({
        status: "fail",
        counts: { total: 1, passed: 0, failed: 1, warnings: 0, errors: 0, skipped: 4000 },
        results: [
          result({ testId: "a", surface: "xdr", fixtureId: "a", status: "fail", summary: "mismatch" }),
        ],
        skipped: Array.from({ length: 4000 }, (_unused, index) => ({
          fixtureId: `p27-xdr-legacy-${String(index)}`,
          surface: "xdr",
          reason: `fixture targets protocol 27 — ${"z".repeat(512)}`,
        })),
      }),
    );

    expect(utf8(markdown)).toBeLessThan(SUMMARY_BYTE_LIMIT);
    expect(markdown.split("<details>")).toHaveLength(2);
    expect(markdown.split("</details>")).toHaveLength(2);
    expect(markdown).toContain("<details><summary>Skipped fixtures</summary>");
    // The whole list cannot have fit, so the section must say how much it lost.
    expect(markdown).toMatch(/\d+ more skipped fixtures omitted/);
  });

  it("drops the least actionable section first, keeping failures and warnings", () => {
    // Priority order: Failures > Warnings > skipped fixtures. With the budget
    // consumed by a huge skipped list, the two sections a reader acts on must
    // both survive, and only the skipped list is clipped.
    const markdown = renderSummaryMarkdown(
      report({
        status: "fail",
        counts: { total: 2, passed: 0, failed: 1, warnings: 1, errors: 0, skipped: 5000 },
        results: [
          result({ testId: "the-failure", surface: "xdr", fixtureId: "f", status: "fail", summary: "mismatch" }),
          result({ testId: "a-warning", surface: "rpc", fixtureId: "w", status: "warning", summary: `slow — ${"w".repeat(1024)}` }),
        ],
        skipped: Array.from({ length: 5000 }, (_unused, index) => ({
          fixtureId: `skipped-${String(index)}`,
          surface: "xdr",
          reason: "z".repeat(512),
        })),
      }),
    );

    expect(utf8(markdown)).toBeLessThan(SUMMARY_BYTE_LIMIT);
    expect(markdown).toContain("#### Failures");
    expect(markdown).toContain("- `the-failure` (xdr) — mismatch");
    expect(markdown).toContain("#### Warnings");
    expect(markdown).toContain("- `a-warning` (rpc) — slow — ");
    // Only the skipped list, the lowest-priority section, was clipped.
    expect(markdown).toMatch(/\d+ more skipped fixtures omitted/);
    expect(markdown).not.toMatch(/\d+ more (failing checks|warnings) omitted/);
    expect(markdown).toContain(TRUNCATION_NOTICE);
  });

  it("drops warnings entirely when the failures alone exhaust the budget", () => {
    // The mirror case: when the high-priority regressions fill the budget, the
    // verbose sections must yield rather than push the payload over the
    // ceiling. The failures are many and small so the leftover slack is under
    // one entry, and the warning is far larger than that slack.
    const failures = Array.from({ length: 5000 }, (_unused, index) =>
      result({
        testId: `fail-${String(index)}`,
        surface: "xdr",
        fixtureId: `fail-${String(index)}`,
        status: "fail",
        summary: `mismatch — ${"f".repeat(1000)}`,
      }),
    );
    const markdown = renderSummaryMarkdown(
      report({
        status: "fail",
        counts: { total: 5001, passed: 0, failed: 5000, warnings: 1, errors: 0, skipped: 0 },
        results: [
          ...failures,
          result({
            testId: "a-warning",
            surface: "rpc",
            fixtureId: "w",
            status: "warning",
            summary: `slow — ${"w".repeat(50_000)}`,
          }),
        ],
      }),
    );

    expect(utf8(markdown)).toBeLessThan(SUMMARY_BYTE_LIMIT);
    // The failures section kept what it could and accounted for the rest...
    expect(markdown).toContain("#### Failures");
    expect(markdown).toContain("- `fail-0` (xdr) — mismatch — ");
    expect(markdown).toMatch(/\d+ more failing checks omitted/);
    // ...and the warnings section, having no budget left, was dropped whole
    // rather than rendered as an empty heading.
    expect(markdown).not.toContain("#### Warnings");
    expect(markdown).not.toContain("- `a-warning`");
    expect(markdown).toContain(TRUNCATION_NOTICE);
  });

  it("drops an entry larger than the whole budget rather than cutting it", () => {
    // A single result whose summary exceeds the entire ceiling cannot be kept
    // whole. Cutting it mid-string would produce exactly the malformed
    // Markdown the issue asks to avoid, so the section is dropped rather than
    // clipped; the totals and the verdict still stand.
    const markdown = renderSummaryMarkdown(
      report({
        status: "fail",
        counts: { total: 1, passed: 0, failed: 1, warnings: 0, errors: 0, skipped: 0 },
        results: [
          result({
            testId: "the-failure",
            surface: "xdr",
            fixtureId: "f",
            status: "fail",
            summary: `mismatch — ${"f".repeat(SUMMARY_BYTE_LIMIT)}`,
          }),
        ],
      }),
    );

    expect(utf8(markdown)).toBeLessThan(SUMMARY_BYTE_LIMIT);
    // No fragment of the oversized entry leaks through.
    expect(markdown).not.toContain("ffff");
    // A section that could show nothing at all is dropped whole, rather than
    // left as a heading whose only content is an omission marker.
    expect(markdown).not.toContain("#### Failures");
    // The verdict survives regardless.
    expect(markdown).toContain("0/1 applicable checks passed.");
    expect(markdown).toContain("❌ **NOT READY**");
    expect(markdown).toContain(TRUNCATION_NOTICE);
  });

  it("is deterministic: the same report always renders to the same Markdown", () => {
    const results = manyFailures(2 * 1024 * 1024);
    const build = (): CanaryReport => report({ status: "fail", results });
    expect(renderSummaryMarkdown(build())).toBe(renderSummaryMarkdown(build()));
  });

  it("still bounds the output when the preamble alone is oversized", () => {
    // A pathological report (here, a multi-megabyte project name) can blow the
    // ceiling before a single section is considered. The ceiling is the hard
    // invariant — a 413 loses everything — so the payload must still fit.
    const markdown = renderSummaryMarkdown(
      report({ project: { name: "p".repeat(3 * 1024 * 1024), type: "soroban" } }),
    );

    expect(utf8(markdown)).toBeLessThan(SUMMARY_BYTE_LIMIT);
  });
});

describe("renderExecutionFailureMarkdown", () => {
  it("clearly distinguishes an execution failure from a compatibility failure", () => {
    const markdown = renderExecutionFailureMarkdown("cargo install failed", "error: could not compile");
    expect(markdown).toContain("could not be executed");
    expect(markdown).not.toContain("NOT READY");
    expect(markdown).toContain("error: could not compile");
  });

  it("shows a placeholder when there is no diagnostic output", () => {
    const markdown = renderExecutionFailureMarkdown("timed out", "");
    expect(markdown).toContain("(no diagnostic output)");
  });

  // The diagnostic is raw text from an external process, so it may itself
  // contain ``` (e.g. a compiler or panic message quoting a code block). A
  // fence is only closed by an equally long backtick run at line start, so
  // the fix makes the fence strictly longer than anything the diagnostic
  // contains and the whole diagnostic still renders as one code block (#269).
  it("keeps a diagnostic containing triple backticks inside the fence (#269)", () => {
    const diagnostic = [
      "error: proc-macro panic:",
      "```rust",
      "let x = 1; // quoted code from the panic message",
      "```",
      "stack backtrace:",
    ].join("\n");
    const markdown = renderExecutionFailureMarkdown("check failed to run", diagnostic);

    // The opening fence must be a longer run than any backtick run inside
    // the diagnostic, so no line of the diagnostic can close or reopen it.
    const opening = /^(`{4,})text$/m.exec(markdown);
    expect(opening).not.toBeNull();
    const fence = opening![1]!;
    const longestDiagnosticRun = Math.max(...[...diagnostic.matchAll(/`+/g)].map((match) => match[0].length));
    expect(fence.length).toBeGreaterThan(longestDiagnosticRun);

    // Exactly one opening fence line and one closing fence line: no line of
    // the diagnostic itself closes the block early. (A fence is closed by an
    // equally long run at line start, so any line whose leading run reaches
    // fence length must be one of the two fence lines.)
    const lines = markdown.split("\n");
    expect(lines.filter((line) => line === `${fence}text`)).toHaveLength(1);
    expect(lines.filter((line) => line === fence)).toHaveLength(1);
    for (const line of lines) {
      const run = /^`+/.exec(line)?.[0] ?? "";
      if (run.length >= fence.length) {
        expect([fence, `${fence}text`]).toContain(line);
      }
    }

    // The verbatim diagnostic content survives inside the single block.
    expect(markdown).toContain("```rust");
    expect(markdown).toContain("// quoted code from the panic message");
    expect(markdown).toContain("stack backtrace:");
  });

  it("keeps a diagnostic made of backtick runs alone inside the fence (#269)", () => {
    // Worst case: every line is a run of backticks long enough to close a
    // fixed-length fence, including runs of the same length as the
    // diagnostic's longest run.
    const diagnostic = ["```", "``````", "``````"].join("\n");
    const markdown = renderExecutionFailureMarkdown("spawn failed", diagnostic);

    const opening = /^(`{4,})text$/m.exec(markdown);
    expect(opening).not.toBeNull();
    const fence = opening![1]!;
    // Six backticks inside; the fence must be strictly longer than that.
    expect(fence.length).toBeGreaterThan(6);

    const lines = markdown.split("\n");
    expect(lines.filter((line) => line === `${fence}text`)).toHaveLength(1);
    expect(lines.filter((line) => line === fence)).toHaveLength(1);
    for (const line of lines) {
      const run = /^`+/.exec(line)?.[0] ?? "";
      if (run.length >= fence.length) {
        expect([fence, `${fence}text`]).toContain(line);
      }
    }
  });
});
