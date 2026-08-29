import { Octokit } from "@octokit/rest";

import type { Logger } from "@loupe/logger";

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

/**
 * Octokit's default logger prints request warnings (like the expected 404s from
 * probing for optional convention docs) straight to the console. Route them all
 * through our logger at debug so they don't clutter info-level output.
 */
export function makeOctokit(token: string, logger: Logger): Octokit {
  return new Octokit({
    auth: token,
    log: {
      debug: (m) => logger.debug(m),
      info: (m) => logger.debug(m),
      warn: (m) => logger.debug(m),
      error: (m) => logger.debug(m),
    },
  });
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
export type Conventions = {
  /** Concatenated doc bodies for the prompt. */
  readonly text: string;
  /** Which requested paths actually resolved to a file at the PR head. */
  readonly found: readonly string[];
};

export async function fetchConventions(
  octokit: Octokit,
  ref: PullRef,
  paths: readonly string[],
): Promise<Conventions> {
  const { data: pr } = await octokit.pulls.get(ref);
  const sha = pr.head.sha;
  const parts: string[] = [];
  const found: string[] = [];
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
        found.push(path);
      }
    } catch {
      // file not present at head — skip
    }
  }
  return { text: parts.join("\n\n---\n\n"), found };
}

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  blocker: "🔴 blocker",
  warning: "🟡 warning",
  nit: "🔵 nit",
};

/** Hidden marker (per reviewer) stamped on loupe's own comments so a later run
 * can find and clean up the previous run's comments instead of piling on. */
function marker(reviewerName: string | undefined): string {
  return `<!-- loupe:${reviewerName ?? "default"} -->`;
}

/**
 * Delete this reviewer's inline comments from a previous run, so re-reviewing a
 * PR (e.g. on every push) replaces its comments rather than duplicating them.
 * Best-effort: a failure here must not block posting the new review.
 */
async function deletePriorComments(
  octokit: Octokit,
  ref: PullRef,
  reviewerName: string | undefined,
  logger: Logger,
): Promise<void> {
  const tag = marker(reviewerName);
  try {
    const comments = await octokit.paginate(octokit.pulls.listReviewComments, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pull_number,
      per_page: 100,
    });
    const mine = comments.filter((c) => c.body.includes(tag));
    for (const c of mine) {
      await octokit.pulls.deleteReviewComment({
        owner: ref.owner,
        repo: ref.repo,
        comment_id: c.id,
      });
    }
    if (mine.length > 0) {
      logger.debug("Removed prior loupe comments", { count: mine.length });
    }
  } catch (err) {
    logger.warn("Could not clean up prior loupe comments", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Post one review with inline comments. Uses REQUEST_CHANGES when any inline
 * finding is a blocker, otherwise COMMENT — never APPROVE (a bot shouldn't be a
 * required approver). Off-diff findings are appended to the summary body. First
 * clears this reviewer's comments from the previous run so re-reviews replace
 * rather than accumulate.
 */
export async function postReview(
  octokit: Octokit,
  ref: PullRef,
  review: ReviewOutput,
  inline: readonly Finding[],
  dropped: readonly Finding[],
  reviewerName: string | undefined,
  logger: Logger,
): Promise<void> {
  await deletePriorComments(octokit, ref, reviewerName, logger);

  const hasBlocker = inline.some((f) => f.severity === "blocker");
  const droppedNote =
    dropped.length > 0
      ? `\n\n**Additional notes (could not anchor to the diff):**\n` +
        dropped.map((f) => `- \`${f.path}:${f.line}\` — ${f.body}`).join("\n")
      : "";
  const title = reviewerName ? `loupe · ${reviewerName}` : "loupe review";
  const tag = marker(reviewerName);

  await octokit.pulls.createReview({
    ...ref,
    event: hasBlocker ? "REQUEST_CHANGES" : "COMMENT",
    body: `🔍 **${title}**\n\n${review.summary}${droppedNote}\n\n${tag}`,
    comments: inline.map((f) => ({
      path: f.path,
      line: f.line,
      body: `**${SEVERITY_LABEL[f.severity]}** ${f.body}\n\n${tag}`,
    })),
  });
}
