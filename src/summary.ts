import * as core from "@actions/core";

import { formatSafeDiagnosticTail } from "./log-block";
import { SummaryPublishFailedError } from "./errors";
import { countReplayed } from "./output";
import { codeSpan, escapeInline, fencedBlock, maskRpcUrl, quoteForShell } from "./markdown";
import type { CanaryReport, CanarySkip, OverallStatus, Surface } from "./output";

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

/** Human-readable labels for CF-01 skip reason codes. */
const SKIP_CODE_LABELS: Readonly<Record<string, string>> = {
  UNSUPPORTED_PROTOCOL: "Unsupported protocol",
  SURFACE_DISABLED: "Surface disabled",
  MISSING_CAPABILITY: "Missing capability",
  OFFLINE: "Offline",
  NETWORK_MISMATCH: "Network mismatch",
  UNKNOWN: "Unknown reason",
};

/** Render order for skip groups; unknown/unrecorded codes always come last. */
const SKIP_CODE_ORDER: readonly string[] = [
  "UNSUPPORTED_PROTOCOL",
  "SURFACE_DISABLED",
  "MISSING_CAPABILITY",
  "OFFLINE",
  "NETWORK_MISMATCH",
  "UNKNOWN",
];

/**
 * Reads a skip reason code per CF-01: an absent or unrecognized code is
 * `UNKNOWN`, never the raw value and never an empty string. This mirrors the
 * engine's own `SkipCode::parse` fallback so the summary groups reports from
 * older and newer engines the same way.
 */
function normalizeSkipCode(code: unknown): string {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(SKIP_CODE_LABELS, code)
    ? code
    : "UNKNOWN";
}

function skipCodeRank(code: string): number {
  const index = SKIP_CODE_ORDER.indexOf(code);
  return index === -1 ? SKIP_CODE_ORDER.length : index;
}

/**
 * Renders skipped fixtures as one table grouped by stable reason code
 * (#341). Rows are sorted by code rank, then fixture id and surface, so
 * repeated runs over the same report produce identical Markdown. Every
 * engine-supplied value is escaped; missing values get explicit fallbacks
 * rather than throwing or rendering an empty cell.
 */
function skippedFixtureLines(skipped: readonly CanarySkip[]): string[] {
  const rows = skipped.map((skip) => {
    const fixtureId =
      typeof skip.fixtureId === "string" && skip.fixtureId.trim() !== ""
        ? skip.fixtureId.trim()
        : "(unknown fixture)";
    const surface =
      typeof skip.surface === "string" && skip.surface.trim() !== ""
        ? skip.surface.trim()
        : "(unknown surface)";
    const reason =
      typeof skip.reason === "string" && skip.reason.trim() !== ""
        ? skip.reason.trim()
        : "(no reason recorded)";
    return { code: normalizeSkipCode(skip.code), fixtureId, surface, reason };
  });
  rows.sort((a, b) => {
    const byCode = skipCodeRank(a.code) - skipCodeRank(b.code);
    if (byCode !== 0) return byCode;
    if (a.fixtureId !== b.fixtureId) return a.fixtureId < b.fixtureId ? -1 : 1;
    if (a.surface !== b.surface) return a.surface < b.surface ? -1 : 1;
    return 0;
  });

  return [
    "<details><summary>Skipped fixtures</summary>",
    "",
    "| Reason code | Fixture | Surface | Reason |",
    "|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${codeSpan(row.code)} — ${escapeInline(SKIP_CODE_LABELS[row.code] ?? "Unknown reason")} | ` +
        `${codeSpan(row.fixtureId)} | ${escapeInline(row.surface)} | ${escapeInline(row.reason)} |`,
    ),
    "",
    "</details>",
    "",
  ];
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

