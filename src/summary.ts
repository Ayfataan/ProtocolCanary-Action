import * as core from "@actions/core";

import { SummaryPublishFailedError } from "./errors";
import { countReplayed } from "./output";
import type { CanaryReport, OverallStatus, Surface } from "./output";

const SURFACE_HEADINGS: Readonly<Record<Surface, string>> = {
  xdr: "XDR",
  rpc: "RPC",
  soroban: "Soroban",
};

const SURFACE_ORDER: readonly Surface[] = ["xdr", "rpc", "soroban"];

const OVERALL_LABEL: Readonly<Record<OverallStatus, string>> = {
  pass: "✅ **PASS**",
  warning: "⚠️ **WARNING**",
  fail: "❌ **NOT READY**",
  error: "🚫 **ERROR**",
};

/**
 * Hard ceiling on the UTF-8 byte length of the Markdown this Action appends to
 * the job summary.
 *
 * GitHub rejects an oversized step-summary append outright (HTTP 413), which
 * loses the *entire* summary — including the pass/fail verdict a reader needs
 * first — rather than degrading it. A run with hundreds of failing checks can
 * produce megabytes of Markdown, so the payload is bounded here.
 *
 * Measured in bytes, not characters, because the limit is enforced on the
 * encoded payload and a summary full of emoji or non-Latin text is far
 * heavier than its character count suggests.
 *
 * Sits a little under the platform's 1 MiB (1024 KiB) ceiling so a payload
 * landing exactly on this number is still comfortably accepted.
 */
export const SUMMARY_BYTE_LIMIT = 1_000_000;

/**
 * Appended whenever truncation dropped detail, so a reader can never mistake
 * a clipped summary for a complete one. Points at the report artifact, which
 * is unaffected by this limit.
 */
export const TRUNCATION_NOTICE =
  "> [!WARNING] Summary truncated due to GitHub Step Summary size limits; view full report artifact for details.";

/** UTF-8 encoded length, which is what the step-summary limit is applied to. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** UTF-8 length of `lines.join("\n")`: the lines' own bytes plus one
 * separator byte between each adjacent pair. */
function joinedByteLength(lines: readonly string[]): number {
  let total = 0;
  for (const line of lines) {
    total += byteLength(line) + 1;
  }
  return Math.max(0, total - 1);
}

/** Aggregates one surface's results into its summary table row. Returns
 * `undefined` when no results match the surface, which is how
 * `renderSummaryMarkdown` omits untouched surfaces (e.g. an offline run has
 * no rpc/soroban rows) instead of fabricating a pass. */
function surfaceRowLabel(results: CanaryReport["results"], surface: Surface): string | undefined {
  const forSurface = results.filter((r) => r.surface === surface);
  if (forSurface.length === 0) {
    return undefined;
  }
  const worst = forSurface.some((r) => r.status === "fail" || r.status === "error")
    ? "fail"
    : forSurface.some((r) => r.status === "warning")
      ? "warning"
      : "pass";
  const passCount = forSurface.filter((r) => r.status === "pass").length;
  const icon = worst === "fail" ? "❌ FAIL" : worst === "warning" ? "⚠️ WARNING" : "✅ PASS";
  return `| ${SURFACE_HEADINGS[surface]} | ${icon} (${String(passCount)}/${String(forSurface.length)}) |`;
}

/** One failing/warning result, as the Markdown lines that describe it. Kept
 * as an array so the entry can be kept or dropped as a single atomic unit
 * when the summary has to be truncated (#334) — a result's summary line and
 * its indented detail body are never separated. */
function notablyEntries(report: CanaryReport, statuses: readonly ("fail" | "error" | "warning")[]): string[][] {
  return report.results
    .filter((r) => (statuses as readonly string[]).includes(r.status))
    .map((r) => {
      const lines = [`- \`${r.testId}\` (${r.surface}) — ${r.summary}`];
      if (r.details !== undefined && r.details.trim() !== "") {
        lines.push(
          r.details
            .trim()
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n"),
        );
      }
      return lines;
    });
}

/**
 * An optional, entry-per-result part of the summary: a heading, one entry per
 * result, and a trailer. Shared by the normal and the truncating renderer so
 * both produce the same section for a given report.
 *
 * The order of the list is also the truncation priority — see
 * {@link renderTruncatedSummary}.
 */
interface SummarySection {
  readonly heading: readonly string[];
  readonly entries: readonly (readonly string[])[];
  readonly trailer: readonly string[];
  /** Plural noun used in the "N more … omitted" marker for this section. */
  readonly noun: string;
}

/** The entry-per-result sections, in render order and in truncation priority:
 * Failures and errors first because those are the high-priority regressions a
 * reader must not lose, then Warnings, then the skipped-fixture list, which is
 * the least actionable detail of the three. */
