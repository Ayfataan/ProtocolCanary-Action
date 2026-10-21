#!/usr/bin/env node
/**
 * Run the built Action (dist/index.js) locally, without GitHub — issue #437.
 *
 * Trying a change today means pushing a branch and waiting for a workflow, or
 * hand-building the runner environment the Action reads (INPUT_* variables,
 * GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, RUNNER_TEMP, CARGO_HOME). This script
 * builds that environment in a temporary directory, runs the Action's real
 * compiled entry point, and prints what it produced: the outputs it wrote,
 * the job summary, and the annotations it emitted.
 *
 * It exists for contributors and maintainers. It does not change the Action,
 * never contacts the network, and never installs anything:
 *
 *   node scripts/run-local.mjs \
 *     --engine "$HOME/.cargo/bin/stellar-canary" \
 *     --fixtures-dir ./my-fixtures \
 *     --protocol 28 \
 *     --input version=0.1.1 \
 *     --input allow-empty=true
 *
 * Node built-ins only — no dependencies.
 */
"use strict";

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");

/** Exit code used by the script itself when its own usage/arguments are wrong. */
const SCRIPT_USAGE_EXIT_CODE = 2;

const USAGE = `Run the built Action (dist/index.js) locally, without GitHub.

Usage:
  node scripts/run-local.mjs --engine <path> [options]

Required:
  --engine <path>          Path to a stellar-canary binary. It is copied into a
                           temporary <CARGO_HOME>/bin, so the Action looks it up
                           exactly as it does on a runner. Never installed; if
                           the option is missing the script exits non-zero.

Options:
  --fixtures-dir <dir>     Values for the Action's fixtures-dir input
                           (required by the Action; send it as its own input if
                           you need a non-default value).
  --input <name>=<value>   Set an Action input, repeatable. The name is mapped
                           to the INPUT_* environment variable the same way
                           GitHub normalizes it (uppercase, spaces -> '_').
                           Example: --input version=0.1.1 --input allow-empty=true
  --protocol <number>      Shorthand for --input protocol=<number>.
  -h, --help               Show this help text and exit.

Behaviour:
  * Builds a runner-like environment in a temporary directory:
    GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, GITHUB_ENV, RUNNER_TEMP and
    CARGO_HOME/bin containing the given engine. Everything is removed
    afterwards, including on failure and interrupt.
  * Runs the Action's real 'dist/index.js' (build it first with
    'npm run build').
  * Prints the outputs the Action wrote (key=value), the rendered job
    summary, any '::error'/'::warning' annotation lines it emitted, and the
    exit code. The script exits with the Action's exit code.

The script never talks to a network and never installs anything.
`;

class UsageError extends Error {}

function parseInputs(argv) {
  const inputs = { engine: undefined, input: [], protocol: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) {
        throw new UsageError(`option ${arg} requires a value`);
      }
      i += 1;
      return argv[i];
    };
    switch (arg) {
      case "-h":
      case "--help":
        return undefined;
      case "--engine":
        inputs.engine = value();
        break;
      case "--fixtures-dir":
        inputs.input.push(["fixtures-dir", value()]);
        break;
      case "--protocol":
        inputs.protocol = value();
        break;
      case "--input": {
        const raw = value();
        const eq = raw.indexOf("=");
        if (eq <= 0) {
          throw new UsageError(
            `--input expects NAME=VALUE (got ${JSON.stringify(raw)}), e.g. --input version=0.1.1`,
          );
        }
        inputs.input.push([raw.slice(0, eq), raw.slice(eq + 1)]);
        break;
      }
      default:
        throw new UsageError(`unknown option: ${arg} (see node scripts/run-local.mjs --help)`);
    }
  }
  return inputs;
}

