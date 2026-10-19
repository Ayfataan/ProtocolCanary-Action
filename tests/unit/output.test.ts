import { describe, expect, it } from "vitest";

import { InvalidReportError } from "../../src/errors";
import type { CanaryReport } from "../../src/output";
import { countReplayed, describeExitCode, isReplayed, parseReport } from "../../src/output";
import { classifyCoverage } from "../../src/output";
import { report, result } from "./helpers";

const VALID_REPORT = JSON.stringify(
  report({
    status: "pass",
    counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
    results: [
      result({
        testId: "p28-xdr-cap83-empty-tx-set",
        surface: "xdr",
        summary: "StellarValue round-tripped byte-for-byte",
        fixtureId: "p28-xdr-cap83-empty-tx-set",
      }),
    ],
    git: { commit: "68a5f8d", branch: "main", isDirty: false },
  }),
);

describe("parseReport", () => {
  it("parses a well-formed report", () => {
    const report = parseReport(VALID_REPORT);
    expect(report.status).toBe("pass");
    expect(report.counts.total).toBe(1);
  });

  it("tolerates surrounding whitespace", () => {
    expect(() => parseReport(`\n  ${VALID_REPORT}  \n`)).not.toThrow();
  });

  it("rejects empty output", () => {
    expect(() => parseReport("")).toThrow(InvalidReportError);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseReport("{ not json")).toThrow(InvalidReportError);
  });

  it("rejects JSON that is not an object", () => {
    expect(() => parseReport("[1, 2, 3]")).toThrow(InvalidReportError);
  });

  // #270: an array passes `typeof parsed === "object"`, so the existing
  // array test above is rejected by the later schemaVersion check, not by
  // the non-object guard itself. These pin that guard directly: JSON null,
  // numbers, strings, and booleans are all non-objects the Action must
  // reject with the same "not a report object" message before any field
  // access is attempted on the parsed value.
  it("rejects JSON null as not a report object (#270)", () => {
    expect(() => parseReport("null")).toThrow(InvalidReportError);
    expect(() => parseReport("null")).toThrow(/not a report object/);
  });

  it("rejects a JSON number as not a report object (#270)", () => {
    expect(() => parseReport("42")).toThrow(InvalidReportError);
    expect(() => parseReport("42")).toThrow(/not a report object/);
  });

  it("rejects a JSON string as not a report object (#270)", () => {
    expect(() => parseReport('"a report"')).toThrow(InvalidReportError);
    expect(() => parseReport('"a report"')).toThrow(/not a report object/);
  });

  it("rejects a JSON boolean as not a report object (#270)", () => {
    expect(() => parseReport("true")).toThrow(InvalidReportError);
    expect(() => parseReport("true")).toThrow(/not a report object/);
  });

  it("rejects a report missing schemaVersion", () => {
    const { schemaVersion: _schemaVersion, ...rest } = JSON.parse(VALID_REPORT) as Record<string, unknown>;
    expect(() => parseReport(JSON.stringify(rest))).toThrow(InvalidReportError);
  });

  it("rejects an unsupported schemaVersion", () => {
    const report = { ...JSON.parse(VALID_REPORT), schemaVersion: 2 };
    expect(() => parseReport(JSON.stringify(report))).toThrow(InvalidReportError);
  });

  it("rejects a report with an unrecognized status", () => {
    const report = { ...JSON.parse(VALID_REPORT), status: "unknown" };
    expect(() => parseReport(JSON.stringify(report))).toThrow(InvalidReportError);
  });

  // Regression test: Protocol-Canary's actual tagged v0.1.0 release predates
  // the `counts` field (added in a later, unreleased commit) even though
  // both reports declare schemaVersion 1 — confirmed directly against a
  // real build of the v0.1.0 tag during three-repository E2E validation.
  // `counts` is documented as "purely a convenience — always re-derivable
  // from results[].status", so a report missing it must still parse, not
  // be rejected as malformed.
  it("derives counts from results when the CLI report omits it (older schemaVersion-1 releases)", () => {
    const { counts: _counts, ...withoutCounts } = JSON.parse(VALID_REPORT) as Record<string, unknown>;
    const report = parseReport(JSON.stringify(withoutCounts));
    expect(report.counts).toEqual({ total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 });
  });

  it("derives counts correctly across every result status and skipped fixtures", () => {
    const report = {
      ...JSON.parse(VALID_REPORT),
      status: "fail",
      results: [
        result({ testId: "a", surface: "xdr", summary: "ok", fixtureId: "a" }),
        result({ testId: "b", surface: "xdr", status: "fail", summary: "bad", fixtureId: "b" }),
        result({ testId: "c", surface: "rpc", status: "warning", summary: "warn", fixtureId: "c" }),
        result({ testId: "d", surface: "rpc", status: "error", summary: "err", fixtureId: "d" }),
      ],
      skipped: [{ fixtureId: "e", surface: "soroban", reason: "disabled" }],
    };
    delete report.counts;
    const parsed = parseReport(JSON.stringify(report));
    expect(parsed.counts).toEqual({ total: 4, passed: 1, failed: 1, warnings: 1, errors: 1, skipped: 1 });
  });

  it("rejects a report whose results field is present but not an array", () => {
    const report = { ...JSON.parse(VALID_REPORT), results: {} };
    expect(() => parseReport(JSON.stringify(report))).toThrow(InvalidReportError);
  });

  it("parses a report with zero results and derives all-zero counts", () => {
    const report = {
      ...JSON.parse(VALID_REPORT),
      results: [],
      counts: { total: 0, passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0 },
    };
    const parsed = parseReport(JSON.stringify(report));
    expect(parsed.counts).toEqual({ total: 0, passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0 });
  });

  it("trusts a well-formed counts field from the CLI rather than recomputing it", () => {
    // If the CLI's own counts ever legitimately differed from a naive
    // recount (e.g. a future aggregation rule), the Action must not
    // second-guess it.
    const report = { ...JSON.parse(VALID_REPORT), counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 9 } };
    const parsed = parseReport(JSON.stringify(report));
    expect(parsed.counts.skipped).toBe(9);
  });

  it("derives counts when the provided counts field is malformed", () => {
    const report = { ...JSON.parse(VALID_REPORT), counts: { total: "not-a-number" } };
    const parsed = parseReport(JSON.stringify(report));
    expect(parsed.counts).toEqual({ total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 });
  });

  // Regression tests for issue #67: the top-level report is otherwise
  // valid, but a single malformed `results` entry must be rejected at
  // parse time with InvalidReportError — not surface later as "undefined"
  // in annotations or the summary markdown.
  const RESULT_FIXTURE = JSON.parse(VALID_REPORT) as Record<string, unknown>;

  function reportWithResultEntry(entry: unknown): string {
    return JSON.stringify({ ...RESULT_FIXTURE, results: [entry] });
  }

  it("rejects a report whose results array contains a non-object entry", () => {
    expect(() => parseReport(reportWithResultEntry("not-an-object"))).toThrow(InvalidReportError);
  });

  it("rejects a result entry missing testId", () => {
    const { testId: _testId, ...rest } = {
      testId: "p28-xdr-cap83-empty-tx-set",
      protocol: 28,
      surface: "xdr",
      status: "pass",
      summary: "ok",
      durationMs: 1,
      fixtureId: "p28-xdr-cap83-empty-tx-set",
    };
    expect(() => parseReport(reportWithResultEntry(rest))).toThrow(InvalidReportError);
  });

  it("rejects a result entry missing surface", () => {
    const entry = { testId: "a", protocol: 28, status: "pass", summary: "ok", durationMs: 1, fixtureId: "a" };
    expect(() => parseReport(reportWithResultEntry(entry))).toThrow(InvalidReportError);
  });

  it("rejects a result entry missing status", () => {
    const entry = { testId: "a", protocol: 28, surface: "xdr", summary: "ok", durationMs: 1, fixtureId: "a" };
    expect(() => parseReport(reportWithResultEntry(entry))).toThrow(InvalidReportError);
  });

  it("rejects a result entry with an invalid status value", () => {
    const entry = { testId: "a", protocol: 28, surface: "xdr", status: "anything", summary: "ok", durationMs: 1, fixtureId: "a" };
    expect(() => parseReport(reportWithResultEntry(entry))).toThrow(InvalidReportError);
  });

  it("rejects a result entry with an invalid surface value", () => {
    const entry = { testId: "a", protocol: 28, surface: "graphql", status: "pass", summary: "ok", durationMs: 1, fixtureId: "a" };
    expect(() => parseReport(reportWithResultEntry(entry))).toThrow(InvalidReportError);
  });

  it("rejects a result entry missing summary", () => {
    const entry = { testId: "a", protocol: 28, surface: "xdr", status: "pass", durationMs: 1, fixtureId: "a" };
    expect(() => parseReport(reportWithResultEntry(entry))).toThrow(InvalidReportError);
  });

  it("rejects a result entry missing durationMs", () => {
    const entry = { testId: "a", protocol: 28, surface: "xdr", status: "pass", summary: "ok", fixtureId: "a" };
    expect(() => parseReport(reportWithResultEntry(entry))).toThrow(InvalidReportError);
  });

  it("rejects a result entry with a non-numeric durationMs", () => {
    const entry = { testId: "a", protocol: 28, surface: "xdr", status: "pass", summary: "ok", durationMs: "100", fixtureId: "a" };
    expect(() => parseReport(reportWithResultEntry(entry))).toThrow(InvalidReportError);
  });

  it("rejects a result entry missing fixtureId", () => {
    const entry = { testId: "a", protocol: 28, surface: "xdr", status: "pass", summary: "ok", durationMs: 1 };
    expect(() => parseReport(reportWithResultEntry(entry))).toThrow(InvalidReportError);
  });

  it("accepts a result entry with a null fixtureId", () => {
    const entry = { testId: "a", protocol: 28, surface: "xdr", status: "pass", summary: "ok", durationMs: 1, fixtureId: null };
    expect(() => parseReport(reportWithResultEntry(entry))).not.toThrow();
  });

  it("rejects a result entry with multiple malformed fields", () => {
    const entry = { testId: 7, surface: "xdr", status: "nope", summary: "ok", durationMs: "100", fixtureId: null };
    expect(() => parseReport(reportWithResultEntry(entry))).toThrow(InvalidReportError);
  });

  it("rejects a result entry missing the required protocol field", () => {
    const entry = { testId: "a", surface: "xdr", status: "pass", summary: "ok", durationMs: 1, fixtureId: "a" };
    expect(() => parseReport(reportWithResultEntry(entry))).toThrow(InvalidReportError);
  });

  it("identifies the offending result index in the error message", () => {
    const bad = { testId: "a", protocol: 28, surface: "xdr", summary: "ok", durationMs: 1, fixtureId: "a" };
    const good = { testId: "b", protocol: 28, surface: "rpc", status: "pass", summary: "ok", durationMs: 1, fixtureId: "b" };
    const report = { ...RESULT_FIXTURE, results: [good, bad] };
    expect(() => parseReport(JSON.stringify(report))).toThrow(/results\[1\]/);
  });

  it("rejects a skipped entry with a missing required field", () => {
    const report = { ...RESULT_FIXTURE, skipped: [{ fixtureId: "f", surface: "xdr" }] };
    expect(() => parseReport(JSON.stringify(report))).toThrow(InvalidReportError);
  });

  it("rejects a skipped entry with an incorrect field type", () => {
    const report = { ...RESULT_FIXTURE, skipped: [{ fixtureId: "f", surface: "xdr", reason: 42 }] };
    expect(() => parseReport(JSON.stringify(report))).toThrow(InvalidReportError);
  });

  it("accepts a well-formed skipped entry", () => {
    const report = { ...RESULT_FIXTURE, skipped: [{ fixtureId: "f", surface: "xdr", reason: "disabled" }] };
    expect(() => parseReport(JSON.stringify(report))).not.toThrow();
  });

  it("rejects a skipped field that is present but not an array", () => {
    const report = { ...RESULT_FIXTURE, skipped: "none" };
    expect(() => parseReport(JSON.stringify(report))).toThrow(InvalidReportError);
  });

  // #349 / CF-01 section 4: a result is identified inside one report by
  // `(surface, fixtureId)` — `testId` when `fixtureId` is absent — and a
  // report in which two results share an identity is invalid. Duplicates
  // could otherwise skew derived counts or hide a failure behind a copy of
  // a passing result.
  it("rejects a report with two results sharing the same (surface, fixtureId) identity (#349)", () => {
    const report = {
      ...RESULT_FIXTURE,
      results: [
        { testId: "a", protocol: 28, surface: "xdr", status: "pass", summary: "ok", durationMs: 1, fixtureId: "dup" },
        { testId: "b", protocol: 28, surface: "xdr", status: "fail", summary: "bad", durationMs: 1, fixtureId: "dup" },
      ],
    };
    expect(() => parseReport(JSON.stringify(report))).toThrow(InvalidReportError);
    expect(() => parseReport(JSON.stringify(report))).toThrow(/duplicate result identity/);
  });

  it("names the exact duplicate identity and surface in the error message (#349)", () => {
    const report = {
      ...RESULT_FIXTURE,
      results: [
        { testId: "a", protocol: 28, surface: "rpc", status: "pass", summary: "ok", durationMs: 1, fixtureId: "dup" },
        { testId: "b", protocol: 28, surface: "rpc", status: "fail", summary: "bad", durationMs: 1, fixtureId: "dup" },
      ],
    };
    expect(() => parseReport(JSON.stringify(report))).toThrow(/\("rpc", "dup"\)/);
    expect(() => parseReport(JSON.stringify(report))).toThrow(/results\[1\]/);
  });

  it("accepts the same fixtureId on different surfaces (identity is per-surface) (#349)", () => {
    const report = {
      ...RESULT_FIXTURE,
      results: [
        { testId: "a", protocol: 28, surface: "xdr", status: "pass", summary: "ok", durationMs: 1, fixtureId: "dup" },
        { testId: "a", protocol: 28, surface: "rpc", status: "pass", summary: "ok", durationMs: 1, fixtureId: "dup" },
      ],
    };
    expect(() => parseReport(JSON.stringify(report))).not.toThrow();
  });

  it("uses testId as the identity when fixtureId is null, rejecting duplicates there too (#349)", () => {
    const dup = (surface: string): Record<string, unknown> => ({
      testId: "shared-test",
      protocol: 28,
      surface,
      status: "pass",
      summary: "ok",
      durationMs: 1,
      fixtureId: null,
    });
    expect(() => parseReport(JSON.stringify({ ...RESULT_FIXTURE, results: [dup("xdr"), dup("xdr")] }))).toThrow(
      InvalidReportError,
    );
    expect(() => parseReport(JSON.stringify({ ...RESULT_FIXTURE, results: [dup("xdr"), dup("rpc")] }))).not.toThrow();
  });

  it("passes cleanly when every result identity is distinct (#349)", () => {
    const report = JSON.parse(VALID_REPORT) as Record<string, unknown>;
    expect(() => parseReport(JSON.stringify(report))).not.toThrow();
  });
});

