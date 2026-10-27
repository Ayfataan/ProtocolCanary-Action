import * as https from "node:https";
import type { IncomingHttpHeaders } from "node:http";

import { consumeResponse, MAX_API_RESPONSE_BYTES } from "./http-response";

export type GitHubRequestFailureKind = "network" | "timeout" | "server" | "rate-limit" | "http";

export class GitHubRequestError extends Error {
  constructor(
    message: string,
    readonly kind: GitHubRequestFailureKind,
    readonly statusCode?: number,
    readonly resetAt?: Date,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GitHubRequestError";
  }
}

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const OVERALL_TIMEOUT_MS = 25_000;
function rateLimitReset(headers: IncomingHttpHeaders | undefined): Date | undefined {
  if (headers === undefined) {
    return undefined;
  }
  const raw = headers["x-ratelimit-reset"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const seconds = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? new Date(seconds * 1000) : undefined;
}

function retryAfterMs(value: string | string[] | undefined): number | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  if (header === undefined) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function requestOnce(
  url: string,
  token: string | undefined,
  timeoutMs: number,
  maxResponseBytes: number,
  deadline: number,
): Promise<{ body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (hardTimer !== undefined) {
        clearTimeout(hardTimer);
        hardTimer = undefined;
      }
    };
    const settleResolve = (value: { body: string; headers: IncomingHttpHeaders }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    let hostname: string;
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "https:") {
        settleReject(new GitHubRequestError(`refusing non-HTTPS GitHub API URL ${url}`, "http"));
        return;
      }
      hostname = parsedUrl.hostname;
    } catch (error) {
      settleReject(new GitHubRequestError(`invalid GitHub API URL ${url}: ${String(error)}`, "http"));
      return;
    }

    const headers: Record<string, string> = {
      "User-Agent": "ProtocolCanary-Action",
      Accept: "application/vnd.github+json",
    };
    if (token !== undefined && hostname === "api.github.com") {
      headers.Authorization = `Bearer ${token}`;
    }

    const request = https.get(url, { headers, timeout: timeoutMs }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        const status = response.statusCode;
        const responseHeaders = response.headers ?? {};
        const resetAt = rateLimitReset(responseHeaders);
        const remainingHeader = responseHeaders["x-ratelimit-remaining"];
        const remaining = Array.isArray(remainingHeader) ? remainingHeader[0] : remainingHeader;
        const retryAfter = retryAfterMs(responseHeaders["retry-after"]);
        const rateLimited =
          (status === 403 || status === 429) && (remaining === "0" || responseHeaders["retry-after"] !== undefined);
        const kind: GitHubRequestFailureKind = rateLimited
          ? "rate-limit"
          : status !== undefined && status >= 500
            ? "server"
            : "http";
        settleReject(new GitHubRequestError(`GitHub returned status ${String(status)} for ${url}`, kind, status, resetAt, retryAfter));
        return;
      }

      const chunks: Buffer[] = [];
      consumeResponse(response, url, maxResponseBytes, (chunk) => chunks.push(chunk))
        .then(() => settleResolve({ body: Buffer.concat(chunks).toString("utf8"), headers: response.headers }))
        .catch((error: unknown) => {
          request?.destroy();
          settleReject(
            error instanceof GitHubRequestError
              ? error
              : new GitHubRequestError(
                  error instanceof Error ? error.message : String(error),
                  "http",
                  response.statusCode,
                ),
          );
        });
    });

    request.on("timeout", () => {
      request?.destroy(new GitHubRequestError(`timed out fetching ${url}`, "timeout"));
    });
    request.on("error", (error: Error) => {
      settleReject(
        error instanceof GitHubRequestError
          ? error
          : new GitHubRequestError(`network error fetching ${url}: ${error.message}`, "network"),
      );
    });

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      request.destroy(new GitHubRequestError(`timed out fetching ${url}`, "timeout"));
    } else {
      hardTimer = setTimeout(() => {
        request?.destroy(new GitHubRequestError(`timed out fetching ${url}`, "timeout"));
      }, remaining);
    }
  });
}

function retryDelay(error: GitHubRequestError, attempt: number): number | undefined {
  if (error.kind === "network" || error.kind === "server" || error.kind === "timeout") {
    return Math.min(250 * 2 ** (attempt - 1), 2_000);
  }
  return undefined;
}

/** Performs a bounded GitHub HTTPS GET, retrying only transient failures. */
export async function githubFetch(
  url: string,
  token?: string,
  maxResponseBytes = MAX_API_RESPONSE_BYTES,
): Promise<{ body: string; headers: IncomingHttpHeaders }> {
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  let lastError: GitHubRequestError | undefined;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    attemptsMade = attempt;
    try {
      return await requestOnce(url, token, Math.min(REQUEST_TIMEOUT_MS, remaining), maxResponseBytes, deadline);
    } catch (error) {
      lastError = error instanceof GitHubRequestError
        ? error
        : new GitHubRequestError(`network error fetching ${url}: ${String(error)}`, "network");
      if (attempt >= MAX_ATTEMPTS) {
        break;
      }
      const delay = retryDelay(lastError, attempt);
      if (delay === undefined || delay >= remaining) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  if (lastError?.kind === "rate-limit") {
    throw lastError;
  }

  const detail = lastError?.message ?? "overall request time limit exceeded";
  throw new GitHubRequestError(
    `GitHub API lookup failed${attemptsMade > 1 ? " after retries" : ""}: ${detail}`,
    lastError?.kind ?? "timeout",
    lastError?.statusCode,
    lastError?.resetAt,
    lastError?.retryAfterMs,
  );
}

export async function githubGetText(url: string, token?: string): Promise<string> {
  const { body } = await githubFetch(url, token);
  return body;
}
