import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:https", () => ({
  get: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  warning: vi.fn(),
}));

import * as core from "@actions/core";
import * as https from "node:https";
import { InvalidInputError } from "../../src/errors";
import { MAX_API_RESPONSE_BYTES } from "../../src/http-response";
import {
  assessEngineVersion,
  DEPRECATED_BELOW_ENGINE_VERSION,
  LATEST_VALIDATED_ENGINE_VERSION,
  MIN_SUPPORTED_ENGINE_VERSION,
  resolveVersion,
} from "../../src/version";
import { githubFetch } from "../../src/github";

class FakeResponse extends EventEmitter {
  destroy(): void { this.emit("close"); }
  pause(): void {}
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  constructor(statusCode: number, headers: Record<string, string | string[] | undefined> = {}) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
  }
  setEncoding(): void {
    /* no-op for this fake */
  }
  resume(): void {
    /* no-op for this fake */
  }
}

class FakeRequest extends EventEmitter {
  destroy(): void {
    /* no-op for this fake */
  }
}

interface FakePage {
  statusCode?: number;
  body: string;
  /** Raw `Link` header value, when the page has a next page. */
  link?: string | string[];
  headers?: Record<string, string | string[] | undefined>;
}

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

/**
 * Serves the given pages in order, recording every request's URL and headers.
 * The last page is reused for any extra requests so a bug that over-fetches
 * cannot hang the suite.
 */
function mockHttpsPages(pages: FakePage[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  let index = 0;
  vi.mocked(https.get).mockImplementation((url, options, callback) => {
    const page = pages[Math.min(index, pages.length - 1)] ?? pages[0];
    if (page === undefined) {
      throw new Error("mockHttpsPages requires at least one page");
    }
    index += 1;
    const headers = ((options as { headers?: Record<string, string> } | undefined)?.headers ?? {}) as Record<
      string,
      string
    >;
    calls.push({ url: String(url), headers });
    const response = new FakeResponse(page.statusCode ?? 200, {
      ...(page.headers ?? {}),
      ...(page.link !== undefined ? { link: page.link } : {}),
    });
    const request = new FakeRequest();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (callback as any)(response);
    queueMicrotask(() => {
      response.emit("data", page.body);
      response.emit("end");
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return request as any;
  });
  return calls;
}

function tagsBody(entries: Array<{ name: string; sha: string }>): string {
  return JSON.stringify(entries.map((entry) => ({ name: entry.name, commit: { sha: entry.sha } })));
}

function nextLink(page: number): string {
  return `<https://api.github.com/repos/StellarCanary/Protocol-Canary/tags?per_page=100&page=${String(page)}>; rel="next"`;
}

const originalToken = process.env.GITHUB_TOKEN;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalToken;
  }
});

