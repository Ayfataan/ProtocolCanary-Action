import { describe, expect, it } from "vitest";

import { codeSpan, escapeInline, fencedBlock, maskRpcUrl, quoteForShell } from "../../src/markdown";

const ZERO_WIDTH_SPACE = "\u200B";

describe("escapeInline (#448)", () => {
  it("returns an empty string unchanged", () => {
    expect(escapeInline("")).toBe("");
  });

  it("collapses newlines, carriage returns, and tabs to single spaces", () => {
    expect(escapeInline("first\r\nsecond\tthird\nfourth")).toBe("first second third fourth");
  });

  it("backslash-escapes Markdown inline syntax", () => {
    expect(escapeInline("# heading")).toBe("\\# heading");
    expect(escapeInline("*bold* _italic_ ~~strike~~")).toBe("\\*bold\\* \\_italic\\_ \\~\\~strike\\~\\~");
    expect(escapeInline("[link](https://example.com)")).toContain("\\[link\\]");
    expect(escapeInline("<script>alert(1)</script>")).toBe("\\<script\\>alert\\(1\\)\\</script\\>");
    expect(escapeInline("a | b")).toBe("a \\| b");
    expect(escapeInline("back\\slash")).toBe("back\\\\slash");
  });

  it("neutralises bare URLs with a zero-width space", () => {
    expect(escapeInline("https://evil.example/path")).toContain(`h${ZERO_WIDTH_SPACE}ttps://`);
  });

  it("neutralises www autolinks with a zero-width space", () => {
    expect(escapeInline("www.example.com/path")).toContain(`w${ZERO_WIDTH_SPACE}ww\\.example\\.com`);
  });

  it("neutralises email autolinks with a zero-width space", () => {
    expect(escapeInline("user@example.com")).toContain(`u${ZERO_WIDTH_SPACE}ser@`);
  });

  it("neutralises GitHub @mentions with a zero-width space", () => {
    expect(escapeInline("@octocat")).toBe(`@${ZERO_WIDTH_SPACE}octocat`);
  });

  it("neutralises GitHub issue references with a zero-width space", () => {
    expect(escapeInline("#123")).toBe(`\\#${ZERO_WIDTH_SPACE}123`);
  });

  it("keeps ordinary text, non-ASCII letters, emoji, and paths readable", () => {
    expect(escapeInline("Compatibility check passed for /usr/local/bin/stellar-canary")).toBe(
      "Compatibility check passed for /usr/local/bin/stellar\\-canary",
    );
    expect(escapeInline("café ✓ 🚀")).toBe("café ✓ 🚀");
    expect(escapeInline("src/main.ts")).toBe("src/main\\.ts");
  });
});

describe("codeSpan (#448)", () => {
  it("wraps content in single backticks", () => {
    expect(codeSpan("plain")).toBe("`plain`");
  });

  it("chooses a delimiter longer than the longest interior backtick run", () => {
    expect(codeSpan("a`b")).toBe("``a`b``");
    expect(codeSpan("a```b")).toBe("````a```b````");
  });

  it("pads content that starts or ends with a backtick", () => {
    expect(codeSpan("`edge`")).toBe("`` `edge` ``");
  });

  it("handles empty content", () => {
    expect(codeSpan("")).toBe("``");
  });
});

describe("fencedBlock (#448)", () => {
  it("wraps content in a plain-text fenced block", () => {
    expect(fencedBlock("hello")).toBe("```text\nhello\n```");
  });

  it("chooses a fence longer than the longest interior backtick run", () => {
    expect(fencedBlock("before ``` after")).toBe("````text\nbefore ``` after\n````");
  });

  it("preserves multi-line content", () => {
    expect(fencedBlock("line one\nline two")).toBe("```text\nline one\nline two\n```");
  });
});

describe("quoteForShell (#416)", () => {
  it("leaves arguments without shell metacharacters unquoted", () => {
    expect(quoteForShell("check")).toBe("check");
    expect(quoteForShell("--fixtures-dir")).toBe("--fixtures-dir");
    expect(quoteForShell("src/main.ts")).toBe("src/main.ts");
    expect(quoteForShell("https://example.com")).toBe("https://example.com");
  });

  it("quotes arguments containing spaces", () => {
    expect(quoteForShell("fixtures dir")).toBe("'fixtures dir'");
  });

  it("quotes shell metacharacters and variable expansions", () => {
    expect(quoteForShell("$HOME")).toBe("'$HOME'");
    expect(quoteForShell("a;rm -rf /")).toBe("'a;rm -rf /'");
    expect(quoteForShell("a&b|c>d<e")).toBe("'a&b|c>d<e'");
    expect(quoteForShell("$(whoami)")).toBe("'$(whoami)'");
  });

  it("escapes embedded single quotes by closing and reopening the quote", () => {
    expect(quoteForShell("it's")).toBe("'it'\\''s'");
  });

  it("quotes empty arguments", () => {
    expect(quoteForShell("")).toBe("''");
  });
});

describe("maskRpcUrl (#416)", () => {
  it("returns a URL without userinfo, query, or fragment unchanged", () => {
    expect(maskRpcUrl("https://soroban-testnet.stellar.org")).toBe("https://soroban-testnet.stellar.org");
    expect(maskRpcUrl("https://soroban-testnet.stellar.org/rpc")).toBe("https://soroban-testnet.stellar.org/rpc");
  });

  it("masks userinfo while preserving scheme, host, and path", () => {
    expect(maskRpcUrl("https://user:pass@example.com/rpc")).toBe("https://[REDACTED]@example.com/rpc");
  });

  it("masks a query string", () => {
    expect(maskRpcUrl("https://example.com/rpc?token=secret")).toBe("https://example.com/rpc[REDACTED]");
  });

  it("masks a fragment", () => {
    expect(maskRpcUrl("https://example.com/rpc#secret")).toBe("https://example.com/rpc[REDACTED]");
  });

  it("masks userinfo and a query/fragment together", () => {
    expect(maskRpcUrl("https://user:pass@example.com/rpc?token=secret#fragment")).toBe(
      "https://[REDACTED]@example.com/rpc[REDACTED]",
    );
  });

  it("returns a non-URL value unchanged", () => {
    expect(maskRpcUrl("not a url")).toBe("not a url");
  });
});
