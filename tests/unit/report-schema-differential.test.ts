import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { InvalidReportError } from "../../src/errors";
import { parseReport } from "../../src/output";

/**
 * #447: Differential conformance test between the pinned report schema
 * (tests/fixtures/report-v1.schema.json — the engine's published report
 * contract, CF-01) and this Action's `parseReport` verdicts.
 *
 * The two are deliberately NOT identical. The test:
 *
 *   1. generates a deterministic case set (≥300 schema-valid reports,
 *      ≥300 mutated reports, each mutation the result of exactly one
 *      schema-violating edit on an otherwise valid report) and runs every
 *      case through BOTH the pinned schema and `parseReport`;
 *   2. fails on any disagreement that is not recorded, with its direction,
 *      in tests/fixtures/report-schema-divergences.json — and fails when a
 *      recorded divergence is no longer observed, so the list can neither
 *      grow stale nor be pre-filled with entries that were never seen;
 *   3. requires every required-field/type mutation `parseReport` rejects to
 *      be rejected with an error naming the offending field;
 *   4. fails loudly if the pinned schema uses a keyword or type value this
 *      test does not implement (no silent partial validation);
 *   5. checks the pinned bytes against the SHA-256 in the PIN record;
 *   6. prints the seed in every failure message; `SEED=<n>` overrides it.
 */

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");
const SCHEMA_PATH = path.join(FIXTURES_DIR, "report-v1.schema.json");
const PIN_PATH = path.join(FIXTURES_DIR, "report-v1.schema.PIN.md");
const DIVERGENCES_PATH = path.join(FIXTURES_DIR, "report-schema-divergences.json");

type SchemaNode = Record<string, unknown>;

const schemaRoot = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as SchemaNode;

function isPlainObject(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Keyword/type support check: the test must fail loudly rather than silently
// skip schema constructs it does not implement.
// ---------------------------------------------------------------------------

const SCHEMA_ANNOTATION_KEYWORDS = new Set(["$schema", "$id", "title", "description"]);
const IMPLEMENTED_KEYWORDS = new Set(["const", "enum", "items", "minimum", "properties", "required", "type"]);
const IMPLEMENTED_TYPE_VALUES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

/** Walks the schema in schema positions and reports anything unimplemented. */
function collectSchemaProblems(node: SchemaNode, at: string, problems: string[]): string[] {
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties") {
      if (!isPlainObject(value)) {
        problems.push(`${at}.properties: expected an object map of property schemas`);
        continue;
      }
      for (const [prop, sub] of Object.entries(value)) {
        if (isPlainObject(sub)) {
          collectSchemaProblems(sub, `${at}.properties.${prop}`, problems);
        } else {
          problems.push(`${at}.properties.${prop}: expected a schema object`);
        }
      }
      continue;
    }
    if (key === "items") {
      if (isPlainObject(value)) {
        collectSchemaProblems(value, `${at}.items`, problems);
      } else {
        problems.push(`${at}.items: only object-form items are implemented by this test`);
      }
      continue;
    }
    if (key === "type") {
      const declared: unknown[] = Array.isArray(value) ? value : [value];
      for (const t of declared) {
        if (typeof t !== "string" || !IMPLEMENTED_TYPE_VALUES.has(t)) {
          problems.push(`${at}.type: type value ${JSON.stringify(t)} is not implemented by this test`);
        }
      }
      continue;
    }
    if (key === "required") {
      if (!Array.isArray(value) || value.some((k) => typeof k !== "string")) {
        problems.push(`${at}.required: expected an array of property names`);
      }
      continue;
    }
    if (key === "enum") {
      if (!Array.isArray(value)) {
        problems.push(`${at}.enum: expected an array of allowed values`);
      }
      continue;
    }
    if (IMPLEMENTED_KEYWORDS.has(key) || SCHEMA_ANNOTATION_KEYWORDS.has(key)) {
      continue;
    }
    problems.push(`${at}.${key}: unsupported schema keyword "${key}" — implement it in this test before re-pinning`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema validator covering exactly the keywords above.
// Verdicts are "no violations" vs "≥1 violation"; a violation string starts
// with the path it applies to so a mutation can be checked to touch exactly
// one schema rule.
// ---------------------------------------------------------------------------

function matchesType(instance: unknown, type: string, at: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(instance);
    case "array":
      return Array.isArray(instance);
    case "string":
      return typeof instance === "string";
    case "number":
      return typeof instance === "number";
    case "integer":
      return typeof instance === "number" && Number.isInteger(instance);
    case "boolean":
      return typeof instance === "boolean";
    case "null":
      return instance === null;
    default:
      throw new Error(
        `The pinned schema uses a type value this test does not implement: "${type}" (at ${at}). ` +
          `Extend tests/unit/report-schema-differential.test.ts before trusting its verdicts.`,
      );
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function deepJsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => deepJsonEqual(entry, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => key in b && deepJsonEqual(a[key], b[key]))
    );
  }
  return false;
}

