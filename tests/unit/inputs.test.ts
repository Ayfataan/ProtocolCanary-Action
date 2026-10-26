import type * as actionsCore from "@actions/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above the imports, so the spies must be too. The suite
// reads inputs through the real `core.getInput`, and CONTRIBUTING's
// partial-mock convention requires spreading the real module so everything
// else keeps working. `vi.spyOn` cannot be used here because an ESM namespace
// object is not configurable.
const { infoMock, warningMock, setSecretMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
  warningMock: vi.fn(),
  setSecretMock: vi.fn(),
}));

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof actionsCore>();
  return { ...actual, info: infoMock, warning: warningMock, setSecret: setSecretMock };
});

import { ConfigNotFoundError, InvalidInputError } from "../../src/errors";
import { getInputs, parseScopedFilter, validateFixturesDir } from "../../src/inputs";

const INPUT_KEYS = [
  "INPUT_PROTOCOL",
  "INPUT_CONFIG",
  "INPUT_WORKING-DIRECTORY",
  "INPUT_NETWORK",
  "INPUT_NETWORK-PASSPHRASE",
  "INPUT_RPC-URL",
  "INPUT_RPC-MAX-RETRIES",
  "INPUT_RPC-RETRY-DELAY-MS",
  "INPUT_FIXTURES-DIR",
  "INPUT_FIXTURE",
  "INPUT_SURFACE",
  "INPUT_CACHE-DIR",
  "INPUT_VERSION",
  "INPUT_UPLOAD-REPORT",
  "INPUT_ANNOTATIONS",
  "INPUT_DIAGNOSTICS",
  "INPUT_TIMEOUT-MINUTES",
  "INPUT_ALLOW-EMPTY",
  "INPUT_FAIL-ON-WARNING",
  "INPUT_OFFLINE",
  "INPUT_FIXTURES-PACK-VERSION",
  "INPUT_FIXTURES-PACK-PROTOCOL",
  "INPUT_BASELINE-REPORT",
  "INPUT_GITHUB-TOKEN",
  "INPUT_GITHUB_TOKEN",
  "INPUT_GENERATE-RECEIPT",
  "INPUT_REPORT-RETENTION-DAYS",
  "INPUT_PR-COMMENT",
  "INPUT_JUNIT-REPORT",
];

function clearInputs(): void {
  for (const key of INPUT_KEYS) {
    delete process.env[key];
  }
  process.env["INPUT_NETWORK-PASSPHRASE"] = "\u0001";
  delete process.env.GITHUB_TOKEN;
  setSecretMock.mockClear();
  infoMock.mockClear();
  warningMock.mockClear();
}

