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

/** Login the workflow token posts as when `GET /user` is unavailable to it. */
const ACTIONS_BOT_LOGIN = "github-actions[bot]";
const selfLogins = new WeakMap<Octokit, Promise<string>>();

/**
 * The login loupe's own comments and reviews carry. A PAT or app user token
 * answers `GET /user`; the default Actions token cannot, and posts as
 * github-actions[bot]. Marker text alone is not proof of authorship: a human
 * quoting loupe output carries the marker too, so every "is this mine" check
 * pairs the marker with this login.
 */
export function getSelfLogin(octokit: Octokit): Promise<string> {
  let cached = selfLogins.get(octokit);
  if (!cached) {
    cached = octokit.users
      .getAuthenticated()
      .then((r) => r.data.login)
      .catch(() => ACTIONS_BOT_LOGIN);
    selfLogins.set(octokit, cached);
  }
  return cached;
}

/**
 * What we know about this reviewer's previous review of the PR. `unknown`
 * means the lookup itself failed, which is different from "no prior review":
 * the caller must then do a full review without touching prior comments.
 */
export type LastReviewed =
  | { readonly unknown: false; readonly sha?: string }
  | { readonly unknown: true; readonly reason: string };

/**
 * The head SHA this reviewer last reviewed, read from its persistent summary
 * comment. Legacy review-body markers remain a fallback for existing PRs.
 */
export async function getLastReviewed(
  octokit: Octokit,
  ref: PullRef,
  reviewerName: string | undefined,
): Promise<LastReviewed> {
  try {
    const self = await getSelfLogin(octokit);
    const comments = await listIssueComments(octokit, ref);
    for (const comment of comments.reverse()) {
      if (comment.user?.login !== self) continue;
      const sha = shaFromMarker(
        comment.body,
        summaryMarkerPrefix(reviewerName),
      );
      if (sha) return { unknown: false, sha };
    }

    const reviews = await octokit.paginate(octokit.pulls.listReviews, {
      ...ref,
      per_page: 100,
    });
    for (const review of reviews.reverse()) {
      if (review.user?.login !== self) continue;
      const sha = shaFromMarker(review.body, markerPrefix(reviewerName));
      if (sha) return { unknown: false, sha };
    }
  } catch (err) {
    return {
      unknown: true,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return { unknown: false };
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

/** GitHub's compare endpoint lists at most this many files; at the cap the list may be incomplete. */
const COMPARE_FILE_CAP = 300;

/**
 * Files changed between two commits (the incremental-review delta). Throws
 * when the response hits GitHub's file cap, because a silently truncated delta
 * would drop files from the review and then advance the reviewed SHA past them.
 */
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
  const files = data.files ?? [];
  if (files.length >= COMPARE_FILE_CAP) {
    throw new Error(
      `compare ${base.slice(0, 7)}..${head.slice(0, 7)} returned ${files.length} files (GitHub cap); delta may be incomplete`,
    );
  }
  return new Set(files.map((f) => f.filename));
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

/** Per-reviewer marker prefixes for inline findings and the persistent summary. */
function markerPrefix(reviewerName: string | undefined): string {
  return `<!-- loupe:${reviewerName ?? "default"} `;
}
function summaryMarkerPrefix(reviewerName: string | undefined): string {
  return `<!-- loupe:summary:${reviewerName ?? "default"} `;
}
function makeMarker(reviewerName: string | undefined, sha: string): string {
  return `${markerPrefix(reviewerName)}sha=${sha} -->`;
}
function makeSummaryMarker(
  reviewerName: string | undefined,
  sha: string,
): string {
  return `${summaryMarkerPrefix(reviewerName)}sha=${sha} -->`;
}
function shaFromMarker(
  body: string | null | undefined,
  prefix: string,
): string | undefined {
  if (!body) return undefined;
  const start = body.indexOf(prefix);
  if (start < 0) return undefined;
  return /sha=([0-9a-f]{7,40})\s*-->/.exec(body.slice(start))?.[1];
}

async function listIssueComments(octokit: Octokit, ref: PullRef) {
  return octokit.paginate(octokit.issues.listComments, {
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.pull_number,
    per_page: 100,
  });
}

/** What to do with this reviewer's inline comments from a previous run. */
export type PriorComments = "resolve" | "delete" | "keep";

/** Prior loupe comments selected for cleanup, captured before the new review posts. */
type PriorSnapshot = {
  readonly commentIds: readonly number[];
  readonly threadIds: readonly string[];
};

const EMPTY_SNAPSHOT: PriorSnapshot = { commentIds: [], threadIds: [] };

type ReviewThreadsPage = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ReadonlyArray<{
          id: string;
          path: string;
          isResolved: boolean;
          viewerCanResolve: boolean;
          comments: {
            nodes: ReadonlyArray<{
              body: string;
              author: { login: string } | null;
              replyTo: { id: string } | null;
            } | null>;
          };
        } | null>;
      };
    };
  };
};

