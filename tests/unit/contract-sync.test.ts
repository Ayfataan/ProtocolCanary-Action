import type * as actionsCore from "@actions/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, parseAllDocuments } from "yaml";

import { getInputs } from "../../src/inputs";
import { run } from "../../src/main";
import type { ResolvedVersion } from "../../src/version";
import type * as artifactModule from "../../src/artifact";
import type * as canaryModule from "../../src/canary";
import type * as runnerModule from "../../src/runner";
import type * as summaryModule from "../../src/summary";
import type * as versionModule from "../../src/version";
import { report, result } from "./helpers";

/**
 * #412: the Action's contract is declared in four places that can drift
 * apart — `action.yml` (inputs/outputs), `src/inputs.ts` (what `getInputs`
 * reads), `src/main.ts` (what `run()` sets), and the documentation/examples
 * (`README.md` tables, `examples/*.yml`, the reusable workflow). This file
 * pins them to each other. Every failure message names the offending
 * input/output/file so a contributor knows exactly what to fix.
 *
 * The mocking follows the repository's established patterns: `@actions/core`
 * and the reaching modules are partially mocked with `importOriginal` +
 * spread (see CONTRIBUTING's "Mocking @actions/core" and main.test.ts);
 * `src/inputs` stays REAL and is driven through a `core.getInput` spy so the
 * parser contract itself is under test. `resolveVersion` is the one
 * additional override: real `run()` calls it, and it reaches out to the
 * GitHub tags API — overriding it (same spread pattern) keeps this suite
 * deterministic and offline, as every unit test must be.
 */

const { getInputSpy, setOutputSpy, setFailedMock, setSecretMock, errorMock, warningMock, infoMock, debugMock, startGroupMock, endGroupMock, ensureCanaryInstalledMock, runCheckMock, renderJUnitReportMock, writeSummaryMock, renderSummaryMarkdownMock, renderExecutionFailureMarkdownMock, uploadReceiptMock, resolveVersionMock } =
  vi.hoisted(() => ({
    getInputSpy: vi.fn<(name: string, options?: actionsCore.InputOptions) => string>(),
    setOutputSpy: vi.fn<(name: string, value: string) => void>(),
    setFailedMock: vi.fn(),
    setSecretMock: vi.fn(),
    errorMock: vi.fn(),
    warningMock: vi.fn(),
    infoMock: vi.fn(),
    debugMock: vi.fn(),
    startGroupMock: vi.fn(),
    endGroupMock: vi.fn(),
    ensureCanaryInstalledMock: vi.fn(),
    runCheckMock: vi.fn(),
    renderJUnitReportMock: vi.fn(),
    writeSummaryMock: vi.fn(),
    renderSummaryMarkdownMock: vi.fn(),
    renderExecutionFailureMarkdownMock: vi.fn(),
    uploadReceiptMock: vi.fn(),
    resolveVersionMock: vi.fn<(version: string) => Promise<ResolvedVersion>>(),
  }));

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof actionsCore>();
  return {
    ...actual,
    getInput: getInputSpy,
    setOutput: setOutputSpy,
    setFailed: setFailedMock,
    setSecret: setSecretMock,
    error: errorMock,
    warning: warningMock,
    info: infoMock,
    debug: debugMock,
    startGroup: startGroupMock,
    endGroup: endGroupMock,
  };
});

// Only the network-reaching entry point of each module is replaced; every
// other export keeps working through the real implementation (main.test.ts
// does the same, minus resolveVersion, which it happens not to assert on).
vi.mock("../../src/version", async (importOriginal) => {
  const actual = await importOriginal<typeof versionModule>();
  return { ...actual, resolveVersion: resolveVersionMock };
});

vi.mock("../../src/canary", async (importOriginal) => {
  const actual = await importOriginal<typeof canaryModule>();
  return { ...actual, ensureCanaryInstalled: ensureCanaryInstalledMock };
});

// buildCheckArgs stays real: it is pure.
vi.mock("../../src/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof runnerModule>();
  return { ...actual, runCheck: runCheckMock, renderJUnitReport: renderJUnitReportMock };
});

vi.mock("../../src/summary", async (importOriginal) => {
  const actual = await importOriginal<typeof summaryModule>();
  return {
    ...actual,
    writeSummary: writeSummaryMock,
    renderSummaryMarkdown: renderSummaryMarkdownMock,
    renderExecutionFailureMarkdown: renderExecutionFailureMarkdownMock,
  };
});

vi.mock("../../src/artifact", async (importOriginal) => {
  const actual = await importOriginal<typeof artifactModule>();
  return { ...actual, uploadReceipt: uploadReceiptMock };
});

