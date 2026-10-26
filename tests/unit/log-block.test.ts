import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_LOG_BLOCK_MAX_BYTES,
  DEFAULT_LOG_BLOCK_MAX_LINES,
  TRUNCATION_NOTICE,
  formatSafeDiagnosticTail,
  printLogBlock,
  sanitizeLogText,
  truncateLogTail,
} from "../../src/log-block";
import { REDACTED } from "../../src/redact";

const coreMocks = vi.hoisted(() => ({
  infoMock: vi.fn(),
  startGroupMock: vi.fn(),
  endGroupMock: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  info: coreMocks.infoMock,
  startGroup: coreMocks.startGroupMock,
  endGroup: coreMocks.endGroupMock,
}));

describe("sanitizeLogText", () => {
  it("masks token-shaped strings, Stellar secret seeds, and URL credentials", () => {
    const raw = [
      "error: failed using token ghp_111122223333444455556666777788889999",
      "secret seed: SB3W52UQNPILTKJE752GYUDO7PXFYS7PBY4CL5NZW5DXRBG5G3EK7R3N",
      "fetched from https://alice:secret123@rpc.stellar.org/v1?token=secret#frag",
    ].join("\n");

    const sanitized = sanitizeLogText(raw);

    expect(sanitized).not.toContain("ghp_111122223333444455556666777788889999");
    expect(sanitized).not.toContain("SB3W52UQNPILTKJE752GYUDO7PXFYS7PBY4CL5NZW5DXRBG5G3EK7R3N");
    expect(sanitized).not.toContain("secret123");
    expect(sanitized).toContain(REDACTED);
    expect(sanitized).toContain("https://[REDACTED]@rpc.stellar.org/v1?[REDACTED]");
  });

  it("strips ANSI color and escape sequences", () => {
    const raw = "\x1B[31;1mError:\x1B[0m \x1B[33mcompilation failed\x1B[0m\x1B[2K";
    const sanitized = sanitizeLogText(raw);
    expect(sanitized).toBe("Error: compilation failed");
  });

  it("removes control characters and carriage returns while preserving newlines and tabs", () => {
    const raw = "Line 1\r\n\tTabbed\x00with\x07bell\x1Funit\nLine 2\r\n";
    const sanitized = sanitizeLogText(raw);
    expect(sanitized).toBe("Line 1\n\tTabbedwithbellunit\nLine 2\n");
    expect(sanitized).not.toContain("\r");
    expect(sanitized).not.toContain("\x00");
  });

  it("neutralises workflow commands by rewriting :: to \\:\\:", () => {
    const raw = "::error::Injected workflow command\n::set-output name=x::val\n::add-mask::secret";
    const sanitized = sanitizeLogText(raw);
    expect(sanitized).not.toContain("::error::");
    expect(sanitized).not.toContain("::set-output");
    expect(sanitized).not.toContain("::add-mask::");
    expect(sanitized).toContain("\\:\\:error\\:\\:");
  });

  it("handles strings with invalid UTF-16 surrogates without crashing", () => {
    const invalid = "abc\uD800xyz\uDFFFend";
    const sanitized = sanitizeLogText(invalid);
    expect(sanitized).toContain("abc");
    expect(sanitized).toContain("xyz");
  });
});

