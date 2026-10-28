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

export const SUMMARY_BYTE_LIMIT = 1_000_000;

export const TRUNCATION_NOTICE =
  "> [!WARNING] Summary truncated due to GitHub Step Summary size limits; view full report artifact for details.";

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function joinedByteLength(lines: readonly string[]): number {
  let total = 0;
  for (const line of lines) {
    total += byteLength(line) + 1;
  }
  return Math.max(0, total - 1);
}

const SKIP_CODE_LABELS: Readonly<Record<string, string>> = {
  UNSUPPORTED_PROTOCOL: "Unsupported protocol",
  SURFACE_DISABLED: "Surface disabled",
  MISSING_CAPABILITY: "Missing capability",
  OFFLINE: "Offline",
  NETWORK_MISMATCH: "Network mismatch",
  UNKNOWN: "Unknown reason",
};

const SKIP_CODE_ORDER: readonly string[] = [
  "UNSUPPORTED_PROTOCOL",
  "SURFACE_DISABLED",
  "MISSING_CAPABILITY",
  "OFFLINE",
  "NETWORK_MISMATCH",
  "UNKNOWN",
];

function normalizeSkipCode(code: unknown): string {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(SKIP_CODE_LABELS, code)
    ? code
    : "UNKNOWN";
}

function skipCodeRank(code: string): number {
  const index = SKIP_CODE_ORDER.indexOf(code);
  return index === -1 ? SKIP_CODE_ORDER.length : index;
}

function skippedFixtureRow(skip: CanarySkip): string {
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
  const code = normalizeSkipCode(skip.code);
  return (
    `| ${codeSpan(code)} — ${escapeInline(SKIP_CODE_LABELS[code] ?? "Unknown reason")} | ` +
    `${codeSpan(fixtureId)} | ${escapeInline(surface)} | ${escapeInline(reason)} |`
  );
}

export interface ArtifactSummaryInfo {
  readonly id?: number | undefined;
  readonly name?: string | undefined;
}

export function buildArtifactUrl(artifactId: number): string {
  const serverUrl = (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (repo && runId) {
    return `${serverUrl}/${repo}/actions/runs/${runId}/artifacts/${String(artifactId)}`;
  }
  return `${serverUrl}/actions/runs/artifacts/${String(artifactId)}`;
}

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

function notablyEntries(report: CanaryReport, statuses: readonly ("fail" | "error" | "warning")[]): string[][] {
  return report.results
    .filter((r) => (statuses as readonly string[]).includes(r.status))
    .map((r) => {
      const lines = [`- ${codeSpan(r.testId)} (${escapeInline(r.surface)}) — ${escapeInline(r.summary)}`];
      if (r.details !== undefined && r.details.trim() !== "") {
        lines.push(fencedBlock(r.details.trim()));
      }
      return lines;
    });
}

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

export interface SummaryProvenance {
  readonly binarySha256?: string | undefined;
  readonly packDigest?: string | undefined;
  readonly engineVersion?: string | undefined;
  readonly engineArgs?: readonly string[] | undefined;
  readonly reportWriteError?: string | undefined;
}

const UNVERIFIED_BINARY_ROW =
  "| Canary binary | (unverified — no published checksum verified in this run) |";
const UNVERIFIED_PACK_ROW =
  "| Fixture pack | (unverified — fixture-pack download pipeline not implemented, see #338) |";

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

interface SummarySection {
  readonly heading: readonly string[];
  readonly entries: readonly (readonly string[])[];
  readonly trailer: readonly string[];
  readonly noun: string;
}

function summarySections(report: CanaryReport): SummarySection[] {
  const skipped = [...(report.skipped ?? [])].sort((a, b) => {
    const byCode = skipCodeRank(normalizeSkipCode(a.code)) - skipCodeRank(normalizeSkipCode(b.code));
    if (byCode !== 0) return byCode;
    const aId = typeof a.fixtureId === "string" ? a.fixtureId : "";
    const bId = typeof b.fixtureId === "string" ? b.fixtureId : "";
    if (aId !== bId) return aId < bId ? -1 : 1;
    const aSurf = typeof a.surface === "string" ? a.surface : "";
    const bSurf = typeof b.surface === "string" ? b.surface : "";
    if (aSurf !== bSurf) return aSurf < bSurf ? -1 : 1;
    return 0;
  });
  const skippedRows = skipped.map((s) => skippedFixtureRow(s));
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
      heading: [
        "<details><summary>Skipped fixtures</summary>",
        "",
        "| Reason code | Fixture | Surface | Reason |",
        "|---|---|---|---|",
      ],
      entries: skippedRows.map((row) => [row]),
      trailer: ["", "</details>", ""],
      noun: "skipped fixtures",
    },
  ];
}