const REPO_ROOT = path.join(__dirname, "..", "..");
const BINARY_PATH = path.join("/fake-cargo-home", "bin", "stellar-canary");

/** Values handed to `getInputs()` through the `core.getInput` spy; every
 * declared input gets one via {@link valueForInput}. */
let inputValues: Record<string, string> = {};

interface ActionInputDeclaration {
  readonly default?: string | number | boolean | undefined;
}

interface ActionManifest {
  readonly inputs?: Record<string, ActionInputDeclaration> | undefined;
  readonly outputs?: Record<string, unknown> | undefined;
}

/** Parses `action.yml` with the same YAML parser the workflow checks use,
 * failing with the file name when it is not valid YAML. */
function actionManifest(): ActionManifest {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "action.yml"), "utf8");
  try {
    return parse(raw) as ActionManifest;
  } catch (error) {
    throw new Error(`action.yml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function declaredInputs(): string[] {
  return Object.keys(actionManifest().inputs ?? {});
}

function declaredOutputs(): string[] {
  return Object.keys(actionManifest().outputs ?? {});
}

/** A valid value for each input action.yml declares today, so the whole
 * parser runs without tripping validation (config must be an existing file).
 * An input this map does not know gets `""` (unset) — a name action.yml
 * declares but the parser never asked for is exactly the drift this test
 * catches, and the read is recorded regardless of the value returned. */
function valueForInput(name: string, configPath: string): string {
  switch (name) {
    case "protocol":
      return "28";
    case "config":
      return configPath;
    case "network":
      return "testnet";
    case "rpc-url":
      return "https://soroban-testnet.stellar.org";
    case "fixtures-dir":
      return "fixtures";
    case "version":
      return "0.1.1";
    case "upload-report":
      return "true";
    case "annotations":
      return "true";
    case "timeout-minutes":
      return "15";
    case "allow-empty":
      return "false";
    case "fixtures-pack-version":
      return "v1.2.0";
    case "fixtures-pack-protocol":
      return "28";
    case "github-token":
      return "ghs_contractsyncfakegittoken0000000000";
    case "generate-receipt":
      return "false";
    case "network-passphrase":
      // action.yml's sentinel default for "unset": an empty passphrase is
      // rejected, so the real runner hands getInputs() this value instead.
      return "\u0001";
    default:
      return "";
  }
}

/**
 * Extracts the table under `## ${section}` in README.md whose first cell is
 * a backticked name: returns `name -> cells` (cells trimmed, outer pipes
 * removed). No Markdown dependency — just row lines, per #412.
 */
function readmeTable(section: string): Map<string, string[]> {
  const lines = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8").split(/\r?\n/);
  const heading = `## ${section}`;
  const headingIndex = lines.indexOf(heading);
  if (headingIndex === -1) {
    throw new Error(`README.md has no "${heading}" section`);
  }
  const rows = new Map<string, string[]>();
  let index = headingIndex + 1;
  // Advance to the first table row, stopping if the section has no table.
  while (index < lines.length && !lines[index]!.startsWith("|") && !lines[index]!.startsWith("## ")) {
    index++;
  }
  while (index < lines.length && lines[index]!.startsWith("|")) {
    const line = lines[index]!;
    const firstCell = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (firstCell !== null) {
      const cells = line
        .replace(/^\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((cell) => cell.trim());
      rows.set(firstCell[1]!, cells);
    }
    index++;
  }
  expect(
    rows.size,
    `README.md's "${heading}" section has no backticked table rows — update this parser if the table format changed`,
  ).toBeGreaterThan(0);
  return rows;
}

/** README default cells are backticked (`` `true` ``); action.yml defaults
 * are plain YAML scalars. Compare them with formatting stripped. */
function normalizeDefault(cell: string): string {
  return cell.replace(/`/g, "").trim();
}

/** The files whose `with:` keys must be declared inputs: every example plus
 * the reusable workflow (per #412's scope). */
function contractYamlFiles(): string[] {
  const examples = fs
    .readdirSync(path.join(REPO_ROOT, "examples"))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => path.posix.join("examples", name));
  return [...examples, ".github/workflows/reusable-canary-check.yml"];
}

/** True when a step's `uses:` refers to *this* Action: the repo-qualified
 * reference (`StellarCanary/ProtocolCanary-Action[@ref]`) or a local
 * checkout of it (`./`, `./action.yml`). Local workflow calls such as
 * `./.github/workflows/...` are not the Action and must not be checked. */
function usesThisAction(uses: unknown): boolean {
  if (typeof uses !== "string") {
    return false;
  }
  if (uses === "." || uses === "./" || uses === "./action.yml") {
    return true;
  }
  return uses === "StellarCanary/ProtocolCanary-Action" || uses.startsWith("StellarCanary/ProtocolCanary-Action@");
}

interface WorkflowStep {
  readonly name?: unknown;
  readonly uses?: unknown;
  readonly with?: unknown;
}

function outputNames(): string[] {
  return setOutputSpy.mock.calls.map((call) => String(call[0]));
}

const PASS_REPORT = report({
  status: "pass",
  counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
  results: [
    result({
      testId: "p28-xdr-cap83-empty-tx-set",
      surface: "xdr",
      status: "pass",
      summary: "StellarValue round-tripped byte-for-byte",
      fixtureId: "p28-xdr-cap83-empty-tx-set",
    }),
  ],
});

// Reset everything between tests (main.test.ts does the same), and wire the
// getInput spy to the per-test values: real getInputs() runs against it.
beforeEach(() => {
  inputValues = {};
  getInputSpy.mockReset().mockImplementation((name) => inputValues[name] ?? "");
  setOutputSpy.mockReset();
  setFailedMock.mockReset();
  setSecretMock.mockReset();
  errorMock.mockReset();
  warningMock.mockReset();
  infoMock.mockReset();
  debugMock.mockReset();
  startGroupMock.mockReset();
  endGroupMock.mockReset();
  ensureCanaryInstalledMock.mockReset();
  runCheckMock.mockReset();
  writeSummaryMock.mockReset();
  renderSummaryMarkdownMock.mockReset();
  renderExecutionFailureMarkdownMock.mockReset();
  uploadReceiptMock.mockReset();
  resolveVersionMock.mockReset();
});

describe("action.yml inputs and getInputs stay in sync (#412)", () => {
  it("reads every input action.yml declares, and no input it does not declare", () => {
    const declared = declaredInputs();
    expect(declared.length, "action.yml declares no inputs — this contract cannot mean anything").toBeGreaterThan(0);

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "contract-sync-config-"));
    const configPath = path.join(configDir, ".stellar-canary.toml");
    fs.writeFileSync(configPath, "[tests]\n", "utf8");
    try {
      // Every declared input is set, so the whole parser runs.
      inputValues = Object.fromEntries(declared.map((name) => [name, valueForInput(name, configPath)]));
      getInputSpy.mockClear();
      getInputs();
      const read = [...new Set(getInputSpy.mock.calls.map((call) => String(call[0])))];

      for (const name of declared) {
        expect(read, `action.yml declares input "${name}" but getInputs() never reads it (src/inputs.ts)`).toContain(
          name,
        );
      }
      for (const name of read) {
        expect(declared, `getInputs() reads input "${name}" which action.yml does not declare`).toContain(name);
      }
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("action.yml outputs and run() stay in sync (#412)", () => {
  let runnerTemp: string;

  beforeEach(() => {
    runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "contract-sync-run-"));
    process.env.RUNNER_TEMP = runnerTemp;
    delete process.env.GITHUB_TOKEN;

    // Inputs for both runs of run(): generate-receipt is enabled so the
    // receipt-path output — which exists only on that branch — is exercised.
    inputValues = {
      protocol: "28",
      version: "0.1.1",
      "timeout-minutes": "1",
      annotations: "true",
      "upload-report": "false",
      "generate-receipt": "true",
      // junit-report-path, like receipt-path, is set on one branch only.
      "junit-report": "true",
      "network-passphrase": "\u0001",
      // #400: run() checks this directory on disk before doing anything else.
      "fixtures-dir": "tests/fixtures",
    };

    resolveVersionMock.mockResolvedValue({ version: "0.1.1", tag: "v0.1.1", commitSha: undefined });
    ensureCanaryInstalledMock.mockResolvedValue({ binaryPath: BINARY_PATH, version: "0.1.1" });
    writeSummaryMock.mockResolvedValue(undefined);
    renderSummaryMarkdownMock.mockReturnValue("## Stellar Protocol Canary (rendered summary)");
    renderExecutionFailureMarkdownMock.mockReturnValue("## Stellar Protocol Canary (execution failure)");
    uploadReceiptMock.mockResolvedValue({ uploaded: true });
    runCheckMock.mockReset();
    renderJUnitReportMock.mockResolvedValue({ path: path.join(runnerTemp, "stellar-canary-report.junit.xml") });
  });

  afterEach(() => {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
    delete process.env.RUNNER_TEMP;
  });

  it("sets exactly the outputs action.yml declares, across the success and execution-failure paths", async () => {
    const declared = declaredOutputs();
    expect(declared.length, "action.yml declares no outputs — this contract cannot mean anything").toBeGreaterThan(0);

    // Success path: a parsed report sets every report-derived output.
    setOutputSpy.mockClear();
    runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: JSON.stringify(PASS_REPORT), stderr: "" });
    await run();
    const success = outputNames();
    expect(success, "the success path set no outputs at all — run() did not complete").toContain("status");

    // Execution-failure path: Canary produced nothing parseable.
    setOutputSpy.mockClear();
    runCheckMock.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: "", stderr: "" });
    await run();
    const failure = outputNames();
    expect(failure, "the execution-failure path set no outputs at all — run() did not complete").toContain("status");

    const union = [...new Set([...success, ...failure])];
    for (const name of declared) {
      expect(
        union,
        `action.yml declares output "${name}" but run() never sets it on the success or the execution-failure path (src/main.ts)`,
      ).toContain(name);
    }
    for (const name of union) {
      expect(declared, `run() sets output "${name}" but action.yml does not declare it`).toContain(name);
    }
  });
});

describe("README tables match action.yml (#412)", () => {
  it("lists every declared input and nothing else", () => {
    const declared = declaredInputs();
    const rows = readmeTable("Inputs");
    for (const name of declared) {
      expect(rows.has(name), `action.yml declares input "${name}" but README.md's Inputs table has no row for it`).toBe(
        true,
      );
    }
    for (const name of rows.keys()) {
      expect(declared, `README.md's Inputs table has a row for "${name}" which action.yml does not declare`).toContain(
        name,
      );
    }
  });

  it("states the same defaults as action.yml", () => {
    const manifest = actionManifest();
    const rows = readmeTable("Inputs");
    for (const [name, meta] of Object.entries(manifest.inputs ?? {})) {
      if (meta.default === undefined || meta.default === "\u0001") {
        // No default (or the "\u0001" sentinel meaning "unset") in action.yml: README follows its own convention for
        // "the CLI decides" / "(none)" — presence is asserted above.
        continue;
      }
      const row = rows.get(name);
      if (row === undefined) {
        continue; // Already reported by the presence check above.
      }
      const cells = row;
      expect(cells.length, `README.md's Inputs table row for "${name}" does not have 3 columns`).toBe(3);
      const readmeDefault = normalizeDefault(cells[2] ?? "");
      expect(
        readmeDefault,
        `README.md states default ${JSON.stringify(readmeDefault)} for input "${name}" but action.yml declares ${JSON.stringify(String(meta.default))}`,
      ).toBe(String(meta.default));
    }
  });

  it("lists every declared output and nothing else", () => {
    const declared = declaredOutputs();
    const rows = readmeTable("Outputs");
    for (const name of declared) {
      expect(
        rows.has(name),
        `action.yml declares output "${name}" but README.md's Outputs table has no row for it`,
      ).toBe(true);
    }
    for (const name of rows.keys()) {
      expect(declared, `README.md's Outputs table has a row for "${name}" which action.yml does not declare`).toContain(
        name,
      );
    }
  });
});