function notablyList(report: CanaryReport, statuses: readonly ("fail" | "error" | "warning")[]): string[] {
  return report.results
    .filter((r) => (statuses as readonly string[]).includes(r.status))
    .map((r) => {
      const lines = [`- ${codeSpan(r.testId)} (${escapeInline(r.surface)}) — ${escapeInline(r.summary)}`];
      if (r.details !== undefined && r.details.trim() !== "") {
        lines.push(fencedBlock(r.details.trim()));
      }
      return lines.join("\n");
    });
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
  /** Argument array the engine was invoked with (issue #416). When present,
   * the summary renders a collapsed "Reproduction command" section. */
  readonly engineArgs?: readonly string[] | undefined;
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

/**
 * Explains an observed-protocol mismatch (#430): the engine checked the
 * target protocol, but the network reported a different protocol version
 * during live checks. Returns `undefined` when there is nothing to warn
 * about — no network, no usable observed protocol, or agreement — so callers
 * never emit a warning for a report that could not observe a protocol at
 * all. The message is shared by the job summary and the annotation so both
 * surfaces say exactly the same thing.
 */
export function protocolMismatchMessage(report: CanaryReport): string | undefined {
  const observed = report.network?.observedProtocol;
  const target = report.targetProtocol;
  if (typeof observed !== "number" || !Number.isInteger(observed) || observed <= 0) {
    return undefined;
  }
  if (!Number.isInteger(target) || target <= 0 || observed === target) {
    return undefined;
  }
  return (
    `Protocol mismatch: the network reported protocol ${String(observed)}, ` +
    `but this run targets protocol ${String(target)}.`
  );
}

/** Pure Markdown rendering, kept separate from `core.summary` so it can be
 * golden/snapshot-tested without a GitHub Actions runtime. `provenance`
 * renders the Provenance & Trust section (issue #373) and the reproduction
 * command (issue #416); omitting it renders no section, keeping every
 * pre-provenance consumer's output identical. */
export function renderSummaryMarkdown(report: CanaryReport, provenance?: SummaryProvenance): string {
  const lines: string[] = [];
  lines.push("## Stellar Protocol Canary", "");
  lines.push(`Protocol: ${escapeInline(String(report.targetProtocol))}`);
  lines.push(`Project: ${escapeInline(report.project.name)} (${escapeInline(report.project.type)})`);
  if (report.network !== undefined) {
    const observed =
      report.network.observedProtocol !== undefined
        ? ` — observed protocol ${escapeInline(String(report.network.observedProtocol))}`
        : "";
    lines.push(`Network: ${escapeInline(report.network.name)}${observed}`);
  }
  // A live-check network that reports a different protocol than the target
  // (#430) is worth surfacing prominently: the checks still describe the
  // target protocol, not what the network is currently running.
  const mismatch = protocolMismatchMessage(report);
  if (mismatch !== undefined) {
    lines.push(`> ⚠️ ${mismatch}`, "");
  }
  lines.push(`Canary version: ${escapeInline(report.toolVersion)}`, "");

  const rows = SURFACE_ORDER.map((surface) => surfaceRowLabel(report.results, surface)).filter(
    (row): row is string => row !== undefined,
  );
  if (rows.length > 0) {
    lines.push("| Surface | Result |", "|---|---|", ...rows, "");
  }

  lines.push("### Result", "", OVERALL_LABEL[report.status], "");
  lines.push(`${String(report.counts.passed)}/${String(report.counts.total)} applicable checks passed.`, "");

  const replayed = countReplayed(report);
  if (replayed > 0) {
    // Footnote for cache reuse (issue #350): how many results were replayed
    // from the engine's result cache instead of executed in this run, so a
    // reader can tell execution from cache reuse at a glance. Reports
    // without any replayed results (all pre-cache engine releases) render
    // nothing here.
    const total = report.counts.total;
    const percent = total > 0 ? Math.round((replayed / total) * 100) : 0;
    lines.push(
      `> ♻️ **Replayed from cache:** ${String(replayed)}/${String(total)} checks (${String(percent)}%) came from the engine's result cache rather than being executed in this run.`,
      "",
    );
  }

  const failures = notablyList(report, ["fail", "error"]);

  if (provenance !== undefined) {
    lines.push(...provenanceLines(provenance));
  }
  if (failures.length > 0) {
    lines.push("#### Failures", "", ...failures, "");
  }

  const warnings = notablyList(report, ["warning"]);
  if (warnings.length > 0) {
    lines.push("#### Warnings", "", ...warnings, "");
  }

  if (report.skipped !== undefined && report.skipped.length > 0) {
    lines.push(...skippedFixtureLines(report.skipped));
  }

  // Reproduction command section (issue #416)
  if (provenance?.engineArgs !== undefined && provenance.engineArgs.length > 0) {
    lines.push(renderReproductionCommand(provenance.engineArgs, provenance.engineVersion));
  }

  return lines.join("\n");
}

/**
 * Renders a collapsed <details> section with the engine version and a
 * copy-pasteable `stellar-canary check` command.
 *
 * Arguments are quoted for POSIX shell safety. The --rpc-url value is
 * masked when it contains userinfo, a query string, or a fragment, using
 * the same parsing as src/redact.ts.
 */
function renderReproductionCommand(args: readonly string[], engineVersion?: string): string {
  const lines: string[] = [];
  lines.push("<details><summary>Reproduction command</summary>", "");

  if (engineVersion !== undefined) {
    lines.push(`Engine version: ${codeSpan(engineVersion)}`, "");
  }

  // Build the command string with POSIX shell quoting
  const command = buildCommandString(args);
  lines.push(fencedBlock(command), "", "</details>", "");

  return lines.join("\n");
}

/**
 * Builds a POSIX-shell-safe command string from the argument array.
 *
 * Masks the --rpc-url value when it contains userinfo, query string, or fragment.
 * Quotes arguments that contain spaces, quotes, or shell metacharacters.
 */
function buildCommandString(args: readonly string[]): string {
  const parts: string[] = ["stellar-canary"];

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!; // i < args.length guaranteed by loop condition
    const nextArg = args[i + 1];

    // Mask --rpc-url value if it contains credentials, query, or fragment
    if (arg === "--rpc-url" && nextArg !== undefined) {
      parts.push(arg, maskRpcUrl(nextArg));
      i += 2; // Skip the next argument since we handled it
      continue;
    }

    parts.push(quoteForShell(arg));
    i++;
  }

  return parts.join(" ");
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
 * Reasons and diagnostic blocks each retain at most 40 tail lines plus
 * the truncation notice, within 8 KiB UTF-8 including that notice (#499).
 * Markdown scaffolding is outside this content budget.
 *
 * The sanitized diagnostic is embedded inside a fenced code block, but it is
 * raw text from an external process (stderr, a timeout notice), so it may
 * itself contain ``` (e.g. a compiler/panic message quoting a code block).
 * A fixed fence would be closed early by that sequence, and the rest of the
 * diagnostic would render as broken markdown. The fence is therefore made
 * longer than the longest backtick run the diagnostic contains — the exact
 * strategy CommonMark §Fenced code blocks specifies for embedding such
 * content.
 */
export function renderExecutionFailureMarkdown(reason: string, diagnostic: string): string {
  const trimmed = formatSafeDiagnosticTail(diagnostic).trim();
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
    `Reason: ${formatSafeDiagnosticTail(reason)}`,
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
