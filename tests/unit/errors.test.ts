import { describe, expect, it } from "vitest";

import {
  ChecksumMismatchError,
  ConfigNotFoundError,
  TimeoutError,
  CanaryExecutionFailedError,
  InvalidReportError,
  InvalidInputError,
  describeError,
  isCanaryActionError,
} from "../../src/errors";

describe("CanaryActionError hierarchy", () => {
  it("names each error after its class", () => {
    expect(new InvalidInputError("bad").name).toBe("InvalidInputError");
  });

  it("builds a clear message for a missing config file", () => {
    const error = new ConfigNotFoundError(".stellar-canary.toml");
    expect(error.message).toBe("Configuration file not found: .stellar-canary.toml");
    expect(error.code).toBe("ConfigNotFound");
  });

  it("sets the TimeoutError code", () => {
    expect(new TimeoutError("boom").code).toBe("Timeout");
  });

  it("sets the CanaryExecutionFailedError code", () => {
    expect(new CanaryExecutionFailedError("boom").code).toBe("CanaryExecutionFailed");
  });

  it("sets the InvalidReportError code", () => {
    expect(new InvalidReportError("boom").code).toBe("InvalidReport");
  });

  it("sets the ChecksumMismatchError code", () => {
    expect(new ChecksumMismatchError("boom").code).toBe("ChecksumMismatch");
  });

  it("names itself after its class so annotations and failures stay greppable", () => {
    expect(new ChecksumMismatchError("boom").name).toBe("ChecksumMismatchError");
  });

  it("carries the expected and actual digests when the mismatch is compared", () => {
    const error = new ChecksumMismatchError("the pack diverged", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(error.message).toBe("the pack diverged");
    expect(error.expected).toBe("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(error.actual).toBe("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("isCanaryActionError distinguishes typed errors from arbitrary errors", () => {
    expect(isCanaryActionError(new InvalidInputError("x"))).toBe(true);
    expect(isCanaryActionError(new Error("plain"))).toBe(false);
    expect(isCanaryActionError("not an error")).toBe(false);
  });
});

describe("describeError", () => {
  it("returns the message of an Error", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error value", () => {
    expect(describeError("plain string")).toBe("plain string");
  });

  it("stringifies a thrown plain object as its JSON representation", () => {
    // Third-party dependencies sometimes reject with bare objects. The
    // fallback branch serializes them as JSON so the message actually
    // conveys what was thrown instead of the useless "[object Object]".
    expect(describeError({ code: 500, details: "boom" })).toBe(
      '{"code":500,"details":"boom"}',
    );
  });

  it("stringifies a thrown array as its JSON representation", () => {
    // Arrays inherit Object.prototype's toString, so they would degrade to
    // "[object Object]" too; JSON keeps their contents visible.
    expect(describeError(["alpha", 2, false])).toBe('["alpha",2,false]');
  });

  it("falls back to default stringification for circular structures", () => {
    // Circular references make JSON.stringify throw; the fallback must not
    // throw either and degrades to the historical "[object Object]" output.
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(describeError(circular)).toBe("[object Object]");
  });

  it("falls back to default stringification when toJSON returns undefined", () => {
    // JSON.stringify(undefined) is undefined, so such objects cannot be
    // serialized and must take the String() fallback instead of collapsing
    // to the literal string "undefined".
    const unserializable = { toJSON: () => undefined };
    expect(describeError(unserializable)).toBe("[object Object]");
  });

  it("falls back to default stringification when toJSON throws", () => {
    // A hostile or buggy toJSON must not escape describeError as a new
    // exception; it is treated like any other unserializable object.
    const hostile = { toJSON: () => { throw new Error("toJSON exploded"); } };
    expect(describeError(hostile)).toBe("[object Object]");
  });

  it("stringifies a thrown number as its decimal literal", () => {
    // Locks down that numeric thrown values (e.g. C-style error codes)
    // survive the fallback branch unchanged rather than being wrapped in
    // additional text.
    expect(describeError(42)).toBe("42");
  });
});