describe("resolveVersion", () => {
  // #192: successful parse of a valid commit SHA from the GitHub tags API.
  // Uses GitHub-shaped payloads — multiple tags in a realistic order and
  // full-length 40-hex SHAs — so the test pins that the sha is taken from
  // the *matching* entry (not the first one) and preserved byte for byte,
  // with no truncation or normalization.
  it("parses the full commit sha of the matching tag from the GitHub tags API (#192)", async () => {
    const linuxSha = "3f2a9c8d7e6b5a4938271605f4e3d2c1b0a99887";
    const targetSha = "c1a7f00d5e8b9273645f0e1d2c3b4a5968778695";
    const v2Sha = "0f1e2d3c4b5a69788796a5b4c3d2e1f00918a7b6";
    mockHttpsPages([
      {
        body: JSON.stringify([
          { name: "v0.2.0", commit: { sha: linuxSha } },
          { name: "v0.1.0", commit: { sha: targetSha } },
          { name: "v0.0.1", commit: { sha: v2Sha } },
        ]),
      },
    ]);

    const resolved = await resolveVersion("0.1.0");

    expect(resolved).toEqual({ version: "0.1.0", tag: "v0.1.0", commitSha: targetSha });
    expect(resolved.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(resolved.commitSha).not.toBe(linuxSha);
    expect(resolved.commitSha).not.toBe(v2Sha);
    // One page fetched, no pagination needed for a first-page match.
    expect(vi.mocked(https.get)).toHaveBeenCalledTimes(1);
  });

  it("resolves a matching tag to its commit sha", async () => {
    const calls = mockHttpsPages([{ body: tagsBody([{ name: "v0.1.0", sha: "abc123" }]) }]);
    const resolved = await resolveVersion("0.1.0");
    expect(resolved).toEqual({ version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" });
    // A first-page match must not fetch a second page.
    expect(calls).toHaveLength(1);
  });

  it("warns when the tag is confirmed absent from the upstream tag list", async () => {
    mockHttpsPages([{ body: tagsBody([{ name: "v9.9.9", sha: "zzz" }]) }]);
    const resolved = await resolveVersion("0.1.0");
    expect(resolved.commitSha).toBeUndefined();
    expect(resolved.tag).toBe("v0.1.0");
    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining("Could not find upstream tag v0.1.0"),
    );
    expect(vi.mocked(core.debug)).not.toHaveBeenCalled();
  });

  it("logs at debug level when the GitHub API call itself fails", async () => {
    mockHttpsPages([{ statusCode: 400, body: "" }]);
    await expect(resolveVersion("0.1.0")).resolves.toMatchObject({ commitSha: undefined });
    expect(vi.mocked(core.warning)).not.toHaveBeenCalled();
    expect(vi.mocked(core.debug)).toHaveBeenCalledWith(
      expect.stringContaining("Could not resolve v0.1.0 to a commit sha"),
    );
  });

  it("retries a transient 503 and resolves successfully without warning", async () => {
    vi.useFakeTimers();
    const calls = mockHttpsPages([
      { statusCode: 503, body: "" },
      { body: tagsBody([{ name: "v0.1.0", sha: "abc123" }]) },
    ]);
    const pending = resolveVersion("0.1.0");

    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toMatchObject({ commitSha: "abc123" });

    expect(calls).toHaveLength(2);
    expect(vi.mocked(core.warning)).not.toHaveBeenCalled();
  });

  it("warns after three consecutive 503 responses", async () => {
    vi.useFakeTimers();
    const calls = mockHttpsPages([{ statusCode: 503, body: "" }]);
    const pending = resolveVersion("0.1.0");

    await vi.advanceTimersByTimeAsync(750);
    await expect(pending).resolves.toMatchObject({ commitSha: undefined });

    expect(calls).toHaveLength(3);
    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining("GitHub API lookup for v0.1.0 failed after retries"),
    );
  });

  it("does not retry a primary rate limit and warns when it resets", async () => {
    const resetSeconds = Math.floor((Date.now() + 60_000) / 1000);
    const calls = mockHttpsPages([
      {
        statusCode: 403,
        body: "",
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetSeconds),
          "retry-after": "1",
        },
      },
    ]);

    await expect(resolveVersion("0.1.0")).resolves.toMatchObject({ commitSha: undefined });

    expect(calls).toHaveLength(1);
    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining(`The rate limit resets at ${new Date(resetSeconds * 1000).toISOString()}`),
    );
  });

  it("bounds total retry delay with fake timers", async () => {
    vi.useFakeTimers();
    const calls = mockHttpsPages([{ statusCode: 503, body: "" }]);
    const start = Date.now();
    const pending = githubFetch("https://api.github.com/repos/StellarCanary/Protocol-Canary/tags");
    const rejected = expect(pending).rejects.toThrow("failed after retries");

    await vi.advanceTimersByTimeAsync(749);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;

    expect(calls).toHaveLength(3);
    expect(Date.now() - start).toBe(750);
  });

  it("degrades to commitSha undefined on a timed-out tag lookup request, never throwing (#263)", async () => {
    // fetchTagsPage has its own "timeout" handler (distinct from the
    // checksum-lookup timeout in canary.ts): it destroys the request with an
    // error, which reaches the promise chain as a rejection that
    // resolveVersion's catch turns into commitSha: undefined. Serving pages
    // would never exercise it, so the mock is driven directly here: a fake
    // request that only ever emits "timeout".
    delete process.env.GITHUB_TOKEN;
    class TimeoutOnlyRequest extends EventEmitter {
      // Real ClientRequest.destroy(error) emits "error" with that error —
      // exactly how the timeout rejection travels to fetchTagsPage's reject.
      destroy(error?: Error): void {
        if (error !== undefined) {
          this.emit("error", error);
        }
      }
    }
    const request = new TimeoutOnlyRequest();
    vi.mocked(https.get).mockImplementation(() => {
      // Emit after the handlers are attached (fetchTagsPage wires "timeout"
      // synchronously after https.get returns, so a queued emission always
      // lands on a wired handler).
      queueMicrotask(() => request.emit("timeout"));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return request as any;
    });

    await expect(resolveVersion("0.1.0")).resolves.toEqual({
      version: "0.1.0",
      tag: "v0.1.0",
      commitSha: undefined,
    });
    expect(vi.mocked(https.get)).toHaveBeenCalledTimes(1);
  });

  it("degrades to commitSha undefined on malformed JSON, never throwing", async () => {
    mockHttpsPages([{ body: "not json" }]);
    await expect(resolveVersion("0.1.0")).resolves.toMatchObject({ commitSha: undefined });
  });

  it("degrades to commitSha undefined on well-formed JSON of an unexpected shape, never throwing", async () => {
    // GitHub returns 200-shaped error bodies for some proxied failures; the
    // tags list contract (an array) must reject them the same way, and
    // InstallationFailedError stays confined to `cargo install` in canary.ts.
    mockHttpsPages([{ body: '{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest"}' }]);
    await expect(resolveVersion("0.1.0")).resolves.toMatchObject({ commitSha: undefined });
  });

  it("sends an Authorization: Bearer header when an explicit token is supplied", async () => {
    const calls = mockHttpsPages([{ body: tagsBody([{ name: "v0.1.0", sha: "abc123" }]) }]);
    await resolveVersion("0.1.0", { token: "ghp_explicit" });
    expect(calls[0]?.headers.Authorization).toBe("Bearer ghp_explicit");
    // The unauthenticated User-Agent/Accept contract is unchanged.
    expect(calls[0]?.headers["User-Agent"]).toBe("ProtocolCanary-Action");
  });

  it("treats a whitespace-only explicit token as no token", async () => {
    delete process.env.GITHUB_TOKEN;
    const calls = mockHttpsPages([{ body: tagsBody([{ name: "v0.1.0", sha: "abc123" }]) }]);
    await resolveVersion("0.1.0", { token: " \t\n " });
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it("falls back to GITHUB_TOKEN from the environment when no explicit token is given", async () => {
    process.env.GITHUB_TOKEN = "ghp_from_env";
    const calls = mockHttpsPages([{ body: tagsBody([{ name: "v0.1.0", sha: "abc123" }]) }]);
    await resolveVersion("0.1.0");
    expect(calls[0]?.headers.Authorization).toBe("Bearer ghp_from_env");
  });

  it("sends no Authorization header when an explicit token is whitespace-only (#262)", async () => {
    // resolveToken counts blank/whitespace-only values as "no token" so an
    // empty secret never produces a bad header. An explicit whitespace-only
    // token — not just an unset GITHUB_TOKEN — must land on that same path.
    delete process.env.GITHUB_TOKEN;
    const calls = mockHttpsPages([{ body: tagsBody([{ name: "v0.1.0", sha: "abc123" }]) }]);
    const resolved = await resolveVersion("0.1.0", { token: "   " });
    expect(calls[0]?.headers).not.toHaveProperty("Authorization");
    // The unauthenticated lookup still succeeds and pins the commit.
    expect(resolved).toEqual({ version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" });
  });

  it("sends no Authorization header when no token is available", async () => {
    delete process.env.GITHUB_TOKEN;
    const calls = mockHttpsPages([{ body: tagsBody([{ name: "v0.1.0", sha: "abc123" }]) }]);
    const resolved = await resolveVersion("0.1.0");
    expect(calls[0]?.headers.Authorization).toBeUndefined();
    // Preserves the existing unauthenticated first-page-match behavior.
    expect(resolved.commitSha).toBe("abc123");
  });

  it("paginates across pages, following Link rel=next, until the tag is found", async () => {
    const calls = mockHttpsPages([
      { body: tagsBody([{ name: "v9.9.9", sha: "zzz" }]), link: nextLink(2) },
      { body: tagsBody([{ name: "v9.9.8", sha: "yyy" }]), link: nextLink(3) },
      { body: tagsBody([{ name: "v0.1.0", sha: "abc123" }]) },
    ]);
    const resolved = await resolveVersion("0.1.0");
    expect(resolved.commitSha).toBe("abc123");
    expect(calls).toHaveLength(3);
    expect(calls[1]?.url).toContain("page=2");
    expect(calls[2]?.url).toContain("page=3");
  });

  it("keeps the Authorization header on every paginated request", async () => {
    process.env.GITHUB_TOKEN = "ghp_from_env";
    const calls = mockHttpsPages([
      { body: tagsBody([{ name: "v9.9.9", sha: "zzz" }]), link: nextLink(2) },
      { body: tagsBody([{ name: "v0.1.0", sha: "abc123" }]) },
    ]);
    await resolveVersion("0.1.0");
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.headers.Authorization === "Bearer ghp_from_env")).toBe(true);
  });

  it("degrades to commitSha undefined when every page is exhausted without a match", async () => {
    mockHttpsPages([
      { body: tagsBody([{ name: "v9.9.9", sha: "zzz" }]), link: nextLink(2) },
      { body: tagsBody([{ name: "v9.9.8", sha: "yyy" }]) },
    ]);
    await expect(resolveVersion("0.1.0")).resolves.toMatchObject({ commitSha: undefined });
  });

  it("terminates pagination when a Link header contains relations other than rel=next", async () => {
    const otherLink =
      '<https://api.github.com/repos/StellarCanary/Protocol-Canary/tags?per_page=100&page=1>; rel="first", ' +
      '<https://api.github.com/repos/StellarCanary/Protocol-Canary/tags?per_page=100&page=3>; rel="last"';
    const calls = mockHttpsPages([{ body: tagsBody([{ name: "v9.9.9", sha: "zzz" }]), link: otherLink }]);

    const resolved = await resolveVersion("0.1.0");

    expect(resolved.commitSha).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining("Could not find upstream tag v0.1.0"),
    );
  });

  it("supports array-valued Link headers (string[]) from the HTTP response", async () => {
    const linkArray = [
      '<https://api.github.com/repos/StellarCanary/Protocol-Canary/tags?per_page=100&page=2>; rel="next"',
      '<https://api.github.com/repos/StellarCanary/Protocol-Canary/tags?per_page=100&page=5>; rel="last"',
    ];
    const calls = mockHttpsPages([
      { body: tagsBody([{ name: "v9.9.9", sha: "zzz" }]), link: linkArray },
      { body: tagsBody([{ name: "v0.1.0", sha: "abc123" }]) },
    ]);

    const resolved = await resolveVersion("0.1.0");

    expect(resolved.commitSha).toBe("abc123");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("page=2");
  });

  it("degrades to commitSha undefined when a Link header carries an invalid URL", async () => {
    mockHttpsPages([
      {
        body: tagsBody([{ name: "v9.9.9", sha: "zzz" }]),
        link: '<not a valid url>; rel="next"',
      },
    ]);

    const resolved = await resolveVersion("0.1.0");

    expect(resolved.commitSha).toBeUndefined();
    expect(vi.mocked(core.debug)).toHaveBeenCalledWith(
      expect.stringContaining("Could not resolve v0.1.0 to a commit sha"),
    );
  });

  it("caps pagination at MAX_TAG_PAGES when the Link header never terminates", async () => {
    // A malformed or hostile Link header must spin the page walk forever;
    // every request re-serves this page, so the loop has to stop itself.
    const calls = mockHttpsPages([{ body: tagsBody([{ name: "v9.9.9", sha: "zzz" }]), link: nextLink(2) }]);
    await expect(resolveVersion("0.1.0")).resolves.toMatchObject({ commitSha: undefined });
    expect(calls).toHaveLength(50);
  });

  it.each([
    ["a missing commit object", [{ name: "v0.1.0" }]],
    ["an empty commit.sha", [{ name: "v0.1.0", commit: { sha: "" } }]],
    ["a non-string commit.sha", [{ name: "v0.1.0", commit: { sha: 123 } }]],
  ])("degrades to commitSha undefined when the matched tag has %s, never throwing", async (_shape, tags) => {
    // Distinct from "tag not found": the tag *is* present, but the entry has
    // an unexpected GitHub API shape. resolveTagCommit rejects, yet
    // resolveVersion's "never throws" contract still requires it to resolve
    // with commitSha undefined and fall back to tag pinning.
    // Uses the paginating mockHttpsPages helper so a matching tag on the first
    // page needs no Link header, mirroring the not-found cases above.
    mockHttpsPages([{ body: JSON.stringify(tags) }]);
    const resolved = await resolveVersion("0.1.0");
    expect(resolved).toEqual({ version: "0.1.0", tag: "v0.1.0", commitSha: undefined });
  });

  it("prefers explicit options.token over GITHUB_TOKEN environment variable", async () => {
    process.env.GITHUB_TOKEN = "env-token";
    const calls = mockHttpsPages([{ body: tagsBody([{ name: "v0.1.0", sha: "sha-123" }]) }]);

    await resolveVersion("0.1.0", { token: "explicit-token" });

    expect(calls[0]?.headers.Authorization).toBe("Bearer explicit-token");
  });

  it("falls back to GITHUB_TOKEN when options.token is whitespace-only", async () => {
    process.env.GITHUB_TOKEN = "env-token";
    const calls = mockHttpsPages([{ body: tagsBody([{ name: "v0.1.0", sha: "sha-123" }]) }]);

    await resolveVersion("0.1.0", { token: "   \t  \n " });

    expect(calls[0]?.headers.Authorization).toBe("Bearer env-token");
  });

  it("attaches Authorization header only when request host is api.github.com", async () => {
    const calls = mockHttpsPages([
      {
        body: tagsBody([{ name: "v9.9.9", sha: "other" }]),
        link: '<https://untrusted.host.test/tags?page=2>; rel="next"',
      },
      {
        body: tagsBody([{ name: "v0.1.0", sha: "sha-123" }]),
      },
    ]);

    await resolveVersion("0.1.0", { token: "secret-token" });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.Authorization).toBe("Bearer secret-token");
    expect(calls[1]?.headers.Authorization).toBeUndefined();
  });
});