function validateNode(instance: unknown, node: SchemaNode, at: string, violations: string[]): void {
  if ("const" in node && !deepJsonEqual(instance, node.const)) {
    violations.push(`${at}: expected the constant ${JSON.stringify(node.const)}, got ${JSON.stringify(instance)}`);
  }
  if (Array.isArray(node.enum)) {
    const allowed = node.enum.some((candidate) => deepJsonEqual(candidate, instance));
    if (!allowed) {
      violations.push(`${at}: ${JSON.stringify(instance)} is not one of the allowed enum values`);
    }
  }
  const declaredTypes: string[] = [];
  if (typeof node.type === "string") {
    declaredTypes.push(node.type);
  } else if (Array.isArray(node.type)) {
    for (const t of node.type) {
      if (typeof t !== "string") {
        throw new Error(`The pinned schema declares a non-string type at ${at}; extend this test.`);
      }
      declaredTypes.push(t);
    }
  }
  if (declaredTypes.length > 0 && !declaredTypes.some((t) => matchesType(instance, t, at))) {
    violations.push(`${at}: expected type ${declaredTypes.join(" or ")}, got ${describeType(instance)}`);
  }
  if (typeof node.minimum === "number" && typeof instance === "number" && instance < node.minimum) {
    violations.push(`${at}: ${instance} is below the minimum ${node.minimum}`);
  }
  if ("items" in node) {
    if (!Array.isArray(instance)) {
      violations.push(`${at}: expected an array to validate items against`);
    } else if (isPlainObject(node.items)) {
      const items = node.items;
      instance.forEach((entry, index) => validateNode(entry, items, `${at}[${String(index)}]`, violations));
    } else {
      throw new Error(`The pinned schema uses non-object-form items at ${at}; extend this test.`);
    }
  }
  if (Array.isArray(node.required)) {
    if (isPlainObject(instance)) {
      for (const key of node.required) {
        if (typeof key === "string" && !(key in instance)) {
          violations.push(`${at}.${key}: missing required property`);
        }
      }
    } else {
      violations.push(`${at}: expected an object carrying required properties (${node.required.join(", ")})`);
    }
  }
  if (isPlainObject(node.properties) && isPlainObject(instance)) {
    for (const [key, sub] of Object.entries(node.properties)) {
      if (isPlainObject(sub) && key in instance) {
        validateNode(instance[key], sub, `${at}.${key}`, violations);
      }
    }
  }
}

function schemaViolations(instance: unknown): string[] {
  const violations: string[] = [];
  validateNode(instance, schemaRoot, "$", violations);
  return violations;
}

function violationPaths(violations: string[]): Set<string> {
  const paths = new Set<string>();
  for (const violation of violations) {
    const separator = violation.indexOf(": ");
    paths.add(separator === -1 ? violation : violation.slice(0, separator));
  }
  return paths;
}