function summaryPreamble(
  report: CanaryReport,
  provenance?: SummaryProvenance,
  artifact?: ArtifactSummaryInfo,
): string[] {
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
  const mismatch = protocolMismatchMessage(report);
  if (mismatch !== undefined) {
    lines.push(`> ⚠️ ${mismatch}`, "");
  }
  lines.push(`Canary version: ${escapeInline(report.toolVersion)}`);
  if (artifact?.id !== undefined) {
    const name = artifact.name || "stellar-protocol-canary-report";
    lines.push(`Report artifact: [${name}](${buildArtifactUrl(artifact.id)})`);
  }
  lines.push("");

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

  if (provenance?.reportWriteError !== undefined) {
    lines.push(
      `> ⚠️ **Report persistence warning:** Could not write the JSON report to disk (${escapeInline(provenance.reportWriteError)}). The report artifact was not uploaded.`,
      "",
    );
  }

  if (provenance !== undefined) {
    for (const line of provenanceLines(provenance)) {
      lines.push(line);
    }
  }

  if (provenance?.engineArgs !== undefined && provenance.engineArgs.length > 0) {
    lines.push(renderReproductionCommand(provenance.engineArgs, provenance.engineVersion));
  }
  return lines;
}

function omittedMarker(count: number, noun: string): string {
  return `- _… ${String(count)} more ${noun} omitted; see the full report artifact._`;
}

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

function renderTruncatedSummary(
  report: CanaryReport,
  provenance?: SummaryProvenance,
  artifact?: ArtifactSummaryInfo,
): string {
  const body: string[] = [];
  let bodyBytes = 0;
  const push = (lines: readonly string[]): void => {
    for (const line of lines) {
      bodyBytes += byteLength(line) + (body.length === 0 ? 0 : 1);
      body.push(line);
    }
  };
  const pushCost = (lines: readonly string[]): number => {
    if (lines.length === 0 || body.length === 0) {
      return joinedByteLength(lines);
    }
    return joinedByteLength(lines) + 1;
  };

  let reserved = 0;
  const noticeCost = byteLength(TRUNCATION_NOTICE) + 1;
  const fits = (lines: readonly string[]): boolean =>
    pushCost(lines) + reserved + noticeCost + bodyBytes < SUMMARY_BYTE_LIMIT;

  push(summaryPreamble(report, provenance, artifact));

  if (bodyBytes + noticeCost >= SUMMARY_BYTE_LIMIT) {
    const roomForBody = SUMMARY_BYTE_LIMIT - byteLength(TRUNCATION_NOTICE) - 2;
    const clipped = clipToLimit(body, roomForBody);
    return clipped === "" ? TRUNCATION_NOTICE : `${clipped}\n${TRUNCATION_NOTICE}`;
  }

  for (const section of summarySections(report)) {
    const first = section.entries[0];
    if (section.entries.length === 0 || first === undefined) {
      continue;
    }
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

export function renderSummaryMarkdown(
  report: CanaryReport,
  provenance?: SummaryProvenance,
  artifact?: ArtifactSummaryInfo,
): string {
  const lines: string[] = [];
  const add = (values: readonly string[]): void => {
    for (const value of values) {
      lines.push(value);
    }
  };

  add(summaryPreamble(report, provenance, artifact));
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
  return byteLength(markdown) < SUMMARY_BYTE_LIMIT ? markdown : renderTruncatedSummary(report, provenance, artifact);
}

export function renderReproductionCommand(args: readonly string[], engineVersion?: string): string {
  const lines: string[] = [];
  lines.push("<details><summary>Reproduction command</summary>", "");

  if (engineVersion !== undefined) {
    lines.push(`Engine version: ${codeSpan(engineVersion)}`, "");
  }

  const command = buildCommandString(args);
  lines.push(fencedBlock(command), "", "</details>", "");

  return lines.join("\n");
}

function buildCommandString(args: readonly string[]): string {
  const parts: string[] = ["stellar-canary"];

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!; // i < args.length guaranteed by loop condition
    const nextArg = args[i + 1];

    if (arg === "--rpc-url" && nextArg !== undefined) {
      parts.push(arg, maskRpcUrl(nextArg));
      i += 2;
      continue;
    }

    parts.push(quoteForShell(arg));
    i++;
  }

  return parts.join(" ");
}

const MAX_EMBEDDED_FENCE_LENGTH = 20;

export function renderExecutionFailureMarkdown(
  reason: string,
  diagnostic: string,
  artifact?: ArtifactSummaryInfo,
): string {
  const trimmed = formatSafeDiagnosticTail(diagnostic).trim();
  const longestRun = (trimmed.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fenceLength = Math.max(3, longestRun + 1, MAX_EMBEDDED_FENCE_LENGTH);
  const fence = "`".repeat(fenceLength);
  const lines = [
    "## Stellar Protocol Canary",
    "",
    "### Result",
    "",
    "🚫 **ERROR**",
    "",
    "Protocol Canary could not be executed.",
    "",
    `Reason: ${formatSafeDiagnosticTail(reason)}`,
  ];
  if (artifact?.id !== undefined) {
    const name = artifact.name || "stellar-protocol-canary-report";
    lines.push("", `Report artifact: [${name}](${buildArtifactUrl(artifact.id)})`);
  }
  lines.push("", fence + "text", trimmed === "" ? "(no diagnostic output)" : trimmed, fence);
  return lines.join("\n");
}

export async function writeSummary(markdown: string): Promise<void> {
  try {
    await core.summary.addRaw(markdown, true).write();
  } catch (error) {
    throw new SummaryPublishFailedError(
      `Failed to publish Canary summary: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
