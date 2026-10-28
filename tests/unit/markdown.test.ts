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

// #515: function-level contracts with exact expected strings, so a helper that
// quietly stops neutralising a mention, a reference or a code span fails here
// instead of turning an engine string into a notification or a broken summary.
describe("escapeInline edge cases (#515)", () => {
  const Z = ZERO_WIDTH_SPACE;

  describe("@mentions", () => {
    it.each([
      ["@a", `@${Z}a`],
      ["@aa", `@${Z}aa`],
      ["@user9", `@${Z}user9`],
      ["@9user", `@${Z}9user`],
      ["@u9ser", `@${Z}u9ser`],
      ["@a-b", `@${Z}a\\-b`],
      ["@" + "a".repeat(39), `@${Z}${"a".repeat(39)}`],
      ["hi @bob, ok", `hi @${Z}bob, ok`],
    ])("neutralises the mention in %j", (input, expected) => {
      expect(escapeInline(input)).toBe(expected);
    });

    it("neutralises the mention part of a name with a trailing hyphen and leaves the hyphen escaped", () => {
      expect(escapeInline("@ab-")).toBe(`@${Z}ab\\-`);
    });

    it("does not treat a leading hyphen, a bare @ or a word-attached @ as a mention", () => {
      expect(escapeInline("@-ab")).toBe("@\\-ab");
      expect(escapeInline("@")).toBe("@");
      expect(escapeInline("x@y")).toBe("x@y");
    });
  });

  describe("e-mail addresses", () => {
    it.each([
      ["a@b.co", `a${Z}@${Z}b\\.co`],
      ["a@b.com", `a${Z}@${Z}b\\.com`],
    ])("neutralises %j", (input, expected) => {
      expect(escapeInline(input)).toBe(expected);
    });

    it("leaves an address with a one-letter top-level domain alone apart from escaping", () => {
      expect(escapeInline("a@b.c")).toBe("a@b\\.c");
    });
  });

  describe("issue references", () => {
    it.each([
      ["#1", `\\#${Z}1`],
      ["#9", `\\#${Z}9`],
      ["#10", `\\#${Z}10`],
      ["see #7.", `see \\#${Z}7\\.`],
    ])("neutralises %j", (input, expected) => {
      expect(escapeInline(input)).toBe(expected);
    });

    it.each([
      ["#0", "\\#0"],
      ["a#1", "a\\#1"],
      ["#12ab", "\\#12ab"],
    ])("does not treat %j as a reference", (input, expected) => {
      expect(escapeInline(input)).toBe(expected);
    });
  });
});

describe("codeSpan edge cases (#515)", () => {
  it.each([
    ["abc", "`abc`"],
    ["`abc", "`` `abc ``"],
    ["abc`", "`` abc` ``"],
    ["`abc`", "`` `abc` ``"],
    ["a`b", "``a`b``"],
    ["a``b", "```a``b```"],
    ["a```b", "````a```b````"],
    ["``", "``` `` ```"],
  ])("renders %j as %j", (input, expected) => {
    expect(codeSpan(input)).toBe(expected);
  });

  it("pads only when a backtick sits at an end, not for interior backticks", () => {
    expect(codeSpan("a`b")).not.toContain("`` a");
    expect(codeSpan("`abc")).toContain("`` `abc ``");
  });
});

describe("fencedBlock edge cases (#515)", () => {
  it.each([
    ["plain", "```text\nplain\n```"],
    ["line1\nline2", "```text\nline1\nline2\n```"],
    ["a````b", "`````text\na````b\n`````"],
    ["```\nx", "````text\n```\nx\n````"],
    ["x\n```", "````text\nx\n```\n````"],
    ["```\nx\n```", "````text\n```\nx\n```\n````"],
    ["`x\n``` y", "````text\n`x\n``` y\n````"],
  ])("renders %j as %j", (input, expected) => {
    expect(fencedBlock(input)).toBe(expected);
  });

  it("always uses a fence strictly longer than any backtick run inside the content", () => {
    for (const run of [1, 2, 3, 4, 7]) {
      const block = fencedBlock(`a${"`".repeat(run)}b`);
      const fence = block.slice(0, block.indexOf("text\n"));
      expect(fence.length).toBe(Math.max(3, run + 1));
      expect(block.endsWith(`\n${fence}`)).toBe(true);
    }
  });

  it("never pads the content with extra newlines, because the fence is longer than any run in it", () => {
    // A line cannot start with a fence that is longer than every run of
    // backticks in the content, so the content is always emitted as written.
    expect(fencedBlock("```\nx")).not.toContain("\n\n");
    expect(fencedBlock("x\n```")).not.toContain("\n\n");
  });
});

describe("quoteForShell edge cases (#515)", () => {
  it.each([
    ["abc", "abc"],
    ["a/b.c-d_e:f@g", "a/b.c-d_e:f@g"],
    ["a b", "'a b'"],
    ["it's", "'it'\\''s'"],
    ["a'b'c", "'a'\\''b'\\''c'"],
    ["", "''"],
    ["$x", "'$x'"],
    ["a=b", "'a=b'"],
  ])("quotes %j as %j", (input, expected) => {
    expect(quoteForShell(input)).toBe(expected);
  });
});

describe("maskRpcUrl edge cases (#515)", () => {
  it.each([
    ["user only", "https://u@h.example/p", "https://[REDACTED]@h.example/p"],
    ["password only", "https://:pw@h.example/p", "https://[REDACTED]@h.example/p"],
    ["user and password", "https://u:pw@h.example/p", "https://[REDACTED]@h.example/p"],
    ["user and password, no path", "https://u:pw@h.example", "https://[REDACTED]@h.example"],
    ["query only", "https://h.example/p?k=v", "https://h.example/p[REDACTED]"],
    ["fragment only", "https://h.example/p#frag", "https://h.example/p[REDACTED]"],
    ["query and fragment", "https://h.example/p?k=v#frag", "https://h.example/p[REDACTED]"],
    ["everything", "https://u:pw@h.example/p?k=v#frag", "https://[REDACTED]@h.example/p[REDACTED]"],
    ["user and query, no path", "https://u@h.example?k=v", "https://[REDACTED]@h.example[REDACTED]"],
    ["user and fragment, no path", "https://u@h.example#f", "https://[REDACTED]@h.example[REDACTED]"],
    ["loopback with a port", "http://u:pw@127.0.0.1:8000/rpc", "http://[REDACTED]@127.0.0.1:8000/rpc"],
  ])("masks %s", (_name, input, expected) => {
    const masked = maskRpcUrl(input);
    expect(masked).toBe(expected);
    expect(masked).not.toContain("pw");
    expect(masked).not.toContain("k=v");
    expect(masked).not.toContain("frag");
    expect(masked).toContain(new URL(input).host);
  });

  it.each([
    "https://h.example/p",
    "https://h.example",
    "https://[::1]:8080/x",
    "not a url",
    "",
  ])("returns %j unchanged", (input) => {
    expect(maskRpcUrl(input)).toBe(input);
  });
});
