#!/usr/bin/env node
/*
 * A fake `stellar-canary` binary used only by this repository's own test
 * suite (see docs/mock-canary.md style contract below). It never talks to
 * a network and is never used outside `tests/`. Scenario is selected via
 * the MOCK_CANARY_SCENARIO environment variable; MOCK_CANARY_VERSION
 * overrides the version string reported by `version`.
 *
 * Supported scenarios: pass, pass-network, pass-no-counts, pass-with-result-source, warning,
 * fail, config-error, empty-run, rpc-error, fixture-error, internal-error,
 * malformed-json, timeout.
 */
"use strict";

// @ts-check

/**
 * @typedef {import("../../src/output").CanaryReport} CanaryReport
 * @typedef {import("../../src/output").CanaryResult} CanaryResult
 * @typedef {import("../../src/output").CanarySkip} CanarySkip
 * @typedef {import("../../src/output").CanaryCounts} CanaryCounts
 */

const args = process.argv.slice(2);
const scenario = process.env.MOCK_CANARY_SCENARIO ?? "pass";
const version = process.env.MOCK_CANARY_VERSION ?? "0.1.0";

/**
 * Builds a schemaVersion-1 report object with baseline defaults
 * (`status: "pass"`, zeroed `counts`, empty `results`, fixed `git` info,
 * and `toolVersion` from MOCK_CANARY_VERSION).
 *
 * The merge is shallow: `Object.assign` copies top-level keys, so an
 * override replaces a whole field rather than merging into it. Pass
 * `counts` in full, or omit it and mutate the returned object (as the
 * `pass-no-counts` scenario does with `delete report.counts`).
 *
 * Unlike {@link emit} and {@link fail}, this only returns a value — it
 * writes nothing and does not exit, so callers are free to adjust the
 * object before producing output.
 *
 * @param {Partial<CanaryReport>} [overrides] Top-level fields to merge over the defaults,
 *   e.g. `{ status: "fail", counts: {...}, results: [...] }`.
 * @returns {CanaryReport} A fresh report object; the caller owns it.
 */
function baseReport(overrides) {
  return Object.assign(
    {
      schemaVersion: 1,
      toolVersion: version,
      targetProtocol: 28,
      project: { name: "mock-project", type: "soroban" },
      status: "pass",
      counts: { total: 0, passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0 },
      results: [],
      git: { commit: "deadbeef", branch: "main", isDirty: false },
    },
    overrides,
  );
}

/**
 * Prints `report` to stdout as a single line of JSON, then TERMINATES THE
 * PROCESS with `exitCode`. Use this for any scenario where Canary runs far
 * enough to produce a report — including a compatibility failure, which is
 * still a successful execution.
 *
 * Because it exits, it never returns to the `switch` case that called it;
 * the `break` statements after each call are kept only for readability.
 *
 * @param {CanaryReport} report The report to serialize, normally built by
 *   {@link baseReport}.
 * @param {number} exitCode Exit code to terminate with, per the contract in
 *   `src/output.ts`: 0 pass, 1 compatibility_failure, 3 execution_error.
 * @returns {never} Never returns.
 */
function emit(report, exitCode) {
  process.stdout.write(JSON.stringify(report) + "\n");
  process.exit(exitCode);
}

/**
 * Writes `error: <message>` to stderr, then TERMINATES THE PROCESS with
 * `exitCode`. Writes nothing to stdout, so the Action sees no report —
 * use this for failures that happen before one can be built
 * (`config-error`, `fixture-error`, `internal-error`, and an unknown
 * subcommand), as opposed to a per-fixture error inside a report, which
 * goes through {@link emit}.
 *
 * @param {number} exitCode Exit code to terminate with, per the contract in
 *   `src/output.ts`: 2 configuration_error, 4 invalid_fixture,
 *   5 internal_error.
 * @param {string} message Diagnostic text, written to stderr prefixed with
 *   `error: `.
 * @returns {never} Never returns.
 */
function fail(exitCode, message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(exitCode);
}

if (args[0] === "version") {
  process.stdout.write(`stellar-canary ${version}\n`);
  process.exit(0);
}

if (args[0] !== "check") {
  fail(2, `mock-canary does not implement subcommand ${JSON.stringify(args[0])}`);
}

