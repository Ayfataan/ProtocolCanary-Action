import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_LOG_BLOCK_MAX_BYTES,
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