describe("isReplayed / countReplayed", () => {
  // #350 / CF-01 section 6: `source: "cache"` marks a result replayed from
  // the engine's result cache; engines that predate the cache emit no
  // `source` at all and every result counts as live.
  it("counts results whose source is \"cache\" (#350)", () => {
    expect(countReplayed(report([result({ source: "cache" }), result({ source: "live" })]))).toBe(1);
    expect(isReplayed(result({ source: "cache" }))).toBe(true);
    expect(isReplayed(result({ source: "live" }))).toBe(false);
  });

  it("treats an absent source as not recorded — counted as 0, without throwing (#350)", () => {
    expect(countReplayed(report([result(), result()]))).toBe(0);
    expect(isReplayed(result())).toBe(false);
  });

  it("reads an unknown source value as not recorded, never as replayed (#350)", () => {
    expect(isReplayed(result({ source: "disk" }))).toBe(false);
    expect(isReplayed(result({ source: 42 as unknown as string }))).toBe(false);
  });

  it("honors boolean replayed/cached attributes alongside source (#350)", () => {
    expect(isReplayed(result({ replayed: true }))).toBe(true);
    expect(isReplayed(result({ cached: true }))).toBe(true);
    expect(isReplayed(result({ replayed: false, cached: false }))).toBe(false);
    // A boolean flag never reclassifies a live result.
    expect(isReplayed(result({ source: "live", replayed: true }))).toBe(true);
    expect(isReplayed(result({ source: "live", replayed: false }))).toBe(false);
  });

  it("parses a report carrying the additive source field without rejecting it (#350)", () => {
    const parsed = parseReport(
      JSON.stringify({
        ...(JSON.parse(VALID_REPORT) as Record<string, unknown>),
        results: [
          { testId: "a", protocol: 28, surface: "xdr", status: "pass", summary: "ok", durationMs: 1, fixtureId: "a", source: "cache" },
        ],
      }),
    );
    expect(countReplayed(parsed)).toBe(1);
  });
});

