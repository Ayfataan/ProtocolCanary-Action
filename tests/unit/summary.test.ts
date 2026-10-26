import { describe, expect, it } from "vitest";

import type { CanaryReport, CanaryResult, CanarySkip } from "../../src/output";
import { SUMMARY_BYTE_LIMIT, TRUNCATION_NOTICE, protocolMismatchMessage, renderExecutionFailureMarkdown, renderSummaryMarkdown } from "../../src/summary";
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

  it("renders a structured skipped-fixtures table grouped by reason code (#341)", () => {
    const markdown = renderSummaryMarkdown(
      report({
        skipped: [
          {
            fixtureId: "p28-rpc-missing",
            surface: "rpc",
            reason: "project does not declare the rpc capability",
            code: "MISSING_CAPABILITY",
          },
          {
            fixtureId: "p27-xdr-old",
            surface: "xdr",
            reason: "fixture targets protocol 27, this run targets protocol 28",
            code: "UNSUPPORTED_PROTOCOL",
          },
          {
            fixtureId: "p27-rpc-old",
            surface: "rpc",
            reason: "fixture targets protocol 27",
            code: "UNSUPPORTED_PROTOCOL",
          },
        ],
      }),
    );

    expect(markdown).toContain("| Reason code | Fixture | Surface | Reason |");
    expect(markdown).toContain("| `UNSUPPORTED_PROTOCOL` — Unsupported protocol |");
    expect(markdown).toContain("| `MISSING_CAPABILITY` — Missing capability |");
    // Group order is deterministic: unsupported protocol rows precede the
    // missing-capability row, and equal codes sort by fixture id.
    const unsupported = markdown.indexOf("p27-rpc-old");
    const unsupported2 = markdown.indexOf("p27-xdr-old");
    const missing = markdown.indexOf("p28-rpc-missing");
    expect(unsupported).toBeGreaterThanOrEqual(0);
    expect(unsupported).toBeLessThan(unsupported2);
    expect(unsupported2).toBeLessThan(missing);
  });

  it("renders safe UNKNOWN fallbacks when skip codes or fields are missing (#341)", () => {
    const skipped = [
      { fixtureId: "unrecorded", surface: "xdr", reason: "older engine wrote no code" },
      { fixtureId: "future", surface: "rpc", reason: "a newer code", code: "FROM_THE_FUTURE" },
      { fixtureId: "", surface: "", reason: "", code: "" },
    ] as unknown as CanarySkip[];

    const markdown = renderSummaryMarkdown(report({ skipped }));

    expect(markdown).toContain("`UNKNOWN` — Unknown reason");
    expect(markdown).toContain("older engine wrote no code");
    expect(markdown).toContain("a newer code");
    expect(markdown).not.toContain("FROM_THE_FUTURE");
    expect(markdown).toContain("(unknown fixture)");
    expect(markdown).toContain("unknown surface");
    expect(markdown).toContain("no reason recorded");
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

  describe("observed protocol mismatch (#430)", () => {
    it("renders a warning when the network reported a different protocol than the target", () => {
      const markdown = renderSummaryMarkdown(
        report({
          targetProtocol: 28,
          network: { name: "testnet", observedProtocol: 27 },
          results: [result({ testId: "a", surface: "rpc", fixtureId: "a" })],
        }),
      );

      expect(markdown).toContain("> ⚠️ Protocol mismatch:");
      // Both numbers and the direction of the mismatch are stated, so a
      // reader never has to guess which protocol the results describe.
      expect(markdown).toContain("reported protocol 27");
      expect(markdown).toContain("targets protocol 28");
    });

    it("does not warn when the observed protocol matches the target", () => {
      const markdown = renderSummaryMarkdown(
        report({ targetProtocol: 28, network: { name: "testnet", observedProtocol: 28 } }),
      );

      expect(markdown).toContain("Network: testnet — observed protocol 28");
      expect(markdown).not.toContain("Protocol mismatch");
    });

    it("does not warn when the report has no observed protocol to compare", () => {
      const markdown = renderSummaryMarkdown(
        report({ targetProtocol: 28, network: { name: "testnet" } }),
      );

      expect(markdown).not.toContain("Protocol mismatch");
    });

    it("does not warn when the report has no network at all", () => {
      expect(renderSummaryMarkdown(report({ targetProtocol: 28 }))).not.toContain("Protocol mismatch");
    });
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

  // #350: fixtures/results served from the engine's cache must be called out
  // so a reader can tell cache reuse from fresh execution.
  it("renders a replayed-from-cache badge with count and percentage (#350)", () => {
    const markdown = renderSummaryMarkdown(
      report({
        status: "pass",
        counts: { total: 4, passed: 4, failed: 0, warnings: 0, errors: 0, skipped: 0 },
        results: [
          result({ testId: "a", surface: "xdr", fixtureId: "a", source: "cache" }),
          result({ testId: "b", surface: "xdr", fixtureId: "b", source: "cache" }),
          result({ testId: "c", surface: "rpc", fixtureId: "c", source: "live" }),
          result({ testId: "d", surface: "rpc", fixtureId: "d" }),
        ],
      }),
    );

    expect(markdown).toContain("Replayed from cache");
    expect(markdown).toContain("2/4 checks (50%)");
    expect(markdown).toContain("♻️");
  });

  it("renders no cache badge when nothing was replayed (#350)", () => {
    const markdown = renderSummaryMarkdown(
      report({
        status: "pass",
        counts: { total: 2, passed: 2, failed: 0, warnings: 0, errors: 0, skipped: 0 },
        results: [
          result({ testId: "a", surface: "xdr", fixtureId: "a", source: "live" }),
          result({ testId: "b", surface: "rpc", fixtureId: "b", source: "live" }),
        ],
      }),
    );
    expect(markdown).not.toContain("Replayed from cache");
    expect(markdown).toContain("2/2 applicable checks passed.");
  });

  it("defaults to zero replayed checks (no badge, no throw) for reports without any replayed field (#350)", () => {
    // Reports from engines that predate the cache carry no source/replayed
    // attributes at all; rendering must be unaffected.
    const markdown = renderSummaryMarkdown(
      report({
        status: "pass",
        counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
        results: [result({ testId: "a", surface: "xdr", fixtureId: "a" })],
      }),
    );
    expect(markdown).not.toContain("Replayed from cache");
    expect(markdown).toContain("1/1 applicable checks passed.");
  });

  it("links the report artifact when an artifact ID is available", () => {
    const originalRepo = process.env.GITHUB_REPOSITORY;
    const originalRunId = process.env.GITHUB_RUN_ID;
    const originalServerUrl = process.env.GITHUB_SERVER_URL;
    try {
      process.env.GITHUB_REPOSITORY = "StellarCanary/ProtocolCanary-Action";
      process.env.GITHUB_RUN_ID = "123456";
      delete process.env.GITHUB_SERVER_URL;

      const markdown = renderSummaryMarkdown(
        report({ status: "pass" }),
        undefined,
        { id: 9876, name: "stellar-protocol-canary-report" },
      );

      expect(markdown).toContain(
        "Report artifact: [stellar-protocol-canary-report](https://github.com/StellarCanary/ProtocolCanary-Action/actions/runs/123456/artifacts/9876)",
      );
    } finally {
      if (originalRepo !== undefined) process.env.GITHUB_REPOSITORY = originalRepo;
      else delete process.env.GITHUB_REPOSITORY;
      if (originalRunId !== undefined) process.env.GITHUB_RUN_ID = originalRunId;
      else delete process.env.GITHUB_RUN_ID;
      if (originalServerUrl !== undefined) process.env.GITHUB_SERVER_URL = originalServerUrl;
      else delete process.env.GITHUB_SERVER_URL;
    }
  });

  it("omits the artifact link when no artifact or no ID is provided", () => {
    const markdown1 = renderSummaryMarkdown(report({ status: "pass" }));
    expect(markdown1).not.toContain("Report artifact:");

    const markdown2 = renderSummaryMarkdown(report({ status: "pass" }), undefined, { name: "stellar-report" });
    expect(markdown2).not.toContain("Report artifact:");
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

  it("keeps the Provenance & Trust section when a 2 MiB report is truncated (#373, #334)", () => {
    const results = manyFailures(2 * 1024 * 1024);
    const markdown = renderSummaryMarkdown(
      report({
        status: "fail",
        counts: { total: results.length, passed: 0, failed: results.length, warnings: 0, errors: 0, skipped: 0 },
        results,
      }),
      { binarySha256: "a".repeat(64), engineVersion: "0.1.1" },
    );

    expect(utf8(markdown)).toBeLessThan(SUMMARY_BYTE_LIMIT);
    expect(markdown).toContain("### Provenance & Trust");
    expect(markdown).toContain(`sha256:${"a".repeat(64)}`);
    expect(markdown).toContain(TRUNCATION_NOTICE);
  });

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

  it("reports omitted warnings when failures leave no room for warning entries", () => {
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
    // ...and the warnings section has no room for its first entry, so it
    // reports the omission without leaking a partial warning.
    expect(markdown).toContain("#### Warnings");
    expect(markdown).toMatch(/1 more warnings omitted/);
    expect(markdown).not.toContain("- `a-warning`");
    expect(markdown).toContain(TRUNCATION_NOTICE);
  });

  it("reports an omitted count when the first entry cannot fit rather than cutting it", () => {
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
    // No fragment of the oversized entry leaks through, but its omission is
    // still explicit even though it was the first entry in the section.
    expect(markdown).not.toContain("ffff");
    expect(markdown).toContain("#### Failures");
    expect(markdown).toContain("1 more failing checks omitted");
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

  it("omits artifact link from execution failure summary when no artifact was uploaded", () => {
    const markdown = renderExecutionFailureMarkdown("cargo install failed", "error: could not compile");
    expect(markdown).not.toContain("Report artifact:");
  });

  it("links the report artifact in execution failure summary when an artifact with ID is provided", () => {
    const originalRepo = process.env.GITHUB_REPOSITORY;
    const originalRunId = process.env.GITHUB_RUN_ID;
    try {
      process.env.GITHUB_REPOSITORY = "StellarCanary/ProtocolCanary-Action";
      process.env.GITHUB_RUN_ID = "123456";

      const markdown = renderExecutionFailureMarkdown(
        "cargo install failed",
        "error: could not compile",
        { id: 54321, name: "stellar-protocol-canary-report" },
      );
      expect(markdown).toContain(
        "Report artifact: [stellar-protocol-canary-report](https://github.com/StellarCanary/ProtocolCanary-Action/actions/runs/123456/artifacts/54321)",
      );
    } finally {
      if (originalRepo !== undefined) process.env.GITHUB_REPOSITORY = originalRepo;
      else delete process.env.GITHUB_REPOSITORY;
      if (originalRunId !== undefined) process.env.GITHUB_RUN_ID = originalRunId;
      else delete process.env.GITHUB_RUN_ID;
    }
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
    expect(markdown).toContain("\\`\\`\\`rust");
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

describe("protocolMismatchMessage (#430)", () => {
  it("returns a message naming both protocols when they differ", () => {
    expect(
      protocolMismatchMessage(
        report({ targetProtocol: 28, network: { name: "testnet", observedProtocol: 27 } }),
      ),
    ).toBe("Protocol mismatch: the network reported protocol 27, but this run targets protocol 28.");
  });

  it("returns undefined when the protocols agree", () => {
    expect(
      protocolMismatchMessage(
        report({ targetProtocol: 28, network: { name: "testnet", observedProtocol: 28 } }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined with no observed protocol, rather than treating it as a mismatch", () => {
    expect(protocolMismatchMessage(report({ network: { name: "testnet" } }))).toBeUndefined();
    expect(protocolMismatchMessage(report({}))).toBeUndefined();
  });

  it("ignores observed values that are not positive integers", () => {
    for (const observedProtocol of [0, -1, 27.5, Number.NaN]) {
      expect(
        protocolMismatchMessage(report({ targetProtocol: 28, network: { name: "testnet", observedProtocol } })),
      ).toBeUndefined();
    }
  });
});

describe("renderSummaryMarkdown — Provenance & Trust section (#373)", () => {
  const BINARY_SHA = "a".repeat(64);
  const PACK_DIGEST = "b".repeat(64);

  it("renders a report persistence warning callout note when reportWriteError is present (#508)", () => {
    const markdown = renderSummaryMarkdown(report({ status: "pass" }), {
      reportWriteError: "EACCES",
    });

    expect(markdown).toContain("Report persistence warning");
    expect(markdown).toContain("EACCES");
    expect(markdown).toContain("report artifact was not uploaded");
  });

  it("renders a provenance table with the binary SHA-256, pack digest, and engine version", () => {
    const markdown = renderSummaryMarkdown(report({ status: "pass" }), {
      binarySha256: BINARY_SHA,
      packDigest: PACK_DIGEST,
      engineVersion: "0.1.0",
    });

    expect(markdown).toContain("### Provenance & Trust");
    expect(markdown).toContain(`| Canary binary | \`sha256:${BINARY_SHA}\` |`);
    expect(markdown).toContain(`| Fixture pack | \`sha256:${PACK_DIGEST}\` |`);
    expect(markdown).toContain("| Engine version | 0.1.0 |");
  });

  it("states the D-07 trust boundary: digests prove integrity, not author authenticity", () => {
    const markdown = renderSummaryMarkdown(report({ status: "pass" }), {
      binarySha256: BINARY_SHA,
    });

    expect(markdown).toContain("data integrity");
    expect(markdown).toMatch(/not\D*proof of (the )?release author/i);
    expect(markdown).toContain("D-07");
  });

  it("marks missing provenance fields as unverified instead of fabricating digests", () => {
    const markdown = renderSummaryMarkdown(report({ status: "pass" }), {
      binarySha256: undefined,
      packDigest: undefined,
      engineVersion: "0.1.0",
    });

    expect(markdown).toContain("### Provenance & Trust");
    expect(markdown).toContain("| Canary binary | (unverified — no published checksum verified in this run) |");
    expect(markdown).toContain("| Fixture pack | (unverified — fixture-pack download pipeline not implemented, see #338) |");
    expect(markdown).not.toContain("| Canary binary | `");
  });

  it("omits the section entirely when no provenance metadata is plumbed at all", () => {
    const markdown = renderSummaryMarkdown(report({ status: "pass" }));
    expect(markdown).not.toContain("Provenance & Trust");
  });

  it("handles omitted provenance metadata cleanly without errors", () => {
    expect(() => renderSummaryMarkdown(report({ status: "pass" }), {})).not.toThrow();
    expect(() => renderSummaryMarkdown(report({ status: "fail" }), { engineVersion: "0.2.0" })).not.toThrow();
  });
});

describe("renderSummaryMarkdown — reproduction command (#416)", () => {
  it("renders a collapsed section with the engine version and exact command", () => {
    const markdown = renderSummaryMarkdown(report({ status: "pass" }), {
      engineVersion: "0.2.0",
      engineArgs: ["check", "--format", "json", "--protocol", "28", "--fixtures-dir", "fixtures"],
    });

    expect(markdown).toContain("<details><summary>Reproduction command</summary>");
    expect(markdown).toContain("Engine version: `0.2.0`");
    expect(markdown).toContain(
      "```text\nstellar-canary check --format json --protocol 28 --fixtures-dir fixtures\n```",
    );
    expect(markdown).toContain("</details>");
  });

  it("quotes arguments containing spaces and shell metacharacters", () => {
    const markdown = renderSummaryMarkdown(report({ status: "pass" }), {
      engineArgs: ["check", "--fixtures-dir", "fixtures dir", "--config", "$WEIRD;value"],
    });

    expect(markdown).toContain("--fixtures-dir 'fixtures dir'");
    expect(markdown).toContain("--config '$WEIRD;value'");
  });

  it("masks credentials in the --rpc-url argument", () => {
    const markdown = renderSummaryMarkdown(report({ status: "pass" }), {
      engineArgs: ["check", "--rpc-url", "https://user:pass@example.com/rpc?token=secret"],
    });

    expect(markdown).toContain("--rpc-url https://[REDACTED]@example.com/rpc[REDACTED]");
    expect(markdown).not.toContain("user:pass");
    expect(markdown).not.toContain("token=secret");
  });

  it("omits the section when no argument array is available", () => {
    expect(renderSummaryMarkdown(report({ status: "pass" }), { engineVersion: "0.2.0" })).not.toContain(
      "Reproduction command",
    );
    expect(renderSummaryMarkdown(report({ status: "pass" }), { engineArgs: [] })).not.toContain(
      "Reproduction command",
    );
  });

  it("does not render the section for pre-#416 callers that pass no provenance", () => {
    expect(renderSummaryMarkdown(report({ status: "pass" }))).not.toContain("Reproduction command");
  });
});
