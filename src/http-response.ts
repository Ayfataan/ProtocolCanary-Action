import type { IncomingMessage } from "node:http";

/** Per-response ceilings; no compression is requested. If compression is added,
 * enforce these limits on decoded bytes. The issue #500 baseline is a 94-byte
 * manifest and roughly 5 MB binary: these allow substantial growth while
 * bounding memory/disk consumption. API pages/releases have a separate budget. */
export const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_CHECKSUM_MANIFEST_BYTES = 1024 * 1024;
export const MAX_RELEASE_ASSET_BYTES = 64 * 1024 * 1024;

/** Consume a complete response, rejecting before delivering any over-budget
 * chunk. Callers destroy the request on rejection; this helper destroys the
 * response. Content-Length is only an early check, never a substitute for
 * counting actual bytes. No partial body is returned on failure. */
export function consumeResponse(
  response: IncomingMessage,
  url: string,
  limit: number,
  onChunk: (chunk: Buffer) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let received = 0;
    const host = new URL(url).host;
    const header = response.headers["content-length"];
    const expected = typeof header === "string" && /^\d+$/.test(header) ? Number(header) : undefined;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      response.destroy();
      reject(error);
    };
    const oversized = (): Error => new Error(`HTTP response from ${host} exceeds the ${limit}-byte limit`);
    response.on("error", fail);
    response.on("aborted", () => fail(new Error(`HTTP response from ${host} was aborted`)));
    response.on("close", () => {
      if (!settled) fail(new Error(`HTTP response from ${host} ended prematurely`));
    });
    if (expected !== undefined && expected > limit) {
      fail(oversized());
      return;
    }
    response.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      received += bytes.length;
      if (received > limit) {
        fail(oversized());
        return;
      }
      try {
        onChunk(bytes);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    response.on("end", () => {
      if (settled) return;
      if (response.complete === false || (expected !== undefined && received !== expected)) {
        fail(new Error(`HTTP response from ${host} ended with an incomplete body`));
        return;
      }
      settled = true;
      resolve();
    });
  });
}

/** Decode only after collecting complete bounded bytes, preserving UTF-8
 * characters split across transport chunks. */
export async function readResponseText(response: IncomingMessage, url: string, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  await consumeResponse(response, url, limit, (chunk) => { chunks.push(chunk); });
  return Buffer.concat(chunks).toString("utf8");
}
