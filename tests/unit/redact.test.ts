import { afterEach, describe, expect, it } from "vitest";

import { REDACTED, escapeWorkflowCommands, redact, redactSecrets } from "../../src/redact";

/**
 * Synthetic secret vectors. They are assembled at runtime rather than written
 * as literals so a secret scanner does not flag the test file, and so the
 * tests exercise the exact prefix/shape rules rather than a checked-in value.
 * None of these are (or ever were) real credentials.
 */
const GITHUB_PAT = `ghp_${"a".repeat(36)}`;
const GITHUB_FINE_GRAINED_PAT = `github_pat_${"b".repeat(24)}`;
const STELLAR_SEED = `S${"A".repeat(55)}`;
const STELLAR_ADDRESS = `G${"A".repeat(55)}`;
const STELLAR_CONTRACT_ID = `C${"A".repeat(55)}`;

const ENV_NAME = "PROTOCOLCANARY_TEST_SECRET";
const ENV_VALUE = "synthetic-secret-value";

afterEach(() => {
  delete process.env[ENV_NAME];
});

describe("redactSecrets", () => {
  it("redacts a GitHub personal access token and keeps the surrounding text", () => {
    expect(redactSecrets(`using token ${GITHUB_PAT} for the lookup`)).toBe(
      `using token ${REDACTED} for the lookup`,
    );
  });

  it("redacts a fine-grained GitHub token", () => {
    expect(redactSecrets(`Authorization: Bearer ${GITHUB_FINE_GRAINED_PAT}`)).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it("redacts every occurrence, not just the first", () => {
    const input = `${GITHUB_PAT} appears twice: ${GITHUB_PAT}`;
    expect(redactSecrets(input)).toBe(`${REDACTED} appears twice: ${REDACTED}`);
  });

  it("redacts a Stellar secret seed", () => {
    expect(redactSecrets(`seed=${STELLAR_SEED}`)).toBe(`seed=${REDACTED}`);
  });

  it("preserves Stellar public addresses (G...) and contract IDs (C...)", () => {
    // The seed pattern must not be broadened to every 56-character StrKey:
    // public addresses and contract IDs are routinely logged and are not
    // secrets.
    const input = `address ${STELLAR_ADDRESS} contract ${STELLAR_CONTRACT_ID}`;
    expect(redactSecrets(input)).toBe(input);
  });

  it("redacts URL userinfo and the query string while keeping scheme, host and path", () => {
    expect(redactSecrets("rpc=https://user:supersecret@example.com/rpc?token=abc123&network=testnet")).toBe(
      `rpc=https://${REDACTED}@example.com/rpc?${REDACTED}`,
    );
  });

  it("redacts a URL fragment as well as a query string", () => {
    expect(redactSecrets("see https://example.com/path#access_token=abc123")).toBe(
      `see https://example.com/path?${REDACTED}`,
    );
  });

  it("leaves a URL without credentials or a query string intact", () => {
    expect(redactSecrets("GET https://soroban-testnet.stellar.org/rpc ok")).toBe(
      "GET https://soroban-testnet.stellar.org/rpc ok",
    );
  });

  it("leaves URL-like strings without a scheme (no ://) or with unsupported schemes intact", () => {
    expect(redactSecrets("connect to localhost:8000/api?token=secret")).toBe(
      "connect to localhost:8000/api?token=secret",
    );
    expect(redactSecrets("ftp://user:pass@example.com/files")).toBe(
      "ftp://user:pass@example.com/files",
    );
    expect(redactSecrets("visit http:example.com/path")).toBe(
      "visit http:example.com/path",
    );
  });

  it("redacts the value of a sensitive environment variable", () => {
    process.env[ENV_NAME] = ENV_VALUE;
    expect(redactSecrets(`debug: ${ENV_VALUE}`)).toBe(`debug: ${REDACTED}`);
  });

  it("skips sensitive environment variables with values shorter than the minimum length or equal to REDACTED", () => {
    process.env[ENV_NAME] = "tiny";
    expect(redactSecrets("log line with tiny secret")).toBe("log line with tiny secret");

    process.env[ENV_NAME] = REDACTED;
    expect(redactSecrets(`log line with ${REDACTED}`)).toBe(`log line with ${REDACTED}`);
  });

  it("masks both trimmed and untrimmed forms of a sensitive environment value with surrounding whitespace", () => {
    process.env[ENV_NAME] = "  surrounded_secret_value  ";
    expect(redactSecrets("log with surrounded_secret_value inside")).toBe(`log with ${REDACTED} inside`);
    expect(redactSecrets("log with   surrounded_secret_value   inside")).toBe(`log with   ${REDACTED}   inside`);
  });

  it("does not redact values of environment variables whose names are not sensitive", () => {
    process.env.PROTOCOLCANARY_TEST_HARMLESS = "a-harmless-log-value";
    try {
      expect(redactSecrets("a-harmless-log-value")).toBe("a-harmless-log-value");
    } finally {
      delete process.env.PROTOCOLCANARY_TEST_HARMLESS;
    }
  });

  it("never includes the process environment in the output", () => {
    process.env[ENV_NAME] = ENV_VALUE;
    const output = redactSecrets(`only this line ${ENV_VALUE}`);
    expect(output).not.toContain(ENV_VALUE);
    expect(output).toBe(`only this line ${REDACTED}`);
  });
});

describe("escapeWorkflowCommands", () => {
  it("neutralises workflow-command sequences", () => {
    const escaped = escapeWorkflowCommands("::error::compatibility failed");
    expect(escaped).not.toContain("::");
    expect(escaped).toBe("\\:\\:error\\:\\:compatibility failed");
  });

  it("escapes backticks so a log tail cannot escape a Markdown code fence", () => {
    expect(escapeWorkflowCommands("```sh\nboom\n```")).toBe("\\`\\`\\`sh\nboom\n\\`\\`\\`");
  });
});

describe("redact", () => {
  it("applies secret redaction and workflow-command escaping together", () => {
    process.env[ENV_NAME] = ENV_VALUE;
    const output = redact(`::warning::token ${GITHUB_PAT} seed ${STELLAR_SEED} env ${ENV_VALUE}`);

    expect(output).not.toContain(GITHUB_PAT);
    expect(output).not.toContain(STELLAR_SEED);
    expect(output).not.toContain(ENV_VALUE);
    expect(output).not.toContain("::");
    expect(output).toBe(`\\:\\:warning\\:\\:token ${REDACTED} seed ${REDACTED} env ${REDACTED}`);
  });

  it("is deterministic and safe to run twice", () => {
    process.env[ENV_NAME] = ENV_VALUE;
    const once = redact(`token ${GITHUB_PAT} env ${ENV_VALUE}`);
    expect(redact(once)).toBe(once);
  });

  it("leaves ordinary log lines unchanged", () => {
    const text = "Running compatibility checks...\n0.1.1: 12/12 applicable checks passed.";
    expect(redact(text)).toBe(text);
  });
});