/**
 * #374: supported engine range and deprecation warnings. The default engine
 * version 0.1.1 is fully supported and must never warn, so a normal run stays
 * noise-free; only releases strictly older than 0.1.0 (or unvalidated future
 * majors) produce an annotation.
 */
describe("assessEngineVersion", () => {
  it("accepts the default 0.1.1 version without a warning", () => {
    expect(assessEngineVersion("0.1.1")).toEqual({
      version: "0.1.1",
      supported: true,
      warning: undefined,
    });
  });

  it("accepts a newer release on the supported 0.x line without a warning", () => {
    expect(assessEngineVersion("0.2.0")).toEqual({
      version: "0.2.0",
      supported: true,
      warning: undefined,
    });
  });

  it("reports 0.1.0 as outside the supported range but not deprecated", () => {
    // 0.1.0 predates the supported >= 0.1.1 range, yet no deprecation
    // decision covers it, so it must not produce warning noise.
    const result = assessEngineVersion("0.1.0");
    expect(result.supported).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it("warns for an engine strictly older than 0.1.0", () => {
    const result = assessEngineVersion("0.0.9");
    expect(result.supported).toBe(false);
    expect(result.warning).toContain("older than 0.1.0");
    expect(result.warning).toContain("no longer supported");
    expect(result.warning).toContain(LATEST_VALIDATED_ENGINE_VERSION);
  });

  it("warns for an unvalidated future major release", () => {
    const result = assessEngineVersion("1.0.0");
    expect(result.warning).toContain("not verified");
    expect(result.warning).toContain(LATEST_VALIDATED_ENGINE_VERSION);
  });

  it("compares numeric components rather than strings", () => {
    // A lexicographic comparison would call 0.10.0 "older" than 0.9.0.
    expect(assessEngineVersion("0.10.0").warning).toBeUndefined();
    expect(assessEngineVersion("0.10.0").supported).toBe(true);
    expect(assessEngineVersion("0.0.10").warning).toContain("older than 0.1.0");
  });

  it("trims surrounding whitespace", () => {
    expect(assessEngineVersion("  0.1.1  ")).toEqual({
      version: "0.1.1",
      supported: true,
      warning: undefined,
    });
  });

  it.each(["latest", "main", "1.2", "1.2.3.4", "v0.1.1", "", "0.1.x", "1.2.3-rc.1"])(
    "rejects the invalid engine version %s with InvalidInputError",
    (value) => {
      expect(() => assessEngineVersion(value)).toThrow(InvalidInputError);
      expect(() => assessEngineVersion(value)).toThrow(/semantic version/);
    },
  );

  it("exposes the documented policy constants", () => {
    expect(MIN_SUPPORTED_ENGINE_VERSION).toBe("0.1.1");
    expect(DEPRECATED_BELOW_ENGINE_VERSION).toBe("0.1.0");
    expect(LATEST_VALIDATED_ENGINE_VERSION).toBe("0.1.1");
  });
});


describe("bounded tag pages (#500)", () => {
  it.each(["exact", "oversized", "header", "lying", "aborted", "short", "split"])("handles a %s response without using partial JSON", async (kind) => {
    const body = Buffer.from(tagsBody([{ name: "v0.2.0", sha: "a".repeat(40) }]) + " ".repeat(MAX_API_RESPONSE_BYTES));
    const response = new FakeResponse(200, kind === "header" ? { "content-length": String(MAX_API_RESPONSE_BYTES + 1) } : kind === "lying" ? { "content-length": "1" } : kind === "short" ? { "content-length": String(MAX_API_RESPONSE_BYTES) } : {});
    const destroyed = vi.spyOn(response, "destroy");
    const request = new FakeRequest();
    const requestDestroyed = vi.spyOn(request, "destroy");
    let delivered = 0;
    vi.mocked(https.get).mockImplementation((_url, _options, callback) => {
      queueMicrotask(() => {
        callback!(response as unknown as Parameters<NonNullable<typeof callback>>[0]);
        const bytes = kind === "split" ? Buffer.from('[{"name":"v0.2.0","commit":{"sha":"é"}}]') : body.subarray(0, kind === "short" ? 100 : MAX_API_RESPONSE_BYTES);
        const split = kind === "split" ? bytes.indexOf(0xc3) + 1 : bytes.length;
        const chunks = [bytes.subarray(0, split), bytes.subarray(split)];
        if (kind === "oversized" || kind === "lying") chunks.push(Buffer.from(" "));
        for (const chunk of chunks) {
          if (destroyed.mock.calls.length > 0) break;
          delivered++;
          response.emit("data", chunk);
        }
        response.emit(kind === "aborted" ? "aborted" : "end");
      });
      return request as unknown as ReturnType<typeof https.get>;
    });
    const result = await resolveVersion("0.2.0");
    expect(result.commitSha).toBe(kind === "exact" ? "a".repeat(40) : kind === "split" ? "é" : undefined);
    if (kind === "header") expect(delivered).toBe(0);
    if (kind !== "exact" && kind !== "split") {
      expect(destroyed).toHaveBeenCalled();
      expect(requestDestroyed).toHaveBeenCalled();
    }
  });
});
