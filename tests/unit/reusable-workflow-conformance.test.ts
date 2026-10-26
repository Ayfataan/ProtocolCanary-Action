import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TempDirTracker } from "./helpers";

const tracker = new TempDirTracker();

afterEach(() => {
  tracker.cleanup();
});

/**
 * #370: CI conformance tests for the maintained reusable workflow.
 *
 * `.github/workflows/test-reusable-workflow.yml` calls
 * `.github/workflows/reusable-canary-check.yml` from this repository against a
 * sample project directory, then runs two embedded bash scripts:
 *
 *  - `fetch-report-artifact`: resolves the `stellar-protocol-canary-report`
 *    artifact for the current run through the GitHub REST API, downloads it,
 *    and unpacks it into the conformance workspace.
 *  - `verify-outputs`: asserts the reusable workflow's documented output
 *    contract (`exit-code`, `diff-verdict`, `report-path`) end to end and
 *    requires an unpacked JSON report before it passes.
 *
 * This suite extracts both scripts verbatim from the shipped YAML and executes
 * them against fixture trees — valid/invalid output combinations, stubbed
 * curl responses, a real zip artifact — so a regression in the shipped
 * workflow breaks `npm test`, not just CI. A simulated runner failure must
 * make the conformance workflow fail closed.
 */
