import type { CanaryReport } from "../../src/output";
import { report, result } from "../unit/helpers";

export interface GoldenReport {
  readonly name: string;
  readonly report: CanaryReport;
}

export const goldenReports: readonly GoldenReport[] = [
  {
    name: "all-pass",
    report: report({
      status: "pass",
      counts: { total: 3, passed: 3, failed: 0, warnings: 0, errors: 0, skipped: 0 },
      results: [
        result({ testId: "xdr-basic", surface: "xdr", fixtureId: "xdr-basic" }),
        result({ testId: "rpc-health", surface: "rpc", fixtureId: "rpc-health" }),
        result({ testId: "soroban-call", surface: "soroban", fixtureId: "soroban-call" }),
      ],
    }),
  },
  {
    name: "pass-with-warnings",
    report: report({
      status: "warning",
      counts: { total: 2, passed: 1, failed: 0, warnings: 1, errors: 0, skipped: 0 },
      results: [
        result({ testId: "xdr-basic", surface: "xdr", fixtureId: "xdr-basic" }),
        result({
          testId: "rpc-warning",
          surface: "rpc",
          status: "warning",
          summary: "endpoint returned a warning",
          fixtureId: "rpc-warning",
        }),
      ],
    }),
  },
  {
    name: "failure",
    report: report({
      status: "fail",
      counts: { total: 1, passed: 0, failed: 1, warnings: 0, errors: 0, skipped: 0 },
      results: [
        result({
          testId: "xdr-incompatible",
          status: "fail",
          summary: "protocol compatibility assertion failed",
          details: "byte 12 differs",
          fixtureId: "xdr-incompatible",
        }),
      ],
    }),
  },
  {
    name: "mixed-failures-and-warnings",
    report: report({
      status: "fail",
      counts: { total: 3, passed: 1, failed: 1, warnings: 1, errors: 0, skipped: 0 },
      results: [
        result({ testId: "xdr-basic", surface: "xdr", fixtureId: "xdr-basic" }),
        result({
          testId: "rpc-incompatible",
          surface: "rpc",
          status: "fail",
          summary: "response did not match the expected protocol",
          fixtureId: "rpc-incompatible",
        }),
        result({
          testId: "soroban-warning",
          surface: "soroban",
          status: "warning",
          summary: "simulation returned a warning",
          fixtureId: "soroban-warning",
        }),
      ],
    }),
  },
  {
    name: "skipped-fixtures",
    report: report({
      counts: { total: 2, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 1 },
      results: [result({ testId: "xdr-basic", fixtureId: "xdr-basic" })],
      skipped: [
        {
          fixtureId: "p27-xdr-legacy",
          surface: "xdr",
          reason: "fixture targets protocol 27, this run targets protocol 28",
          code: "UNSUPPORTED_PROTOCOL",
        },
      ],
    }),
  },
  {
    name: "empty-run",
    report: report(),
  },
  {
    name: "replayed-from-cache",
    report: report({
      counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
      results: [result({ testId: "xdr-cached", source: "cache", fixtureId: "xdr-cached" })],
    }),
  },
  {
    name: "protocol-mismatch",
    report: report({
      network: { name: "testnet", observedProtocol: 27 },
      results: [result({ testId: "rpc-health", surface: "rpc", fixtureId: "rpc-health" })],
      counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
    }),
  },
  {
    name: "hostile-engine-text",
    report: report({
      status: "fail",
      counts: { total: 1, passed: 0, failed: 1, warnings: 0, errors: 0, skipped: 0 },
      results: [
        result({
          testId: "xdr|<script>alert(1)</script>",
          status: "fail",
          summary: "unexpected | *emphasis* <script>alert(1)</script>",
          details: "literal ` tick\nsecond line",
          fixtureId: "xdr-hostile",
        }),
      ],
    }),
  },
];

export const executionFailure = {
  name: "execution-failure",
  reason: "cargo install failed",
  diagnostic: "error: could not compile",
} as const;
