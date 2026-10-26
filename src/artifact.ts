import { DefaultArtifactClient } from "@actions/artifact";
import * as core from "@actions/core";
import * as path from "node:path";

/**
 * The stable, documented artifact name used by the common case of a single
 * Action invocation per workflow run. It is always tried first, so existing
 * consumers are never silently renamed.
 */
export const ARTIFACT_NAME = "stellar-protocol-canary-report";

/**
 * Stable prefix of the Execution Receipt artifact (#362). The full name is
 * run-scoped (`stellar-canary-receipt-<run-id>`) so the receipt never
 * collides with the report artifact and downstream consumers can fetch it
 * by a predictable name.
 */
export const RECEIPT_ARTIFACT_PREFIX = "stellar-canary-receipt";

/**
 * Describes the result of an artifact upload attempt.
 *
 * `reason` is present only when `uploaded` is `false`; a successful upload
 * returns `true` without a reason. Upload failures are reported through this
 * outcome and are not thrown.
 */
export interface ArtifactUploadOutcome {
  /** Whether the report artifact was uploaded successfully. */
  readonly uploaded: boolean;
  /** The failure reason, present only when `uploaded` is `false`. */
  readonly reason?: string | undefined;
  /** The name of the artifact, present when `uploaded` is `true`. */
  readonly name?: string | undefined;
  /** The artifact ID, present when `uploaded` is `true` and returned by the client. */
  readonly id?: number | undefined;
}

/**
 * Reduces a caller-supplied differentiator (for example the resolved
 * protocol/network) to a value that is valid inside a GitHub artifact
 * name. GitHub permits alphanumerics, `-`, `_`, and `.`; everything else
 * collapses to `-`.
 */
function sanitizeDifferentiator(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Builds the name used when the stable {@link ARTIFACT_NAME} is already
 * taken in the current workflow run. A `differentiator` keeps the name
 * stable and predictable (e.g. `stellar-protocol-canary-report-protocol-28`);
 * without one, a short unique suffix is used so nothing collides.
 */
export function fallbackArtifactName(differentiator?: string): string {
  const suffix = differentiator === undefined ? "" : sanitizeDifferentiator(differentiator);
  if (suffix !== "") {
    return `${ARTIFACT_NAME}-${suffix}`;
  }
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return `${ARTIFACT_NAME}-${unique}`;
}

/**
 * True when `error` is the artifact API rejecting a name that already
 * exists in the current workflow run (a 409 Conflict), as opposed to any
 * other upload failure. `@actions/artifact` surfaces this as
 * `Received non-retryable error: Failed request: (409) Conflict: ...`.
 */
export function isArtifactNameCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/\(409\)/.test(message) || /conflict/i.test(message)) {
    return true;
  }
  return /already exists/i.test(message) && /artifact/i.test(message);
}

/**
 * Maximum attempts to upload a report artifact before giving up on collisions (#494).
 */
export const MAX_REPORT_UPLOAD_ATTEMPTS = 3;

/**
 * Builds candidate artifact names across successive attempts.
 * Attempt 1: stable name {@link ARTIFACT_NAME}.
 * Attempt 2: readable differentiator name when available, else a unique name.
 * Attempt 3+: unique name with short random suffix to guarantee distinct names.
 */
function candidateReportArtifactName(attempt: number, differentiator?: string): string {
  if (attempt === 1) {
    return ARTIFACT_NAME;
  }
  const hasDifferentiator = differentiator !== undefined && sanitizeDifferentiator(differentiator) !== "";
  if (attempt === 2 && hasDifferentiator) {
    return fallbackArtifactName(differentiator);
  }
  const base = hasDifferentiator ? fallbackArtifactName(differentiator) : ARTIFACT_NAME;
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return `${base}-${unique}`;
}

/**
 * Uploads the JSON report as a workflow artifact. Artifact upload is
 * always auxiliary (section 30/62 of the product spec): a failure here is
 * logged as a warning and reflected in the returned outcome, but it never
 * throws and never changes the underlying compatibility result.
 *
 * GitHub requires artifact names to be unique within a workflow run, so a
 * second invocation (a matrix leg, or a second Action step) would
 * otherwise fail to upload. The stable {@link ARTIFACT_NAME} is tried
 * first; only if the service reports that name as taken does the upload
 * retry under a name derived from `differentiator` (falling back to a
 * short unique suffix when none was provided or when multiple invocations
 * share the same differentiator, #494).
 */
