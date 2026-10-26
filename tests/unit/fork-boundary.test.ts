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
 * #369: least-privilege permissions and fork PR trust boundaries.
 *
 * The quality bar in this repository is that a workflow test must execute the
 * code that ships, not restate its strings. `.github/workflows/test-fork-boundary.yml`
 * embeds two bash scripts:
 *
 *  - `fork-boundary-audit`: scans a workflow file for trust-boundary violations
 *    (elevated event triggers, permission scopes beyond `contents: read`,
 *    checkout steps that persist credentials, secret bridges beyond the
 *    declared `github-token`).
 *  - `token-boundary-probe`: performs a write-scoped API call with the run's
 *    `GITHUB_TOKEN` and fails closed unless the API refuses it (HTTP 401/403).
 *
 * This suite extracts both scripts verbatim from the shipped YAML and runs
 * them with `bash` against fixture workflow trees and a stubbed `curl`, so the
 * behaviour under test is exactly the behaviour on GitHub-hosted runners.
 */
const REPO_ROOT = path.join(__dirname, "..", "..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "test-fork-boundary.yml");
const REUSABLE_PATH = path.join(REPO_ROOT, ".github", "workflows", "reusable-canary-check.yml");

function workflowSource(): string {
  if (!fs.existsSync(WORKFLOW_PATH)) {
    throw new Error(`Missing shipped workflow: ${WORKFLOW_PATH}`);
  }
  // Windows runners materialise untracked-by-.gitattributes text files with
  // CRLF endings (runner git uses core.autocrlf=true); the extraction regexes
  // below are line-ending sensitive, so read the stored LF form on every OS.
  return fs.readFileSync(WORKFLOW_PATH, "utf8").replace(/\r\n/g, "\n");
}

/** Extracts the literal `run: |` block that belongs to the step with `id: <stepId>`. */
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
      break; // reached the next step before finding a run block
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

function runScript(script: string, env: Record<string, string>, curlStub?: string): RunResult {
  const dir = tracker.track(fs.mkdtempSync(path.join(os.tmpdir(), "l75-fork-boundary-")));
  const scriptPath = path.join(dir, "step.sh");
  fs.writeFileSync(scriptPath, script);
  // With a stub, run the step inside the shell that also defines the stub:
  // `. ./step.sh` keeps the shell's `curl` function visible to every command
  // the step runs (shell functions take precedence over PATH lookups). The
  // old scheme prepended a stub directory to PATH, which cannot work on the
  // Windows runner (":" is not a PATH separator there and the extensionless
  // stub is not executable), so the real curl.exe answered with
  // "curl: (6) Could not resolve host" and every stubbed probe degraded.
  const command = curlStub === undefined ? [scriptPath] : ["-c", `${curlStub}\n. ./step.sh`];
  const fullEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? dir,
    ...env,
  };
  const result = spawnSync("bash", command, { cwd: dir, env: fullEnv, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Materialises a fixture workflow file and returns its path. */
function fixtureWorkflow(name: string, body: string): string {
  const dir = tracker.track(fs.mkdtempSync(path.join(os.tmpdir(), "l75-fixture-")));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

/** Builds a bash function definition shadowing `curl` for one probe call:
 * it reports `httpCode` for any request, mirroring real curl behaviour with
 * `--write-out '%{http_code}'` (which exits 0 even for 4xx responses unless
 * --fail is given). Defining it as a shell function — instead of a stub
 * binary on PATH — is what makes the probe stubbed on Windows and ubuntu
 * alike: bash resolves functions before PATH entries, and the runner's real
 * curl.exe stays unreachable from the step either way. */
function fakeCurlFunction(httpCode: string): string {
  return `curl() { printf '%s' '${httpCode}'; return 0; }`;
}

const CLEAN_WORKFLOW = [
  "name: clean",
  "on:",
  "  workflow_call: {}",
  "permissions:",
  "  contents: read",
  "jobs:",
  "  job:",
  "    permissions:",
  "      contents: read",
  "    steps:",
  "      - uses: actions/checkout@deadbeef # v7",
  "        with:",
  "          persist-credentials: false",
  "",
].join("\n");

describe("test-fork-boundary workflow (#369)", () => {
  it("ships a fork-boundary audit step and a token-boundary probe step with literal run blocks", () => {
    const source = workflowSource();
    expect(() => extractRunScript(source, "fork-boundary-audit")).not.toThrow();
    expect(() => extractRunScript(source, "token-boundary-probe")).not.toThrow();
  });

  it("audit script accepts the shipped reusable workflow and the shipped conformance workflows", () => {
    const script = extractRunScript(workflowSource(), "fork-boundary-audit");
    for (const target of [REUSABLE_PATH, WORKFLOW_PATH]) {
      const result = runScript(script, { TARGET_WORKFLOW: target });
      expect(
        result.stdout + result.stderr,
        `audit of ${target} must pass`,
      ).not.toContain("::error::");
      expect(result.status, `audit of ${target} must exit 0`).toBe(0);
    }
  });

  it("audit script fails closed on workflows that request write or elevated scopes (#369 negative)", () => {
    const script = extractRunScript(workflowSource(), "fork-boundary-audit");
    const bad = fixtureWorkflow(
      "bad-perms.yml",
      CLEAN_WORKFLOW.replace("contents: read", "contents: write"),
    );
    const result = runScript(script, { TARGET_WORKFLOW: bad });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("::error::");
  });

  it("audit script fails closed on fork-trust-evading triggers (pull_request_target / workflow_run / repository_dispatch)", () => {
    const script = extractRunScript(workflowSource(), "fork-boundary-audit");
    for (const trigger of ["pull_request_target", "workflow_run", "repository_dispatch"]) {
      const bad = fixtureWorkflow(
        `bad-${trigger}.yml`,
        CLEAN_WORKFLOW.replace("  workflow_call: {}", `  ${trigger}:`),
      );
      const result = runScript(script, { TARGET_WORKFLOW: bad });
      expect(result.status, `${trigger} must be rejected`).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(trigger);
    }
  });

  it("audit script fails closed when a checkout step persists credentials", () => {
    const script = extractRunScript(workflowSource(), "fork-boundary-audit");
    const bad = fixtureWorkflow(
      "bad-persist.yml",
      CLEAN_WORKFLOW.replace("persist-credentials: false", "persist-credentials: true"),
    );
    const result = runScript(script, { TARGET_WORKFLOW: bad });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("persist-credentials");

    // Missing the opt-out entirely must fail too — absence of the hardening is
    // treated as a violation, never as "assume secure".
    const missing = fixtureWorkflow(
      "missing-persist.yml",
      CLEAN_WORKFLOW.replace([
        "      - uses: actions/checkout@deadbeef # v7",
        "        with:",
        "          persist-credentials: false",
      ].join("\n"), "      - uses: actions/checkout@deadbeef # v7"),
    );
    const missingResult = runScript(script, { TARGET_WORKFLOW: missing });
    expect(missingResult.status).not.toBe(0);
    expect(missingResult.stdout + missingResult.stderr).toContain("persist-credentials");
  });

  it("audit script fails closed on secret bridges beyond the declared github-token", () => {
    const script = extractRunScript(workflowSource(), "fork-boundary-audit");
    const bad = fixtureWorkflow(
      "bad-secrets.yml",
      `${CLEAN_WORKFLOW}\n      DEPLOY_KEY: \${{ secrets.DEPLOY_KEY }}\n`,
    );
    const result = runScript(script, { TARGET_WORKFLOW: bad });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("DEPLOY_KEY");

    // The declared github-token bridge is explicitly allowed.
    const ok = fixtureWorkflow(
      "ok-secrets.yml",
      `${CLEAN_WORKFLOW}\n      TOKEN_IN: \${{ secrets.github-token }}\n      RUN_TOKEN: \${{ github.token }}\n`,
    );
    const okResult = runScript(script, { TARGET_WORKFLOW: ok });
    expect(okResult.stdout + okResult.stderr).not.toContain("::error::");
    expect(okResult.status).toBe(0);
  });

  it("probe script passes when the write attempt is refused with 403 or 401", () => {
    const script = extractRunScript(workflowSource(), "token-boundary-probe");
    for (const code of ["403", "401"]) {
      const result = runScript(script, {
        GITHUB_TOKEN: "s", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "1", GH_API_BASE: "https://example.invalid",
      }, fakeCurlFunction(code));
      expect(result.stdout + result.stderr, `HTTP ${code} proves the boundary holds`).toContain("boundary holds");
      expect(result.status).toBe(0);
    }
  });

  it("probe script fails closed when the write attempt is ACCEPTED (elevated token)", () => {
    const script = extractRunScript(workflowSource(), "token-boundary-probe");
    const result = runScript(script, {
      GITHUB_TOKEN: "s", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "1", GH_API_BASE: "https://example.invalid",
    }, fakeCurlFunction("200"));
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("::error::");
  });

  it("documents the fork PR trust model in docs/security-model.md", () => {
    const doc = path.join(REPO_ROOT, "docs", "security-model.md");
    expect(fs.existsSync(doc), "docs/security-model.md must ship").toBe(true);
    // CRLF-normalised read — see workflowSource() for why (windows checkout
    // rewrites untracked-by-.gitattributes text files).
    const text = fs.readFileSync(doc, "utf8").replace(/\r\n/g, "\n");
    for (const heading of ["pull_request", "fork", "permissions", "secret"]) {
      expect(text.toLowerCase(), `security model must cover "${heading}"`).toContain(heading);
    }
    // No YAML example may violate the very boundaries the doc defends: the
    // shipped audit script is run against every fenced workflow block it shows.
    const script = extractRunScript(workflowSource(), "fork-boundary-audit");
    const blocks = [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
    expect(blocks.length, "security model must include workflow YAML examples").toBeGreaterThan(0);
    for (const [index, block] of blocks.entries()) {
      const file = fixtureWorkflow(`doc-block-${index}.yml`, block);
      const result = runScript(script, { TARGET_WORKFLOW: file });
      expect(result.status, `doc example ${index} violates the boundary: ${result.stdout}${result.stderr}`).toBe(0);
    }
  });

  it("cleans up temporary directories so none are left behind (#501)", () => {
    const file = fixtureWorkflow("guard.yml", "name: test\n");
    const parentDir = path.dirname(file);
    expect(tracker.has(parentDir)).toBe(true);
    expect(fs.existsSync(parentDir)).toBe(true);

    tracker.cleanup();

    expect(fs.existsSync(parentDir)).toBe(false);
    expect(tracker.has(parentDir)).toBe(false);
  });
});
