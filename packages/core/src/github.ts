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
  /** The PR head commit SHA (what this review is of). */
  readonly headSha: string;
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
    headSha: pr.head.sha,
  };
}

/**
 * The head SHA this reviewer last reviewed, read from the sha stamped in its
 * most recent review's marker. Undefined if it has never reviewed this PR.
 */
export async function getLastReviewedSha(
  octokit: Octokit,
  ref: PullRef,
  reviewerName: string | undefined,
): Promise<string | undefined> {
  const prefix = markerPrefix(reviewerName);
  try {
    const reviews = await octokit.paginate(octokit.pulls.listReviews, {
      ...ref,
      per_page: 100,
    });
    for (const r of reviews.reverse()) {
      if (r.body?.includes(prefix)) {
        const m = /sha=([0-9a-f]{7,40})/.exec(r.body);
        if (m) return m[1];
      }
    }
  } catch {
    // treat as no prior review
  }
  return undefined;
}

/** Post a top-level PR comment (used for chat replies). */
export async function postIssueComment(
  octokit: Octokit,
  ref: PullRef,
  body: string,
): Promise<void> {
  await octokit.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.pull_number,
    body,
  });
}

/** Files changed between two commits (the incremental-review delta). */
export async function changedFilesBetween(
  octokit: Octokit,
  ref: PullRef,
  base: string,
  head: string,
): Promise<Set<string>> {
  const { data } = await octokit.repos.compareCommits({
    owner: ref.owner,
    repo: ref.repo,
    base,
    head,
  });
  return new Set((data.files ?? []).map((f) => f.filename));
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

/** Per-reviewer marker prefix; the sha is appended per run. Comments and the
 * review body carry it so a later run can find and clean up its own output. */
function markerPrefix(reviewerName: string | undefined): string {
  return `<!-- loupe:${reviewerName ?? "default"} `;
}
function makeMarker(reviewerName: string | undefined, sha: string): string {
  return `${markerPrefix(reviewerName)}sha=${sha} -->`;
}

/**
 * Delete this reviewer's inline comments from a previous run so re-reviews
 * replace rather than duplicate. When `refreshPaths` is given (incremental
 * review), only comments on those files are removed — comments on files
 * unchanged since the last review are kept. Best-effort: never blocks posting.
 */
async function deletePriorComments(
  octokit: Octokit,
  ref: PullRef,
  reviewerName: string | undefined,
  logger: Logger,
  refreshPaths?: ReadonlySet<string>,
): Promise<void> {
  const prefix = markerPrefix(reviewerName);
  try {
    const comments = await octokit.paginate(octokit.pulls.listReviewComments, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pull_number,
      per_page: 100,
    });
    const mine = comments.filter(
      (c) =>
        c.body.includes(prefix) && (!refreshPaths || refreshPaths.has(c.path)),
    );
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

const SEV_EMOJI: Record<Finding["severity"], string> = {
  blocker: "🔴",
  warning: "🟡",
  nit: "🔵",
};

/** One-line severity tally across inline findings + PR-level concerns. */
function statLine(
  inline: readonly Finding[],
  review: ReviewOutput,
  fileCount: number,
): string {
  const all = [...inline, ...review.concerns];
  const n = (s: Finding["severity"]): number =>
    all.filter((f) => f.severity === s).length;
  const bits: string[] = [];
  if (n("blocker")) bits.push(`🔴 ${n("blocker")}`);
  if (n("warning")) bits.push(`🟡 ${n("warning")}`);
  if (n("nit")) bits.push(`🔵 ${n("nit")}`);
  if (bits.length === 0) bits.push("✅ no issues");
  bits.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
  return bits.join(" · ");
}

/** Assemble the rich Markdown review body from the structured review output. */
function renderReviewBody(
  title: string,
  stats: string,
  review: ReviewOutput,
  inline: readonly Finding[],
  dropped: readonly Finding[],
  tag: string,
): string {
  const parts: string[] = [`### 🔍 ${title}\n\n${stats}`];
  if (review.summary.trim()) parts.push(review.summary.trim());

  if (review.concerns.length > 0) {
    parts.push(
      `#### Concerns\n${review.concerns
        .map(
          (c) =>
            `- ${SEV_EMOJI[c.severity]} **${c.title}** — ${c.detail.replace(/\n/g, " ")}`,
        )
        .join("\n")}`,
    );
  }
  if (review.highlights.length > 0) {
    parts.push(
      `#### Highlights\n${review.highlights.map((h) => `- ✅ ${h}`).join("\n")}`,
    );
  }
  if (inline.length > 0) {
    parts.push(
      `_${inline.length} inline comment${inline.length === 1 ? "" : "s"} on the diff below._`,
    );
  }
  if (review.walkthrough.length > 0) {
    const rows = review.walkthrough
      .map((w) => `| \`${w.path}\` | ${w.summary.replace(/\n/g, " ")} |`)
      .join("\n");
    parts.push(
      `<details><summary>Walkthrough (${review.walkthrough.length} file${review.walkthrough.length === 1 ? "" : "s"})</summary>\n\n| File | Change |\n|---|---|\n${rows}\n\n</details>`,
    );
  }
  if (review.diagram) {
    parts.push("```mermaid\n" + review.diagram + "\n```");
  }
  if (dropped.length > 0) {
    parts.push(
      `<details><summary>Other notes (${dropped.length})</summary>\n\n${dropped
        .map(
          (f) =>
            `- ${SEV_EMOJI[f.severity]} \`${f.path}:${f.line}\` — ${f.body.replace(/\n/g, " ")}`,
        )
        .join("\n")}\n\n</details>`,
    );
  }
  parts.push(tag);
  return parts.join("\n\n");
}

/**
 * Post one review with inline comments. Uses REQUEST_CHANGES when any inline
 * finding is a blocker, otherwise COMMENT — never APPROVE (a bot shouldn't be a
 * required approver). Off-diff findings are appended to the summary body. First
 * clears this reviewer's comments from the previous run so re-reviews replace
 * rather than accumulate.
 */
export type PostReviewOptions = {
  readonly reviewerName?: string;
  /** PR head SHA to stamp in the marker (for incremental review next time). */
  readonly headSha: string;
  /** Incremental review: only replace prior comments on these files. */
  readonly refreshPaths?: ReadonlySet<string>;
  /** Files in scope, for the stat line. */
  readonly fileCount: number;
};

export async function postReview(
  octokit: Octokit,
  ref: PullRef,
  review: ReviewOutput,
  inline: readonly Finding[],
  dropped: readonly Finding[],
  logger: Logger,
  opts: PostReviewOptions,
): Promise<void> {
  await deletePriorComments(
    octokit,
    ref,
    opts.reviewerName,
    logger,
    opts.refreshPaths,
  );

  const hasBlocker = [...inline, ...review.concerns].some(
    (f) => f.severity === "blocker",
  );
  const title = opts.reviewerName
    ? `loupe · ${opts.reviewerName}`
    : "loupe review";
  const tag = makeMarker(opts.reviewerName, opts.headSha);
  const stats = statLine(inline, review, opts.fileCount);

  await octokit.pulls.createReview({
    ...ref,
    event: hasBlocker ? "REQUEST_CHANGES" : "COMMENT",
    body: renderReviewBody(title, stats, review, inline, dropped, tag),
    comments: inline.map((f) => ({
      path: f.path,
      line: f.line,
      body: `${SEV_EMOJI[f.severity]} **${f.severity}** ${f.body}\n\n${tag}`,
    })),
  });
}