describe("getInputs", () => {
  beforeEach(clearInputs);
  afterEach(clearInputs);

  it("applies documented defaults when nothing is set", () => {
    const inputs = getInputs();
    expect(inputs).toEqual({
      protocol: undefined,
      config: undefined,
      workingDirectory: process.cwd(),
      network: undefined,
      networkPassphrase: undefined,
      rpcUrl: undefined,
      rpcMaxRetries: undefined,
      rpcRetryDelayMs: undefined,
      fixturesDir: "fixtures",
      version: "0.2.0",
      uploadReport: true,
      annotations: true,
      diagnostics: false,
      timeoutMinutes: 15,
      allowEmpty: false,
      failOnWarning: false,
      offline: false,
      fixturesPackVersion: undefined,
      fixturesPackProtocol: undefined,
      baselineReport: undefined,
      githubToken: undefined,
      generateReceipt: false,
      reportRetentionDays: undefined,
      junitReport: false,
      strictIntegrity: false,
      prComment: false,
    });
  });

  it("parses a valid protocol", () => {
    process.env.INPUT_PROTOCOL = "28";
    expect(getInputs().protocol).toBe(28);
  });

  it("rejects protocol 0, which the engine rejects too (#456)", () => {
    // `protocol` now accepts 1 to 4294967295 inclusive: 0 was accepted by the
    // Action but is rejected by the engine ("--protocol must be a positive
    // protocol version number"), so no working configuration changes.
    process.env.INPUT_PROTOCOL = "0";
    expect(() => getInputs()).toThrow(InvalidInputError);
    expect(() => getInputs()).toThrow(/"protocol"/);
    expect(() => getInputs()).toThrow(/from 1 to 4294967295/);
  });

  it("rejects a non-numeric protocol", () => {
    process.env.INPUT_PROTOCOL = "not-a-number";
    expect(() => getInputs()).toThrow(InvalidInputError);
  });

  it("rejects a negative protocol", () => {
    // A negative value is a plausible typo (array index / off-by-one) and a
    // different input shape than a non-numeric string, so lock in that
    // PROTOCOL_LIKE's digits-only anchor rejects it too.
    process.env.INPUT_PROTOCOL = "-1";
    expect(() => getInputs()).toThrow(InvalidInputError);
  });

  it("rejects a config path that does not exist", () => {
    process.env.INPUT_CONFIG = "/nonexistent/.stellar-canary.toml";
    expect(() => getInputs()).toThrow(ConfigNotFoundError);
  });

  // #344: a baseline that is supplied but cannot be found must fail before
  // installation or engine work rather than surfacing as a confusing
  // execution failure later.
  it("rejects a baseline report path that does not exist", () => {
    process.env["INPUT_BASELINE-REPORT"] = "/nonexistent/baseline-report.json";
    expect(() => getInputs()).toThrow(InvalidInputError);
    expect(() => getInputs()).toThrow(/"baseline-report"/);
    expect(() => getInputs()).toThrow(/does not exist/);
  });

  it("rejects a baseline report path that is not a regular file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-baseline-dir-"));
    try {
      process.env["INPUT_BASELINE-REPORT"] = dir;
      expect(() => getInputs()).toThrow(InvalidInputError);
      expect(() => getInputs()).toThrow(/not a regular file/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a baseline report path resolved to an absolute path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-baseline-"));
    const baselinePath = path.join(dir, "baseline.json");
    fs.writeFileSync(baselinePath, "{}", "utf8");
    try {
      process.env["INPUT_BASELINE-REPORT"] = path.relative(process.cwd(), baselinePath);
      expect(getInputs().baselineReport).toBe(path.resolve(baselinePath));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a whitespace-only baseline report as unset", () => {
    process.env["INPUT_BASELINE-REPORT"] = "   ";
    expect(getInputs().baselineReport).toBeUndefined();
  });

  it("returns a config path resolved to an absolute path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-config-"));
    const configPath = path.join(dir, ".stellar-canary.toml");
    fs.writeFileSync(configPath, "[tests]\n", "utf8");
    try {
      // Deliberately relative: this is what distinguishes the resolved value
      // from the raw input that used to be returned.
      const relative = path.relative(process.cwd(), configPath);
      process.env.INPUT_CONFIG = relative;

      const inputs = getInputs();

      // The value forwarded to the CLI as --config must be exactly the path
      // the existence check validated, not the string as written.
      expect(inputs.config).toBe(configPath);
      // GitHub-hosted Windows runners can check the repository out on a
      // different drive from the system temp directory. In that case
      // path.relative returns an absolute path, so comparing it with the raw
      // value is not a portable way to prove resolution occurred.
      const resolvedConfig = inputs.config;
      expect(resolvedConfig).toBe(path.resolve(relative));
      if (resolvedConfig === undefined) {
        throw new Error("Expected the validated config path to be present.");
      }
      expect(path.isAbsolute(resolvedConfig)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a config path that exists but is a directory", () => {
    // parseConfig must require an actual file: forwarding a directory to the
    // stellar-canary CLI only fails later, with a less specific error than
    // ConfigNotFoundError/InvalidInputError would give up front. This test
    // pins the strict (file-only) behavior.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-config-dir-"));
    try {
      process.env.INPUT_CONFIG = dir;
      expect(() => getInputs()).toThrow(InvalidInputError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trims surrounding whitespace from network", () => {
    process.env.INPUT_NETWORK = "  testnet  ";
    expect(getInputs().network).toBe("testnet");
  });

  it("preserves the exact network passphrase for endpoint identity checks", () => {
    process.env["INPUT_NETWORK-PASSPHRASE"] = "  Local Network ; 2026  ";
    expect(getInputs().networkPassphrase).toBe("  Local Network ; 2026  ");
    expect(setSecretMock).toHaveBeenCalledWith("  Local Network ; 2026  ");
  });

  it("rejects an explicitly empty network passphrase", () => {
    process.env["INPUT_NETWORK-PASSPHRASE"] = "";
    expect(() => getInputs()).toThrow(InvalidInputError);
    expect(() => getInputs()).toThrow(/"network-passphrase"/);
  });

  it.each(["line\nbreak", "tab\tvalue", "delete\u007fvalue"])(
    "rejects control characters in network-passphrase %j",
    (value) => {
      process.env["INPUT_NETWORK-PASSPHRASE"] = value;
      expect(() => getInputs()).toThrow(InvalidInputError);
      expect(() => getInputs()).toThrow(/"network-passphrase"/);
    },
  );

  it("leaves an omitted network-passphrase unset", () => {
    expect(getInputs().networkPassphrase).toBeUndefined();
  });

  it.each([
    ["0", 0],
    ["3", 3],
    ["4294967295", 4294967295],
  ])("accepts rpc-max-retries %s", (value, expected) => {
    process.env["INPUT_RPC-MAX-RETRIES"] = value;
    expect(getInputs().rpcMaxRetries).toBe(expected);
  });

  it.each(["-1", "1.5", "1e3", "4294967296"])("rejects rpc-max-retries %s", (value) => {
    process.env["INPUT_RPC-MAX-RETRIES"] = value;
    expect(() => getInputs()).toThrow(InvalidInputError);
    expect(() => getInputs()).toThrow(/"rpc-max-retries"/);
  });

  it.each([
    ["0", 0],
    ["500", 500],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])("accepts rpc-retry-delay-ms %s", (value, expected) => {
    process.env["INPUT_RPC-RETRY-DELAY-MS"] = value;
    expect(getInputs().rpcRetryDelayMs).toBe(expected);
  });

  it.each(["-1", "1.5", "1e3", "9007199254740992"])("rejects rpc-retry-delay-ms %s", (value) => {
    process.env["INPUT_RPC-RETRY-DELAY-MS"] = value;
    expect(() => getInputs()).toThrow(InvalidInputError);
    expect(() => getInputs()).toThrow(/"rpc-retry-delay-ms"/);
  });

  it("trims surrounding whitespace from rpc-url", () => {
    process.env["INPUT_RPC-URL"] = "  https://soroban-testnet.stellar.org  ";
    expect(getInputs().rpcUrl).toBe("https://soroban-testnet.stellar.org");
  });

  it("treats an all-whitespace network as unset", () => {
    process.env.INPUT_NETWORK = "   ";
    expect(getInputs().network).toBeUndefined();
  });

  it("accepts an https rpc-url", () => {
    process.env["INPUT_RPC-URL"] = "https://soroban-testnet.stellar.org";
    expect(getInputs().rpcUrl).toBe("https://soroban-testnet.stellar.org");
  });

  it("accepts http for localhost only", () => {
    process.env["INPUT_RPC-URL"] = "http://localhost:8000/soroban/rpc";
    expect(getInputs().rpcUrl).toBe("http://localhost:8000/soroban/rpc");
  });

  it("accepts http for 127.0.0.1", () => {
    // The isLocalHttp branch permits plain http:// for IPv4 loopback too, so
    // refactoring parseRpcUrl must keep this working alongside localhost.
    process.env["INPUT_RPC-URL"] = "http://127.0.0.1:8000/soroban/rpc";
    expect(getInputs().rpcUrl).toBe("http://127.0.0.1:8000/soroban/rpc");
  });

  it("rejects plain http for the IPv6 loopback [::1]", () => {
    // Pins the current contract of isLocalHttp: the plain-http exemption
    // matches only the literal hostnames "localhost" and "127.0.0.1", so
    // the IPv6 loopback representation of the same machine is rejected even
    // though it is a common way local Soroban RPC endpoints are addressed.
    // This documents a known limitation rather than a regression; if IPv6
    // loopback support is added intentionally later, update this test
    // alongside that change.
    process.env["INPUT_RPC-URL"] = "http://[::1]:8000/soroban/rpc";
    expect(() => getInputs()).toThrow(InvalidInputError);
  });

  it("rejects plain http for a non-local host", () => {
    process.env["INPUT_RPC-URL"] = "http://example.com/rpc";
    expect(() => getInputs()).toThrow(InvalidInputError);
  });

  it("rejects a malformed rpc-url", () => {
    process.env["INPUT_RPC-URL"] = "not a url";
    expect(() => getInputs()).toThrow(InvalidInputError);
  });

  it("normalizes a version with a leading v", () => {
    process.env.INPUT_VERSION = "v0.1.0";
    expect(getInputs().version).toBe("0.1.0");
  });

  it("preserves an explicit legacy engine pin for migration compatibility", () => {
    process.env.INPUT_VERSION = "0.1.1";
    expect(getInputs().version).toBe("0.1.1");
  });

  it("rejects a non-semver version", () => {
    process.env.INPUT_VERSION = "latest";
    expect(() => getInputs()).toThrow(InvalidInputError);
  });

  it.each(["true", "True", "TRUE"])("accepts %s as a true boolean", (value) => {
    process.env["INPUT_UPLOAD-REPORT"] = value;
    expect(getInputs().uploadReport).toBe(true);
  });

  it.each(["false", "False", "FALSE"])("accepts %s as a false boolean", (value) => {
    process.env["INPUT_UPLOAD-REPORT"] = value;
    expect(getInputs().uploadReport).toBe(false);
  });

  it("rejects an undocumented boolean form", () => {
    process.env["INPUT_UPLOAD-REPORT"] = "yes";
    expect(() => getInputs()).toThrow(InvalidInputError);
  });

  it("rejects a zero or negative timeout", () => {
    process.env["INPUT_TIMEOUT-MINUTES"] = "0";
    expect(() => getInputs()).toThrow(InvalidInputError);
  });

  it("parses a valid timeout", () => {
    process.env["INPUT_TIMEOUT-MINUTES"] = "30";
    expect(getInputs().timeoutMinutes).toBe(30);
  });

  it("rejects a fractional timeout instead of silently truncating it (#456)", () => {
    // A truncated timeout silently runs a different timeout than the user
    // wrote, so "15.9" is rejected outright rather than becoming 15.
    process.env["INPUT_TIMEOUT-MINUTES"] = "15.9";
    expect(() => getInputs()).toThrow(InvalidInputError);
    expect(() => getInputs()).toThrow(/"timeout-minutes"/);
    expect(() => getInputs()).toThrow(/from 1 to 35791/);
  });

  it.each([
    ["1", 1],
    ["15", 15],
    [" 15 ", 15],
    ["35791", 35791],
  ])("accepts timeout-minutes %j as %i minutes (#456)", (raw, expected) => {
    process.env["INPUT_TIMEOUT-MINUTES"] = raw;
    expect(getInputs().timeoutMinutes).toBe(expected);
  });

  it.each([
    ["0", 1, 35791],
    ["35792", 1, 35791],
    ["40000", 1, 35791],
    ["9".repeat(400), 1, 35791],
  ])(
    "rejects timeout-minutes %j (#456)",
    (raw, min, max) => {
      process.env["INPUT_TIMEOUT-MINUTES"] = raw;
      expect(() => getInputs()).toThrow(InvalidInputError);
      expect(() => getInputs()).toThrow(/"timeout-minutes"/);
      expect(() => getInputs()).toThrow(new RegExp(`from ${min} to ${max}`));
    },
  );

  it.each([
    ["1", 1],
    ["28", 28],
    [" 28 ", 28],
    ["028", 28],
    ["4294967295", 4294967295],
  ])("accepts protocol %j as %i (#456)", (raw, expected) => {
    process.env.INPUT_PROTOCOL = raw;
    expect(getInputs().protocol).toBe(expected);
  });

  it.each([
    ["0", 1, 4294967295],
    ["4294967296", 1, 4294967295],
    ["9".repeat(20), 1, 4294967295],
    ["9".repeat(400), 1, 4294967295],
  ])(
    "rejects protocol %j (#456)",
    (raw, min, max) => {
      process.env.INPUT_PROTOCOL = raw;
      expect(() => getInputs()).toThrow(InvalidInputError);
      expect(() => getInputs()).toThrow(/"protocol"/);
      expect(() => getInputs()).toThrow(new RegExp(`from ${min} to ${max}`));
    },
  );

  it("treats an empty or whitespace-only protocol as unset (#456)", () => {
    process.env.INPUT_PROTOCOL = "";
    expect(getInputs().protocol).toBeUndefined();
    process.env.INPUT_PROTOCOL = "   ";
    expect(getInputs().protocol).toBeUndefined();
  });

  it.each([
    "1e3",
    "5 minutes",
    "1.9",
    "+5",
    "-1",
    "0x10",
    "1_000",
    "٣",
    "5 5",
  ])(
    "rejects %j for both protocol and timeout-minutes, naming the input and range (#456)",
    (raw) => {
      process.env.INPUT_PROTOCOL = raw;
      expect(() => getInputs()).toThrow(InvalidInputError);
      expect(() => getInputs()).toThrow(/"protocol"/);
      expect(() => getInputs()).toThrow(/from 1 to 4294967295/);

      delete process.env.INPUT_PROTOCOL;
      process.env["INPUT_TIMEOUT-MINUTES"] = raw;
      expect(() => getInputs()).toThrow(InvalidInputError);
      expect(() => getInputs()).toThrow(/"timeout-minutes"/);
      expect(() => getInputs()).toThrow(/from 1 to 35791/);
    },
  );

  it("keeps the default timeout-minutes of 15 when unset (#456)", () => {
    expect(getInputs().timeoutMinutes).toBe(15);
  });

  it("defaults allow-empty to false", () => {
    expect(getInputs().allowEmpty).toBe(false);
  });

  it.each([
    ["true", true],
    ["TRUE", true],
    ["false", false],
    ["False", false],
  ])("parses allow-empty %s", (value, expected) => {
    process.env["INPUT_ALLOW-EMPTY"] = value;
    expect(getInputs().allowEmpty).toBe(expected);
  });

  it("rejects an undocumented allow-empty form and names the input", () => {
    process.env["INPUT_ALLOW-EMPTY"] = "1";
    expect(() => getInputs()).toThrow(/"allow-empty"/);
  });

  it("warns when unsupported fail-on-warning or offline inputs are enabled", () => {
    process.env["INPUT_FAIL-ON-WARNING"] = "true";
    process.env.INPUT_OFFLINE = "true";

    const inputs = getInputs();

    expect(inputs.failOnWarning).toBe(true);
    expect(inputs.offline).toBe(true);
    expect(warningMock.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('"fail-on-warning"'),
      expect.stringContaining('"offline"'),
    ]);
  });

  // #361: `generate-receipt` opts a run into producing an Execution Receipt.
  // It shares the documented boolean literals with the other toggles.
  it("defaults generate-receipt to false", () => {
    expect(getInputs().generateReceipt).toBe(false);
  });

  it.each([
    ["true", true],
    ["True", true],
    ["TRUE", true],
    ["false", false],
    ["False", false],
    ["FALSE", false],
  ])("parses generate-receipt %s", (value, expected) => {
    process.env["INPUT_GENERATE-RECEIPT"] = value;
    expect(getInputs().generateReceipt).toBe(expected);
  });

  it("rejects a non-boolean generate-receipt and names the input", () => {
    process.env["INPUT_GENERATE-RECEIPT"] = "yes";
    expect(() => getInputs()).toThrow(InvalidInputError);
    expect(() => getInputs()).toThrow(/"generate-receipt"/);
  });
});

