import type * as actionsCore from "@actions/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above the imports, so the spy must be too. Only `info` is
// replaced: the whole suite reads inputs through the real `core.getInput`, and
// CONTRIBUTING's partial-mock convention requires spreading the real module so
// everything else keeps working. `vi.spyOn` cannot be used here because an ESM
// namespace object is not configurable.
const { infoMock, setSecretMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
  setSecretMock: vi.fn(),
}));

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof actionsCore>();
  return { ...actual, info: infoMock, setSecret: setSecretMock };
});

import { ConfigNotFoundError, InvalidInputError } from "../../src/errors";
import { getInputs } from "../../src/inputs";

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
  "INPUT_RPC-TIMEOUT-SECONDS",
  "INPUT_MAX-CONCURRENCY",
  "INPUT_NO-CACHE",
  "INPUT_LIVE-CACHE-TTL-SECONDS",
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
      rpcTimeoutSeconds: undefined,
      maxConcurrency: undefined,
      noCache: undefined,
      liveCacheTtlSeconds: undefined,
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

  it("accepts protocol '0' as a valid non-negative integer", () => {
    process.env.INPUT_PROTOCOL = "0";
    expect(getInputs().protocol).toBe(0);
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

  it("truncates a fractional timeout to an integer", () => {
    process.env["INPUT_TIMEOUT-MINUTES"] = "15.9";
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

  /**
   * #413: the engine check options `allow-empty` already paved the way for —
   * `rpc-timeout-seconds`, `max-concurrency`, `no-cache` and
   * `live-cache-ttl-seconds`. Omitted means "engine default", so every one
   * parses to `undefined` when unset; when set, validation is strict (digits
   * only, bounded) and every failure names the offending input.
   */
  describe("engine check option inputs (#413)", () => {
    it("leaves all four inputs undefined when unset", () => {
      const inputs = getInputs();
      expect(inputs.rpcTimeoutSeconds).toBeUndefined();
      expect(inputs.maxConcurrency).toBeUndefined();
      expect(inputs.noCache).toBeUndefined();
      expect(inputs.liveCacheTtlSeconds).toBeUndefined();
    });

    it("treats empty and whitespace-only values as unset", () => {
      process.env["INPUT_RPC-TIMEOUT-SECONDS"] = "   ";
      process.env["INPUT_MAX-CONCURRENCY"] = "";
      process.env["INPUT_NO-CACHE"] = "";
      process.env["INPUT_LIVE-CACHE-TTL-SECONDS"] = " \t ";
      const inputs = getInputs();
      expect(inputs.rpcTimeoutSeconds).toBeUndefined();
      expect(inputs.maxConcurrency).toBeUndefined();
      expect(inputs.noCache).toBeUndefined();
      expect(inputs.liveCacheTtlSeconds).toBeUndefined();
    });

    it.each([
      ["INPUT_RPC-TIMEOUT-SECONDS", "30", "rpcTimeoutSeconds", 30],
      ["INPUT_RPC-TIMEOUT-SECONDS", "1", "rpcTimeoutSeconds", 1],
      ["INPUT_RPC-TIMEOUT-SECONDS", "600", "rpcTimeoutSeconds", 600],
      ["INPUT_MAX-CONCURRENCY", "8", "maxConcurrency", 8],
      ["INPUT_MAX-CONCURRENCY", "1", "maxConcurrency", 1],
      ["INPUT_MAX-CONCURRENCY", "64", "maxConcurrency", 64],
      ["INPUT_LIVE-CACHE-TTL-SECONDS", "600", "liveCacheTtlSeconds", 600],
      ["INPUT_LIVE-CACHE-TTL-SECONDS", "1", "liveCacheTtlSeconds", 1],
      ["INPUT_LIVE-CACHE-TTL-SECONDS", "604800", "liveCacheTtlSeconds", 604800],
    ])("parses %s=%s as %s", (envKey, raw, field, expected) => {
      process.env[envKey] = raw;
      expect(getInputs()[field as keyof ReturnType<typeof getInputs>]).toBe(expected);
    });

    it.each([
      ["INPUT_NO-CACHE", "true", true],
      ["INPUT_NO-CACHE", "True", true],
      ["INPUT_NO-CACHE", "TRUE", true],
      ["INPUT_NO-CACHE", "false", false],
      ["INPUT_NO-CACHE", "False", false],
      ["INPUT_NO-CACHE", "FALSE", false],
    ])("parses no-cache %s=%s as %s", (envKey, raw, expected) => {
      process.env[envKey] = raw;
      expect(getInputs().noCache).toBe(expected);
    });

    it("rejects an undocumented no-cache form and names the input", () => {
      process.env["INPUT_NO-CACHE"] = "1";
      expect(() => getInputs()).toThrow(InvalidInputError);
      expect(() => getInputs()).toThrow(/"no-cache"/);
    });

    // Strict parsing: these must fail in validation with a message naming the
    // input — never be truncated by parseInt leniency ("12abc" → 12,
    // "12.5" → 12) and forwarded to the engine as something else.
    it.each([
      ["rpc-timeout-seconds", "INPUT_RPC-TIMEOUT-SECONDS", "0"],
      ["rpc-timeout-seconds", "INPUT_RPC-TIMEOUT-SECONDS", "-1"],
      ["rpc-timeout-seconds", "INPUT_RPC-TIMEOUT-SECONDS", "abc"],
      ["rpc-timeout-seconds", "INPUT_RPC-TIMEOUT-SECONDS", "12abc"],
      ["rpc-timeout-seconds", "INPUT_RPC-TIMEOUT-SECONDS", "12.5"],
      ["rpc-timeout-seconds", "INPUT_RPC-TIMEOUT-SECONDS", "+30"],
      ["rpc-timeout-seconds", "INPUT_RPC-TIMEOUT-SECONDS", "601"],
      ["rpc-timeout-seconds", "INPUT_RPC-TIMEOUT-SECONDS", "999999999999999999999999"],
      ["max-concurrency", "INPUT_MAX-CONCURRENCY", "0"],
      ["max-concurrency", "INPUT_MAX-CONCURRENCY", "-1"],
      ["max-concurrency", "INPUT_MAX-CONCURRENCY", "abc"],
      ["max-concurrency", "INPUT_MAX-CONCURRENCY", "12abc"],
      ["max-concurrency", "INPUT_MAX-CONCURRENCY", "4.5"],
      ["max-concurrency", "INPUT_MAX-CONCURRENCY", "65"],
      ["max-concurrency", "INPUT_MAX-CONCURRENCY", "999999999999999999999999"],
      ["live-cache-ttl-seconds", "INPUT_LIVE-CACHE-TTL-SECONDS", "0"],
      ["live-cache-ttl-seconds", "INPUT_LIVE-CACHE-TTL-SECONDS", "-1"],
      ["live-cache-ttl-seconds", "INPUT_LIVE-CACHE-TTL-SECONDS", "abc"],
      ["live-cache-ttl-seconds", "INPUT_LIVE-CACHE-TTL-SECONDS", "12abc"],
      ["live-cache-ttl-seconds", "INPUT_LIVE-CACHE-TTL-SECONDS", "60.5"],
      ["live-cache-ttl-seconds", "INPUT_LIVE-CACHE-TTL-SECONDS", "604801"],
      ["live-cache-ttl-seconds", "INPUT_LIVE-CACHE-TTL-SECONDS", "999999999999999999999999"],
    ])("rejects %s=%s and names the input", (input, envKey, raw) => {
      process.env[envKey] = raw;
      expect(() => getInputs()).toThrow(InvalidInputError);
      expect(() => getInputs()).toThrow(new RegExp(`"${input}"`));
      // The message quotes the offending value so the mistake is actionable.
      expect(() => getInputs()).toThrow(new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });

    // The engine declares `--no-cache` and `--live-cache-ttl` as conflicting
    // (`conflicts_with` in CheckArgs), so the combination must die here —
    // where the message can name both inputs — instead of at the CLI.
    it("rejects no-cache: true together with live-cache-ttl-seconds and explains the conflict", () => {
      process.env["INPUT_NO-CACHE"] = "true";
      process.env["INPUT_LIVE-CACHE-TTL-SECONDS"] = "600";
      expect(() => getInputs()).toThrow(InvalidInputError);
      expect(() => getInputs()).toThrow(/"no-cache"/);
      expect(() => getInputs()).toThrow(/"live-cache-ttl-seconds"/);
      expect(() => getInputs()).toThrow(/conflicts with/);
      expect(() => getInputs()).toThrow(/--no-cache/);
      expect(() => getInputs()).toThrow(/--live-cache-ttl/);
    });

    it("accepts no-cache: false together with live-cache-ttl-seconds", () => {
      // `false` is the engine-default cache behavior; a TTL alongside it is
      // not a conflict — only `no-cache: true` disables the cache the TTL
      // would configure.
      process.env["INPUT_NO-CACHE"] = "false";
      process.env["INPUT_LIVE-CACHE-TTL-SECONDS"] = "600";
      const inputs = getInputs();
      expect(inputs.noCache).toBe(false);
      expect(inputs.liveCacheTtlSeconds).toBe(600);
    });

    it("accepts live-cache-ttl-seconds without no-cache", () => {
      process.env["INPUT_LIVE-CACHE-TTL-SECONDS"] = "600";
      const inputs = getInputs();
      expect(inputs.liveCacheTtlSeconds).toBe(600);
      expect(inputs.noCache).toBeUndefined();
    });
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

  it("rejects fixtures-pack-protocol 0, unlike the protocol input", () => {
    // The two inputs differ deliberately: `protocol` accepts 0 because a
    // non-negative integer is the right shape there, while a pack "pinned to
    // protocol 0" is not something anyone publishes. Pin that difference so a
    // future refactor cannot silently unify the two validators.
    process.env.INPUT_PROTOCOL = "0";
    expect(getInputs().protocol).toBe(0);

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