switch (scenario) {
  case "pass": {
    emit(
      baseReport({
        status: "pass",
        counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
        results: [
          {
            testId: "p28-xdr-cap83-empty-tx-set",
            protocol: 28,
            surface: "xdr",
            status: "pass",
            summary: "StellarValue round-tripped byte-for-byte",
            durationMs: 1,
            fixtureId: "p28-xdr-cap83-empty-tx-set",
          },
        ],
      }),
      0,
    );
    break;
  }

  case "pass-network": {
    emit(
      baseReport({
        status: "pass",
        network: { name: "testnet", observedProtocol: 28 },
        counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
        results: [
          {
            testId: "p28-xdr-cap83-empty-tx-set",
            protocol: 28,
            surface: "xdr",
            status: "pass",
            summary: "StellarValue round-tripped byte-for-byte",
            durationMs: 1,
            fixtureId: "p28-xdr-cap83-empty-tx-set",
          },
        ],
      }),
      0,
    );
    break;
  }

  case "pass-no-counts": {
    // Simulates Protocol-Canary's actual tagged v0.1.0 release, whose
    // schemaVersion-1 report predates the `counts` field.
    const report = baseReport({
      status: "pass",
      results: [
        {
          testId: "p28-xdr-cap83-empty-tx-set",
          protocol: 28,
          surface: "xdr",
          status: "pass",
          summary: "StellarValue round-tripped byte-for-byte",
          durationMs: 1,
          fixtureId: "p28-xdr-cap83-empty-tx-set",
        },
      ],
    });
    // Delete `counts` to simulate the older report shape. `counts` is readonly in
    // `CanaryReport`, so cast to `any` to allow deletion without a type error
    // when this file is checked with `// @ts-check` / `checkJs`.
    delete /** @type {any} */ (report).counts;
    emit(report, 0);
    break;
  }

  case "pass-with-result-source": {
    // A report from an engine release that marks where each result came from
    // (`results[].source`, "live" or "cache") and gives each skip a stable
    // `code`. Both are additive optional fields in schemaVersion 1, so a
    // consumer written before they existed must still read the report.
    emit(
      baseReport({
        status: "pass",
        counts: { total: 2, passed: 2, failed: 0, warnings: 0, errors: 0, skipped: 1 },
        results: [
          {
            testId: "p28-xdr-cap83-empty-tx-set",
            protocol: 28,
            surface: "xdr",
            status: "pass",
            summary: "StellarValue round-tripped byte-for-byte",
            durationMs: 1,
            fixtureId: "p28-xdr-cap83-empty-tx-set",
            source: "live",
          },
          {
            testId: "p28-xdr-cap85-external-ref-roundtrip",
            protocol: 28,
            surface: "xdr",
            status: "pass",
            summary: "ContractExecutable round-tripped byte-for-byte",
            durationMs: 0,
            fixtureId: "p28-xdr-cap85-external-ref-roundtrip",
            source: "cache",
          },
        ],
        skipped: [
          {
            fixtureId: "p27-xdr-old",
            surface: "xdr",
            reason: "fixture targets protocol 27, this run targets protocol 28",
            code: "UNSUPPORTED_PROTOCOL",
          },
        ],
      }),
      0,
    );
    break;
  }

  case "warning": {
    // Modeled on the default policy (`warnings_are_failures = false`):
    // a warning-only run does not fail the process.
    emit(
      baseReport({
        status: "warning",
        counts: { total: 1, passed: 0, failed: 0, warnings: 1, errors: 0, skipped: 0 },
        results: [
          {
            testId: "p28-rpc-get-network",
            protocol: 28,
            surface: "rpc",
            status: "warning",
            summary: "getNetwork responded, but passphrase field was empty",
            details: "Expected a non-empty string passphrase.",
            durationMs: 42,
            fixtureId: "p28-rpc-get-network",
          },
        ],
      }),
      0,
    );
    break;
  }

  case "fail": {
    emit(
      baseReport({
        status: "fail",
        counts: { total: 1, passed: 0, failed: 1, warnings: 0, errors: 0, skipped: 0 },
        results: [
          {
            testId: "p28-xdr-cap83-empty-tx-set",
            protocol: 28,
            surface: "xdr",
            status: "fail",
            summary: "failed to decode StellarValue",
            details: "Invalid symbol 45, offset 3.",
            durationMs: 0,
            fixtureId: "p28-xdr-cap83-empty-tx-set",
          },
        ],
      }),
      1,
    );
    break;
  }

  case "config-error": {
    fail(2, "configuration error: unsupported config version 2");
    break;
  }

  case "empty-run": {
    // The engine's refusal to report success for a run that executes nothing
    // (maintainer decision D-02, releases after 0.1.1): exit code 2, nothing
    // on stdout, and the explanation on stderr. The text is the engine's
    // real message for `check --protocol 29` against a Protocol 28 pack.
    fail(
      2,
      "configuration error: no checks ran: all 7 loaded fixtures were skipped. 7 target another protocol (this run targets protocol 29; the fixtures target protocol 28). Executing nothing is not evidence of compatibility; pass --allow-empty if an empty run is intended.",
    );
    break;
  }

  case "rpc-error": {
    // An execution error surfaced as a per-fixture Error result, still
    // with a full report on stdout (contrast with fixture-error/
    // internal-error below, which fail before a report can be built).
    emit(
      baseReport({
        status: "error",
        counts: { total: 1, passed: 0, failed: 0, warnings: 0, errors: 1, skipped: 0 },
        results: [
          {
            testId: "p28-rpc-get-network",
            protocol: 28,
            surface: "rpc",
            status: "error",
            summary: "RPC request failed",
            details: "connection timed out after 3 attempts",
            durationMs: 3000,
            fixtureId: "p28-rpc-get-network",
          },
        ],
      }),
      3,
    );
    break;
  }

  case "fixture-error": {
    fail(4, "invalid fixture: duplicate fixture id \"p28-xdr-cap83-empty-tx-set\"");
    break;
  }

  case "internal-error": {
    fail(5, "internal error: unreachable state");
    break;
  }

  case "malformed-json": {
    process.stdout.write("{ this is not valid json");
    process.exit(0);
    break;
  }

  case "timeout": {
    setTimeout(() => {
      process.stdout.write(JSON.stringify(baseReport({})) + "\n");
      process.exit(0);
    }, 10_000);
    break;
  }

  case "many-failures": {
    // Simulates a report with more failures than GitHub's per-job annotation limit (50).
    // This tests that the job summary still lists all results even when annotations are truncated.
    const manyResults = [];
    for (let i = 1; i <= 60; i++) {
      manyResults.push({
        testId: `p28-xdr-many-${i}`,
        protocol: 28,
        surface: "xdr",
        status: "fail",
        summary: `failure ${i}`,
        details: `detail for failure ${i}`,
        durationMs: 1,
        fixtureId: `p28-xdr-many-${i}`,
      });
    }
    emit(
      baseReport({
        status: "fail",
        counts: { total: 60, passed: 0, failed: 60, warnings: 0, errors: 0, skipped: 0 },
        results: manyResults,
      }),
      1,
    );
    break;
  }

  default:
    fail(5, `unknown MOCK_CANARY_SCENARIO ${JSON.stringify(scenario)}`);
}