/**
 * #331 / CF-08 / D-10: `diagnostics` is strictly opt-in and disabled by
 * default, so an omitted input must never start uploading diagnostic
 * artifacts. The input only records the workflow author's intent here; the
 * bundle itself is uploaded by the diagnostics path that consumes it.
 */
describe("getInputs diagnostics (#331)", () => {
  beforeEach(clearInputs);
  afterEach(clearInputs);

  it("defaults diagnostics to false when omitted", () => {
    expect(getInputs().diagnostics).toBe(false);
  });

  it.each([
    ["true", true],
    ["True", true],
    ["TRUE", true],
    ["false", false],
    ["False", false],
    ["FALSE", false],
  ])("parses diagnostics %s strictly", (value, expected) => {
    process.env.INPUT_DIAGNOSTICS = value;
    expect(getInputs().diagnostics).toBe(expected);
  });

  it.each(["yes", "1", "0", "on", "diagnostics"])(
    "rejects the non-boolean diagnostics value %s and names the input",
    (value) => {
      process.env.INPUT_DIAGNOSTICS = value;
      expect(() => getInputs()).toThrow(InvalidInputError);
      expect(() => getInputs()).toThrow(/"diagnostics"/);
    },
  );

  it("leaves artifacts disabled when the input is empty", () => {
    // GitHub passes an omitted input as the empty string, which is not a
    // boolean literal: the documented default must still apply.
    process.env.INPUT_DIAGNOSTICS = "";
    expect(getInputs().diagnostics).toBe(false);
  });
});