export async function uploadReport(
  reportPath: string,
  differentiator?: string,
  retentionDays?: number,
  additionalFiles?: readonly string[],
): Promise<ArtifactUploadOutcome>;
export async function uploadReport(
  reportPath: string,
  differentiator?: string,
  additionalFiles?: readonly string[],
  retentionDays?: number,
): Promise<ArtifactUploadOutcome>;
export async function uploadReport(
  reportPath: string,
  differentiator?: string,
  arg3?: number | readonly string[],
  arg4?: readonly string[] | number,
): Promise<ArtifactUploadOutcome> {
  const retentionDays =
    typeof arg3 === "number" ? arg3 : typeof arg4 === "number" ? arg4 : undefined;
  const additionalFiles: readonly string[] =
    Array.isArray(arg3) ? arg3 : Array.isArray(arg4) ? arg4 : [];
  const files = [reportPath, ...additionalFiles];
  const options = retentionDays !== undefined ? { retentionDays } : undefined;
  const client = new DefaultArtifactClient();
  let previousName = ARTIFACT_NAME;
  let currentName = ARTIFACT_NAME;

  for (let attempt = 1; attempt <= MAX_REPORT_UPLOAD_ATTEMPTS; attempt += 1) {
    currentName = candidateReportArtifactName(attempt, differentiator);
    try {
      if (attempt > 1) {
        core.info(
          `Artifact name "${previousName}" is already used in this workflow run; ` +
            `uploading this report as "${currentName}" instead.`,
        );
      }
      const response = await client.uploadArtifact(
        currentName,
        files,
        path.dirname(reportPath),
        ...(options !== undefined ? [options] : []),
      );
      core.info(`Uploaded ${currentName} artifact.`);
      return {
        uploaded: true,
        name: currentName,
        ...(response?.id !== undefined ? { id: response.id } : {}),
      };
    } catch (error) {
      if (!isArtifactNameCollision(error) || attempt === MAX_REPORT_UPLOAD_ATTEMPTS) {
        const reason = error instanceof Error ? error.message : String(error);
        core.warning(`Failed to upload ${currentName} artifact: ${reason}`);
        return { uploaded: false, reason };
      }
      previousName = currentName;
    }
  }

  return { uploaded: false, reason: `Failed to upload artifact after ${MAX_REPORT_UPLOAD_ATTEMPTS} attempts.` };
}

/**
 * The artifact name for the Execution Receipt of the current workflow run:
 * `stellar-canary-receipt-<run-id>`, falling back to a short unique suffix
 * when `GITHUB_RUN_ID` is unavailable (outside a workflow) so the name is
 * never empty or colliding with itself.
 */
export function receiptArtifactName(runId: string | undefined): string {
  const id = runId?.trim() ?? "";
  if (id !== "") {
    return `${RECEIPT_ARTIFACT_PREFIX}-${sanitizeDifferentiator(id)}`;
  }
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return `${RECEIPT_ARTIFACT_PREFIX}-${unique}`;
}

/**
 * Uploads the Execution Receipt JSON (#362) as a run-scoped workflow
 * artifact. Like {@link uploadReport}, this is auxiliary: failures are
 * logged and reflected in the returned outcome, never thrown, and never
 * change the compatibility result. Because the name embeds the run id it is
 * unique per run already; if a second Action invocation in the *same* run
 * collides on it (409), the upload retries once under a short unique suffix,
 * mirroring the report artifact's collision behavior.
 */
export async function uploadReceipt(receiptPath: string): Promise<ArtifactUploadOutcome> {
  let name = receiptArtifactName(process.env.GITHUB_RUN_ID);
  const preferredName = name;
  try {
    const client = new DefaultArtifactClient();
    try {
      await client.uploadArtifact(name, [receiptPath], path.dirname(receiptPath));
    } catch (error) {
      if (!isArtifactNameCollision(error)) {
        throw error;
      }
      const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      name = `${preferredName}-${unique}`;
      core.info(
        `Artifact name "${preferredName}" is already used in this workflow run; ` +
          `uploading this receipt as "${name}" instead.`,
      );
      await client.uploadArtifact(name, [receiptPath], path.dirname(receiptPath));
    }
    core.info(`Uploaded ${name} artifact.`);
    return { uploaded: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to upload ${name} artifact: ${reason}`);
    return { uploaded: false, reason };
  }
}