function summarySections(report: CanaryReport): SummarySection[] {
  const skipped = report.skipped ?? [];
  return [
    {
      heading: ["#### Failures", ""],
      entries: notablyEntries(report, ["fail", "error"]),
      trailer: [""],
      noun: "failing checks",
    },
    {
      heading: ["#### Warnings", ""],
      entries: notablyEntries(report, ["warning"]),
      trailer: [""],
      noun: "warnings",
    },
    {
      heading: ["<details><summary>Skipped fixtures</summary>", ""],
      entries: skipped.map((s) => [`- \`${s.fixtureId}\` (${s.surface}) — ${s.reason}`]),
      trailer: ["", "</details>", ""],
      noun: "skipped fixtures",
    },
  ];
}

/**
 * Provenance metadata for the "Provenance & Trust" summary section
 * (issue #373). Every field is optional because the upstream pipelines
 * that produce them are only partially landed on `main`: the binary digest
 * comes from the published-checksum verification in `src/canary.ts`, while
 * the fixture-pack digest depends on the unmerged download pipeline (#338)
 * and the receipt data on #360. Missing fields are rendered as explicitly
 * unverified rather than omitted or fabricated.
 */
export interface SummaryProvenance {
  /** SHA-256 of the Canary binary as observed for this run (issue #373).
   * Undefined when the binary could not be read. */
  readonly binarySha256?: string | undefined;
  /** SHA-256 digest of the canonical fixture pack, once #338's download
   * verification produces one. */
  readonly packDigest?: string | undefined;
  /** Engine version the run executed. */
  readonly engineVersion?: string | undefined;
}

const UNVERIFIED_BINARY_ROW =
  "| Canary binary | (unverified — no published checksum verified in this run) |";
const UNVERIFIED_PACK_ROW =
  "| Fixture pack | (unverified — fixture-pack download pipeline not implemented, see #338) |";

/** Renders the "Provenance & Trust" section (issue #373). The wording is
 * deliberately constrained by decision D-07: a published checksum verifies
 * *data integrity* — it detects corruption or substitution of the artifact
 * between release and runner — and is expressly not proof of the release
 * author's identity or endorsement, because Protocol-Canary publishes no
 * signatures. D-11 keeps the same honesty on the transport side: no redirect
 * is followed during lookup today, so a digest reported here was fetched (or
 * refused) over a single authenticated HTTPS request. */
function provenanceLines(provenance: SummaryProvenance): string[] {
  const binaryRow =
    provenance.binarySha256 !== undefined
      ? `| Canary binary | \`sha256:${provenance.binarySha256}\` |`
      : UNVERIFIED_BINARY_ROW;
  const packRow =
    provenance.packDigest !== undefined
      ? `| Fixture pack | \`sha256:${provenance.packDigest}\` |`
      : UNVERIFIED_PACK_ROW;
  const engineRow = `| Engine version | ${provenance.engineVersion ?? "(unknown)"} |`;
  return [
    "### Provenance & Trust",
    "",
    "| Artifact | Digest |",
    "|---|---|",
    binaryRow,
    packRow,
    engineRow,
    "",
    "> ℹ️ These digests are a **data integrity** check against accidental corruption or " +
      "substitution of published artifacts. They are **not** proof of the release author's " +
      "identity, authenticity, or endorsement: release signing is deferred (decision D-07) " +
      "and the download-redirect policy is unresolved (decision D-11).",
    "",
  ];
}

/** The verdict block: title, protocol/project/network identity, the per-surface
 * table, and the overall status with its counts. These are what a reader opens
 * the summary for, so truncation never drops them (#334). */
function summaryPreamble(report: CanaryReport, provenance?: SummaryProvenance): string[] {
  const lines: string[] = [];
  lines.push("## Stellar Protocol Canary", "");
  lines.push(`Protocol: ${String(report.targetProtocol)}`);
  lines.push(`Project: ${report.project.name} (${report.project.type})`);
  if (report.network !== undefined) {
    const observed =
      report.network.observedProtocol !== undefined ? ` — observed protocol ${String(report.network.observedProtocol)}` : "";
    lines.push(`Network: ${report.network.name}${observed}`);
  }
  lines.push(`Canary version: ${report.toolVersion}`, "");

  const rows = SURFACE_ORDER.map((surface) => surfaceRowLabel(report.results, surface)).filter(
    (row): row is string => row !== undefined,
  );
  if (rows.length > 0) {
    lines.push("| Surface | Result |", "|---|---|");
    for (const row of rows) {
      lines.push(row);
    }
    lines.push("");
  }

  lines.push("### Result", "", OVERALL_LABEL[report.status], "");
  lines.push(`${String(report.counts.passed)}/${String(report.counts.total)} applicable checks passed.`, "");
  const replayed = countReplayed(report);
  if (replayed > 0) {
    const total = report.counts.total;
    const percent = total > 0 ? Math.round((replayed / total) * 100) : 0;
    lines.push(
      `> ♻️ **Replayed from cache:** ${String(replayed)}/${String(total)} checks (${String(percent)}%) came from the engine's result cache rather than being executed in this run.`,
      "",
    );
  }
  if (provenance !== undefined) {
    // Small and bounded, so it stays in the part truncation never drops.
    for (const line of provenanceLines(provenance)) {
      lines.push(line);
    }
  }
  return lines;
}

