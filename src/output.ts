import { InvalidReportError } from "./errors";

/**
 * The JSON report shape produced by `stellar-canary check --format json`,
 * as documented in `docs/json-report-contract.md` of
 * `StellarCanary/Protocol-Canary` (schemaVersion 1). This Action treats
 * that document, not this file, as the source of truth — see
 * CONTRIBUTING.md for how to update this type when the schema changes.
 */
export const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Validates that a value is a non-empty string. Throws {@link InvalidReportError}
 * with the given field path if not.
 */
function requireNonEmptyString(value: unknown, fieldPath: string): string {
  if (typeof value !== "string" || value === "") {
    throw new InvalidReportError(`Canary's JSON output is missing or has an empty "${fieldPath}" field.`);
  }
  return value;
}

/**
 * Validates that a value is a positive integer (>= 1). Throws {@link InvalidReportError}
 * with the given field path if not.
 */
function requirePositiveInteger(value: unknown, fieldPath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new InvalidReportError(`Canary's JSON output has an invalid "${fieldPath}" field: expected a positive integer.`);
  }
  return value;
}

/**
 * Validates that a value is a non-negative integer (>= 0). Throws {@link InvalidReportError}
 * with the given field path if not.
 */
function requireNonNegativeInteger(value: unknown, fieldPath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidReportError(`Canary's JSON output has an invalid "${fieldPath}" field: expected a non-negative integer.`);
  }
  return value;
}

/**
 * Validates the project object has required name and type fields.
 */
function validateProject(project: unknown, fieldPath: string): { readonly name: string; readonly type: string } {
  if (typeof project !== "object" || project === null) {
    throw new InvalidReportError(`Canary's JSON output is missing or has an invalid "${fieldPath}" field: expected an object.`);
  }
  const p = project as Record<string, unknown>;
  const name = requireNonEmptyString(p.name, `${fieldPath}.name`);
  const type = requireNonEmptyString(p.type, `${fieldPath}.type`);
  return { name, type };
}

/**
 * Validates the network object if present.
 */
function validateNetwork(network: unknown, fieldPath: string): { readonly name: string; readonly observedProtocol?: number } | undefined {
  if (network === undefined || network === null) {
    return undefined;
  }
  if (typeof network !== "object") {
    throw new InvalidReportError(`Canary's JSON output has an invalid "${fieldPath}" field: expected an object or null.`);
  }
  const n = network as Record<string, unknown>;
  const name = requireNonEmptyString(n.name, `${fieldPath}.name`);
  let observedProtocol: number | undefined;
  if (n.observedProtocol !== undefined) {
    observedProtocol = requirePositiveInteger(n.observedProtocol, `${fieldPath}.observedProtocol`);
  }
  if (n.error !== undefined && typeof n.error !== "string") {
    throw new InvalidReportError(`Canary's JSON output has an invalid "${fieldPath}.error" field: expected a string.`);
  }
  return observedProtocol !== undefined ? { name, observedProtocol } : { name };
}

/**
 * Validates the counts object and checks agreement with results/skipped.
 */
function validateCounts(
  counts: unknown,
  results: readonly CanaryResult[],
  skipped: readonly CanarySkip[] | undefined,
  fieldPath: string,
): CanaryCounts {
  if (typeof counts !== "object" || counts === null) {
    throw new InvalidReportError(`Canary's JSON output is missing or has an invalid "${fieldPath}" field: expected an object.`);
  }
  const c = counts as Partial<CanaryCounts>;
  const total = requireNonNegativeInteger(c.total, `${fieldPath}.total`);
  const passed = requireNonNegativeInteger(c.passed, `${fieldPath}.passed`);
  const failed = requireNonNegativeInteger(c.failed, `${fieldPath}.failed`);
  const warnings = requireNonNegativeInteger(c.warnings, `${fieldPath}.warnings`);
  const errors = requireNonNegativeInteger(c.errors, `${fieldPath}.errors`);
  const skippedCount = requireNonNegativeInteger(c.skipped, `${fieldPath}.skipped`);

  const validated: CanaryCounts = { total, passed, failed, warnings, errors, skipped: skippedCount };

  // Verify agreement with results and skipped
  const derived = deriveCounts(results, skipped);
  if (
    validated.total !== derived.total ||
    validated.passed !== derived.passed ||
    validated.failed !== derived.failed ||
    validated.warnings !== derived.warnings ||
    validated.errors !== derived.errors ||
    validated.skipped !== derived.skipped
  ) {
    throw new InvalidReportError(
      `Canary's JSON output has a "${fieldPath}" field that disagrees with results/skipped: ` +
        `expected total=${derived.total}, passed=${derived.passed}, failed=${derived.failed}, ` +
        `warnings=${derived.warnings}, errors=${derived.errors}, skipped=${derived.skipped}; ` +
        `got total=${validated.total}, passed=${validated.passed}, failed=${validated.failed}, ` +
        `warnings=${validated.warnings}, errors=${validated.errors}, skipped=${validated.skipped}.`,
    );
  }

  return validated;
}