// ---------------------------------------------------------------------------
// The Action's verdict for a report.
// ---------------------------------------------------------------------------

interface ActionVerdict {
  readonly accepted: boolean;
  readonly error?: string;
}

function actionVerdict(report: unknown): ActionVerdict {
  try {
    parseReport(JSON.stringify(report));
    return { accepted: true };
  } catch (error) {
    if (!(error instanceof InvalidReportError)) {
      throw error;
    }
    return { accepted: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Divergence list (#447): the observed, justified disagreements.
// ---------------------------------------------------------------------------

type Direction = "schema-rejects/action-accepts" | "schema-accepts/action-rejects";

interface DivergenceEntry {
  readonly rule: string;
  readonly direction: Direction;
  readonly reason: string;
  readonly reference: string;
}

const divergenceFile = JSON.parse(fs.readFileSync(DIVERGENCES_PATH, "utf8")) as {
  divergences: DivergenceEntry[];
};
const divergences: readonly DivergenceEntry[] = divergenceFile.divergences;

// ---------------------------------------------------------------------------
// Deterministic report generation.
// ---------------------------------------------------------------------------

const DEFAULT_SEED = 0x5eed1eaf;

function readSeed(): number {
  const raw = process.env.SEED;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SEED;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new Error(`SEED must be an integer between 0 and 4294967295, got "${raw}"`);
  }
  return parsed >>> 0;
}

const SEED = readSeed();

/** mulberry32: tiny deterministic PRNG so a seed fully reproduces the case set. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROJECT_TYPES = ["soroban", "rpc-consumer", "stellar-sdk", "generic-stellar", "unknown"] as const;
const SURFACES = ["xdr", "rpc", "soroban"] as const;
const OVERALL_STATUSES = ["pass", "warning", "fail", "error"] as const;
const RESULT_STATUSES = ["pass", "warning", "fail", "error"] as const;
const HEX_DIGITS = [..."0123456789abcdef"];

function pick<T>(rng: () => number, values: readonly T[]): T {
  const index = Math.floor(rng() * values.length);
  const value = values[index];
  if (value === undefined) {
    throw new Error(`pick: index ${String(index)} out of range for ${String(values.length)} values`);
  }
  return value;
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function randomHex(rng: () => number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += pick(rng, HEX_DIGITS);
  }
  return out;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Mirrors the Action's deriveCounts so valid reports satisfy both sides. */
function deriveCounts(results: unknown[], skipped: unknown[]): SchemaNode {
  let passed = 0;
  let failed = 0;
  let warnings = 0;
  let errors = 0;
  for (const entry of results) {
    const status = isPlainObject(entry) ? entry.status : undefined;
    if (status === "pass") passed += 1;
    else if (status === "fail") failed += 1;
    else if (status === "warning") warnings += 1;
    else if (status === "error") errors += 1;
  }
  return { total: results.length, passed, failed, warnings, errors, skipped: skipped.length };
}

function skippedArray(report: SchemaNode): unknown[] {
  return Array.isArray(report.skipped) ? report.skipped : [];
}

/**
 * A report both the pinned schema and parseReport accept. `results` is never
 * empty so probes/mutations can address results[0]; empty-result reports are
 * covered by output.test.ts.
 */
function validReport(rng: () => number): SchemaNode {
  const targetProtocol = randInt(rng, 1, 40);
  const resultCount = randInt(rng, 1, 5);
  const results: SchemaNode[] = [];
  for (let i = 0; i < resultCount; i += 1) {
    const entry: SchemaNode = {
      testId: `fixture-${String(i)}`,
      protocol: targetProtocol,
      surface: pick(rng, SURFACES),
      status: pick(rng, RESULT_STATUSES),
      summary: `check ${String(i)} completed`,
      durationMs: randInt(rng, 0, 5000),
      fixtureId: `fixture-${String(i)}`,
    };
    if (rng() < 0.3) entry.details = `extra detail for check ${String(i)}`;
    if (rng() < 0.3) entry.source = pick(rng, ["live", "cache"]);
    results.push(entry);
  }
  const skipped: SchemaNode[] = [];
  if (rng() < 0.4) {
    const skipCount = randInt(rng, 1, 2);
    for (let i = 0; i < skipCount; i += 1) {
      const skip: SchemaNode = {
        fixtureId: `skipped-${String(i)}`,
        surface: pick(rng, SURFACES),
        reason: "fixture targets another protocol",
      };
      if (rng() < 0.5) skip.code = "UNSUPPORTED_PROTOCOL";
      skipped.push(skip);
    }
  }
  const report: SchemaNode = {
    schemaVersion: 1,
    toolVersion: pick(rng, ["0.1.0", "0.2.0", "0.3.0-rc.1"]),
    targetProtocol,
    project: { name: "example-project", type: pick(rng, PROJECT_TYPES) },
    status: pick(rng, OVERALL_STATUSES),
    counts: deriveCounts(results, skipped),
    results,
  };
  if (skipped.length > 0) report.skipped = skipped;
  if (rng() < 0.5) {
    report.network = { name: pick(rng, ["testnet", "mainnet", "futurenet"]), observedProtocol: randInt(rng, 1, 40) };
  }
  if (rng() < 0.5) {
    report.git = { commit: randomHex(rng, 40), branch: "main", isDirty: rng() < 0.2 };
  }
  if (rng() < 0.3) report.verbose = rng() < 0.5;
  if (rng() < 0.3) report.run = { toolBuildCommit: randomHex(rng, 40) };
  return report;
}

// ---------------------------------------------------------------------------
// Record helpers used by mutations/probes.
// ---------------------------------------------------------------------------

function requireObject(value: unknown, what: string): SchemaNode {
  if (!isPlainObject(value)) {
    throw new Error(`fixture error: ${what} is not an object`);
  }
  return value;
}

function requireResultsArray(report: SchemaNode): unknown[] {
  const results = report.results;
  if (!Array.isArray(results)) {
    throw new Error("fixture error: report has no results array");
  }
  return results;
}

function firstResult(report: SchemaNode): SchemaNode {
  const first = requireResultsArray(report)[0];
  if (!isPlainObject(first)) {
    throw new Error("fixture error: report has no results[0]");
  }
  return first;
}

/**
 * Returns skipped[0], adding a schema-valid skip entry (and fixing counts) so
 * skipped mutations always start from a report both sides accept.
 */
function firstSkip(report: SchemaNode): SchemaNode {
  const existing = report.skipped;
  if (Array.isArray(existing)) {
    const first = existing[0];
    if (isPlainObject(first)) return first;
    throw new Error("fixture error: skipped[0] is not an object");
  }
  const added: SchemaNode = {
    fixtureId: "skipped-0",
    surface: "xdr",
    reason: "fixture targets another protocol",
  };
  report.skipped = [added];
  const counts = requireObject(report.counts, "counts");
  counts.skipped = 1;
  return added;
}

function ensureField(report: SchemaNode, key: string, fallback: SchemaNode): SchemaNode {
  const existing = report[key];
  if (isPlainObject(existing)) return existing;
  report[key] = fallback;
  return fallback;
}

// ---------------------------------------------------------------------------
// Mutations: each starts from a report both sides accept and applies exactly
// one schema-violating edit (helpers may first add schema-valid setup).
// `errorField` marks mutations parseReport must reject naming that field;
// mutations without it are the observed divergences (parseReport accepts).
// ---------------------------------------------------------------------------

interface Mutation {
  readonly rule: string;
  readonly errorField?: string;
  apply(report: SchemaNode): void;
}

const MUTATIONS: readonly Mutation[] = [
  { rule: "del:schemaVersion", errorField: "schemaVersion", apply: (r) => { delete r.schemaVersion; } },
  { rule: "const:schemaVersion", errorField: "schemaVersion", apply: (r) => { r.schemaVersion = "1"; } },
  { rule: "del:toolVersion", errorField: "toolVersion", apply: (r) => { delete r.toolVersion; } },
  { rule: "type:toolVersion", errorField: "toolVersion", apply: (r) => { r.toolVersion = 7; } },
  { rule: "del:targetProtocol", errorField: "targetProtocol", apply: (r) => { delete r.targetProtocol; } },
  { rule: "type:targetProtocol", errorField: "targetProtocol", apply: (r) => { r.targetProtocol = "28"; } },
  { rule: "min:targetProtocol", errorField: "targetProtocol", apply: (r) => { r.targetProtocol = 0; } },
  { rule: "del:project", errorField: "project", apply: (r) => { delete r.project; } },
  { rule: "del:project.name", errorField: "project.name", apply: (r) => { delete requireObject(r.project, "project").name; } },
  { rule: "del:project.type", errorField: "project.type", apply: (r) => { delete requireObject(r.project, "project").type; } },
  { rule: "enum:project.type", apply: (r) => { requireObject(r.project, "project").type = "custom-engine"; } },
  { rule: "del:status", errorField: "status", apply: (r) => { delete r.status; } },
  { rule: "type:status", errorField: "status", apply: (r) => { r.status = 1; } },
  { rule: "enum:status", errorField: "status", apply: (r) => { r.status = "skipped"; } },
  { rule: "del:results", errorField: "results", apply: (r) => { delete r.results; } },
  { rule: "type:results", errorField: "results", apply: (r) => { r.results = "none"; } },
  { rule: "del:results[i].testId", errorField: "results[0]", apply: (r) => { delete firstResult(r).testId; } },
  { rule: "type:results[i].protocol", errorField: "results[0]", apply: (r) => { firstResult(r).protocol = "28"; } },
  { rule: "noninteger:results[i].protocol", apply: (r) => { firstResult(r).protocol = 1.5; } },
  { rule: "min:results[i].protocol", apply: (r) => { firstResult(r).protocol = 0; } },
  { rule: "type:results[i].surface", errorField: "results[0]", apply: (r) => { firstResult(r).surface = 7; } },
  { rule: "enum:results[i].surface", errorField: "results[0]", apply: (r) => { firstResult(r).surface = "udp"; } },
  { rule: "type:results[i].status", errorField: "results[0]", apply: (r) => { firstResult(r).status = 1; } },
  { rule: "enum:results[i].status", errorField: "results[0]", apply: (r) => { firstResult(r).status = "unknown"; } },
  { rule: "type:results[i].summary", errorField: "results[0]", apply: (r) => { firstResult(r).summary = 42; } },
  { rule: "del:results[i].summary", errorField: "results[0]", apply: (r) => { delete firstResult(r).summary; } },
  { rule: "del:results[i].durationMs", errorField: "results[0]", apply: (r) => { delete firstResult(r).durationMs; } },
  { rule: "type:results[i].durationMs", errorField: "results[0]", apply: (r) => { firstResult(r).durationMs = "5"; } },
  { rule: "noninteger:results[i].durationMs", apply: (r) => { firstResult(r).durationMs = 1.5; } },
  { rule: "min:results[i].durationMs", apply: (r) => { firstResult(r).durationMs = -1; } },
  { rule: "type:results[i].fixtureId", errorField: "results[0]", apply: (r) => { firstResult(r).fixtureId = 9; } },
  { rule: "type:results[i].source", apply: (r) => { firstResult(r).source = 9; } },
  { rule: "del:counts", apply: (r) => { delete r.counts; } },
  { rule: "type:counts", apply: (r) => { r.counts = "unreadable"; } },
  { rule: "del:counts.member", apply: (r) => { delete requireObject(r.counts, "counts").total; } },
  { rule: "type:counts.member", apply: (r) => { requireObject(r.counts, "counts").total = "1"; } },
  { rule: "min:counts.total", errorField: "counts", apply: (r) => { requireObject(r.counts, "counts").total = -1; } },
  { rule: "type:network-null", apply: (r) => { r.network = null; } },
  {
    rule: "del:network.name",
    errorField: "network.name",
    apply: (r) => { delete ensureField(r, "network", { name: "testnet", observedProtocol: 28 }).name; },
  },
  {
    rule: "min:network.observedProtocol",
    errorField: "network",
    apply: (r) => { ensureField(r, "network", { name: "testnet", observedProtocol: 28 }).observedProtocol = 0; },
  },
  {
    rule: "type:network.error",
    errorField: "network",
    apply: (r) => { ensureField(r, "network", { name: "testnet", observedProtocol: 28 }).error = 12; },
  },
  { rule: "type:git", apply: (r) => { r.git = "not-an-object"; } },
  { rule: "type:verbose", apply: (r) => { r.verbose = "yes"; } },
  {
    rule: "del:run.toolBuildCommit",
    apply: (r) => { delete ensureField(r, "run", { toolBuildCommit: randomHexForFixtures() }).toolBuildCommit; },
  },
  { rule: "type:skipped[i].fixtureId", errorField: "skipped[0]", apply: (r) => { firstSkip(r).fixtureId = 5; } },
  { rule: "del:skipped[i].reason", errorField: "skipped[0]", apply: (r) => { delete firstSkip(r).reason; } },
  { rule: "type:skipped[i].surface", errorField: "skipped[0]", apply: (r) => { firstSkip(r).surface = 3; } },
  { rule: "enum:skipped[i].surface", apply: (r) => { firstSkip(r).surface = "udp"; } },
];

/** Deterministic stand-in commit for fixture setup (no RNG dependency). */
function randomHexForFixtures(): string {
  return "0123456789abcdef0123456789abcdef0123456789";
}

// ---------------------------------------------------------------------------
// Probes: schema-valid reports parseReport rejects (or explicitly allows) —
// the reverse-direction observations behind the divergence list.
// ---------------------------------------------------------------------------

interface Probe {
  readonly rule: string;
  apply(report: SchemaNode): void;
}

const PROBES: readonly Probe[] = [
  { rule: "probe:absent-fixture-id", apply: (r) => { delete firstResult(r).fixtureId; } },
  {
    rule: "probe:counts-disagree",
    apply: (r) => {
      const counts = requireObject(r.counts, "counts");
      counts.total = Number(counts.total) + 1;
    },
  },
  {
    rule: "probe:duplicate-identity",
    apply: (r) => {
      const results = requireResultsArray(r);
      const first = results[0];
      if (!isPlainObject(first)) throw new Error("fixture error: results[0] is not an object");
      results.push({ ...first });
      r.counts = deriveCounts(results, skippedArray(r));
    },
  },
  { rule: "probe:empty-tool-version", apply: (r) => { r.toolVersion = ""; } },
  { rule: "probe:empty-project-name", apply: (r) => { requireObject(r.project, "project").name = ""; } },
  { rule: "probe:empty-network-name", apply: (r) => { r.network = { name: "" }; } },
  { rule: "probe:additive-property", apply: (r) => { r.futureEngineField = { note: "unknown to this Action version" }; } },
];

// ---------------------------------------------------------------------------
// Case generation.
// ---------------------------------------------------------------------------

interface DifferentialCase {
  readonly rule: string;
  readonly kind: "valid" | "mutated";
  readonly report: SchemaNode;
}

const BASE_CASE_COUNT = 320;

function generateCases(seed: number): DifferentialCase[] {
  const rng = mulberry32(seed);
  const cases: DifferentialCase[] = [];
  for (let i = 0; i < BASE_CASE_COUNT; i += 1) {
    const base = validReport(rng);
    cases.push({ rule: "base", kind: "valid", report: cloneJson(base) });

    const probe = PROBES[i % PROBES.length];
    if (probe === undefined) throw new Error("PROBES is empty");
    const probeReport = cloneJson(base);
    probe.apply(probeReport);
    cases.push({ rule: probe.rule, kind: "valid", report: probeReport });

    const mutation = MUTATIONS[i % MUTATIONS.length];
    if (mutation === undefined) throw new Error("MUTATIONS is empty");
    const mutant = cloneJson(base);
    mutation.apply(mutant);
    cases.push({ rule: mutation.rule, kind: "mutated", report: mutant });
  }
  return cases;
}

// ---------------------------------------------------------------------------

describe("#447 report schema differential conformance", () => {
  it("the pinned schema only uses keywords and type values this test implements", () => {
    expect(collectSchemaProblems(schemaRoot, "$", [])).toEqual([]);

    // Negative checks: an unimplemented keyword or type value must fail loudly.
    const withOneOf: SchemaNode = { ...schemaRoot, oneOf: [{ type: "string" }] };
    expect(collectSchemaProblems(withOneOf, "$", []).join("\n")).toContain(
      'unsupported schema keyword "oneOf"',
    );
    const withUriType: SchemaNode = { type: "uri" };
    expect(collectSchemaProblems(withUriType, "$", []).join("\n")).toContain(
      'type value "uri" is not implemented',
    );
    expect(() => matchesType("x", "uri", "$.type")).toThrow(/uri/);
  });

  it("the pinned schema bytes match the SHA-256 recorded in the PIN record", () => {
    const digest = crypto.createHash("sha256").update(fs.readFileSync(SCHEMA_PATH)).digest("hex");
    const pin = fs.readFileSync(PIN_PATH, "utf8");
    expect(pin, "PIN record does not contain the SHA-256 of the pinned schema").toContain(digest);
    expect(pin).toMatch(/Source commit \(full SHA[^)]*\)\s*\|\s*`[0-9a-f]{40}`/);
  });

  it("the divergence list is well-formed", () => {
    expect(divergences.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const entry of divergences) {
      expect(["schema-rejects/action-accepts", "schema-accepts/action-rejects"]).toContain(entry.direction);
      expect(entry.reason.length, `${entry.rule} needs a substantive reason`).toBeGreaterThan(30);
      expect(entry.reference, `${entry.rule} needs a reference link`).toMatch(/^https:\/\//);
      expect(seen.has(entry.rule), `duplicate divergence rule ${entry.rule}`).toBe(false);
      seen.add(entry.rule);
    }
  });

  it(`generates the same case set for the same seed (seed=${String(SEED)})`, () => {
    const first = JSON.stringify(generateCases(SEED));
    const second = JSON.stringify(generateCases(SEED));
    expect(first).toBe(second);
    expect(JSON.stringify(generateCases(SEED + 1))).not.toBe(first);
  });

  it(`distinguishes schema and parseReport verdicts exactly as listed (seed=${String(SEED)})`, () => {
    const cases = generateCases(SEED);

    const generatorFailures: string[] = [];
    const unlistedDisagreements: string[] = [];
    const nonFieldSpecificErrors: string[] = [];
    const observed = new Map<string, Direction>();

    for (const testCase of cases) {
      const violations = schemaViolations(testCase.report);
      const schemaAccepts = violations.length === 0;
      const action = actionVerdict(testCase.report);
      const reportJson = JSON.stringify(testCase.report);

      // A "valid" case must be schema-valid; a "mutated" case must violate
      // the schema at exactly one rule (one distinct violation path).
      if (testCase.kind === "valid" && !schemaAccepts) {
        generatorFailures.push(
          `case marked valid but rejected by the schema: rule=${testCase.rule} violations=${violations.join("; ")} seed=${String(SEED)} report=${reportJson}`,
        );
        continue;
      }
      if (testCase.kind === "mutated") {
        if (schemaAccepts) {
          generatorFailures.push(
            `case marked mutated but accepted by the schema (no rule violated): rule=${testCase.rule} seed=${String(SEED)} report=${reportJson}`,
          );
          continue;
        }
        const paths = violationPaths(violations);
        if (paths.size !== 1) {
          generatorFailures.push(
            `mutation must violate exactly one schema rule: rule=${testCase.rule} violated paths=${[...paths].join(", ")} seed=${String(SEED)} report=${reportJson}`,
          );
          continue;
        }
      }

      if (schemaAccepts === action.accepted) {
        // Agreement. If parseReport rejects, mutations that touch a required
        // field or type must be rejected with an error naming that field.
        if (!action.accepted) {
          const mutation = MUTATIONS.find((m) => m.rule === testCase.rule);
          if (mutation?.errorField !== undefined && !(action.error ?? "").includes(mutation.errorField)) {
            nonFieldSpecificErrors.push(
              `rule=${testCase.rule}: rejected without naming field "${mutation.errorField}": ${action.error ?? "(no message)"} seed=${String(SEED)} report=${reportJson}`,
            );
          }
        }
        continue;
      }

      // Disagreement: must be recorded with the observed direction.
      const direction: Direction = schemaAccepts
        ? "schema-accepts/action-rejects"
        : "schema-rejects/action-accepts";
      observed.set(testCase.rule, direction);
      const entry = divergences.find((d) => d.rule === testCase.rule);
      if (testCase.rule === "base") {
        generatorFailures.push(
          `generator produced a base report not accepted by both sides: schema=${schemaAccepts ? "accepts" : `rejects (${violations.join("; ")})`} action=${action.accepted ? "accepts" : `rejects (${action.error ?? ""})`} seed=${String(SEED)} report=${reportJson}`,
        );
      } else if (entry === undefined) {
        unlistedDisagreements.push(
          `UNLISTED DISAGREEMENT rule=${testCase.rule} direction=${direction} schema=${schemaAccepts ? "accepts" : `rejects (${violations.join("; ")})`} action=${action.accepted ? "accepts" : `rejects (${action.error ?? ""})`} seed=${String(SEED)} report=${reportJson}`,
        );
      } else if (entry.direction !== direction) {
        unlistedDisagreements.push(
          `WRONG DIRECTION for rule=${testCase.rule}: listed ${entry.direction}, observed ${direction} seed=${String(SEED)} report=${reportJson}`,
        );
      }
    }

    expect(generatorFailures, `generator invariant failed (seed=${String(SEED)})`).toEqual([]);
    expect(
      unlistedDisagreements,
      `every observed schema-vs-parseReport disagreement must be in ` +
        `tests/fixtures/report-schema-divergences.json with its direction (seed=${String(SEED)})`,
    ).toEqual([]);
    expect(
      nonFieldSpecificErrors,
      `required-field/type mutations parseReport rejects must name the field (seed=${String(SEED)})`,
    ).toEqual([]);

    // The list must be written from observations: an entry no longer observed
    // (or observed with a different direction) is stale and must fail.
    const staleEntries = [...divergences]
      .filter((entry) => observed.get(entry.rule) !== entry.direction)
      .map((entry) => `${entry.rule} listed as ${entry.direction}`);
    expect(
      staleEntries,
      `divergence entries not observed by the generator (seed=${String(SEED)})`,
    ).toEqual([]);

    // Coverage floors from the issue: ≥300 valid and ≥300 mutated reports.
    expect(cases.filter((c) => c.kind === "valid").length).toBeGreaterThanOrEqual(300);
    expect(cases.filter((c) => c.kind === "mutated").length).toBeGreaterThanOrEqual(300);
    expect(observed.size).toBe(divergences.length);
  });
});