describe("truncateLogTail", () => {
  it("preserves text within line and byte limits without modification", () => {
    const text = "line 1\nline 2\nline 3";
    const result = truncateLogTail(text, 10, 100);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
  });

  it("truncates lines when exceeding maxLines and prepends truncation notice", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const result = truncateLogTail(lines.join("\n"), 3, 10_000);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith(TRUNCATION_NOTICE)).toBe(true);
    expect(result.text).toContain("line 8\nline 9\nline 10");
    expect(result.text).not.toContain("line 7");
  });

  it("truncates bytes when exceeding maxBytes and prepends truncation notice", () => {
    const text = "a".repeat(500);
    const result = truncateLogTail(text, 100, 100);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith(TRUNCATION_NOTICE)).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(100);
  });

  it("does not split multi-byte UTF-8 sequences at byte boundaries", () => {
    // € is 3 bytes (0xE2, 0x82, 0xAC)
    const euros = "€".repeat(100);
    const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, "utf8");
    // Limit to noticeBytes + 10 bytes (which would be 3.33 euros)
    const result = truncateLogTail(euros, 100, noticeBytes + 10);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("\uFFFD");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(noticeBytes + 10);
  });

  it("handles a single very long line without newlines", () => {
    const longLine = "x".repeat(100_000);
    const result = truncateLogTail(longLine, 10, 500);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(500);
    expect(result.text.startsWith(TRUNCATION_NOTICE)).toBe(true);
  });
});

describe("formatSafeDiagnosticTail", () => {
  it("returns empty string when input is empty or whitespace only", () => {
    expect(formatSafeDiagnosticTail("")).toBe("");
    expect(formatSafeDiagnosticTail("   \t  \n  ")).toBe("");
  });

  it("caps lines at 40 and bytes at 8 KiB by default", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `diagnostic line ${i + 1}`);
    const tail = formatSafeDiagnosticTail(lines.join("\n"), 40, 8 * 1024);
    expect(tail).toContain(TRUNCATION_NOTICE);
    expect(tail).toContain("diagnostic line 60");
    expect(tail).toContain("diagnostic line 21");
    expect(tail).not.toContain("diagnostic line 20\n");
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(8 * 1024);
  });

  it("redacts secrets and strips control characters in the diagnostic tail", () => {
    const raw = "error: ghp_111122223333444455556666777788889999 failed\r\n";
    const tail = formatSafeDiagnosticTail(raw);
    expect(tail).not.toContain("ghp_111122223333444455556666777788889999");
    expect(tail).not.toContain("\r");
    expect(tail).toContain(REDACTED);
  });
});

describe("printLogBlock", () => {
  beforeEach(() => {
    coreMocks.infoMock.mockClear();
    coreMocks.startGroupMock.mockClear();
    coreMocks.endGroupMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("prints nothing when raw text is empty or whitespace-only", () => {
    printLogBlock("Title", "");
    printLogBlock("Title", "   \n\t  ");
    expect(coreMocks.startGroupMock).not.toHaveBeenCalled();
    expect(coreMocks.infoMock).not.toHaveBeenCalled();
    expect(coreMocks.endGroupMock).not.toHaveBeenCalled();
  });

  it("wraps output in core.startGroup and core.endGroup with the provided title", () => {
    printLogBlock("Canary diagnostics", "some warning message");

    expect(coreMocks.startGroupMock).toHaveBeenCalledWith("Canary diagnostics");
    expect(coreMocks.endGroupMock).toHaveBeenCalledTimes(1);
  });

  it("emits stop-commands with a random token before and after output", () => {
    printLogBlock("Canary diagnostics", "test output");

    const calls = coreMocks.infoMock.mock.calls.map((c) => String(c[0]));
    expect(calls).toHaveLength(3);

    const startCmd = calls[0]!;
    const body = calls[1]!;
    const endCmd = calls[2]!;

    expect(startCmd).toMatch(/^::stop-commands::[0-9a-f]{32}$/);
    const token = startCmd.replace("::stop-commands::", "");
    expect(body).toBe("test output");
    expect(endCmd).toBe(`::${token}::`);
  });

  it("uses a fresh random token per call", () => {
    printLogBlock("Block 1", "output 1");
    printLogBlock("Block 2", "output 2");

    const calls = coreMocks.infoMock.mock.calls.map((c) => String(c[0]));
    const token1 = calls[0]!.replace("::stop-commands::", "");
    const token2 = calls[3]!.replace("::stop-commands::", "");

    expect(token1).not.toBe(token2);
    expect(token1).toHaveLength(32);
    expect(token2).toHaveLength(32);
  });

  it("neutralises attempted workflow command injection inside log blocks", () => {
    const malicious = [
      "::stop-commands::deadbeef",
      "::error::forged error annotation",
      "::add-mask::secret-token",
      "::deadbeef::",
    ].join("\n");

    printLogBlock("Canary diagnostics", malicious);

    const calls = coreMocks.infoMock.mock.calls.map((c) => String(c[0]));
    const body = calls[1]!;

    // Escaped by redact()
    expect(body).not.toContain("::error::");
    expect(body).not.toContain("::add-mask::");
    expect(body).toContain("\\:\\:error\\:\\:");
    expect(body).toContain("\\:\\:add-mask\\:\\:");
  });

  it("bounds output to 64 KiB and 200 lines by default", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `log line ${i + 1}`);
    printLogBlock("Big output", lines.join("\n"));

    const calls = coreMocks.infoMock.mock.calls.map((c) => String(c[0]));
    const body = calls[1]!;

    expect(body.startsWith(TRUNCATION_NOTICE)).toBe(true);
    expect(body).toContain("log line 300");
    expect(body).toContain("log line 101");
    expect(body).not.toContain("log line 100\n");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(DEFAULT_LOG_BLOCK_MAX_BYTES);
  });

  it("handles megabytes of output without crashing", () => {
    const huge = "a".repeat(5 * 1024 * 1024); // 5 MB
    printLogBlock("Huge output", huge);

    const calls = coreMocks.infoMock.mock.calls.map((c) => String(c[0]));
    const body = calls[1]!;

    expect(body.startsWith(TRUNCATION_NOTICE)).toBe(true);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(DEFAULT_LOG_BLOCK_MAX_BYTES);
  });
});

