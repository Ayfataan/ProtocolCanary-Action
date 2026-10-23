/**
 * Typed internal errors. Each one maps to a distinct, user-facing failure
 * category so that a compatibility failure (Canary ran and found a real
 * problem) is never confused with the Action failing to run Canary at all.
 */

export abstract class CanaryActionError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** An Action input failed validation before Canary was ever invoked. */
export class InvalidInputError extends CanaryActionError {
  readonly code = "InvalidInput";
}

/** A `config` input was given but the file does not exist. */
export class ConfigNotFoundError extends CanaryActionError {
  readonly code = "ConfigNotFound";

  constructor(readonly path: string) {
    super(`Configuration file not found: ${path}`);
  }
}

/** No usable `stellar-canary` binary could be found or installed. */
export class CanaryNotFoundError extends CanaryActionError {
  readonly code = "CanaryNotFound";
}

/** Installing the requested Canary version failed. */
export class InstallationFailedError extends CanaryActionError {
  readonly code = "InstallationFailed";

  constructor(message: string, readonly diagnostic?: string) {
    super(message);
  }
}

/**
 * A downloaded artifact (the fixture pack archive, or a release asset) was
 * found to diverge from its published SHA-256 checksum, or a computed pack
 * digest did not match the canonical registry digest. Verification aborts
 * before the artifact is used or handed to the extractor any further, so a
 * corrupted or tampered download can never reach the checks.
 */
export class ChecksumMismatchError extends CanaryActionError {
  readonly code = "ChecksumMismatch";

  constructor(
    message: string,
    readonly expected?: string,
    readonly actual?: string,
  ) {
    super(message);
  }
}

/** The Canary process could not be started or was killed abnormally. */
export class CanaryExecutionFailedError extends CanaryActionError {
  readonly code = "CanaryExecutionFailed";
}

/** The Canary process exceeded its allotted execution time. */
export class TimeoutError extends CanaryActionError {
  readonly code = "Timeout";

  constructor(
    message: string,
    readonly stdout: string = "",
    readonly stderr: string = "",
  ) {
    super(message);
  }
}

/** Canary's stdout could not be parsed as a report matching the documented schema. */
export class InvalidReportError extends CanaryActionError {
  readonly code = "InvalidReport";
}

/** Publishing the GitHub job summary failed. */
export class SummaryPublishFailedError extends CanaryActionError {
  readonly code = "SummaryPublishFailed";
}

/**
 * Narrows an unknown thrown value to a {@link CanaryActionError}. `main.ts`
 * uses this to distinguish an error this Action raised deliberately (which
 * carries a typed `code` and a safe, user-facing message) from any other
 * value that merely happened to be thrown, which must instead be routed
 * through `describeError`. Reuse this guard rather than re-checking
 * `instanceof CanaryActionError` inline, so the public error-handling
 * contract stays defined in one place.
 */
export function isCanaryActionError(error: unknown): error is CanaryActionError {
  return error instanceof CanaryActionError;
}

/**
 * Formats an unknown thrown value into a safe, single-line message.
 * Never includes a stack trace: stack traces are only surfaced via
 * `core.debug`, gated on `ACTIONS_STEP_DEBUG`, by the caller.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  // The default stringification of a thrown plain object or array is
  // "[object Object]", which carries no diagnostic information at all. Such
  // values do get thrown (some third-party dependencies reject with bare
  // objects), so prefer a JSON serialization when one is possible and fall
  // back to the default only when it is not (e.g. circular structures).
  if (typeof error === "object" && error !== null) {
    try {
      // An object whose `toJSON` returns undefined serializes as undefined;
      // anything else either produces a string or throws.
      const serialized: string | undefined = JSON.stringify(error);
      if (serialized !== undefined) {
        return serialized;
      }
    } catch {
      // Not representable as JSON; fall through to the default below.
    }
  }
  return String(error);
}
