import type * as actionsCore from "@actions/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const { errorMock } = vi.hoisted(() => ({ errorMock: vi.fn() }));
vi.mock("@actions/core", async (importOriginal) => ({
  ...await importOriginal<typeof actionsCore>(),
  error: errorMock,
}));
import { emitExecutionFailureAnnotation, emitExitFailureAnnotation } from "../../src/annotations";
import { TRUNCATION_NOTICE } from "../../src/log-block";
import { extractDiagnostic } from "../../src/runner";
import { renderExecutionFailureMarkdown } from "../../src/summary";

afterEach(() => { vi.unstubAllEnvs(); errorMock.mockReset(); });

const sinks = {
  execution: (text: string) => {
    emitExecutionFailureAnnotation("timeout", text);
    return String(errorMock.mock.lastCall?.[0]).split("Engine diagnostic: ")[1] ?? "";
  },
  exit: (text: string) => {
    emitExitFailureAnnotation(1, text);
    return String(errorMock.mock.lastCall?.[0]).split("Engine diagnostic: ")[1] ?? "";
  },
  summary: (text: string) => renderExecutionFailureMarkdown("timeout", text).split(/`+text\n/)[1]?.split(/\n`+$/)[0] ?? "",
};

describe.each(Object.entries(sinks))("safe failure diagnostic: %s", (_name, sink) => {
  it("redacts all existing secret shapes and neutralizes controls and commands", () => {
    const secrets = ["ghp_" + "a".repeat(36), "S" + "A".repeat(55), "query-secret", "user:password", "environment-secret"];
    vi.stubEnv("DIAGNOSTIC_TEST_TOKEN", secrets[4]);
    const raw = `${secrets[0]} ${secrets[1]} https://host/?api_key=${secrets[2]} https://${secrets[3]}@host/ ${secrets[4]}\n\x1b[31mfatal\x1b[0m\0\x85\n::error::injected\n::add-mask::value`;
    const output = sink(raw);
    for (const secret of secrets) expect(output.includes(secret)).toBe(false);
    expect(output).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(output).not.toContain("::");
    expect(output).toContain("fatal");
  });

  it("bounds 2 MiB by UTF-8 bytes and retains the tail without splitting code points", () => {
    const output = sink("é".repeat(1024 * 1024) + " tail");
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(8192);
    expect(output.startsWith(TRUNCATION_NOTICE)).toBe(true);
    expect(output.endsWith(" tail")).toBe(true);
    expect(output).not.toContain("�");
  });

  it("redacts before byte and line cuts, including multiline environment values", () => {
    const token = "ghp_" + "b".repeat(36);
    const multiline = "first-secret-half\nsecond-secret-half";
    vi.stubEnv("DIAGNOSTIC_TEST_SECRET", multiline);
    const output = sink("prefix " + token + " " + "z".repeat(8170) + "\n" + multiline + "\n" + "safe\n".repeat(39));
    expect(output).not.toContain("b".repeat(10));
    expect(output).not.toContain("secret-half");
    expect(output.startsWith(TRUNCATION_NOTICE)).toBe(true);
    expect(output.split("\n").length).toBeLessThanOrEqual(41);
  });

  it("redacts a token straddling the byte cut before retaining its tail", () => {
    const token = "ghp_" + "e".repeat(36);
    const output = sink("prefix ".repeat(100) + token + " " + "x".repeat(8130));
    expect(output).not.toContain("e".repeat(10));
    expect(output.startsWith(TRUNCATION_NOTICE)).toBe(true);
  });

  it("preserves clean single and multiline text", () => {
    for (const text of ["no checks ran: all 7 loaded fixtures were skipped", "fatal\nmore context"]) {
      expect(sink(text)).toBe(text);
    }
  });
});

it("redacts before root-line selection and the 500-byte extraction cut", () => {
  vi.stubEnv("DIAGNOSTIC_TEST_PASSWORD", "first-half\nsecond-half");
  expect(extractDiagnostic("first-half\nsecond-half")).toBe("[REDACTED]");
  const token = "ghp_" + "c".repeat(36);
  const output = extractDiagnostic("error: " + token + " " + "é".repeat(245));
  expect(output).not.toContain("c".repeat(10));
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(500);
});

it("sanitizes untrusted reasons in annotations and summaries", () => {
  const token = "ghp_" + "d".repeat(36);
  const reason = `Unexpected token \x1b[31m${token}\0\x85 ::error::`;
  emitExecutionFailureAnnotation(reason);
  for (const output of [String(errorMock.mock.lastCall?.[0]), renderExecutionFailureMarkdown(reason, "")]) {
    expect(output.includes(token)).toBe(false);
    expect(output).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(output).not.toContain("::");
  }
});