describe("truncateLogTail exact boundaries (#513)", () => {
  const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, "utf8");
  const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
  const numbered = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `row-${String(index + 1).padStart(3, "0")}`);

  it("pins the notice to 35 bytes, which every byte-limit expectation below depends on", () => {
    expect(TRUNCATION_NOTICE).toBe("[... earlier output truncated ...]\n");
    expect(noticeBytes).toBe(35);
  });

  describe("line limit", () => {
    it.each([39, 40])("returns %i lines unchanged when maxLines is 40", (count) => {
      const text = numbered(count).join("\n");
      expect(truncateLogTail(text, 40, 100_000)).toEqual({ text, truncated: false });
    });

    it("truncates 41 lines to the last 40, behind the notice", () => {
      const lines = numbered(41);
      const result = truncateLogTail(lines.join("\n"), 40, 100_000);

      expect(result.truncated).toBe(true);
      expect(result.text).toBe(`${TRUNCATION_NOTICE}${lines.slice(1).join("\n")}`);
      expect(result.text.startsWith(`${TRUNCATION_NOTICE}row-002\n`)).toBe(true);
      expect(result.text.endsWith("\nrow-041")).toBe(true);
      expect(result.text).not.toContain("row-001");
    });

    it("keeps the most recent lines even when the input is far over the limit", () => {
      const lines = numbered(500);
      const result = truncateLogTail(lines.join("\n"), 40, 100_000);

      expect(result.text).toBe(`${TRUNCATION_NOTICE}${lines.slice(-40).join("\n")}`);
    });

    it("counts a trailing newline as one more (empty) line", () => {
      const text = `${numbered(40).join("\n")}\n`;
      const result = truncateLogTail(text, 40, 100_000);

      expect(result.truncated).toBe(true);
      expect(result.text.endsWith("row-040\n")).toBe(true);
      expect(result.text).not.toContain("row-001");
    });
  });

  describe("byte limit", () => {
    it.each([99, 100])("returns %i ASCII bytes unchanged when maxBytes is 100", (size) => {
      const text = "a".repeat(size);
      expect(truncateLogTail(text, 1000, 100)).toEqual({ text, truncated: false });
    });

    it("truncates 101 ASCII bytes to exactly maxBytes including the notice, keeping the end", () => {
      const text = `${"a".repeat(60)}${"b".repeat(41)}`;
      const result = truncateLogTail(text, 1000, 100);

      expect(result.truncated).toBe(true);
      expect(bytes(result.text)).toBe(100);
      expect(result.text.startsWith(TRUNCATION_NOTICE)).toBe(true);
      expect(result.text).toBe(`${TRUNCATION_NOTICE}${"a".repeat(24)}${"b".repeat(41)}`);
    });

    it("keeps nothing but the notice-sized budget when maxBytes is smaller than the notice", () => {
      const result = truncateLogTail("a".repeat(500), 1000, 10);

      expect(result.truncated).toBe(true);
      expect(result.text).toBe(TRUNCATION_NOTICE);
    });
  });

  describe("both limits together", () => {
    it("applies the line limit first and then the byte limit, ending with the last line", () => {
      const lines = numbered(50);
      const result = truncateLogTail(lines.join("\n"), 40, 200);

      expect(result.truncated).toBe(true);
      expect(bytes(result.text)).toBe(200);
      expect(result.text.startsWith(TRUNCATION_NOTICE)).toBe(true);
      expect(result.text.endsWith("\nrow-050")).toBe(true);
      expect(result.text).toBe(`${TRUNCATION_NOTICE}${lines.slice(-40).join("\n").slice(-165)}`);
    });

    it("cuts further when the kept lines fit alone but not together with the notice", () => {
      // 41 one-character lines: after the line cut, 40 "x" + 39 "\n" = 79 bytes.
      const text = Array.from({ length: 41 }, () => "x").join("\n");

      const exactFit = truncateLogTail(text, 40, 79 + noticeBytes);
      expect(exactFit.truncated).toBe(true);
      expect(bytes(exactFit.text)).toBe(79 + noticeBytes);
      expect(exactFit.text).toBe(`${TRUNCATION_NOTICE}${Array.from({ length: 40 }, () => "x").join("\n")}`);

      const oneByteShort = truncateLogTail(text, 40, 79 + noticeBytes - 1);
      expect(bytes(oneByteShort.text)).toBe(79 + noticeBytes - 1);
      expect(oneByteShort.text.endsWith("x")).toBe(true);
      expect(oneByteShort.text.startsWith(`${TRUNCATION_NOTICE}\nx`)).toBe(true);
    });
  });

  describe("UTF-8 alignment", () => {
    it.each([
      { name: "2-byte", char: "é", width: 2, budgets: [4, 5], kept: 2 },
      { name: "3-byte", char: "€", width: 3, budgets: [9, 10, 11], kept: 3 },
      { name: "4-byte", char: "😀", width: 4, budgets: [4, 6, 7], kept: 1 },
    ])("never starts inside a $name character", ({ char, width, budgets, kept }) => {
      const text = char.repeat(50);
      expect(bytes(text)).toBe(50 * width);

      for (const budget of budgets) {
        const result = truncateLogTail(text, 1000, noticeBytes + budget);
        expect(result.truncated).toBe(true);
        expect(result.text).toBe(`${TRUNCATION_NOTICE}${char.repeat(kept)}`);
        expect(result.text).not.toContain("\uFFFD");
        expect(bytes(result.text)).toBeLessThanOrEqual(noticeBytes + budget);
      }
    });

    it("keeps one more whole character when the budget lands exactly between characters", () => {
      const result = truncateLogTail("😀".repeat(50), 1000, noticeBytes + 8);
      expect(result.text).toBe(`${TRUNCATION_NOTICE}${"😀".repeat(2)}`);
    });

    it("stays valid when a multi-byte character is the very last thing in the input", () => {
      const text = `${"a".repeat(200)}€`;
      const result = truncateLogTail(text, 1000, noticeBytes + 5);

      expect(result.text.endsWith("€")).toBe(true);
      expect(result.text).not.toContain("\uFFFD");
      expect(bytes(result.text)).toBe(noticeBytes + 5);
    });
  });
});