/** Closes a section that could not keep every entry, so a clipped section is
 * visibly clipped rather than silently short. The counts are exact, not
 * sampled. */
function omittedMarker(count: number, noun: string): string {
  return `- _… ${String(count)} more ${noun} omitted; see the full report artifact._`;
}

/** Keeps whole leading lines up to `limit` UTF-8 bytes. Last-resort guard for
 * a report whose preamble alone exceeds the ceiling; the ceiling is the hard
 * invariant because a 413 loses the whole summary. */
function clipToLimit(lines: readonly string[], limit: number): string {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const cost = byteLength(line) + (kept.length === 0 ? 0 : 1);
    if (bytes + cost > limit) {
      break;
    }
    kept.push(line);
    bytes += cost;
  }
  return kept.join("\n");
}

/**
 * Renders a bounded summary for a report too large to publish whole (#334).
 *
 * Deterministic by construction: the same report always produces the same
 * Markdown, because every decision below depends only on the report's content
 * and the byte budget — never on iteration order beyond the report's own.
 *
 * Budget, in priority order:
 *
 * 1. the preamble (identity, per-surface table, verdict, counts) — never
 *    dropped, so a clipped summary still answers "did it pass, and how much
 *    of the suite ran";
 * 2. Failures/errors, kept in report order as far as the budget allows;
 * 3. Warnings;
 * 4. the skipped-fixture list.
 *
 * Entries are taken whole, so the cut never lands mid-line, mid-entry, or
 * between a `<details>` and its `</details>`. The truncation notice is
 * reserved *before* any optional section is admitted, which is what
 * guarantees a summary that was clipped can always say so.
 */
function renderTruncatedSummary(report: CanaryReport, provenance?: SummaryProvenance): string {
  const body: string[] = [];
  /** Exactly `Buffer.byteLength(body.join("\n"))`, maintained incrementally:
   * each line contributes its own bytes plus the single newline separating it
   * from the previous one. Tracked as a running total so a report with tens of
   * thousands of entries stays O(n) instead of re-measuring on every append. */
  let bodyBytes = 0;
  const push = (lines: readonly string[]): void => {
    for (const line of lines) {
      bodyBytes += byteLength(line) + (body.length === 0 ? 0 : 1);
      body.push(line);
    }
  };
  /** Cost of appending `lines` to what has been pushed so far. */
  const pushCost = (lines: readonly string[]): number => {
    if (lines.length === 0 || body.length === 0) {
      return joinedByteLength(lines);
    }
    return joinedByteLength(lines) + 1;
  };

  // Bytes deliberately held back so that a section's closing marker and
  // trailer still fit once its entries have been chosen. Checked on every
  // admission below, not just when the section is opened.
  let reserved = 0;
  // Cost of the notice itself plus the newline that separates it from the body.
  // Reserved up front so an admitted section can never crowd it out.
  const noticeCost = byteLength(TRUNCATION_NOTICE) + 1;
  const fits = (lines: readonly string[]): boolean =>
    pushCost(lines) + reserved + noticeCost + bodyBytes < SUMMARY_BYTE_LIMIT;

  push(summaryPreamble(report, provenance));

  if (bodyBytes + noticeCost >= SUMMARY_BYTE_LIMIT) {
    // Pathological: even the identity and verdict exceed the ceiling, which
    // needs an unbounded field such as a multi-megabyte project name. Honour
    // the ceiling anyway — a rejected append loses everything.
    return clipToLimit(body, SUMMARY_BYTE_LIMIT);
  }

  for (const section of summarySections(report)) {
    const first = section.entries[0];
    if (section.entries.length === 0 || first === undefined) {
      continue;
    }
    // Prefer showing the first whole entry, but if it cannot fit, retain the
    // section heading and omission marker whenever those fit. Otherwise the
    // highest-priority dropped failures could disappear without any count.
    //
    // Entries are then kept as a prefix in report order: the first oversized
    // entry ends the section instead of being skipped over in favour of a
    // smaller later one, which keeps the output predictable.
    const worstCaseMarker = omittedMarker(section.entries.length, section.noun);
    if (!fits([...section.heading, ...first, worstCaseMarker, ...section.trailer])) {
      if (fits([...section.heading, worstCaseMarker, ...section.trailer])) {
        push(section.heading);
        push([worstCaseMarker]);
        push(section.trailer);
      }
      continue;
    }

    push(section.heading);
    // Hold the marker and trailer back from the entry loop. Without this
    // reservation the entries below would be free to spend the very bytes
    // those closing lines need, and the section would overrun the ceiling.
    reserved = pushCost([worstCaseMarker, ...section.trailer]);
    let kept = 0;
    for (const entry of section.entries) {
      if (!fits(entry)) {
        break;
      }
      push(entry);
      kept += 1;
    }
    reserved = 0;
    const dropped = section.entries.length - kept;
    if (dropped > 0) {
      push([omittedMarker(dropped, section.noun)]);
    }
    push(section.trailer);
  }

  push([TRUNCATION_NOTICE]);
  return body.join("\n");
}