/** The INPUT_* env var name @actions/core derives from an input name. */
function inputEnvName(name) {
  return `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
}

function readOutputsFile(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const outputs = {};
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$/.exec(lines[i] ?? "");
    if (match) {
      const [, name, delimiter] = match;
      const valueLines = [];
      i += 1;
      while (i < lines.length && lines[i] !== delimiter) {
        valueLines.push(lines[i]);
        i += 1;
      }
      outputs[name] = valueLines.join("\n");
    }
  }
  return outputs;
}

function buildEnvironment(enginePath, fixes) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-run-local-"));
  const env = { ...process.env };

  env.CARGO_HOME = path.join(tempDir, "cargo-home");
  fs.mkdirSync(path.join(env.CARGO_HOME, "bin"), { recursive: true });
  const engineName = process.platform === "win32" ? "stellar-canary.exe" : "stellar-canary";
  fs.copyFileSync(enginePath, path.join(env.CARGO_HOME, "bin", engineName));
  fs.chmodSync(path.join(env.CARGO_HOME, "bin", engineName), 0o755);

  env.RUNNER_TEMP = path.join(tempDir, "runner-temp");
  fs.mkdirSync(env.RUNNER_TEMP, { recursive: true });

  env.GITHUB_OUTPUT = path.join(tempDir, "github-output");
  env.GITHUB_STEP_SUMMARY = path.join(tempDir, "github-step-summary");
  env.GITHUB_ENV = path.join(tempDir, "github-env");
  for (const file of [env.GITHUB_OUTPUT, env.GITHUB_STEP_SUMMARY, env.GITHUB_ENV]) {
    fs.writeFileSync(file, "");
  }

  const overridden = new Set();
  for (const [name, value] of fixes) {
    env[inputEnvName(name)] = value;
    overridden.add(inputEnvName(name));
  }
  for (const name of Object.keys(env)) {
    // Strip whatever INPUT_* state the invoking shell may still carry so the
    // child sees exactly the invocation the command line describes.
    if (name.startsWith("INPUT_") && !overridden.has(name)) {
      delete env[name];
    }
  }

  return { env, tempDir };
}

async function main() {
  const inputs = parseInputs(process.argv.slice(2));
  if (inputs === undefined) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (inputs.engine === undefined) {
    process.stderr.write(
      "error: no engine given. Pass --engine <path/to/stellar-canary>.\n" +
        "This script never installs an engine and never talks to the network.\n",
    );
    return SCRIPT_USAGE_EXIT_CODE;
  }

  if (!fs.existsSync(DIST_INDEX)) {
    process.stderr.write(
      `error: ${path.relative(process.cwd(), DIST_INDEX) || DIST_INDEX} does not exist. Run 'npm run build' first.\n`,
    );
    return SCRIPT_USAGE_EXIT_CODE;
  }

  const engineStats = fs.statSync(inputs.engine, { throwIfNoEntry: false });
  if (engineStats === undefined || !engineStats.isFile()) {
    process.stderr.write(`error: engine path does not exist (or is not a file): ${inputs.engine}\n`);
    return SCRIPT_USAGE_EXIT_CODE;
  }

  for (const [name, value] of inputs.input) {
    if (name === "fixtures-dir") {
      if (!fs.existsSync(value)) {
        process.stderr.write(`error: --fixtures-dir does not exist: ${value}\n`);
        return SCRIPT_USAGE_EXIT_CODE;
      }
    }
  }

  const fixes = [...inputs.input];
  if (inputs.protocol !== undefined) {
    fixes.unshift(["protocol", inputs.protocol]);
  }

  const { env, tempDir } = buildEnvironment(inputs.engine, fixes);

  const child = spawn(process.execPath, [DIST_INDEX], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let interrupted = false;
  const onInterrupt = (signal) => {
    interrupted = true;
    child.kill(signal);
  };
  if (process.platform !== "win32") {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onInterrupt);
  }

  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });

    process.stdout.write(stdout);
    if (stderr !== "") {
      process.stdout.write(stderr);
    }

    process.stdout.write("\n=== Action outputs ===\n");
    const outputs = readOutputsFile(env.GITHUB_OUTPUT);
    for (const name of Object.keys(outputs)) {
      process.stdout.write(`${name}=${outputs[name]}\n`);
    }
    if (Object.keys(outputs).length === 0) {
      process.stdout.write("(none)\n");
    }

    process.stdout.write("\n=== Job summary (GITHUB_STEP_SUMMARY) ===\n");
    const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
    process.stdout.write(summary === "" ? "(empty)\n" : summary);

    process.stdout.write("\n=== Annotations on stdout ===\n");
    const annotations = stdout.split("\n").filter((line) => line.startsWith("::"));
    if (annotations.length === 0) {
      process.stdout.write("(none)\n");
    } else {
      for (const line of annotations) {
        process.stdout.write(`${line}\n`);
      }
    }

    process.stdout.write(`\nAction exit code: ${String(exitCode)}\n`);
    if (interrupted) {
      return 130; // 128+SIGINT convention
    }
    return exitCode ?? 1;
  } finally {
    if (process.platform !== "win32") {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
    }
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