export type Surface = "xdr" | "rpc" | "soroban";
export type ResultStatus = "pass" | "warning" | "fail" | "error" | "skipped";
export type OverallStatus = "pass" | "warning" | "fail" | "error";

export interface CanaryResult {
  readonly testId: string;
  readonly protocol: number;
  readonly surface: Surface;
  readonly status: ResultStatus;
  readonly summary: string;
  readonly details?: string;
  readonly durationMs: number;
  readonly fixtureId: string | null;
  /**
   * Where this result came from, per CF-01 §6/§4 reserved field:
   * `"live"` (executed in this run), `"cache"` (replayed from the engine's
   * result cache), or absent/not-recorded (reports from engines that predate
   * the cache). An unknown value is deliberately typed as a plain `string`
   * and read as *not recorded*, exactly as the contract prescribes — the
   * Action must never assume a result was live.
   */
  readonly source?: string;
  /**
   * Boolean spellings of {@link CanaryResult.source} some engines may emit
   * for a cached replay. Honored alongside `source: "cache"` so a replayed
   * result is flagged whichever form the report uses.
   */
  readonly replayed?: boolean;
  /** Boolean companion to {@link CanaryResult.replayed} ("cached: true"). */
  readonly cached?: boolean;
}

export interface CanarySkip {
  readonly fixtureId: string;
  readonly surface: string;
  readonly reason: string;
  /**
   * Stable machine-readable skip reason (CF-01): one of
   * `UNSUPPORTED_PROTOCOL`, `SURFACE_DISABLED`, `MISSING_CAPABILITY`,
   * `OFFLINE`, `NETWORK_MISMATCH`, or `UNKNOWN`. Absent in reports written
   * before the field existed; an unrecognized value is read as `UNKNOWN` by
   * consumers rather than rejected.
   */
  readonly code?: string;
}

export interface CanaryFixturePack {
  /** Canonical `sha256:<64 lowercase hex>` digest of the fixture pack. */
  readonly digest?: string;
  /** Protocol the pack is pinned to, when recorded. */
  readonly protocol?: number;
  /** Pack release tag/version, when recorded. */
  readonly version?: string;
  /** Alias some report producers use for the release tag. */
  readonly tag?: string;
  /** Fixture registry format version. */
  readonly registryVersion?: number;
  /** `"directory"` or `"release"`, when recorded. */
  readonly source?: string;
  /** Full git revision of the pack source, or null. */
  readonly revision?: string | null;
  /** Alias some producers use for the canonical digest. */
  readonly packDigest?: string;
}

export interface CanaryCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly warnings: number;
  readonly errors: number;
  readonly skipped?: number;
}

export interface CanaryReport {
  readonly schemaVersion: number;
  readonly toolVersion: string;
  readonly targetProtocol: number;
  readonly project: { readonly name: string; readonly type: string };
  readonly network?: { readonly name: string; readonly observedProtocol?: number };
  readonly status: OverallStatus;
  readonly counts: CanaryCounts;
  readonly results: readonly CanaryResult[];
  readonly skipped?: readonly CanarySkip[];
  /** Reserved additive CF-02 pack identity; absent for local/unrecorded packs. */
  readonly fixturePack?: CanaryFixturePack;
  /** Legacy/top-level alias for the pack digest used by early receipt drafts. */
  readonly packDigest?: string;
  readonly git: {
    readonly commit: string | null;
    readonly branch: string | null;
    readonly isDirty: boolean | null;
  };
}