const REVIEW_THREADS_QUERY = `
query LoupeReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          path
          isResolved
          viewerCanResolve
          comments(first: 1) {
            nodes { body author { login } replyTo { id } }
          }
        }
      }
    }
  }
}`;

const RESOLVE_THREAD_MUTATION = `
mutation LoupeResolveThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

/**
 * Select this reviewer's prior inline comments so re-reviews replace rather
 * than duplicate. Only comments posted under loupe's own login with this
 * reviewer's marker qualify; a human quoting the marker is left alone. Scope:
 * `undefined` paths = every such comment, an empty set = none, otherwise only
 * comments on those paths. Runs BEFORE the new review posts so the snapshot
 * can never include the replacements. Best-effort: a failed lookup selects
 * nothing and warns.
 */
async function snapshotPriorComments(
  octokit: Octokit,
  ref: PullRef,
  reviewerName: string | undefined,
  policy: PriorComments,
  logger: Logger,
  refreshPaths?: ReadonlySet<string>,
): Promise<PriorSnapshot> {
  if (policy === "keep" || refreshPaths?.size === 0) return EMPTY_SNAPSHOT;
  const prefix = markerPrefix(reviewerName);
  const inScope = (path: string): boolean =>
    !refreshPaths || refreshPaths.has(path);
  try {
    const self = await getSelfLogin(octokit);
    if (policy === "delete") {
      const comments = await octokit.paginate(
        octokit.pulls.listReviewComments,
        {
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.pull_number,
          per_page: 100,
        },
      );
      return {
        commentIds: comments
          .filter(
            (c) =>
              c.user?.login === self &&
              c.body.includes(prefix) &&
              inScope(c.path),
          )
          .map((c) => c.id),
        threadIds: [],
      };
    }
    const threadIds: string[] = [];
    let after: string | null = null;
    do {
      const page: ReviewThreadsPage = await octokit.graphql(
        REVIEW_THREADS_QUERY,
        {
          owner: ref.owner,
          repo: ref.repo,
          number: ref.pull_number,
          after,
        },
      );
      const conn = page.repository.pullRequest.reviewThreads;
      for (const t of conn.nodes) {
        if (!t || t.isResolved || !inScope(t.path)) continue;
        const root = t.comments.nodes[0];
        if (!root || root.replyTo || root.author?.login !== self) continue;
        if (!root.body.includes(prefix)) continue;
        if (!t.viewerCanResolve) {
          logger.warn("Cannot resolve a prior loupe thread; leaving it open", {
            thread: t.id,
            path: t.path,
          });
          continue;
        }
        threadIds.push(t.id);
      }
      after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (after);
    return { commentIds: [], threadIds };
  } catch (err) {
    logger.warn(
      "Could not look up prior loupe comments; leaving them in place",
      {
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return EMPTY_SNAPSHOT;
  }
}

/**
 * Apply the cleanup policy to a snapshot taken before posting. Each deletion
 * or resolution fails independently; a failure never blocks the others and
 * never touches anything outside the snapshot.
 */
async function cleanupPriorComments(
  octokit: Octokit,
  ref: PullRef,
  snapshot: PriorSnapshot,
  logger: Logger,
): Promise<void> {
  for (const id of snapshot.commentIds) {
    try {
      await octokit.pulls.deleteReviewComment({
        owner: ref.owner,
        repo: ref.repo,
        comment_id: id,
      });
    } catch (err) {
      logger.warn("Could not delete a prior loupe comment", {
        comment: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  for (const threadId of snapshot.threadIds) {
    try {
      await octokit.graphql(RESOLVE_THREAD_MUTATION, { threadId });
    } catch (err) {
      logger.warn("Could not resolve a prior loupe thread", {
        thread: threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const n = snapshot.commentIds.length + snapshot.threadIds.length;
  if (n > 0) logger.debug("Cleaned up prior loupe comments", { count: n });
}

const SEV_EMOJI: Record<Finding["severity"], string> = {
  blocker: "🔴",
  warning: "🟡",
  nit: "🔵",
};

/**
 * How the run went, beyond the findings themselves. Rendered into the summary
 * so a degraded review (fallback, unverified, lossy parse) is visible on the PR
 * instead of only in the Actions log.
 */
export type ReviewDiagnostics = {
  /** The agentic run failed and the review came from the headless retry. */
  readonly fallback: boolean;
  /** passed = complete valid verdicts applied; skipped = nothing to verify or verify off. */
  readonly verify: "passed" | "skipped" | "invalid" | "failed";
  /** unknown = history lookup or compare failed, so a full review ran without cleanup. */
  readonly incremental: "full" | "delta" | "unknown";
  readonly malformedDropped: {
    readonly findings: number;
    readonly concerns: number;
  };
  /** Findings anchored outside the reassessed files on an incremental run. */
  readonly outOfScopeDropped: number;
  /** Inline findings removed by the noise profile. */
  readonly profileDropped: number;
  /** Inline findings the verification pass judged not real. */
  readonly verifyDropped: number;
  /** Off-diff notes actually published under "Other notes". */
  readonly offDiff: number;
};

/** True when the run lost or skipped something the reader should know about. */
export function isDegraded(d: ReviewDiagnostics): boolean {
  return (
    d.fallback ||
    d.verify === "invalid" ||
    d.verify === "failed" ||
    d.incremental === "unknown" ||
    d.malformedDropped.findings + d.malformedDropped.concerns > 0
  );
}

function renderDiagnostics(d: ReviewDiagnostics): string {
  const rows = [
    `- review: ${d.fallback ? "headless fallback (agentic run failed)" : "agentic"}`,
    `- verification: ${d.verify}`,
    `- scope: ${d.incremental}${d.incremental === "unknown" ? " (history lookup failed; prior comments kept)" : ""}`,
    `- dropped: ${d.malformedDropped.findings} malformed finding(s), ${d.malformedDropped.concerns} malformed concern(s), ${d.outOfScopeDropped} out of scope, ${d.profileDropped} below profile, ${d.verifyDropped} rejected by verification`,
    `- off-diff notes published: ${d.offDiff}`,
  ];
  return `<details><summary>Run details</summary>\n\n${rows.join("\n")}\n\n</details>`;
}

/** One-line severity tally across inline findings + PR-level concerns. */
function statLine(
  inline: readonly Finding[],
  review: ReviewOutput,
  fileCount: number,
  degraded: boolean,
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
  if (degraded) bits.push("⚠️ degraded run");
  return bits.join(" · ");
}

/** Assemble the rich Markdown review body from the structured review output. */
function renderReviewBody(
  title: string,
  stats: string,
  review: ReviewOutput,
  inline: readonly Finding[],
  dropped: readonly Finding[],
  diagnostics: ReviewDiagnostics | undefined,
  tag: string,
): string {
  const parts: string[] = [`### 🔍 ${title}\n\n${stats}`];
  if (review.summary.trim()) parts.push(review.summary.trim());

  // Concern details and note bodies are Markdown and may span paragraphs or
  // code fences, so each one is its own block rather than a bullet.
  if (review.concerns.length > 0) {
    parts.push(
      `#### Concerns\n\n${review.concerns
        .map(
          (c) =>
            `${SEV_EMOJI[c.severity]} **${c.title}**\n\n${c.detail.trim()}`,
        )
        .join("\n\n")}`,
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
  if (review.diagram) {
    parts.push("```mermaid\n" + review.diagram + "\n```");
  }
  if (dropped.length > 0) {
    parts.push(
      `<details><summary>Other notes (${dropped.length})</summary>\n\n${dropped
        .map(
          (f) =>
            `${SEV_EMOJI[f.severity]} \`${f.path}:${f.line}\`\n\n${f.body.trim()}`,
        )
        .join("\n\n")}\n\n</details>`,
    );
  }
  if (diagnostics) parts.push(renderDiagnostics(diagnostics));
  parts.push(tag);
  return parts.join("\n\n");
}

/**
 * Post inline findings as an empty-body review and create or update this
 * reviewer's persistent issue-comment summary. Uses REQUEST_CHANGES when any
 * finding is a blocker, otherwise COMMENT — never APPROVE (a bot shouldn't be a
 * required approver). Prior inline comments are cleared before replacements are
 * posted; off-diff findings remain in the summary.
 */
export type PostReviewOptions = {
  readonly reviewerName?: string;
  /** PR head SHA to stamp in the marker (for incremental review next time). */
  readonly headSha: string;
  /**
   * Prior-comment cleanup scope: undefined = every marked comment of this
   * reviewer, empty set = clean up nothing, otherwise only those paths.
   */
  readonly refreshPaths?: ReadonlySet<string>;
  /** Files in scope, for the stat line. */
  readonly fileCount: number;
  /** What to do with prior inline comments (default resolve). */
  readonly priorComments?: PriorComments;
  /** Run diagnostics for the summary; omitted = not rendered. */
  readonly diagnostics?: ReviewDiagnostics;
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
  // Snapshot first, post second, clean up last: a failed post must never leave
  // the PR with its old comments gone and no replacement.
  const prior = await snapshotPriorComments(
    octokit,
    ref,
    opts.reviewerName,
    opts.priorComments ?? "resolve",
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
  const summaryTag = makeSummaryMarker(opts.reviewerName, opts.headSha);
  const shortSha = opts.headSha.slice(0, 7);
  const lastReviewed = `Last reviewed commit: [\`${shortSha}\`](https://github.com/${ref.owner}/${ref.repo}/commit/${opts.headSha})`;
  const degraded = opts.diagnostics ? isDegraded(opts.diagnostics) : false;
  const stats = statLine(inline, review, opts.fileCount, degraded);
  const summaryBody = renderReviewBody(
    title,
    stats,
    review,
    inline,
    dropped,
    opts.diagnostics,
    `${lastReviewed}\n\n${summaryTag}`,
  );

  if (inline.length > 0 || hasBlocker) {
    await octokit.pulls.createReview({
      ...ref,
      event: hasBlocker ? "REQUEST_CHANGES" : "COMMENT",
      // GitHub requires content when a review has no inline comments. Keep that
      // body visually empty while preserving PR-level blocker verdicts.
      body: inline.length > 0 ? "" : tag,
      comments: inline.map((f) => ({
        path: f.path,
        line: f.line,
        body: `${SEV_EMOJI[f.severity]} **${f.severity}** ${f.body}\n\n${tag}`,
      })),
    });
  }

  const self = await getSelfLogin(octokit);
  const comments = await listIssueComments(octokit, ref);
  const priorSummary = comments
    .reverse()
    .find(
      (comment) =>
        comment.user?.login === self &&
        comment.body?.includes(summaryMarkerPrefix(opts.reviewerName)),
    );
  if (priorSummary) {
    await octokit.issues.updateComment({
      owner: ref.owner,
      repo: ref.repo,
      comment_id: priorSummary.id,
      body: summaryBody,
    });
  } else {
    await octokit.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.pull_number,
      body: summaryBody,
    });
  }

  await cleanupPriorComments(octokit, ref, prior, logger);
}
