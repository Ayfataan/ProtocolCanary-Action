import type * as actionsCore from "@actions/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above the imports, so the spy must be too. Only `info`,
// `warning`, and `setSecret` are replaced: the whole suite reads inputs
// through the real `core.getInput`, and CONTRIBUTING's partial-mock
// convention requires spreading the real module so everything else keeps
// working. `vi.spyOn` cannot be used here because an ESM namespace object is
// not configurable. `warning` is mocked for `validateFixturesDir`'s
// allow-empty path (#400).
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
import { getInputs, validateFixturesDir } from "../../src/inputs";

const INPUT_KEYS = [
  "INPUT_PROTOCOL",
  "INPUT_CONFIG",
  "INPUT_NETWORK",
  "INPUT_RPC-URL",
  "INPUT_FIXTURES-DIR",
  "INPUT_VERSION",
  "INPUT_UPLOAD-REPORT",
  "INPUT_ANNOTATIONS",
  "INPUT_TIMEOUT-MINUTES",
  "INPUT_ALLOW-EMPTY",
  "INPUT_FIXTURES-PACK-VERSION",
  "INPUT_FIXTURES-PACK-PROTOCOL",
  "INPUT_GITHUB-TOKEN",
  "INPUT_GITHUB_TOKEN",
  "INPUT_GENERATE-RECEIPT",
];

function clearInputs(): void {
  for (const key of INPUT_KEYS) {
    delete process.env[key];
  }
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
      network: undefined,
      rpcUrl: undefined,
      fixturesDir: "fixtures",
      version: "0.1.1",
      uploadReport: true,
      annotations: true,
      timeoutMinutes: 15,
      allowEmpty: false,
      fixturesPackVersion: undefined,
      fixturesPackProtocol: undefined,
      githubToken: undefined,
      generateReceipt: false,
      strictIntegrity: false,
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