/** Pure Markdown rendering, kept separate from `core.summary` so it can be
 * golden/snapshot-tested without a GitHub Actions runtime.
 *
 * The returned Markdown is always under {@link SUMMARY_BYTE_LIMIT} UTF-8
 * bytes. A report that renders within the budget is returned byte-for-byte as
 * rendered — truncation is invisible to every ordinary run — and only an
 * oversized one is clipped, with {@link TRUNCATION_NOTICE} appended so the
 * loss is never silent (#334). */
export function renderSummaryMarkdown(report: CanaryReport, provenance?: SummaryProvenance): string {
  const lines: string[] = [];
  // Pushed element-wise rather than via `push(...array)`: a spread of tens of
  // thousands of arguments overflows the call stack, which is exactly the
  // oversized-report case this function has to survive.
  const add = (values: readonly string[]): void => {
    for (const value of values) {
      lines.push(value);
    }
  };

  add(summaryPreamble(report, provenance));
  for (const section of summarySections(report)) {
    if (section.entries.length === 0) {
      continue;
    }
    add(section.heading);
    for (const entry of section.entries) {
      add(entry);
    }
    add(section.trailer);
  }

  const markdown = lines.join("\n");
  return byteLength(markdown) < SUMMARY_BYTE_LIMIT ? markdown : renderTruncatedSummary(report, provenance);
}

/**
 * Longest fenced code block the summary may embed, used to pick a fence
 * length that is strictly longer than any run of backticks the embedded
 * text itself contains. A fence is only closed by an equally long run at
 * line start, so a run inside the content can never close a longer fence.
 */
const MAX_EMBEDDED_FENCE_LENGTH = 20;

/**
 * Markdown rendering of an execution failure — the "Canary could not run
 * at all" case, distinct from a compatibility failure the report describes.
 *
 * The diagnostic is embedded verbatim inside a fenced code block, but it is
 * raw text from an external process (stderr, a timeout notice), so it may
 * itself contain ``` (e.g. a compiler/panic message quoting a code block).
 * A fixed fence would be closed early by that sequence, and the rest of the
 * diagnostic would render as broken markdown. The fence is therefore made
 * longer than the longest backtick run the diagnostic contains — the exact
 * strategy CommonMark §Fenced code blocks specifies for embedding such
 * content.
 */
export function renderExecutionFailureMarkdown(reason: string, diagnostic: string): string {
  const trimmed = diagnostic.trim();
  // Longest run of backticks anywhere in the diagnostic, in characters.
  // Also covers the closing fence the diagnostic text may already contain,
  // because a closing fence of length n is itself a run of n backticks.
  const longestRun = (trimmed.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  // A fence shorter than the diagnostic's longest run could be closed early
  // by that run; one strictly longer cannot. 20 backticks of headroom also
  // gives nested embedding (a summary quoted inside another code block) room.
  const fenceLength = Math.max(3, longestRun + 1, MAX_EMBEDDED_FENCE_LENGTH);
  const fence = "`".repeat(fenceLength);
  return [
    "## Stellar Protocol Canary",
    "",
    "### Result",
    "",
    "🚫 **ERROR**",
    "",
    "Protocol Canary could not be executed.",
    "",
    `Reason: ${reason}`,
    "",
    fence + "text",
    trimmed === "" ? "(no diagnostic output)" : trimmed,
    fence,
  ].join("\n");
}

/**
 * Publishes `markdown` to the current GitHub Actions job summary.
 *
 * This wraps `core.summary.addRaw(markdown, true).write()`. If adding or
 * writing the summary fails, it throws {@link SummaryPublishFailedError}
 * with the underlying error message.
 *
 * @param markdown Markdown to append to the job summary.
 * @throws {SummaryPublishFailedError} When summary publication fails.
 */
export async function writeSummary(markdown: string): Promise<void> {
  try {
    await core.summary.addRaw(markdown, true).write();
  } catch (error) {
    throw new SummaryPublishFailedError(
      `Failed to publish Canary summary: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
