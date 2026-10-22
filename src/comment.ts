import * as core from "@actions/core";

const MARKER = "<!-- protocol-canary-pr-comment:v1 -->";
const LIMIT = 60_000;

export interface CommentContext {
  eventName: string;
  repository: string;
  pullRequest: number | undefined;
  fork: boolean;
  workflow: string;
  job: string;
}

export function buildCommentBody(summary: string, workflow: string, job: string): string {
  // The summary renderer already escapes all engine-controlled Markdown.
  // Never let report text forge our hidden identity marker.
  const safe = summary.split(MARKER).join("&lt;!-- protocol-canary-pr-comment:v1 --&gt;");
  const identity = `${workflow} / ${job}`.replace(/[\r\n<>]/g, " ");
  const prefix = `${MARKER}\n<!-- workflow-job: ${identity} -->\n`;
  const suffix = "\n\n_Additional report details omitted to fit the comment limit. See the job summary._";
  return prefix + (prefix.length + safe.length <= LIMIT ? safe : safe.slice(0, LIMIT - prefix.length - suffix.length) + suffix);
}

export async function postPullRequestComment(
  summary: string,
  token: string | undefined,
  context: CommentContext,
  request: typeof fetch = fetch,
): Promise<void> {
  if (context.eventName !== "pull_request" || context.pullRequest === undefined) {
    core.info("PR comment skipped: not a pull_request event.");
    return;
  }
  if (context.fork) {
    core.info("PR comment skipped: fork pull requests use read-only permissions.");
    return;
  }
  if (!token) {
    core.warning("PR comment skipped: no GitHub token available.");
    return;
  }
  const [owner, repo] = context.repository.split("/");
  if (!owner || !repo) {
    core.warning("PR comment skipped: invalid repository context.");
    return;
  }
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const identity = `<!-- workflow-job: ${`${context.workflow} / ${context.job}`.replace(/[\r\n<>]/g, " ")} -->`;
  const body = buildCommentBody(summary, context.workflow, context.job);
  try {
    let existing: { id: number; body?: string } | undefined;
    for (let page = 1; page <= 10 && !existing; page++) {
      const response = await request(`${base}/issues/${context.pullRequest}/comments?per_page=100&page=${page}`, { headers });
      if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
      const comments = (await response.json()) as { id: number; body?: string; user?: { login?: string } }[];
      existing = comments.find((comment) => comment.body?.startsWith(MARKER + "\n" + identity + "\n"));
      if (comments.length < 100) break;
    }
    const url = existing ? `${base}/issues/comments/${existing.id}` : `${base}/issues/${context.pullRequest}/comments`;
    const response = await request(url, { method: existing ? "PATCH" : "POST", headers, body: JSON.stringify({ body }) });
    if (!response.ok) core.warning(`PR comment not published: GitHub API HTTP ${response.status}`);
  } catch (error) {
    core.warning(`PR comment not published: ${error instanceof Error ? error.message : "GitHub API error"}`);
  }
}
