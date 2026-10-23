import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { computePackDigest, isCanonicalPackDigest, verifyPackDigest } from "../../src/canary";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChecksumMismatchError } from "../../src/errors";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "canary-pack-test-"));

beforeEach(() => {
  // Clean up test directory before each test
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeFile(content: string, relPath: string): void {
  const fullPath = path.join(TEST_DIR, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

describe("isCanonicalPackDigest", () => {
  it("accepts a canonical CF-02 pack digest (sha256: followed by 64 lowercase hex)", () => {
    expect(isCanonicalPackDigest("sha256:" + "a".repeat(64))).toBe(true);
  });

  it("rejects a bare hex string without the sha256: prefix", () => {
    expect(isCanonicalPackDigest("a".repeat(64))).toBe(false);
  });

  it("rejects uppercase hex after the prefix", () => {
    expect(isCanonicalPackDigest("SHA256:" + "a".repeat(64))).toBe(false);
  });

  it("rejects a string that is too short", () => {
    expect(isCanonicalPackDigest("sha256:abc")).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(isCanonicalPackDigest(null)).toBe(false);
    expect(isCanonicalPackDigest(undefined)).toBe(false);
  });

  it("rejects a number", () => {
    expect(isCanonicalPackDigest(42)).toBe(false);
  });
});

describe("computePackDigest", () => {
  it("computes the canonical pack digest from a single file", () => {
    writeFile("test content\n", "sample.txt");
    const digest = computePackDigest(TEST_DIR);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("computes the canonical pack digest from multiple files in sorted order", () => {
    writeFile("data1", "alpha.txt");
    writeFile("data2", "beta.txt");
    const digest = computePackDigest(TEST_DIR);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("returns sha256: with empty directory", () => {
    const digest = computePackDigest(TEST_DIR);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("verifyPackDigest", () => {
  it("accepts a matching digest", () => {
    writeFile("test content\n", "sample.txt");
    const computed = computePackDigest(TEST_DIR);
    const result = verifyPackDigest(TEST_DIR, computed);
    expect(result).toBe(computed);
  });

  it("throws ChecksumMismatchError when the expected digest is not canonical", () => {
    writeFile("test content\n", "sample.txt");
    expect(() =>
      verifyPackDigest(TEST_DIR, "not-a-canonical-digest"),
    ).toThrow(ChecksumMismatchError);
  });

  it("throws ChecksumMismatchError when the computed digest diverges", () => {
    writeFile("original content\n", "sample.txt");
    expect(() =>
      verifyPackDigest(TEST_DIR, "sha256:" + "b".repeat(64)),
    ).toThrow(ChecksumMismatchError);
  });
});