describe("classifyCoverage", () => {
  // #333: `coverage-state` is what a downstream job reads to decide whether a
  // pass may be promoted. `full` therefore has to mean "every fixture the
  // engine knew about ran", not merely "some checks passed".

  it("reports `full` when every discovered fixture ran and nothing was skipped", () => {
    const covered = report([
      result({ testId: "a", fixtureId: "a" }),
      result({ testId: "b", fixtureId: "b", surface: "rpc" }),
      result({ testId: "c", fixtureId: "c", surface: "soroban", status: "warning" }),
      // An errored check still executed: coverage is about what ran, not about
      // how it turned out.
      result({ testId: "d", fixtureId: "d", surface: "rpc", status: "error" }),
    ]);
    expect(classifyCoverage(covered)).toBe("full");
  });

  it("reports `partial` when at least one fixture was skipped", () => {
    const partial = report({
      results: [result({ testId: "a", fixtureId: "a" })],
      skipped: [{ fixtureId: "p27-xdr-legacy", surface: "xdr", reason: "fixture targets protocol 27" }],
      counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 1 },
    });
    expect(classifyCoverage(partial)).toBe("partial");
  });

  it("reports `partial` when a result's own status is `skipped`, even with no skipped[] entry", () => {
    // Some engine builds surface a skip as a result with status "skipped"
    // rather than as a `skipped[]` entry; coverage must not read that as full.
    const partial = report([
      result({ testId: "a", fixtureId: "a" }),
      result({ testId: "b", fixtureId: "b", status: "skipped", summary: "not applicable" }),
    ]);
    expect(classifyCoverage(partial)).toBe("partial");
  });

  it("reports `partial` when only counts.skipped records the skip", () => {
    // An older release can report a skipped count without shipping the
    // `skipped[]` array at all; the count alone must still demote `full`.
    const partial = report({
      results: [result({ testId: "a", fixtureId: "a" })],
      counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 4 },
    });
    expect(classifyCoverage(partial)).toBe("partial");
  });

  it("reports `none` when no fixture executed (empty results)", () => {
    expect(classifyCoverage(report({}))).toBe("none");
    // The empty-but-explicitly-shaped form an `--allow-empty` run produces:
    // no results at all and an all-zero counts object.
    expect(
      classifyCoverage(report({ results: [], counts: { total: 0, passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0 } })),
    ).toBe("none");
  });

  it("reports `none` when every discovered fixture was skipped", () => {
    // Something was discovered, but nothing ran: coverage is still none, and
    // the skips must not turn it into `partial` (which implies real coverage).
    const none = report({
      results: [result({ testId: "a", fixtureId: "a", status: "skipped" })],
      skipped: [{ fixtureId: "b", surface: "xdr", reason: "disabled" }],
    });
    expect(classifyCoverage(none)).toBe("none");
  });

  // Negative testing: a report that cannot prove coverage must classify, not
  // throw. This runs inside the reporting path of a real run, where an
  // exception would replace the run's results with a crash.
  it("defaults to `none` for missing coverage fields without throwing", () => {
    const missingResults = { schemaVersion: 1, toolVersion: "0.1.0" } as unknown as CanaryReport;
    expect(() => classifyCoverage(missingResults)).not.toThrow();
    expect(classifyCoverage(missingResults)).toBe("none");
  });

  it("defaults to `none` when results or counts are present but the wrong shape", () => {
    const wrongShape = {
      schemaVersion: 1,
      toolVersion: "0.1.0",
      results: { not: "an array" },
      counts: "not an object",
    } as unknown as CanaryReport;
    expect(() => classifyCoverage(wrongShape)).not.toThrow();
    expect(classifyCoverage(wrongShape)).toBe("none");
  });

  it("tolerates entries inside results that are not readable result objects", () => {
    const oddEntries = {
      ...report([result({ testId: "a", fixtureId: "a" })]),
      results: [null, "not-an-object", result({ testId: "b", fixtureId: "b" })],
    } as unknown as CanaryReport;
    expect(() => classifyCoverage(oddEntries)).not.toThrow();
    // None of those entries is readable as a skipped result, and nothing else
    // in the report records a skip, so the run is fully covered.
    expect(classifyCoverage(oddEntries)).toBe("full");
  });

  it("ignores a skipped[] field that is not an array instead of throwing", () => {
    const badSkipped = {
      ...report([result({ testId: "a", fixtureId: "a" })]),
      skipped: "none",
    } as unknown as CanaryReport;
    expect(classifyCoverage(badSkipped)).toBe("full");
  });

  it("does not read counts.total as coverage (a total can include skipped fixtures)", () => {
    // counts.total counts every result entry, including skipped ones, so using
    // it as the denominator would call a one-check run with four skipped
    // fixtures "full". Coverage is derived from what actually executed.
    const partial = report({
      results: [result({ testId: "a", fixtureId: "a" })],
      counts: { total: 5, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 4 },
    });
    expect(classifyCoverage(partial)).toBe("partial");
  });

  it("classifies a report that came through parseReport the same way as a hand-built one", () => {
    const parsed = parseReport(
      JSON.stringify({
        ...JSON.parse(VALID_REPORT),
        results: [result({ testId: "a", fixtureId: "a" })],
        skipped: [{ fixtureId: "b", surface: "xdr", reason: "disabled" }],
      }),
    );
    expect(classifyCoverage(parsed)).toBe("partial");
  });
});

describe("describeExitCode", () => {
  it("maps every documented exit code", () => {
    expect(describeExitCode(0).category).toBe("pass");
    expect(describeExitCode(1).category).toBe("compatibility_failure");
    expect(describeExitCode(2).category).toBe("configuration_error");
    expect(describeExitCode(3).category).toBe("execution_error");
    expect(describeExitCode(4).category).toBe("invalid_fixture");
    expect(describeExitCode(5).category).toBe("internal_error");
  });

  it("falls back to unknown for an unrecognized code", () => {
    expect(describeExitCode(99).category).toBe("unknown");
  });

  it("falls back to unknown for a negative code", () => {
    // A negative code can appear when a process-exec library synthesizes one
    // from a fatal signal; pin the Record<number, ...> lookup's fallback so a
    // future EXIT_CODES rework (e.g. a Map or a different default) cannot
    // silently change behavior for out-of-range input.
    expect(describeExitCode(-1).category).toBe("unknown");
  });
});
