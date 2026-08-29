import { Octokit } from "@octokit/rest";

import type { DiffFile } from "./diff";
import type { Finding, ReviewOutput } from "./types";

export type PullRef = {
  readonly owner: string;
  readonly repo: string;
  readonly pull_number: number;
};

export type PullContext = {
  readonly title: string;
  readonly description: string;
  readonly files: readonly DiffFile[];
};

export function makeOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
}

/** Fetch PR metadata and the changed files (with patches) in one place. */
export async function fetchPullContext(
  octokit: Octokit,
  ref: PullRef,
): Promise<PullContext> {
  const { data: pr } = await octokit.pulls.get(ref);
  const files = await octokit.paginate(octokit.pulls.listFiles, {
    ...ref,
    per_page: 100,
  });
  return {
    title: pr.title,
    description: pr.body ?? "",
    files: files.map((f) => ({ path: f.filename, patch: f.patch })),
  };
}

/**
 * Fetch the target repo's own convention docs at the PR head, in priority
 * order. Concatenated so the reviewer enforces the repo's actual rules rather
 * than a vendored copy. Missing files are skipped silently.
 */
export async function fetchConventions(
  octokit: Octokit,
  ref: PullRef,
  paths: readonly string[],
): Promise<string> {
  const { data: pr } = await octokit.pulls.get(ref);
  const sha = pr.head.sha;
  const parts: string[] = [];
  for (const path of paths) {
    try {
      const { data } = await octokit.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path,
        ref: sha,
      });
      if ("content" in data && data.type === "file") {
        const text = Buffer.from(data.content, "base64").toString("utf8");
        parts.push(`# ${path}\n\n${text}`);
      }
    } catch {
      // file not present at head — skip
    }
  }
  return parts.join("\n\n---\n\n");
}

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  blocker: "🔴 blocker",
  warning: "🟡 warning",
  nit: "🔵 nit",
};

/**
 * Post one review with inline comments. Uses REQUEST_CHANGES when any inline
 * finding is a blocker, otherwise COMMENT — never APPROVE (a bot shouldn't be a
 * required approver). Off-diff findings are appended to the summary body.
 */
export async function postReview(
  octokit: Octokit,
  ref: PullRef,
  review: ReviewOutput,
  inline: readonly Finding[],
  dropped: readonly Finding[],
): Promise<void> {
  const hasBlocker = inline.some((f) => f.severity === "blocker");
  const droppedNote =
    dropped.length > 0
      ? `\n\n**Additional notes (could not anchor to the diff):**\n` +
        dropped.map((f) => `- \`${f.path}:${f.line}\` — ${f.body}`).join("\n")
      : "";

  await octokit.pulls.createReview({
    ...ref,
    event: hasBlocker ? "REQUEST_CHANGES" : "COMMENT",
    body: `🔍 **loupe review**\n\n${review.summary}${droppedNote}`,
    comments: inline.map((f) => ({
      path: f.path,
      line: f.line,
      body: `**${SEVERITY_LABEL[f.severity]}** ${f.body}`,
    })),
  });
}