function isCountsShape(value: unknown): value is CanaryCounts {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<CanaryCounts>;
  return (
    typeof candidate.total === "number" &&
    typeof candidate.passed === "number" &&
    typeof candidate.failed === "number" &&
    typeof candidate.warnings === "number" &&
    typeof candidate.errors === "number" &&
    (typeof candidate.skipped === "number" || candidate.skipped === undefined)
  );
}

const RESULT_STATUSES: readonly ResultStatus[] = ["pass", "warning", "fail", "error", "skipped"];
const SURFACES: readonly Surface[] = ["xdr", "rpc", "soroban"];

/**
 * Validates one `results[]` entry against the documented CanaryResult
 * shape. `details` is the only optional field; `fixtureId` may be null.
 * Returns a human-readable reason when the entry is malformed, so the
 * caller can include the offending result's index in the error.
 */
function resultShapeError(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) {
    return "entry is not an object";
  }
  const result = entry as Partial<CanaryResult>;
  if (typeof result.testId !== "string") {
    return "missing or non-string \"testId\"";
  }
  if (typeof result.protocol !== "number") {
    return "missing or non-numeric \"protocol\"";
  }
  if (typeof result.surface !== "string" || !SURFACES.includes(result.surface)) {
    return `invalid \"surface\" (expected one of ${SURFACES.map((s) => `"${s}"`).join(", ")})`;
  }
  if (typeof result.status !== "string" || !RESULT_STATUSES.includes(result.status)) {
    return `invalid \"status\" (expected one of ${RESULT_STATUSES.map((s) => `"${s}"`).join(", ")})`;
  }
  if (typeof result.summary !== "string") {
    return "missing or non-string \"summary\"";
  }
  if (result.details !== undefined && typeof result.details !== "string") {
    return 'non-string "details"';
  }
  if (typeof result.durationMs !== "number") {
    return 'missing or non-numeric "durationMs"';
  }
  if (typeof result.fixtureId !== "string" && result.fixtureId !== null) {
    return 'non-string, non-null "fixtureId"';
  }
  return undefined;
}

/**
 * Validates one `skipped[]` entry against the documented CanarySkip
 * shape (`surface` is a free-form string there, unlike results).
 */
function skipShapeError(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) {
    return "entry is not an object";
  }
  const skip = entry as Partial<CanarySkip>;
  if (typeof skip.fixtureId !== "string") {
    return 'missing or non-string "fixtureId"';
  }
  if (typeof skip.surface !== "string") {
    return 'missing or non-string "surface"';
  }
  if (typeof skip.reason !== "string") {
    return 'missing or non-string "reason"';
  }
  if (skip.code !== undefined && typeof skip.code !== "string") {
    return 'non-string "code" when present';
  }
  return undefined;
}

/**
 * `counts` is documented as "purely a convenience — always re-derivable
 * from results[].status" and, like `git`, was added to the report schema
 * after schemaVersion 1 was first shipped without bumping it (a purely
 * additive field). An older Canary release's report predating that
 * addition is still schemaVersion 1 and still fully valid; reject it here
 * and every check against that release fails as an "execution failure"
 * even when Canary itself reported a real pass. Derive `counts` from
 * `results`/`skipped` instead of requiring the CLI to have sent it.
 */
function deriveCounts(results: readonly CanaryResult[], skipped: readonly CanarySkip[] | undefined): CanaryCounts {
  const counts: { total: number; passed: number; failed: number; warnings: number; errors: number; skipped: number } =
    { total: results.length, passed: 0, failed: 0, warnings: 0, errors: 0, skipped: skipped?.length ?? 0 };
  for (const result of results) {
    if (result.status === "pass") counts.passed += 1;
    else if (result.status === "fail") counts.failed += 1;
    else if (result.status === "warning") counts.warnings += 1;
    else if (result.status === "error") counts.errors += 1;
  }
  return counts;
}

/**
 * Parses Canary's stdout as a report matching the documented schema.
 * Throws {@link InvalidReportError} if the text is not JSON, is not
 * shaped like a report, or declares an unsupported `schemaVersion`.
 */