/**
 * #337: `fixtures-pack-version` / `fixtures-pack-protocol`. They are declared
 * and validated here; they are deliberately *not* forwarded to Canary, whose
 * fixture-loading contract has no fixture-pack flag (see the parser's doc
 * comment), so these tests pin parsing, validation, and the "no silent
 * no-op" note rather than any CLI argument.
 */
describe("getInputs fixtures-pack inputs (#337)", () => {
  beforeEach(clearInputs);
  // Reset alongside the inputs so one test's log note cannot satisfy another
  // test's assertion.
  afterEach(() => {
    clearInputs();
    infoMock.mockReset();
  });

  it("leaves both inputs undefined when omitted, preserving default behavior", () => {
    const inputs = getInputs();
    expect(inputs.fixturesPackVersion).toBeUndefined();
    expect(inputs.fixturesPackProtocol).toBeUndefined();
    // Nothing else about the run changes when the new inputs are absent.
    expect(inputs.fixturesDir).toBe("fixtures");
    expect(inputs.protocol).toBeUndefined();
  });

  it("treats a whitespace-only value as unset rather than rejecting it", () => {
    // Consistent with the other optional inputs: an unset input written as
    // `fixtures-pack-version: ""` must not fail the run.
    process.env["INPUT_FIXTURES-PACK-VERSION"] = "   ";
    process.env["INPUT_FIXTURES-PACK-PROTOCOL"] = "   ";
    const inputs = getInputs();
    expect(inputs.fixturesPackVersion).toBeUndefined();
    expect(inputs.fixturesPackProtocol).toBeUndefined();
  });

  it.each([
    ["1.2.3", "1.2.3"],
    ["v1.2.3", "v1.2.3"],
    ["0.0.1", "0.0.1"],
    ["v10.20.30", "v10.20.30"],
    ["v1.2.3-rc.1", "v1.2.3-rc.1"],
    ["1.2.3+build.5", "1.2.3+build.5"],
  ])("accepts fixture-pack-version %s", (raw, expected) => {
    process.env["INPUT_FIXTURES-PACK-VERSION"] = raw;
    expect(getInputs().fixturesPackVersion).toBe(expected);
  });

  it("trims surrounding whitespace from fixtures-pack-version", () => {
    process.env["INPUT_FIXTURES-PACK-VERSION"] = "  v1.2.0  ";
    expect(getInputs().fixturesPackVersion).toBe("v1.2.0");
  });

  it.each([
    "latest",
    "main",
    "1.2",
    "v1",
    "1.2.3.4",
    "not-a-version",
    "v1.2.0 with spaces",
    "1.2.3; rm -rf /",
  ])("rejects fixture-pack-version %s and names the input", (raw) => {
    process.env["INPUT_FIXTURES-PACK-VERSION"] = raw;
    expect(() => getInputs()).toThrow(InvalidInputError);
    expect(() => getInputs()).toThrow(/"fixtures-pack-version"/);
  });

  it("rejects a fixture-pack-version that is only a v prefix", () => {
    process.env["INPUT_FIXTURES-PACK-VERSION"] = "v";
    expect(() => getInputs()).toThrow(InvalidInputError);
  });

  it.each([
    ["28", 28],
    ["1", 1],
    ["27", 27],
  ])("accepts fixtures-pack-protocol %s", (raw, expected) => {
    process.env["INPUT_FIXTURES-PACK-PROTOCOL"] = raw;
    expect(getInputs().fixturesPackProtocol).toBe(expected);
  });

  it("rejects fixtures-pack-protocol 0, as does the protocol input (#456)", () => {
    // `protocol` now rejects 0 too (the engine rejects `--protocol 0`), so no
    // working configuration changes. Pin that the two validators stay strict
    // and independent rather than silently unifying around a shared shape.
    process.env.INPUT_PROTOCOL = "0";
    expect(() => getInputs()).toThrow(InvalidInputError);
    expect(() => getInputs()).toThrow(/"protocol"/);

    delete process.env.INPUT_PROTOCOL;
    process.env["INPUT_FIXTURES-PACK-PROTOCOL"] = "0";
    expect(() => getInputs()).toThrow(InvalidInputError);
    expect(() => getInputs()).toThrow(/"fixtures-pack-protocol"/);
  });

  it.each(["-1", "28.5", "twenty-eight", "28 28", "1e3", "+28", "0x1c"])(
    "rejects fixtures-pack-protocol %s and names the input",
    (raw) => {
      process.env["INPUT_FIXTURES-PACK-PROTOCOL"] = raw;
      expect(() => getInputs()).toThrow(InvalidInputError);
      expect(() => getInputs()).toThrow(/"fixtures-pack-protocol"/);
    },
  );

  it("treats an empty fixtures-pack-protocol as unset rather than rejecting it", () => {
    process.env["INPUT_FIXTURES-PACK-PROTOCOL"] = "";
    expect(getInputs().fixturesPackProtocol).toBeUndefined();
  });

  it("rejects a fixtures-pack-protocol too large to be a safe integer", () => {
    // Digits-only passes the shape check, so this is the branch that catches a
    // value which would silently lose precision through parseInt.
    process.env["INPUT_FIXTURES-PACK-PROTOCOL"] = "9".repeat(30);
    expect(() => getInputs()).toThrow(InvalidInputError);
    expect(() => getInputs()).toThrow(/safe integer/);
  });

  it("reports the offending value in the error so the mistake is actionable", () => {
    process.env["INPUT_FIXTURES-PACK-PROTOCOL"] = "twenty-eight";
    // The message must quote what was actually received, not just what was
    // expected, or a user cannot tell which of several inputs is wrong.
    expect(() => getInputs()).toThrow(/"twenty-eight"/);
    expect(() => getInputs()).toThrow(/positive integer/);
  });

  it("logs a note when a pack input is set, so it is not a silent no-op", () => {
    // These inputs cannot be forwarded to Canary yet. A caller who sets one
    // must be told that the run did not use it, instead of reading a clean
    // run as "my pack is pinned".
    process.env["INPUT_FIXTURES-PACK-VERSION"] = "v1.2.0";
    getInputs();
    const note = infoMock.mock.calls
      .map((call) => String(call[0]))
      .find((message) => message.includes("fixtures-pack-version"));
    expect(note).toBeDefined();
    expect(note).toContain("not forwarded");
    expect(note).toContain("--fixtures-dir");
  });

  it("logs the note when only fixtures-pack-protocol is set", () => {
    process.env["INPUT_FIXTURES-PACK-PROTOCOL"] = "28";
    getInputs();
    const mentions = infoMock.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("fixtures-pack"));
    expect(mentions).toHaveLength(1);
  });

  it("stays silent when neither pack input is set", () => {
    getInputs();
    const mentions = infoMock.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("fixtures-pack"));
    expect(mentions).toHaveLength(0);
  });

  describe("github-token input and GITHUB_TOKEN precedence", () => {
    it("selects input token over GITHUB_TOKEN when both are provided", () => {
      process.env["INPUT_GITHUB-TOKEN"] = "token-from-input";
      process.env.GITHUB_TOKEN = "token-from-env";
      const inputs = getInputs();
      expect(inputs.githubToken).toBe("token-from-input");
      expect(setSecretMock).toHaveBeenCalledWith("token-from-input");
      expect(setSecretMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to GITHUB_TOKEN when github-token input is not set", () => {
      process.env.GITHUB_TOKEN = "token-from-env";
      const inputs = getInputs();
      expect(inputs.githubToken).toBe("token-from-env");
      expect(setSecretMock).toHaveBeenCalledWith("token-from-env");
      expect(setSecretMock).toHaveBeenCalledTimes(1);
    });

    it("treats whitespace-only github-token input as empty and falls back to GITHUB_TOKEN", () => {
      process.env["INPUT_GITHUB-TOKEN"] = "   \t  \n ";
      process.env.GITHUB_TOKEN = "token-from-env";
      const inputs = getInputs();
      expect(inputs.githubToken).toBe("token-from-env");
      expect(setSecretMock).toHaveBeenCalledWith("token-from-env");
      expect(setSecretMock).toHaveBeenCalledTimes(1);
    });

    it("treats whitespace-only GITHUB_TOKEN as empty when input is not set", () => {
      process.env.GITHUB_TOKEN = "   \t  \n ";
      const inputs = getInputs();
      expect(inputs.githubToken).toBeUndefined();
      expect(setSecretMock).not.toHaveBeenCalled();
    });

    it("calls core.setSecret once with selected token and registers tokens with special regex chars and newlines", () => {
      const specialToken = "token+with*special?chars^$()[]{}|\\";
      process.env["INPUT_GITHUB-TOKEN"] = `  ${specialToken}  `;
      const inputs = getInputs();
      expect(inputs.githubToken).toBe(specialToken);
      expect(setSecretMock).toHaveBeenCalledWith(specialToken);
      expect(setSecretMock).toHaveBeenCalledTimes(1);
    });

    it("results in undefined when both input and environment are unset", () => {
      const inputs = getInputs();
      expect(inputs.githubToken).toBeUndefined();
      expect(setSecretMock).not.toHaveBeenCalled();
    });
  });

  describe("report-retention-days", () => {
    it("parses valid report-retention-days integers", () => {
      process.env["INPUT_REPORT-RETENTION-DAYS"] = "7";
      expect(getInputs().reportRetentionDays).toBe(7);
    });

    it("accepts report-retention-days boundary values 1 and 90", () => {
      process.env["INPUT_REPORT-RETENTION-DAYS"] = "1";
      expect(getInputs().reportRetentionDays).toBe(1);

      process.env["INPUT_REPORT-RETENTION-DAYS"] = "90";
      expect(getInputs().reportRetentionDays).toBe(90);
    });

    it("trims surrounding whitespace", () => {
      process.env["INPUT_REPORT-RETENTION-DAYS"] = "  14  ";
      expect(getInputs().reportRetentionDays).toBe(14);
    });

    it("treats empty or whitespace-only input as undefined", () => {
      process.env["INPUT_REPORT-RETENTION-DAYS"] = "   ";
      expect(getInputs().reportRetentionDays).toBeUndefined();
    });

    it("rejects values outside 1 to 90 or non-integers, naming the input", () => {
      for (const invalid of ["0", "91", "1.5", "abc", "-5"]) {
        process.env["INPUT_REPORT-RETENTION-DAYS"] = invalid;
        expect(() => getInputs()).toThrowError(InvalidInputError);
        expect(() => getInputs()).toThrowError(
          `Invalid "report-retention-days" input: "${invalid}". Expected an integer from 1 to 90.`,
        );
      }
    });
  });

  describe("fixture, surface, and cache-dir inputs (#458)", () => {
    it("are all unset when omitted", () => {
      const inputs = getInputs();
      expect(inputs.fixture).toBeUndefined();
      expect(inputs.surface).toBeUndefined();
      expect(inputs.cacheDir).toBeUndefined();
    });

    it("treats empty and whitespace-only values as unset rather than rejecting them", () => {
      process.env.INPUT_FIXTURE = "   ";
      process.env.INPUT_SURFACE = "";
      process.env["INPUT_CACHE-DIR"] = "\t\n";
      const inputs = getInputs();
      expect(inputs.fixture).toBeUndefined();
      expect(inputs.surface).toBeUndefined();
      expect(inputs.cacheDir).toBeUndefined();
    });

    it("parses valid values, trimming surrounding whitespace", () => {
      process.env.INPUT_FIXTURE = "  p28-xdr-cap83-empty-tx-set  ";
      process.env.INPUT_SURFACE = " rpc ";
      process.env["INPUT_CACHE-DIR"] = " .canary-cache ";
      const inputs = getInputs();
      expect(inputs.fixture).toBe("p28-xdr-cap83-empty-tx-set");
      expect(inputs.surface).toBe("rpc");
      expect(inputs.cacheDir).toBe(".canary-cache");
    });

    it("accepts each engine surface name and nothing else", () => {
      for (const surface of ["xdr", "rpc", "soroban"]) {
        process.env.INPUT_SURFACE = surface;
        expect(getInputs().surface).toBe(surface);
      }
    });

    it.each(["XDR", "Rpc", "xdr rpc", "all", "soroban-rpc"])(
      "rejects surface %j with an error naming the accepted values",
      (value) => {
        process.env.INPUT_SURFACE = value;
        expect(() => getInputs()).toThrow(InvalidInputError);
        expect(() => getInputs()).toThrow(/"surface"/);
        expect(() => getInputs()).toThrow(/xdr.*rpc.*soroban/);
      },
    );

    it.each([
      ["newline", "a\nb"],
      ["tab", "a\tb"],
      ["DEL", "a\u007fb"],
      ["C1", "a\u0085b"],
    ])("rejects a %s control character in fixture", (_label, value) => {
      process.env.INPUT_FIXTURE = value;
      expect(() => getInputs()).toThrow(InvalidInputError);
      expect(() => getInputs()).toThrow(/"fixture"/);
      expect(() => getInputs()).toThrow(/[Cc]ontrol characters/);
    });

    it.each([
      ["newline", "a\nb"],
      ["DEL", "a\u007fb"],
      ["C1", "a\u0085b"],
    ])("rejects a %s control character in cache-dir", (_label, value) => {
      process.env["INPUT_CACHE-DIR"] = value;
      expect(() => getInputs()).toThrow(InvalidInputError);
      expect(() => getInputs()).toThrow(/"cache-dir"/);
    });

    // NUL cannot be carried through process.env (the platform rejects the
    // byte), so the NUL case of the shared validator is exercised directly.
    it.each([["fixture"], ["cache-dir"]])("rejects a NUL control character in %s", (inputName) => {
      expect(() => parseScopedFilter("a\u0000b", inputName)).toThrow(InvalidInputError);
      expect(() => parseScopedFilter("a\u0000b", inputName)).toThrow(new RegExp(`"${inputName}"`));
      expect(() => parseScopedFilter("a\u0000b", inputName)).toThrow(/[Cc]ontrol characters/);
    });

    it("accepts ids and paths containing spaces, dots, slashes, and a leading dash", () => {
      process.env.INPUT_FIXTURE = "-weird id.v1/x";
      process.env["INPUT_CACHE-DIR"] = "-cache dir/./nested";
      const inputs = getInputs();
      expect(inputs.fixture).toBe("-weird id.v1/x");
      expect(inputs.cacheDir).toBe("-cache dir/./nested");
    });
  });

  describe("junit-report input (#423)", () => {
    it("defaults to false", () => {
      expect(getInputs().junitReport).toBe(false);
    });

    it.each([["true"], ["True"], ["TRUE"]])("parses %j as enabled", (value) => {
      process.env["INPUT_JUNIT-REPORT"] = value;
      expect(getInputs().junitReport).toBe(true);
    });

    it.each([["false"], ["False"], [""]])("parses %j as disabled", (value) => {
      process.env["INPUT_JUNIT-REPORT"] = value;
      expect(getInputs().junitReport).toBe(false);
    });

    it("rejects an undocumented boolean form by name", () => {
      process.env["INPUT_JUNIT-REPORT"] = "yes";
      expect(() => getInputs()).toThrow(InvalidInputError);
      expect(() => getInputs()).toThrow(/"junit-report"/);
    });
  });
});

