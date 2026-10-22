import { describe, expect, it, vi } from "vitest";
import { buildCommentBody, postPullRequestComment } from "../../src/comment";

const context = {
  eventName: "pull_request",
  repository: "example/project",
  pullRequest: 42,
  fork: false,
  workflow: "Canary",
  job: "check",
};

describe("PR comments", () => {
  it("bounds oversized comments and describes omitted content", () => {
    const body = buildCommentBody("x".repeat(100_000), "Canary", "check");
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain("omitted");
  });

  it("neutralizes forged marker text", () => {
    const body = buildCommentBody("<!-- protocol-canary-pr-comment:v1 -->", "Canary", "check");
    expect(body.match(/<!-- protocol-canary-pr-comment:v1 -->/g)).toHaveLength(1);
  });

  it("skips fork pull requests", async () => {
    const request = vi.fn();
    await postPullRequestComment("summary", "token", { ...context, fork: true }, request);
    expect(request).not.toHaveBeenCalled();
  });

  it("creates a comment when no existing bot comment matches", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true });
    await postPullRequestComment("summary", "token", context, request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![1]!.method).toBe("POST");
  });

  it("updates an existing bot comment", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 7, user: { type: "Bot" }, body: buildCommentBody("old", "Canary", "check") }],
      })
      .mockResolvedValueOnce({ ok: true });
    await postPullRequestComment("new", "token", context, request);
    expect(request.mock.calls[1]![1]!.method).toBe("PATCH");
    expect(request.mock.calls[1]![0]).toContain("/issues/comments/7");
  });

  it("does not fail when permission is denied", async () => {
    const request = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    await expect(postPullRequestComment("summary", "token", context, request)).resolves.toBeUndefined();
  });
});