describe("log tail defaults (#513)", () => {
  const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
  const numbered = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `line ${String(index + 1).padStart(3, "0")}`);

  beforeEach(() => {
    coreMocks.infoMock.mockClear();
  });

  it("pins the documented default limits by value", () => {
    expect(DEFAULT_LOG_BLOCK_MAX_LINES).toBe(200);
    expect(DEFAULT_LOG_BLOCK_MAX_BYTES).toBe(64 * 1024);
    expect(DEFAULT_LOG_BLOCK_MAX_BYTES).toBe(65_536);
  });

  describe("formatSafeDiagnosticTail with its own defaults (40 lines, 8 KiB)", () => {
    it("keeps 40 lines whole and truncates 41 to the last 40", () => {
      const forty = numbered(40).join("\n");
      expect(formatSafeDiagnosticTail(forty)).toBe(forty);

      const lines = numbered(41);
      expect(formatSafeDiagnosticTail(lines.join("\n"))).toBe(`${TRUNCATION_NOTICE}${lines.slice(1).join("\n")}`);
    });

    it("keeps 8192 bytes whole and cuts 8193 to exactly 8192 behind the notice", () => {
      expect(formatSafeDiagnosticTail("y".repeat(8192))).toBe("y".repeat(8192));

      const cut = formatSafeDiagnosticTail("y".repeat(8193));
      expect(bytes(cut)).toBe(8192);
      expect(cut.startsWith(TRUNCATION_NOTICE)).toBe(true);
      expect(cut).toBe(`${TRUNCATION_NOTICE}${"y".repeat(8192 - 35)}`);
    });

    it("turns 9000 characters into exactly 8192 bytes", () => {
      const cut = formatSafeDiagnosticTail("y".repeat(9000));
      expect(bytes(cut)).toBe(8192);
      expect(cut.startsWith(TRUNCATION_NOTICE)).toBe(true);
    });

    it("ends with the last line of the input after redaction", () => {
      const lines = [...numbered(59), "final: ghp_" + "a1B2".repeat(9)];
      const tail = formatSafeDiagnosticTail(lines.join("\n"));

      expect(tail.endsWith("final: [REDACTED]")).toBe(true);
      expect(tail.startsWith(`${TRUNCATION_NOTICE}line 021\n`)).toBe(true);
    });
  });

  describe("printLogBlock with its defaults (200 lines, 64 KiB)", () => {
    const printed = (): string => String(coreMocks.infoMock.mock.calls[1]?.[0]);

    it("prints 200 lines whole and truncates 201 to the last 200", () => {
      const lines = numbered(201);

      printLogBlock("diagnostics", lines.slice(0, 200).join("\n"));
      expect(printed()).toBe(lines.slice(0, 200).join("\n"));

      coreMocks.infoMock.mockClear();
      printLogBlock("diagnostics", lines.join("\n"));
      expect(printed()).toBe(`${TRUNCATION_NOTICE}${lines.slice(1).join("\n")}`);
    });

    it("prints 65536 bytes whole and cuts 65537 to exactly 65536", () => {
      printLogBlock("diagnostics", "z".repeat(65_536));
      expect(printed()).toBe("z".repeat(65_536));

      coreMocks.infoMock.mockClear();
      printLogBlock("diagnostics", "z".repeat(65_537));
      expect(bytes(printed())).toBe(65_536);
      expect(printed().startsWith(TRUNCATION_NOTICE)).toBe(true);
    });

    it("lets explicit options override the defaults", () => {
      printLogBlock("diagnostics", numbered(10).join("\n"), { maxLines: 3, maxBytes: 10_000 });
      expect(printed()).toBe(`${TRUNCATION_NOTICE}${numbered(10).slice(-3).join("\n")}`);
    });
  });
});