/**
 * Issue #400: `fixtures-dir` is validated against the filesystem before the
 * engine version is resolved or installed. The helper resolves the input
 * against the working directory, distinguishes a missing path from one that
 * is not a directory, treats a dangling symlink as a missing path (statSync
 * follows links), and preserves the `allow-empty` exception for a missing
 * directory via a `core.warning` — while never creating the directory.
 */
describe("validateFixturesDir (#400)", () => {
  let root: string;

  beforeEach(() => {
    clearInputs();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "canary-fixtures-dir-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    clearInputs();
  });

  it("accepts an existing directory and returns the resolved absolute path", () => {
    const dir = path.join(root, "fixtures");
    fs.mkdirSync(dir);

    const resolved = validateFixturesDir(dir, false);

    expect(resolved).toBe(path.resolve(dir));
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(warningMock).not.toHaveBeenCalled();
  });

  it("rejects a missing directory, naming the input, the resolved absolute path, and the reason", () => {
    const missing = path.join(root, "no-such-fixtures");

    expect(() => validateFixturesDir(missing, false)).toThrow(InvalidInputError);
    expect(() => validateFixturesDir(missing, false)).toThrow(/"fixtures-dir"/);
    expect(() => validateFixturesDir(missing, false)).toThrow(path.resolve(missing));
    expect(() => validateFixturesDir(missing, false)).toThrow(/does not exist/);
  });

  it("rejects a nonexistent absolute path the same way", () => {
    const missing = path.join(path.resolve(path.parse(root).root), "canary-absent", "fixtures");
    expect(fs.existsSync(missing)).toBe(false);

    expect(() => validateFixturesDir(missing, false)).toThrow(InvalidInputError);
    expect(() => validateFixturesDir(missing, false)).toThrow(path.resolve(missing));
  });

  it("rejects a resolved path that is a regular file with a distinct not-a-directory message", () => {
    const file = path.join(root, "fixtures.toml");
    fs.writeFileSync(file, "[tests]\n", "utf8");

    expect(() => validateFixturesDir(file, false)).toThrow(InvalidInputError);
    expect(() => validateFixturesDir(file, false)).toThrow(/is not a directory/);
    expect(() => validateFixturesDir(file, false)).toThrow(/"fixtures-dir"/);
    expect(() => validateFixturesDir(file, false)).toThrow(path.resolve(file));

    // allow-empty excuses an empty fixture set, not a mistyped path: a
    // regular file is rejected even when the run may load no fixtures.
    expect(() => validateFixturesDir(file, true)).toThrow(/is not a directory/);
    expect(warningMock).not.toHaveBeenCalled();
  });

  // Symlink creation needs elevated privileges or Developer Mode on Windows,
  // so the capability is probed once (with the same dangling shape the test
  // uses) and the test is skipped where creation is impossible — it must
  // never fail the suite on a platform that merely cannot make symlinks.
  describe("dangling symlink", () => {
    const supported = (() => {
      const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "canary-symlink-probe-"));
      try {
        fs.symlinkSync(path.join(probeRoot, "absent-target"), path.join(probeRoot, "link"));
        return true;
      } catch {
        return false;
      } finally {
        fs.rmSync(probeRoot, { recursive: true, force: true });
      }
    })();

    it.skipIf(!supported)("follows the documented missing-path behavior", () => {
      const link = path.join(root, "dangling");
      fs.symlinkSync(path.join(root, "absent-target"), link);
      expect(fs.existsSync(link)).toBe(false);

      // statSync follows the link to a target that does not exist, so the
      // result is exactly the missing-path behavior above...
      expect(() => validateFixturesDir(link, false)).toThrow(InvalidInputError);
      expect(() => validateFixturesDir(link, false)).toThrow(/does not exist/);
      expect(() => validateFixturesDir(link, false)).toThrow(path.resolve(link));

      // ...including the allow-empty warning branch.
      expect(validateFixturesDir(link, true)).toBe(path.resolve(link));
      expect(warningMock).toHaveBeenCalledTimes(1);
      const warning = String(warningMock.mock.calls[0]?.[0]);
      expect(warning).toContain('"fixtures-dir"');
      expect(warning).toContain(path.resolve(link));
    });
  });

  it("resolves a relative path against the current working directory", () => {
    const dir = path.join(root, "relative-fixtures");
    fs.mkdirSync(dir);
    // Deliberately relative: this is what distinguishes the resolved value
    // from the raw input. GitHub-hosted Windows runners can check the
    // repository out on a different drive from the system temp directory;
    // then path.relative returns an absolute path and this stops exercising
    // a relative input, so the assertion below is written in terms of
    // path.resolve rather than the raw string.
    const relative = path.relative(process.cwd(), dir);

    expect(validateFixturesDir(relative, false)).toBe(path.resolve(relative));
  });

  it("normalizes `..` segments and validates the normalized destination", () => {
    const dir = path.join(root, "fx");
    fs.mkdirSync(dir);

    // An existing directory reached through `..` is accepted, and the
    // returned path is the normalized one.
    const viaParent = `${dir}${path.sep}..${path.sep}fx`;
    expect(validateFixturesDir(viaParent, false)).toBe(path.resolve(dir));

    // A missing destination is rejected at its normalized path — the
    // lexically-passed string with `..` in it never reaches the message.
    const missingViaParent = `${dir}${path.sep}..${path.sep}missing`;
    expect(() => validateFixturesDir(missingViaParent, false)).toThrow(
      path.join(root, "missing"),
    );
    expect(() => validateFixturesDir(missingViaParent, false)).not.toThrow(
      `${path.sep}fx${path.sep}..${path.sep}missing`,
    );
  });

  it("warns and continues for a missing directory when allow-empty is true", () => {
    const missing = path.join(root, "missing-pack");

    expect(validateFixturesDir(missing, true)).toBe(path.resolve(missing));

    expect(warningMock).toHaveBeenCalledTimes(1);
    const warning = String(warningMock.mock.calls[0]?.[0]);
    expect(warning).toContain('"fixtures-dir"');
    expect(warning).toContain(path.resolve(missing));
    // The directory is never created behind the user's back.
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("emits no warning for an existing directory even when allow-empty is true", () => {
    const dir = path.join(root, "fixtures");
    fs.mkdirSync(dir);

    expect(validateFixturesDir(dir, true)).toBe(path.resolve(dir));
    expect(warningMock).not.toHaveBeenCalled();
  });
});
    // Masking tests for credential-bearing RPC URLs
    it("masks username and password from userinfo", () => {
      process.env["INPUT_RPC-URL"] = "https://alice:password123@example.com/soroban/rpc";
      getInputs();
      expect(setSecretMock).toHaveBeenCalledWith("alice");
      expect(setSecretMock).toHaveBeenCalledWith("password123");
      expect(setSecretMock).toHaveBeenCalledWith("https://alice:password123@example.com/soroban/rpc");
    });

    it("masks query parameter values", () => {
      process.env["INPUT_RPC-URL"] = "https://example.com/soroban/rpc?apikey=secret123&token=abc";
      getInputs();
      expect(setSecretMock).toHaveBeenCalledWith("secret123");
      expect(setSecretMock).toHaveBeenCalledWith("abc");
      expect(setSecretMock).toHaveBeenCalledWith("https://example.com/soroban/rpc?apikey=secret123&token=abc");
    });

    it("masks URL fragment", () => {
      process.env["INPUT_RPC-URL"] = "https://example.com/soroban/rpc#fragment";
      getInputs();
      expect(setSecretMock).toHaveBeenCalledWith("fragment");
      expect(setSecretMock).toHaveBeenCalledWith("https://example.com/soroban/rpc#fragment");
    });

    it("does not mask plain URL without sensitive components", () => {
      process.env["INPUT_RPC-URL"] = "https://example.com/soroban/rpc";
      getInputs();
      expect(setSecretMock).not.toHaveBeenCalled();
    });

    it("does not mask empty username", () => {
      process.env["INPUT_RPC-URL"] = "https://@example.com/soroban/rpc";
      getInputs();
      expect(setSecretMock).not.toHaveBeenCalled();
    });

    it("masks password from userinfo even when username is empty", () => {
      process.env["INPUT_RPC-URL"] = "https://:password@example.com/soroban/rpc";
      getInputs();
      expect(setSecretMock).toHaveBeenCalledWith("password"); expect(setSecretMock).toHaveBeenCalledWith("https://:password@example.com/soroban/rpc");
    });

    it("handles repeated query parameters", () => {
      process.env["INPUT_RPC-URL"] = "https://example.com/soroban/rpc?key=val1&key=val2";
      getInputs();
      expect(setSecretMock).toHaveBeenCalledWith("val1");
      expect(setSecretMock).toHaveBeenCalledWith("val2");
    });

    it("does not mask empty query parameter values", () => {
      process.env["INPUT_RPC-URL"] = "https://example.com/soroban/rpc?key=";
      getInputs();
      expect(setSecretMock).not.toHaveBeenCalled();
    });

    it("handles percent-encoded values", () => {
      process.env["INPUT_RPC-URL"] = "https://example.com/soroban/rpc?key=%24secre7";
      getInputs();
      expect(setSecretMock).toHaveBeenCalledWith("$secre7");
    });

    it("handles plain http localhost URL without masking", () => {
      process.env["INPUT_RPC-URL"] = "http://localhost:8000/soroban/rpc";
      getInputs();
      expect(setSecretMock).not.toHaveBeenCalled();
    });

    it("rejects invalid URL still throws error", () => {
      process.env["INPUT_RPC-URL"] = "not a url";
      expect(() => getInputs()).toThrow(InvalidInputError);
    });