export function parseReport(stdout: string): CanaryReport {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    throw new InvalidReportError("Canary produced no output to parse as a JSON report.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new InvalidReportError(
      `Canary's output could not be parsed as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new InvalidReportError("Canary's JSON output is not a report object.");
  }

  const report = parsed as Partial<CanaryReport>;
  if (typeof report.schemaVersion !== "number") {
    throw new InvalidReportError("Canary's JSON output is missing a numeric \"schemaVersion\" field.");
  }
  if (report.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new InvalidReportError(
      `Unsupported report schemaVersion ${String(report.schemaVersion)} ` +
        `(this Action supports schemaVersion ${String(SUPPORTED_SCHEMA_VERSION)}). ` +
        `A newer Protocol-Canary release may require a newer ProtocolCanary-Action version.`,
    );
  }
  // Split into field-specific errors (rather than one combined shape check)
  // so a rejected report always names the offending field — the differential
  // test for #447 asserts that every schema-required-field/type violation is
  // rejected with an error that identifies the field it violates.
  if (typeof report.status !== "string") {
    throw new InvalidReportError(
      'Canary\'s JSON output is missing or has an invalid "status" field: expected a string.',
    );
  }
  if (!["pass", "warning", "fail", "error"].includes(report.status)) {
    throw new InvalidReportError(
      `Canary's JSON output has an invalid "status" field: expected one of ` +
        `"pass", "warning", "fail", "error" (got ${JSON.stringify(report.status)}).`,
    );
  }
  if (!Array.isArray(report.results)) {
    throw new InvalidReportError(
      'Canary\'s JSON output is missing or has an invalid "results" field: expected an array.',
    );
  }

  // Validate required fields that the renderer and annotation code depend on
  const toolVersion = requireNonEmptyString(report.toolVersion, "toolVersion");
  const targetProtocol = requirePositiveInteger(report.targetProtocol, "targetProtocol");
  const project = validateProject(report.project, "project");
  const network = validateNetwork(report.network, "network");

  const rawResults: unknown[] = report.results;
  for (const [index, entry] of rawResults.entries()) {
    const problem = resultShapeError(entry);
    if (problem !== undefined) {
      throw new InvalidReportError(
        `Canary's JSON output does not match the documented report shape: results[${String(index)}] ${problem}.`,
      );
    }
  }
  const results = rawResults as CanaryResult[];

  // CF-01 section 4: a result is identified inside one report by
  // `(surface, fixtureId)`, using `testId` when `fixtureId` is absent. A
  // report in which two results share an identity is invalid and must be
  // rejected by consumers — otherwise duplicated entries could skew the
  // derived counts or mask a real failure behind a copy of a passing result.
  const seenIdentities = new Set<string>();
  for (const [index, result] of results.entries()) {
    const id = result.fixtureId ?? result.testId;
    const identity = `${result.surface}:${id}`;
    if (seenIdentities.has(identity)) {
      throw new InvalidReportError(
        `Canary's JSON output contains a duplicate result identity: ` +
          `(surface, id) = ("${result.surface}", "${id}") appears more than once ` +
          `(results[${String(index)}]).`,
      );
    }
    seenIdentities.add(identity);
  }

  if (report.skipped !== undefined && !Array.isArray(report.skipped)) {
    throw new InvalidReportError(
      'Canary\'s JSON output does not match the documented report shape: "skipped" is present but not an array.',
    );
  }
  const rawSkipped: readonly unknown[] = report.skipped ?? [];
  for (const [index, entry] of rawSkipped.entries()) {
    const problem = skipShapeError(entry);
    if (problem !== undefined) {
      throw new InvalidReportError(
        `Canary's JSON output does not match the documented report shape: skipped[${String(index)}] ${problem}.`,
      );
    }
  }
  const skipped = report.skipped as CanarySkip[] | undefined;

  // Validate counts if present and complete; otherwise derive.
  // A malformed counts field (missing fields, wrong types) is silently
  // replaced by derived counts, preserving the behavior older engines rely
  // on. A well-formed counts field that disagrees with results/skipped is
  // rejected. Engines that predate the `skipped` count omit only that one
  // field: the rest of their counts are preserved and `skipped` is populated
  // from the skipped array, exactly as before.
  const rawCounts = isCountsShape(report.counts) ? report.counts : undefined;
  let counts: CanaryCounts;
  if (rawCounts === undefined) {
    counts = deriveCounts(results, skipped);
  } else if (rawCounts.skipped === undefined) {
    counts = { ...rawCounts, skipped: skipped?.length ?? 0 };
  } else {
    counts = validateCounts(rawCounts, results, skipped, "counts");
  }

  // Spread the raw report so reserved/additive fields this Action does not
  // (yet) model — `engineCommit`, `packDigest`, `network.error`, … — survive
  // parsing for downstream consumers such as the Execution Receipt. The
  // validated fields below overwrite their raw counterparts.
  return {
    ...report,
    toolVersion,
    targetProtocol,
    project,
    ...(network !== undefined ? { network } : {}),
    status: report.status,
    counts,
    results,
    skipped,
    git: report.git ?? { commit: null, branch: null, isDirty: null },
  } as CanaryReport;
}