describe("example workflows only pass declared inputs (#412)", () => {
  it.each(contractYamlFiles())("is valid YAML and only uses declared inputs: %s", (relativePath) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
    const documents = parseAllDocuments(text);
    const yamlErrors = documents.flatMap((document) => document.errors.map((error) => error.message));
    expect(yamlErrors, `${relativePath} is not valid YAML: ${yamlErrors.join("; ")}`).toHaveLength(0);

    const declared = declaredInputs();
    for (const document of documents) {
      const workflow = document.toJS() as { jobs?: unknown };
      if (typeof workflow.jobs !== "object" || workflow.jobs === null) {
        continue;
      }
      for (const [jobId, job] of Object.entries(workflow.jobs as Record<string, unknown>)) {
        if (typeof job !== "object" || job === null) {
          continue;
        }
        const steps = (job as { steps?: unknown }).steps;
        if (!Array.isArray(steps)) {
          continue;
        }
        for (const [index, rawStep] of steps.entries()) {
          if (typeof rawStep !== "object" || rawStep === null) {
            continue;
          }
          const step = rawStep as WorkflowStep;
          if (!usesThisAction(step.uses)) {
            continue;
          }
          const label =
            `job "${jobId}" step ${index + 1}` +
            (typeof step.name === "string" ? ` (${step.name})` : "");
          const withKeys =
            typeof step.with === "object" && step.with !== null ? Object.keys(step.with) : [];
          for (const key of withKeys) {
            expect(
              declared,
              `${relativePath}: ${label} passes with key "${key}" which action.yml does not declare as an input`,
            ).toContain(key);
          }
        }
      }
    }
  });
});