const REPO_ROOT = path.join(__dirname, "..", "..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "test-reusable-workflow.yml");
const REUSABLE_PATH = path.join(REPO_ROOT, ".github", "workflows", "reusable-canary-check.yml");
const SAMPLE_ROOT = path.join(REPO_ROOT, "tests", "fixtures", "conformance-project");

/**
 * #522: prerequisites the scripts under test need on PATH. `bash` runs the
 * extracted step scripts, `jq` parses the GitHub artifacts listing inside
 * `fetch-report-artifact`, and `python3` builds and unpacks the zip
 * fixtures. GitHub-hosted runners ship all three, so CI is unaffected; on
 * a local machine without one of them these tests used to fail with a
 * misleading assertion ("the artifacts listing is not valid JSON") that
 * pointed at the fixture rather than the missing tool.
 *
 * A missing tool therefore skips exactly the tests that need it, with the
 * reason in the test title — unless `CI` is set, in which case the whole
 * file fails with one clear error naming the tool, so a runner image that
 * loses `jq` can never silently skip the conformance tests.
 */
const REQUIRED_TOOLS = ["bash", "jq", "python3"] as const;

type RequiredTool = (typeof REQUIRED_TOOLS)[number];

function detectMissingTools(): RequiredTool[] {
  const missing: RequiredTool[] = [];
  for (const tool of REQUIRED_TOOLS) {
    const probe = spawnSync(tool, ["--version"], { encoding: "utf8" });
    if (probe.error !== undefined || (probe.status ?? 1) !== 0) {
      missing.push(tool);
    }
  }
  return missing;
}

const MISSING_TOOLS = detectMissingTools();

if (MISSING_TOOLS.length > 0 && process.env.CI) {
  throw new Error(
    `The reusable-workflow conformance tests require ${REQUIRED_TOOLS.join(", ")} on PATH, but ` +
      `${MISSING_TOOLS.join(", ")} ${MISSING_TOOLS.length > 1 ? "are" : "is"} missing on this runner. ` +
      "GitHub-hosted runners include all of them; install the missing tool(s) so the conformance " +
      "tests cannot be silently skipped in CI.",
  );
}

/** Declares an `it` that is skipped — with the missing tool named in the
 * test title — when any tool in `tools` is absent and `CI` is not set. */
function itNeeds(tools: readonly RequiredTool[], title: string, fn: () => Promise<void> | void): void {
  const absent = tools.filter((tool) => MISSING_TOOLS.includes(tool));
  const label =
    absent.length === 0
      ? title
      : `${title} [skipped: ${absent.join(", ")} not on PATH; install ${absent.join(", ")} to run this test]`;
  it.skipIf(absent.length > 0)(label, fn);
}

function workflowSource(): string {
  if (!fs.existsSync(WORKFLOW_PATH)) {
    throw new Error(`Missing shipped workflow: ${WORKFLOW_PATH}`);
  }
  // Windows runners materialise untracked-by-.gitattributes text files with
  // CRLF endings (runner git uses core.autocrlf=true); the extraction and
  // structure regexes below are line-ending sensitive, so read the stored LF
  // form on every OS.
  return fs.readFileSync(WORKFLOW_PATH, "utf8").replace(/\r\n/g, "\n");
}

function extractRunScript(source: string, stepId: string): string {
  const lines = source.split(/\r?\n/);
  const idIndex = lines.findIndex((line) => line.trim() === `id: ${stepId}`);
  if (idIndex === -1) {
    throw new Error(`Shipped workflow has no step with "id: ${stepId}".`);
  }
  let runIndex = -1;
  let runIndent = -1;
  for (let i = idIndex; i < lines.length; i += 1) {
    const match = /^(\s*)run:\s*\|\s*$/.exec(lines[i] ?? "");
    if (match !== null) {
      runIndex = i;
      runIndent = (match[1] ?? "").length;
      break;
    }
    if (i > idIndex && /^\s{0,6}-\s+/.test(lines[i] ?? "")) {
      break;
    }
  }
  if (runIndex === -1) {
    throw new Error(`Step "id: ${stepId}" ships no literal block ("run: |").`);
  }
  const body: string[] = [];
  for (let i = runIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() !== "" && line.length - line.trimStart().length <= runIndent) {
      break;
    }
    body.push(line.slice(runIndent + 2));
  }
  const script = body.join("\n");
  if (script.trim() === "") {
    throw new Error(`Step "id: ${stepId}" ships an empty run block.`);
  }
  return script;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runScript(script: string, env: StepEnv, opts?: { stub?: string; cwd?: string }): RunResult {
  const dir = opts?.cwd ?? tracker.track(fs.mkdtempSync(path.join(os.tmpdir(), "l75-conformance-")));
  const scriptPath = path.join(dir, "step.sh");
  fs.writeFileSync(scriptPath, script);
  // With a stub, run the step inside the shell that also defines it:
  // `. ./step.sh` keeps the shell's `curl` function visible to every command
  // the step runs (bash resolves functions before PATH entries). The old
  // scheme prepended a stub binary to PATH, which cannot work on the Windows
  // runner (":" is not a PATH separator there and the extensionless stub is
  // not executable), so the real curl.exe answered every stubbed request
  // with "curl: (6) Could not resolve host" instead of the fixture API.
  const command = opts?.stub === undefined ? [scriptPath] : ["-c", `${opts.stub}\n. ./step.sh`];
  const result = spawnSync("bash", command, {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? dir,
      ...env,
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Stub `curl` as a POSIX shell function: scenario data arrives through env
 * vars (never through temp-file paths embedded in bash text, which break on
 * Windows), and the function takes lookup precedence over any real curl on
 * the machine. Mirrors the artifacts REST API: every request whose URL
 * contains `https://example.invalid` responds with the mapped body (or the
 * named local file when the script asked for `--output <file>`).
 */
const CURL_STUB = [
  "curl() {",
  '  local out="" url="" i a',
  '  local args=("$@")',
  '  i=0',
  '  while [ "$i" -lt "${#args[@]}" ]; do',
  '    a="${args[$i]}"',
  '    case "$a" in',
  '      --output) i=$((i + 1)); out="${args[$i]}";;',
  '      https://example.invalid*) url="$a";;',
  "    esac",
  "    i=$((i + 1))",
  "  done",
  '  case "$url" in',
  "    */artifacts*/zip*)",
  '      if [ -n "$out" ] && [ -n "${FAKE_ARTIFACT_ZIP:-}" ] && [ -f "${FAKE_ARTIFACT_ZIP}" ]; then',
  '        cp -- "${FAKE_ARTIFACT_ZIP}" "$out"',
  "        return 0",
  "      fi",
  "      return 22;;",
  "    */artifacts*)",
  '      if [ "${FAKE_ARTIFACT_FAILLIST:-0}" = "1" ]; then return 22; fi',
  '      if [ -n "$out" ] && [ "$out" != "-" ]; then',
  "        printf '%s' \"${FAKE_ARTIFACT_LIST:-}\" > \"$out\"",
  "      else",
  "        printf '%s' \"${FAKE_ARTIFACT_LIST:-}\"",
  "      fi",
  "      return 0;;",
  "    *) return 22;;",
  "  esac",
  "}",
].join("\n");

function curlScenarioEnv(scenario: { list: string; zip?: string; failList?: boolean }): StepEnv {
  const env: StepEnv = { FAKE_ARTIFACT_LIST: scenario.list };
  // Forward slashes: the msys runtime opens native "C:/…" paths directly,
  // while backslashes would be eaten as escapes inside the bash stub.
  if (scenario.zip !== undefined) env.FAKE_ARTIFACT_ZIP = scenario.zip.split("\\").join("/");
  if (scenario.failList === true) env.FAKE_ARTIFACT_FAILLIST = "1";
  return env;
}

/** Real zip archive containing a Protocol Canary-shaped JSON report. */
function reportZipFixture(): string {
  const dir = tracker.track(fs.mkdtempSync(path.join(os.tmpdir(), "l75-zip-")));
  const reportPath = path.join(dir, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify({ schema: 1, protocol: 28, status: "compatible", results: [] }));
  const zipPath = path.join(dir, "artifact.zip");
  const res = spawnSync("python3", ["-c", [
    "import zipfile,sys",
    "z=zipfile.ZipFile(sys.argv[1],'w')",
    "z.write(sys.argv[2], arcname='report.json')",
    "z.close()",
  ].join("; "), zipPath, reportPath], { encoding: "utf8" });
  if ((res.status ?? 1) !== 0) {
    throw new Error(`fixture zip creation failed: ${res.stderr}`);
  }
  return zipPath;
}

const VALID_LIST = JSON.stringify({
  total_count: 1,
  artifacts: [
    {
      id: 4242,
      name: "stellar-protocol-canary-report",
      workflow_run: { id: 99 },
      archive_download_url: "https://example.invalid/repos/o/r/actions/artifacts/4242/zip",
    },
  ],
});

interface StepEnv {
  [key: string]: string | undefined;
}

function artifactEnv(): StepEnv {
  return {
    GH_API_BASE: "https://example.invalid",
    GITHUB_TOKEN: "s",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_RUN_ID: "99",
    REPORT_DIR: "unpacked",
  };
}

function outputsEnv(over?: StepEnv): StepEnv {
  return {
    CANARY_OUTCOME: "success",
    CANARY_EXIT_CODE: "0",
    CANARY_DIFF_VERDICT: "not-requested",
    CANARY_REPORT_PATH: "/runner/work/report.json",
    REPORT_DIR: "unpacked",
    ...over,
  };
}

describe("test-reusable-workflow conformance (#370)", () => {
  it("calls the shipped reusable workflow against a sample project directory", () => {
    const source = workflowSource();
    expect(source).toContain("uses: ./.github/workflows/reusable-canary-check.yml");
    // The sample project directory the call exercises must exist with the
    // files the reusable workflow discovers.
    expect(fs.existsSync(path.join(SAMPLE_ROOT, ".stellar-canary.toml")), "sample project config present").toBe(true);
    expect(fs.existsSync(path.join(SAMPLE_ROOT, "fixtures")), "sample fixtures directory present").toBe(true);
    // The `with:` block may only pass inputs the reusable workflow declares.
    // CRLF-normalised read — see workflowSource() for why.
    const reusable = fs.readFileSync(REUSABLE_PATH, "utf8").replace(/\r\n/g, "\n");
    const inputsStart = reusable.indexOf("    inputs:");
    const inputsEnd = reusable.indexOf("    outputs:");
    expect(inputsStart, "reusable workflow declares workflow_call inputs").toBeGreaterThan(-1);
    expect(inputsEnd, "reusable workflow declares workflow_call outputs").toBeGreaterThan(inputsStart);
    const inputsSection = reusable.slice(inputsStart, inputsEnd);
    const declared = [...inputsSection.matchAll(/^ {6}([a-z-]+):$/gm)].map((m) => m[1] ?? "");
    expect(declared).toContain("project-root");
    const withBlock = /^ {4}with:\n((?: {6}\S.*\n)+)/m.exec(source)?.[1] ?? "";
    const withKeys = [...withBlock.matchAll(/^ {6}([a-z-]+):/gm)].map((m) => m[1] ?? "");
    expect(withKeys.length, "the local reusable-workflow call must pass inputs").toBeGreaterThan(0);
    for (const key of withKeys) {
      expect(declared, `conformance workflow passes input "${key}" which reusable-canary-check.yml does not declare`).toContain(key);
    }
  });

  itNeeds(
    ["bash", "jq", "python3"],
    "fetch-report-artifact unpacks the shipped JSON report from a real run artifact",
    () => {
    const script = extractRunScript(workflowSource(), "fetch-report-artifact");
    const zip = reportZipFixture();
    const result = runScript(
      script,
      { ...artifactEnv(), ...curlScenarioEnv({ list: VALID_LIST, zip }) },
      { stub: CURL_STUB },
    );
    // cwd is a fresh tmp dir inside runScript; the script unpacks relative to it.
    expect(result.stdout + result.stderr).not.toContain("::error::");
    expect(result.status).toBe(0);
  });

  itNeeds(
    ["bash", "jq"],
    "fetch-report-artifact fails closed when the run produced no report artifact",
    () => {
    const script = extractRunScript(workflowSource(), "fetch-report-artifact");
    const empty = JSON.stringify({ total_count: 0, artifacts: [] });
    const result = runScript(
      script,
      { ...artifactEnv(), ...curlScenarioEnv({ list: empty }) },
      { stub: CURL_STUB },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("::error::");
    expect(result.stdout + result.stderr).toContain("stellar-protocol-canary-report");
  });

  itNeeds(
    ["bash", "jq"],
    "fetch-report-artifact ignores artifacts from other workflow runs",
    () => {
    const script = extractRunScript(workflowSource(), "fetch-report-artifact");
    const otherRun = JSON.stringify({ total_count: 1, artifacts: [{ id: 1, name: "stellar-protocol-canary-report", workflow_run: { id: 7 } }] });
    const result = runScript(
      script,
      { ...artifactEnv(), ...curlScenarioEnv({ list: otherRun }) },
      { stub: CURL_STUB },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("::error::");
  });

  itNeeds(
    ["bash"],
    "fetch-report-artifact fails when the API itself is unreachable",
    () => {
    const script = extractRunScript(workflowSource(), "fetch-report-artifact");
    const result = runScript(
      script,
      { ...artifactEnv(), ...curlScenarioEnv({ list: VALID_LIST, failList: true }) },
      { stub: CURL_STUB },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("::error::");
  });

  itNeeds(
    ["bash", "python3"],
    "verify-outputs accepts a documented-conformant successful run",
    () => {
    const script = extractRunScript(workflowSource(), "verify-outputs");
    const zip = reportZipFixture();
    // Stage the unpacked artifact the fetch step would have produced.
    const work = tracker.track(fs.mkdtempSync(path.join(os.tmpdir(), "l75-verify-")));
    const unpacked = path.join(work, "unpacked");
    fs.mkdirSync(unpacked);
    fs.copyFileSync(zip, path.join(work, "seed.zip"));
    spawnSync("python3", ["-m", "zipfile", "-e", path.join(work, "seed.zip"), unpacked]);
    const result = runScript(script, outputsEnv(), { cwd: work });
    expect(result.stdout + result.stderr).not.toContain("::error::");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("conformance");
  });

  itNeeds(
    ["bash"],
    "verify-outputs fails closed on a simulated runner failure",
    () => {
    const script = extractRunScript(workflowSource(), "verify-outputs");
    const result = runScript(script, outputsEnv({ CANARY_OUTCOME: "failure", CANARY_EXIT_CODE: "1" }));
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("::error::");
  });

  itNeeds(
    ["bash"],
    "verify-outputs rejects off-contract outputs",
    () => {
    const script = extractRunScript(workflowSource(), "verify-outputs");
    const cases: StepEnv[] = [
      { CANARY_EXIT_CODE: "7" },
      { CANARY_DIFF_VERDICT: "diffed" },
      { CANARY_EXIT_CODE: "1" },
      { CANARY_REPORT_PATH: "" },
    ];
    for (const over of cases) {
      const env = outputsEnv(over);
      const result = runScript(script, env, { cwd: stageUnpackedFixture() });
      expect(result.status, `env override ${JSON.stringify(over)} must be rejected`).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("::error::");
    }
  });

  itNeeds(
    ["bash"],
    "verify-outputs fails when the artifact tree holds no valid report",
    () => {
    const script = extractRunScript(workflowSource(), "verify-outputs");
    const work = tracker.track(fs.mkdtempSync(path.join(os.tmpdir(), "l75-verify-empty-")));
    fs.mkdirSync(path.join(work, "unpacked"));
    const result = runScript(script, outputsEnv(), { cwd: work });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("::error::");
  });

  it("ships read-only permissions for the conformance job itself", () => {
    const source = workflowSource();
    const scopes = [...source.matchAll(/^\s*(contents|actions|checks|issues|packages|pull-requests|statuses|security-events):\s*(\S+)/gm)];
    expect(scopes.length).toBeGreaterThan(0);
    for (const match of scopes) {
      expect(match[2], `scope ${match[1]} must stay read-only`).toBe("read");
    }
  });

  it("cleans up temporary directories so no l75-* directories are left behind (#501)", () => {
    const zip = reportZipFixture();
    const parentDir = path.dirname(zip);
    expect(tracker.has(parentDir)).toBe(true);
    expect(fs.existsSync(parentDir)).toBe(true);

    tracker.cleanup();

    expect(fs.existsSync(parentDir)).toBe(false);
    expect(tracker.has(parentDir)).toBe(false);
  });
});

function stageUnpackedFixture(): string {
  const work = tracker.track(fs.mkdtempSync(path.join(os.tmpdir(), "l75-verify-")));
  const unpacked = path.join(work, "unpacked");
  fs.mkdirSync(unpacked);
  fs.writeFileSync(path.join(unpacked, "report.json"), JSON.stringify({ schema: 1, protocol: 28, status: "compatible" }));
  return work;
}