/** Inputs that may carry a fixture-pack pin even when the report does not. */
export interface PackIdentitySource {
  readonly fixturesPackVersion?: string | undefined;
  readonly fixturesPackProtocol?: number | undefined;
}

/** Pack provenance available for the Action outputs (#340). */
export interface ResolvedPackIdentity {
  /** Canonical `sha256:<64 lowercase hex>` digest, when known. */
  readonly digest?: string;
  /** Integer protocol the pack is pinned to, when known. */
  readonly protocol?: number;
  /** Release tag/version of the pack, when known. */
  readonly version?: string;
}

const CANONICAL_DIGEST = /^(?:sha256:)?([0-9a-fA-F]{64})$/;

/**
 * Normalizes a pack digest to the documented `sha256:<64 lowercase hex>`
 * form. Accepts a bare 64-hex digest as a convenience, but returns
 * `undefined` for anything else instead of emitting a loosely shaped output.
 */
function canonicalPackDigest(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = CANONICAL_DIGEST.exec(value.trim());
  const hex = match?.[1];
  return hex === undefined ? undefined : `sha256:${hex.toLowerCase()}`;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * Resolves the fixture-pack identity this run can honestly report (#340).
 *
 * The CF-02 pack identity is an additive report field (`fixturePack`), and
 * the engine releases that emit it are still rolling out. The Action
 * therefore reads it defensively, falls back to the validated
 * `fixtures-pack-version` / `fixtures-pack-protocol` inputs when a caller
 * pinned a pack explicitly, and returns an empty identity when no external
 * pack is in play. A pack digest is only surfaced in the canonical
 * `sha256:<64 lowercase hex>` form; a malformed value is ignored rather than
 * echoed into an output. This function never throws for a malformed optional
 * field — reports are untrusted input.
 */
export function resolvePackIdentity(
  report: CanaryReport,
  source: PackIdentitySource = {},
): ResolvedPackIdentity {
  const rawFixturePack = (report as { readonly fixturePack?: unknown }).fixturePack;
  const fixturePack =
    typeof rawFixturePack === "object" && rawFixturePack !== null && !Array.isArray(rawFixturePack)
      ? (rawFixturePack as Record<string, unknown>)
      : undefined;
  const rawTopLevelDigest = (report as { readonly packDigest?: unknown }).packDigest;

  const digest =
    canonicalPackDigest(fixturePack?.digest) ??
    canonicalPackDigest(fixturePack?.packDigest) ??
    canonicalPackDigest(rawTopLevelDigest);
  const version =
    nonEmptyString(fixturePack?.version) ??
    nonEmptyString(fixturePack?.tag) ??
    nonEmptyString(source.fixturesPackVersion);
  const protocol =
    positiveInteger(fixturePack?.protocol) ??
    positiveInteger(source.fixturesPackProtocol) ??
    (digest !== undefined ? positiveInteger(report.targetProtocol) : undefined);

  const identity: { digest?: string; protocol?: number; version?: string } = {};
  if (digest !== undefined) identity.digest = digest;
  if (protocol !== undefined) identity.protocol = protocol;
  if (version !== undefined) identity.version = version;
  return identity;
}

/**
 * How completely the fixture set was exercised, exposed as the Action's
 * `coverage-state` output so a downstream job can gate a release promotion on
 * coverage rather than on the pass/fail verdict alone:
 *
 * - `full`: every discovered fixture ran and nothing was skipped;
 * - `partial`: at least one fixture ran, but some were skipped;
 * - `none`: no fixture ran at all (an empty run, or a report too malformed to
 *   say otherwise).
 *
 * `none` is deliberately the conservative default: a run that cannot prove it
 * executed the fixtures must not claim full coverage.
 */
export type CoverageState = "full" | "partial" | "none";

/**
 * Classifies a report's fixture coverage (#333).
 *
 * "Discovered" fixtures are the ones the engine reported on at all — the
 * executed `results[]` plus the `skipped[]` fixtures it deliberately did not
 * run. Classification is therefore:
 *
 * - `none` when nothing executed, which also covers a report that carries no
 *   usable coverage information at all (an absent/!array `results`, an absent
 *   `counts`): such a report must never be reported as `full`;
 * - `full` when something executed and no fixture was skipped anywhere;
 * - `partial` when something executed *and* something was skipped.
 *
 * Skips are detected from three independent signals, because which one is
 * populated depends on the engine release: a `skipped[]` entry, a result whose
 * own status is `skipped`, and `counts.skipped` (which older releases report
 * without sending the `skipped[]` array at all). Any non-zero signal is enough.
 *
 * Tolerant by construction — every field access is guarded — so a partially
 * shaped report yields a state instead of throwing inside the reporting path.
 */
export function classifyCoverage(report: CanaryReport): CoverageState {
  // Read defensively rather than trusting the declared types: this runs in the
  // reporting path on a report that may have come from an unexpected engine
  // build, so a missing or oddly shaped field must classify as `none` rather
  // than throw and take the run's reporting down with it.
  const raw = report as CanaryReport | undefined;
  const results: readonly unknown[] = Array.isArray(raw?.results) ? raw.results : [];

  const isSkipped = (entry: unknown): boolean =>
    typeof entry === "object" && entry !== null && (entry as Partial<CanaryResult>).status === "skipped";

  // An entry the Action cannot read as a result is treated as an executed
  // one: it came back inside `results[]`, which the engine only populates for
  // checks it ran.
  const executed = results.filter((entry) => !isSkipped(entry)).length;
  if (executed === 0) {
    return "none";
  }

  const skippedResults = results.filter(isSkipped).length;
  const skippedEntries = Array.isArray(raw?.skipped) ? (raw.skipped ?? []).length : 0;
  const reportedSkipped = isCountsShape(raw?.counts) ? (raw.counts?.skipped ?? 0) : 0;

  return Math.max(skippedResults, skippedEntries, reportedSkipped) > 0 ? "partial" : "full";
}

/**
 * Whether a result was replayed from the engine's result cache rather than
 * executed in this run (CF-01 §6). `source: "cache"` is the contract's
 * spelling; the boolean `replayed`/`cached` attributes are honored too.
 * Anything else — including an unknown or absent `source` — is *not
 * recorded*, never assumed live and never counted as replayed.
 */
export function isReplayed(result: CanaryResult): boolean {
  if (result.source === "cache") {
    return true;
  }
  return result.replayed === true || result.cached === true;
}

/**
 * How many of the report's results were replayed from cache. Reports from
 * engines without the cache simply have no replayed results — this counts,
 * it never throws.
 */
export function countReplayed(report: CanaryReport): number {
  return report.results.filter(isReplayed).length;
}

export type ExitCodeCategory =
  | "pass"
  | "compatibility_failure"
  | "configuration_error"
  | "execution_error"
  | "invalid_fixture"
  | "internal_error"
  | "unknown";

interface ExitCodeInfo {
  readonly category: ExitCodeCategory;
  readonly description: string;
}

/**
 * The documented `stellar-canary` exit-code contract
 * (`crates/canary-core/src/errors.rs`). This table is the Action's only
 * understanding of what an exit code *means* — it never reinterprets
 * Canary's actual pass/fail decision.
 */
const EXIT_CODES: Readonly<Record<number, ExitCodeInfo>> = {
  0: { category: "pass", description: "Compatibility checks passed." },
  1: {
    category: "compatibility_failure",
    description: "Test failures detected: a compatibility assertion failed.",
  },
  2: {
    category: "configuration_error",
    description: "Regression gate triggered or Canary configuration is invalid.",
  },
  3: {
    category: "execution_error",
    description: "Unexpected runtime crash: execution or RPC communication failed.",
  },
  4: { category: "invalid_fixture", description: "One or more fixtures are invalid." },
  5: { category: "internal_error", description: "Canary encountered an internal error." },
};

/**
 * Describes a `stellar-canary` exit code according to the
 * `crates/canary-core/src/errors.rs` contract. Unrecognized codes fall back
 * to the `unknown` category.
 */
export function describeExitCode(code: number): ExitCodeInfo {
  return EXIT_CODES[code] ?? { category: "unknown", description: `Unrecognized exit code ${String(code)}.` };
}
