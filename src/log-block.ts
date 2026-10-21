import * as core from "@actions/core";
import * as crypto from "node:crypto";

import { redact } from "./redact";

/**
 * Options controlling log-block bounding.
 */
export interface LogBlockOptions {
  /** Maximum number of lines to retain in the tail. */
  readonly maxLines?: number;
  /** Maximum byte length of the UTF-8 encoded text to retain. */
  readonly maxBytes?: number;
}

/** Default line limit for external log blocks (last 200 lines). */
export const DEFAULT_LOG_BLOCK_MAX_LINES = 200;

/** Default byte limit for external log blocks (64 KiB). */
export const DEFAULT_LOG_BLOCK_MAX_BYTES = 64 * 1024;

/** Truncation notice prepended when output exceeds the line or byte limit. */
export const TRUNCATION_NOTICE = "[... earlier output truncated ...]\n";

/**
 * Matches ANSI escape codes: standard CSI sequences, OSC sequences, and simple escapes.
 */
const ANSI_PATTERN =
  /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\x1B\].*?(?:\x07|\x1B\\)/g;

/**
 * Control characters other than newline (`\n`, \u000A) and tab (`\t`, \u0009).
 * ASCII 0x00-0x08, 0x0B-0x1F (includes \r \u000D), and 0x7F-0x9F (DEL & C1 controls).
 */
const CONTROL_CHARS_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * Sanitizes external text before logging:
 * 1. Ensures valid string encoding (converts lone surrogates to replacement characters).
 * 2. Strips ANSI escape sequences and colors.
 * 3. Strips control characters other than newline (`\n`) and tab (`\t`).
 * 4. Passes through `redact` from `src/redact.ts` to mask secrets and escape workflow command sequences (`::` -> `\:\:`).
 */
export function sanitizeLogText(rawText: string): string {
  const wellFormed =
    typeof (rawText as unknown as { toWellFormed?: () => string }).toWellFormed === "function"
      ? (rawText as unknown as { toWellFormed: () => string }).toWellFormed()
      : Buffer.from(rawText, "utf8").toString("utf8");
  const noAnsi = wellFormed.replace(ANSI_PATTERN, "").replace(/\x1B/g, "");
  const cleanControls = noAnsi.replace(CONTROL_CHARS_PATTERN, "");
  return redact(cleanControls);
}

/**
 * Safely extracts the tail of a string bounded by line count and UTF-8 byte length.
 * When the input exceeds either limit, the tail is kept and `TRUNCATION_NOTICE` is prepended.
 *
 * Ensures byte slicing never splits multi-byte UTF-8 character sequences.
 */
export function truncateLogTail(
  text: string,
  maxLines: number = DEFAULT_LOG_BLOCK_MAX_LINES,
  maxBytes: number = DEFAULT_LOG_BLOCK_MAX_BYTES,
): { text: string; truncated: boolean } {
  let truncated = false;
  let currentText = text;

  const lines = currentText.split("\n");
  if (lines.length > maxLines) {
    truncated = true;
    currentText = lines.slice(-maxLines).join("\n");
  }

  const noticeBuf = Buffer.from(TRUNCATION_NOTICE, "utf8");
  const noticeBytes = noticeBuf.length;

  const buf = Buffer.from(currentText, "utf8");
  if (buf.length > maxBytes || (truncated && buf.length + noticeBytes > maxBytes)) {
    truncated = true;
    const targetBytes = Math.max(0, maxBytes - noticeBytes);
    let start = buf.length - targetBytes;
    // Align start to the beginning of a UTF-8 code point sequence (skip continuation bytes 10xxxxxx)
    while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
      start++;
    }
    currentText = buf.subarray(start).toString("utf8");
  }

  if (truncated) {
    return {
      text: `${TRUNCATION_NOTICE}${currentText}`,
      truncated: true,
    };
  }

  return {
    text: currentText,
    truncated: false,
  };
}

/**
 * Prepares a bounded, redacted, control-character free diagnostic tail for error messages.
 * Returns empty string if rawText contains only whitespace.
 */
export function formatSafeDiagnosticTail(
  rawText: string,
  maxLines: number = 40,
  maxBytes: number = 8 * 1024,
): string {
  if (rawText.trim() === "") {
    return "";
  }
  const sanitized = sanitizeLogText(rawText);
  const { text } = truncateLogTail(sanitized, maxLines, maxBytes);
  return text;
}

/**
 * Safely prints external process text inside a collapsed GitHub Actions log group.
 *
 * External process output (from Cargo builds or Canary CLI execution) is untrusted.
 * Compiler diagnostics and dependency source files may quote arbitrary text,
 * echo environment variables, or contain lines starting with `::` that GitHub Actions
 * would otherwise interpret as workflow commands (such as `::error::` annotations or
 * `::add-mask::`).
 *
 * To safely present this output:
 * - Output is stripped of ANSI escapes and non-whitespace control characters.
 * - Recognised secrets and tokens are masked via `redact()`.
 * - Output is bounded by line count and byte length to avoid log flooding.
 * - To stop workflow command interpretation, the log block emits `::stop-commands::<token>`
 *   before printing and resumes with `::<token>::` after printing. A fresh 128-bit
 *   cryptographically random token is generated on every call, preventing external output
 *   from closing the region early or forging an end token.
 * - The entire output is enclosed within `core.startGroup` / `core.endGroup`.
 *
 * If `rawText` contains only whitespace or is empty, nothing is printed.
 */
export function printLogBlock(
  title: string,
  rawText: string,
  options: LogBlockOptions = {},
): void {
  if (rawText.trim() === "") {
    return;
  }

  const maxLines = options.maxLines ?? DEFAULT_LOG_BLOCK_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_BLOCK_MAX_BYTES;

  const sanitized = sanitizeLogText(rawText);
  const { text } = truncateLogTail(sanitized, maxLines, maxBytes);

  // Fresh random token per call to neutralize workflow command processing
  const token = crypto.randomBytes(16).toString("hex");

  core.startGroup(title);
  core.info(`::stop-commands::${token}`);
  core.info(text);
  core.info(`::${token}::`);
  core.endGroup();
}