describe("rejected rpc-url values never echo credentials (#510)", () => {
  beforeEach(clearInputs);
  afterEach(clearInputs);

  /** The message getInputs() throws for this rpc-url value. Secrets are built
   * from fragments inside each test so no literal credential-looking string
   * appears in a log if an assertion fails. */
  function rejectionMessage(rpcUrl: string): string {
    process.env["INPUT_RPC-URL"] = rpcUrl;
    try {
      getInputs();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidInputError);
      return (error as Error).message;
    }
    throw new Error("expected getInputs() to reject this rpc-url");
  }

  it("redacts userinfo and query credentials of a rejected http:// URL but keeps the host and the https rule", () => {
    const userSecret = ["KEY", "SECRET", "123"].join("");
    const querySecret = ["SECRET", "456"].join("");
    const message = rejectionMessage(`http://user:${userSecret}@rpc.example.org/v1?api_key=${querySecret}`);

    expect(message).not.toContain(userSecret);
    expect(message).not.toContain(querySecret);
    expect(message).not.toContain("user:");
    expect(message).not.toContain("api_key");
    expect(message).toContain("rpc.example.org");
    expect(message).toContain("/v1");
    expect(message).toContain("[REDACTED]");
    expect(message).toContain("Must be an https:// URL (plain http:// is only accepted for localhost/127.0.0.1).");
  });

  it("keeps the exact message shape for a rejected URL that carries no credentials", () => {
    expect(rejectionMessage("http://example.com/rpc")).toBe(
      'Invalid "rpc-url" input: http://example.com/rpc. Must be an https:// URL ' +
        "(plain http:// is only accepted for localhost/127.0.0.1).",
    );
  });

  it("redacts userinfo, query and fragment of a rejected non-http scheme", () => {
    const message = rejectionMessage("ftp://user:pw@example.org/x?token=abc#frag");

    for (const secret of ["pw", "abc", "frag", "token", "user"]) {
      expect(message).not.toContain(secret);
    }
    expect(message).toContain("example.org");
    expect(message).toContain("/x");
  });

  it("redacts a fragment on its own", () => {
    const fragment = ["frag", "secret"].join("-");
    const message = rejectionMessage(`ftp://example.org/x#${fragment}`);

    expect(message).not.toContain(fragment);
    expect(message).toContain("example.org");
  });

  it("keeps a non-default port visible", () => {
    const message = rejectionMessage("http://user:pw@rpc.example.org:8545/v1");

    expect(message).toContain("rpc.example.org:8545");
    expect(message).not.toContain("pw");
  });

  it("masks a GitHub token that sits in the path of a rejected URL", () => {
    const token = `ghp_${"a1B2".repeat(9)}`;
    const message = rejectionMessage(`http://rpc.example.org/${token}/v1`);

    expect(message).not.toContain(token);
    expect(message).toContain("rpc.example.org");
    expect(message).toContain("[REDACTED]");
  });

  it("describes a URL without an authority as having no host, without echoing its scheme or remainder", () => {
    const secret = ["mail", "secret"].join("-");
    const message = rejectionMessage(`mailto:${secret}@example.org?subject=${secret}`);

    expect(message).not.toContain(secret);
    expect(message).not.toContain("example.org");
    expect(message).not.toContain("mailto");
    expect(message).toContain("a URL with no host");
    expect(message).toContain("Must be an https:// URL");
  });

  it("does not echo any part of an unparseable value with whitespace in the host", () => {
    const secret = ["SECRET"].join("");
    const message = rejectionMessage(`https://user:KEY@exa mple.org/?key=${secret}`);

    for (const fragment of ["user", "KEY", secret, "exa", "mple", "key="]) {
      expect(message).not.toContain(fragment);
    }
    expect(message).toContain("contains whitespace");
    expect(message).toContain("Expected a valid URL.");
  });

  it("does not echo an unparseable value that is not a URL at all", () => {
    const message = rejectionMessage("not a url KEY");

    expect(message).not.toContain("not a url");
    expect(message).not.toContain("KEY");
    expect(message).toContain("13 characters");
    expect(message).toContain("contains whitespace");
  });

  it("does not echo the leading part of a value that merely parses as an opaque scheme", () => {
    const message = rejectionMessage("tok3n:rest:KEY");

    for (const fragment of ["tok3n", "rest", "KEY"]) {
      expect(message).not.toContain(fragment);
    }
    expect(message).toContain("a URL with no host");
  });

  it("reports only the length for an unparseable value without whitespace", () => {
    const message = rejectionMessage("//KEY-only");

    expect(message).not.toContain("KEY");
    expect(message).toContain("10 characters");
    expect(message).not.toContain("contains whitespace");
  });

  it("writes nothing that contains the original value to the log while rejecting", () => {
    const secret = ["LOG", "SECRET", "789"].join("");
    rejectionMessage(`http://user:${secret}@rpc.example.org/v1?api_key=${secret}`);

    for (const mock of [infoMock, warningMock, setSecretMock]) {
      expect(JSON.stringify(mock.mock.calls)).not.toContain(secret);
    }
  });

  it("leaves accepted values untouched: https with a query string, localhost and loopback http", () => {
    process.env["INPUT_RPC-URL"] = "https://rpc.example.org/v1?api_key=kept-as-is";
    expect(getInputs().rpcUrl).toBe("https://rpc.example.org/v1?api_key=kept-as-is");

    process.env["INPUT_RPC-URL"] = "http://localhost:8000/soroban/rpc";
    expect(getInputs().rpcUrl).toBe("http://localhost:8000/soroban/rpc");

    process.env["INPUT_RPC-URL"] = "http://127.0.0.1:8000/soroban/rpc";
    expect(getInputs().rpcUrl).toBe("http://127.0.0.1:8000/soroban/rpc");
  });

  it("treats an empty or whitespace-only rpc-url as unset", () => {
    process.env["INPUT_RPC-URL"] = "   ";
    expect(getInputs().rpcUrl).toBeUndefined();
  });
});
