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

// ---------------------------------------------------------------------------
// #512: the exact boundaries of every secret pattern. Each secret-shaped
// string is assembled at runtime from its documented shape (no credential,
// real or synthetic, is ever pasted or printed) and every boundary has an
// exact expected output, so a pattern narrowed by one character class slot
// or one length unit fails a test instead of silently disclosing secrets.
// ---------------------------------------------------------------------------

/** Every classic GitHub token prefix the pattern recognises. */
const CLASSIC_TOKEN_PREFIXES = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] as const;

describe("redact pattern boundaries (#512)", () => {
  describe("GitHub classic tokens", () => {
    it.each(CLASSIC_TOKEN_PREFIXES)(
      "masks a %s token with a 36-character body (the minimum length)",
      (prefix) => {
        const token = `${prefix}${"a".repeat(36)}`;
        expect(redactSecrets(`token ${token} end`)).toBe(`token ${REDACTED} end`);
      },
    );

    it.each(CLASSIC_TOKEN_PREFIXES)(
      "masks a %s token with a 255-character body (the maximum length)",
      (prefix) => {
        const token = `${prefix}${"a".repeat(255)}`;
        expect(redactSecrets(`token ${token} end`)).toBe(`token ${REDACTED} end`);
      },
    );

    it.each(CLASSIC_TOKEN_PREFIXES)(
      "leaves a %s token with a 35-character body unchanged (below the minimum)",
      (prefix) => {
        const token = `${prefix}${"a".repeat(35)}`;
        expect(redactSecrets(`token ${token} end`)).toBe(`token ${token} end`);
      },
    );

    it("masks a token body that uses every character class the pattern allows", () => {
      // Lower case, upper case, 0 and 9: a body built only from "a" would
      // not notice a class losing 0 or 9 (or an entire digit range).
      const body = "aA09".repeat(9);
      expect(body.length).toBe(36);
      const token = `ghp_${body}`;
      expect(redactSecrets(`key=${token}`)).toBe(`key=${REDACTED}`);
    });
  });

  describe("fine-grained GitHub tokens", () => {
    it("masks a github_pat_ token with a 22-character body including underscores", () => {
      const body = "a_".repeat(11);
      expect(body.length).toBe(22);
      const token = `github_pat_${body}`;
      expect(redactSecrets(`Authorization: Bearer ${token}`)).toBe(`Authorization: Bearer ${REDACTED}`);
    });

    it("masks a github_pat_ token with a 255-character body", () => {
      const body = `${"a_".repeat(127)}a`;
      expect(body.length).toBe(255);
      const token = `github_pat_${body}`;
      expect(redactSecrets(`Authorization: Bearer ${token}`)).toBe(`Authorization: Bearer ${REDACTED}`);
    });

    it("leaves a github_pat_ token with a 21-character body unchanged (below the minimum)", () => {
      const body = `${"a_".repeat(10)}a`;
      expect(body.length).toBe(21);
      const token = `github_pat_${body}`;
      expect(redactSecrets(`Authorization: Bearer ${token}`)).toBe(`Authorization: Bearer ${token}`);
    });
  });

  describe("Stellar secret seeds", () => {
    it.each(["2", "3", "4", "5", "6", "7"])(
      "masks a 55-character seed body containing the digit %s",
      (digit) => {
        const seed = `S${digit}${"A".repeat(54)}`;
        expect(redactSecrets(`seed=${seed}`)).toBe(`seed=${REDACTED}`);
      },
    );

    it("masks a 55-character seed body containing every allowed digit and both boundary letters", () => {
      const body = `234567AZ${"B".repeat(47)}`;
      expect(body.length).toBe(55);
      const seed = `S${body}`;
      expect(redactSecrets(`seed=${seed}`)).toBe(`seed=${REDACTED}`);
    });

    it("masks a seed body of all A (the first allowed letter) and all Z (the last)", () => {
      expect(redactSecrets(`seed=${`S${"A".repeat(55)}`}`)).toBe(`seed=${REDACTED}`);
      expect(redactSecrets(`seed=${`S${"Z".repeat(55)}`}`)).toBe(`seed=${REDACTED}`);
    });

    it("leaves a 54-character seed body unchanged (below the required length)", () => {
      const seed = `S${"A".repeat(54)}`;
      expect(redactSecrets(`seed=${seed}`)).toBe(`seed=${seed}`);
    });

    it("leaves a 56-character seed body unchanged (no word boundary after 55)", () => {
      const seed = `S${"A".repeat(56)}`;
      expect(redactSecrets(`seed=${seed}`)).toBe(`seed=${seed}`);
    });
  });

  describe("sensitive environment values", () => {
    it("masks an 8-character value wherever it appears (at the minimum length)", () => {
      process.env[ENV_NAME] = "ab12CD34";
      expect(redactSecrets("debug: ab12CD34 and ab12CD34 end")).toBe(
        `debug: ${REDACTED} and ${REDACTED} end`,
      );
    });

    it("leaves a 7-character value untouched (below the minimum length)", () => {
      process.env[ENV_NAME] = "ab12CD3";
      expect(redactSecrets("debug: ab12CD3 end")).toBe("debug: ab12CD3 end");
    });

    it("masks the trimmed form of a whitespace-padded 8-character value", () => {
      process.env[ENV_NAME] = "  ab12CD34  ";
      expect(redactSecrets("debug: ab12CD34 end")).toBe(`debug: ${REDACTED} end`);
    });

    it("never masks a value whose variable name carries no sensitive keyword", () => {
      process.env.MY_TEST_VARIABLE = "a-harmless-value";
      try {
        expect(redactSecrets("log a-harmless-value end")).toBe("log a-harmless-value end");
      } finally {
        delete process.env.MY_TEST_VARIABLE;
      }
    });
  });

  describe("URL credentials", () => {
    it("masks userinfo with a user only, keeping scheme and host", () => {
      const out = redactSecrets("rpc=https://user@example.com/rpc");
      expect(out).toBe(`rpc=https://${REDACTED}@example.com/rpc`);
      expect(out).not.toContain("user@");
      expect(out).toContain("https://");
      expect(out).toContain("example.com");
    });

    it("masks userinfo with a password only, keeping scheme and host", () => {
      const out = redactSecrets("rpc=https://:supersecret@example.com/rpc");
      expect(out).toBe(`rpc=https://${REDACTED}@example.com/rpc`);
      expect(out).not.toContain("supersecret");
      expect(out).toContain("example.com");
    });

    it("masks userinfo with both a user and a password, keeping scheme and host", () => {
      const out = redactSecrets("rpc=https://user:supersecret@example.com/rpc");
      expect(out).toBe(`rpc=https://${REDACTED}@example.com/rpc`);
      expect(out).not.toContain("supersecret");
      expect(out).not.toContain("user@");
      expect(out).toContain("example.com");
    });

    it("masks userinfo on a URL with no path component", () => {
      const out = redactSecrets("rpc=https://user:supersecret@example.com");
      expect(out).toBe(`rpc=https://${REDACTED}@example.com`);
      expect(out).not.toContain("supersecret");
      expect(out).toContain("https://");
      expect(out).toContain("example.com");
    });

    it("masks a query string only, keeping scheme, host and path", () => {
      const out = redactSecrets("rpc=https://example.com/rpc?token=abc123&network=testnet");
      expect(out).toBe(`rpc=https://example.com/rpc?${REDACTED}`);
      expect(out).not.toContain("abc123");
      expect(out).toContain("https://example.com/rpc");
    });

    it("masks a fragment only, collapsing it into the redacted suffix", () => {
      const out = redactSecrets("see https://example.com/path#access_token=abc123");
      expect(out).toBe(`see https://example.com/path?${REDACTED}`);
      expect(out).not.toContain("abc123");
      expect(out).toContain("https://example.com/path");
    });

    it("leaves a URL with no credentials, query or fragment unchanged", () => {
      const url = "https://soroban-testnet.stellar.org/rpc";
      expect(redactSecrets(`GET ${url} ok`)).toBe(`GET ${url} ok`);
    });
  });
});
