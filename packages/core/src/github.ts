import { Octokit } from "@octokit/rest";

import type { Logger } from "@loupe/logger";

import type { DiffFile } from "./diff";
import {
  anchorLabel,
  type Finding,
  type Note,
  type ReviewOutput,
} from "./types";

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
  /** Every file path that exists at `head` (the full PR file list). */
  readonly headPaths: ReadonlySet<string>;
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
    headPaths: new Set(files.map((f) => f.filename)),
  };
}

/**
 * Why a pre-publish review was skipped. The PR can change state between the
 * start of a run and the moment loupe is ready to post; re-reading it right
 * before publishing catches a merge, close, or head move that happened while
 * inference was running. See issue #39.
 */
export type SkipReason = "merged" | "closed" | "head-moved";

/** A pre-publish freshness check result: either publishable, or why not. */
export type PublishCheck =
  | { readonly publishable: true }
  | { readonly publishable: false; readonly reason: SkipReason };

/**
 * Re-read the pull request right before publishing and decide whether it is
 * still safe to post findings onto it. The review runs for minutes and the PR
 * can merge, close, or receive a new push in that window; posting onto a dead
 * diff reads as the author ignoring the tool when they never had a chance.
 *
 * `reviewedHeadSha` is the head SHA the review was computed against (captured
 * at the start of the run). A different current head means the findings are
 * anchored to a commit the branch has moved past, so they are not published.
 */
export async function checkPublishable(
  octokit: Octokit,
  ref: PullRef,
  reviewedHeadSha: string,
): Promise<PublishCheck> {
  const { data: pr } = await octokit.pulls.get(ref);
  if (pr.merged) return { publishable: false, reason: "merged" };
  if (pr.state === "closed") return { publishable: false, reason: "closed" };
  if (pr.head.sha !== reviewedHeadSha) {
    return { publishable: false, reason: "head-moved" };
  }
  return { publishable: true };
}

/**
 * Re-read the pull request and report whether it is still open (not merged, not
 * closed). Used to gate writes that carry findings but are not anchored to a
 * specific head — the combined summary — where a head move is already handled
 * per reviewer (`checkPublishable`) and the only fatal state is the PR being
 * gone. Comparing heads here would need a run-start anchor that can race the
 * reviewers' own fetches and falsely skip a summary whose inline comments are
 * valid on the current head, so this check deliberately ignores the head.
 */
export async function checkPrOpen(
  octokit: Octokit,
  ref: PullRef,
): Promise<
  | { readonly open: true }
  | { readonly open: false; readonly reason: "merged" | "closed" }
> {
  const { data: pr } = await octokit.pulls.get(ref);
  if (pr.merged) return { open: false, reason: "merged" };
  if (pr.state === "closed") return { open: false, reason: "closed" };
  return { open: true };
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

/** Post a top-level PR comment (used for chat replies). Returns the comment id. */
export async function postIssueComment(
  octokit: Octokit,
  ref: PullRef,
  body: string,
): Promise<number> {
  const { data } = await octokit.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.pull_number,
    body,
  });
  return data.id;
}

/** Replace the body of a top-level PR comment (e.g. turn an "On it" ack into its result). */
export async function updateIssueComment(
  octokit: Octokit,
  ref: PullRef,
  commentId: number,
  body: string,
): Promise<void> {
  await octokit.issues.updateComment({
    owner: ref.owner,
    repo: ref.repo,
    comment_id: commentId,
    body,
  });
}

/** GitHub's compare endpoint lists at most this many files; at the cap the list may be incomplete. */
const COMPARE_FILE_CAP = 300;

/**
 * Files changed between two commits (the incremental-review delta). Throws
 * when the response hits GitHub's file cap, because a silently truncated delta
 * would drop files from the review and then advance the reviewed SHA past them.
 *
 * Renamed files need no special handling here: threads stranded at a vanished
 * old path are swept by `snapshotPriorComments` (via `headPaths`), which covers
 * renames, delete+add rewrites, deletions, and full reviews alike.
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

/** Parse only inline-finding markers, never summary markers. */
function parseFindingMarker(
  body: string,
): { reviewer: string; sha: string } | undefined {
  const match =
    /<!-- loupe:(?!summary:)([^\s]+) sha=([0-9a-f]{7,40}) -->\s*$/.exec(body);
  const reviewer = match?.[1];
  const sha = match?.[2];
  return reviewer && sha ? { reviewer, sha } : undefined;
}
function summaryMarkerPrefix(reviewerName: string | undefined): string {
  return `<!-- loupe:summary:${reviewerName ?? "default"} `;
}
const COMBINED_SUMMARY_MARKER = "<!-- loupe:summary:combined -->";
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

export type OpenLoupeFinding = {
  readonly reviewer: string;
  readonly path: string;
  readonly line?: number;
  readonly body: string;
  readonly sha: string;
  readonly url?: string;
};

type ReviewThreadsPage = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ReadonlyArray<{
          id: string;
          path: string;
          line: number | null;
          isResolved: boolean;
          viewerCanResolve: boolean;
          comments: {
            nodes: ReadonlyArray<{
              body: string;
              url: string;
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
          line
          isResolved
          viewerCanResolve
          comments(first: 1) {
            nodes { body url author { login } replyTo { id } }
          }
        }
      }
    }
  }
}`;

/** List unresolved findings across configured reviewers, including findings
 * retained by incremental reviews from an earlier head. */
export async function listOpenLoupeFindings(
  octokit: Octokit,
  ref: PullRef,
  _headSha: string,
  reviewers?: ReadonlySet<string>,
): Promise<OpenLoupeFinding[]> {
  const self = await getSelfLogin(octokit);
  const findings: OpenLoupeFinding[] = [];
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
    for (const thread of conn.nodes) {
      if (!thread || thread.isResolved) continue;
      const root = thread.comments.nodes[0];
      const rootAuthor = root?.author?.login;
      const authoredBySelf =
        rootAuthor === self ||
        (self === "github-actions[bot]" && rootAuthor === "github-actions");
      if (!root || root.replyTo || !authoredBySelf) continue;
      const marker = parseFindingMarker(root.body);
      if (!marker) continue;
      if (reviewers && !reviewers.has(marker.reviewer)) continue;
      const body = root.body
        .replace(
          /\n\n<!-- loupe:(?!summary:)[^\s]+ sha=[0-9a-f]{7,40} -->\s*$/,
          "",
        )
        .trim();
      findings.push({
        reviewer: marker.reviewer,
        path: thread.path,
        ...(thread.line === null ? {} : { line: thread.line }),
        body,
        sha: marker.sha,
        ...(root.url ? { url: root.url } : {}),
      });
    }
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return findings.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.reviewer.localeCompare(b.reviewer),
  );
}

const RESOLVE_THREAD_MUTATION = `
mutation LoupeResolveThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

/**
 * Take a point-in-time snapshot of this reviewer's prior comments eligible for
 * cleanup, so re-reviews replace rather than duplicate. Only comments posted
 * under loupe's own login with this reviewer's marker qualify; a human quoting
 * the marker is left alone. `scope` selects which paths are eligible:
 * `undefined` = every such comment, otherwise only those paths. Runs BEFORE
 * the new review posts so the snapshot can never include the replacements.
 * Best-effort: a failed lookup selects nothing and warns.
 */
async function snapshotPriorComments(
  octokit: Octokit,
  ref: PullRef,
  reviewerName: string | undefined,
  policy: PriorComments,
  logger: Logger,
  scope?: (path: string) => boolean,
): Promise<PriorSnapshot> {
  if (policy === "keep") return EMPTY_SNAPSHOT;
  const prefix = markerPrefix(reviewerName);
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
              (!scope || (c.path !== undefined && scope(c.path))),
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
        if (!t || t.isResolved || (scope && !scope(t.path))) continue;
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
  /** How the review was produced: with tools, one-shot by design, or one-shot because the agentic run failed. */
  readonly mode: "agentic" | "headless" | "fallback";
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
  /** Inline findings suppressed as duplicates of a finding another reviewer owns. */
  readonly crossReviewerDropped: number;
  /** Off-diff notes actually published under "Other notes". */
  readonly offDiff: number;
  /** Schema-rejected findings kept as notes instead of dropped. */
  readonly salvagedFindings: number;
  /**
   * Ensemble models that failed and were dropped from the merge so the
   * surviving legs' findings still post. Empty (and undefined semantically)
   * for a non-ensemble or fully-successful run; names the failed model ids
   * otherwise, so the summary can flag the review as degraded.
   */
  readonly degradedLegs: readonly string[];
};

/** True when the run lost or skipped something the reader should know about. */
export function isDegraded(d: ReviewDiagnostics): boolean {
  return (
    d.mode === "fallback" ||
    d.verify === "invalid" ||
    d.verify === "failed" ||
    d.incremental === "unknown" ||
    d.malformedDropped.findings + d.malformedDropped.concerns > 0 ||
    d.salvagedFindings > 0 ||
    d.degradedLegs.length > 0
  );
}

function renderDiagnostics(d: ReviewDiagnostics): string {
  const rows = [
    `- review: ${
      d.mode === "fallback" ? "headless fallback (agentic run failed)" : d.mode
    }`,
    `- verification: ${d.verify}`,
    `- scope: ${d.incremental}${d.incremental === "unknown" ? " (history lookup failed; prior comments kept)" : ""}`,
    `- dropped: ${d.malformedDropped.findings} malformed finding(s), ${d.malformedDropped.concerns} malformed concern(s), ${d.outOfScopeDropped} out of scope, ${d.profileDropped} below profile, ${d.verifyDropped} rejected by verification, ${d.crossReviewerDropped} duplicate of another reviewer`,
    `- off-diff notes published: ${d.offDiff}${
      d.salvagedFindings > 0
        ? ` (${d.salvagedFindings} salvaged from malformed finding(s))`
        : ""
    }`,
    // Only surface an ensemble row when a leg was actually lost. A clean
    // ensemble has nothing to flag, and a non-ensemble run has no ensemble to
    // report on — rendering "all models completed" for either would be noise
    // (and a plain single-model review isn't an ensemble at all).
    ...(d.degradedLegs.length > 0
      ? [
          `- ensemble: ⚠️ degraded — ${d.degradedLegs.length} model(s) failed and dropped: ${d.degradedLegs.join(", ")}`,
        ]
      : []),
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
  dropped: readonly Note[],
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
            `${SEV_EMOJI[f.severity]} \`${anchorLabel(f)}\`${
              f.line === undefined ? " _unanchored_" : ""
            }\n\n${f.body.trim()}`,
        )
        .join("\n\n")}\n\n</details>`,
    );
  }
  if (diagnostics) parts.push(renderDiagnostics(diagnostics));
  parts.push(tag);
  return parts.join("\n\n");
}

/**
 * The cleanup scope for prior-comment snapshotting: `undefined` = every marked
 * comment of this reviewer, otherwise only those paths — plus, always, any path
 * that no longer exists at head. A thread anchored at a vanished path (renamed
 * or deleted since it was posted) can never be superseded by a scoped refresh,
 * so it is swept regardless of scope rather than stranded forever. Threads on
 * paths that still exist stay bound to the scope filter.
 */
function scopeFor(
  refreshPaths: ReadonlySet<string> | undefined,
  headPaths: ReadonlySet<string> | undefined,
): ((path: string) => boolean) | undefined {
  // An empty refresh set means "clean up nothing"; keep that strictness.
  if (!refreshPaths) return undefined;
  if (refreshPaths.size === 0) return () => false;
  if (!headPaths) return (path) => refreshPaths.has(path);
  return (path) => refreshPaths.has(path) || !headPaths.has(path);
}

/**
 * Resolve or delete this reviewer's prior loupe comments anchored at paths that
 * no longer exist at head — stranded by a rename or deletion, where no scoped
 * refresh can ever reach them. Best-effort: failures leave threads in place.
 */
export async function cleanupStrandedThreads(
  octokit: Octokit,
  ref: PullRef,
  headPaths: ReadonlySet<string>,
  logger: Logger,
  options?: { reviewerName?: string; priorComments?: PriorComments },
): Promise<void> {
  const policy = options?.priorComments ?? "resolve";
  if (policy === "keep") return;
  const snapshot = await snapshotPriorComments(
    octokit,
    ref,
    options?.reviewerName,
    policy,
    logger,
    (path) => !headPaths.has(path),
  );
  await cleanupPriorComments(octokit, ref, snapshot, logger);
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
  /**
   * Paths that exist at head (the full PR file list). A prior thread anchored
   * at any other path is stranded — its file was renamed or deleted — and is
   * swept regardless of scope.
   */
  readonly headPaths?: ReadonlySet<string>;
  /** Files in scope, for the stat line. */
  readonly fileCount: number;
  /** What to do with prior inline comments (default resolve). */
  readonly priorComments?: PriorComments;
  /** Run diagnostics for the summary; omitted = not rendered. */
  readonly diagnostics?: ReviewDiagnostics;
  /** Let a higher-level orchestrator publish one summary for all reviewers. */
  readonly deferSummary?: boolean;
};

function priorReviewerSection(
  priorBody: string,
  reviewer: string,
): string | undefined {
  const escaped = reviewer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startMarker = `<!-- loupe:section:${reviewer}:start -->`;
  const endMarker = `<!-- loupe:section:${reviewer}:end -->`;
  const markedStart = priorBody.indexOf(startMarker);
  if (markedStart >= 0) {
    const markedEnd = priorBody.indexOf(endMarker, markedStart);
    if (markedEnd >= 0) {
      return priorBody
        .slice(markedStart + startMarker.length + 1, markedEnd)
        .trim();
    }
  }

  // Legacy combined summaries had no section boundaries. Bound the section by
  // the next generated reviewer heading/footer; accept a SHA marker only when
  // it is actually inside those bounds, never one retained at the comment end.
  const heading = `## ${reviewer}\n\n`;
  const start = priorBody.indexOf(heading);
  if (start < 0) return undefined;
  const afterHeading = start + heading.length;
  const nextHeading = priorBody.indexOf("\n\n---\n\n## ", afterHeading);
  const footer = priorBody.indexOf("\n\n---\n\nUse `@loupe fix`", afterHeading);
  const combinedMarker = priorBody.indexOf(
    "\n\n<!-- loupe:summary:combined -->",
    afterHeading,
  );
  const candidates = [nextHeading, footer, combinedMarker].filter(
    (index) => index >= 0,
  );
  const end =
    candidates.length > 0 ? Math.min(...candidates) : priorBody.length;
  const section = priorBody.slice(start, end).trim();
  const marker = new RegExp(
    `<!-- loupe:summary:${escaped} sha=[0-9a-f]{7,40} -->`,
  ).exec(section);
  return marker ? section : undefined;
}

/**
 * True for a combined-summary section body that carries no findings and should
 * be restored from the prior summary: either the `_Not run:` stub (a reviewer
 * with nothing to reassess) or the `Skipped:` stub (a pre-publish freshness
 * skip - findings were computed but not posted, so the section has no SHA
 * marker and no content worth keeping). Both would otherwise wipe the
 * reviewer's previous findings when the combined summary is upserted, since
 * the summary gate only blocks merged/closed PRs and a head-moved PR is still
 * open (issue #39).
 */
function isNoUpdateStub(content: string): boolean {
  const trimmed = content.trim();
  return (
    /^## [^\n]+\n\n_Not run: [^\n]*_$/s.test(trimmed) ||
    /^## [^\n]+\n\n\u23F8\uFE0F Skipped: /.test(trimmed)
  );
}

function preserveSkippedSummarySections(
  body: string,
  priorBody?: string,
): string {
  if (!priorBody) return body;

  // New combined summaries have explicit structural boundaries. Replace only
  // the content inside a skipped reviewer's own pair and retain the new pair.
  const marked = body.replace(
    /<!-- loupe:section:([^\s]+):start -->\n([\s\S]*?)\n<!-- loupe:section:\1:end -->/g,
    (section, reviewer: string, content: string) => {
      if (!isNoUpdateStub(content)) {
        return section;
      }
      const priorSection = priorReviewerSection(priorBody, reviewer);
      return priorSection
        ? `<!-- loupe:section:${reviewer}:start -->\n${priorSection}\n\n> ℹ️ Not updated in this run.\n<!-- loupe:section:${reviewer}:end -->`
        : section;
    },
  );

  // Backward compatibility for callers/new bodies created before section
  // boundaries were introduced.
  return marked.replace(
    /## ([^\n]+)\n\n(_Not run: [^\n]*_|\u23F8\uFE0F Skipped: [^\n]*)(?=\n\n---|$)/g,
    (stub, reviewer: string) => {
      const priorSection = priorReviewerSection(priorBody, reviewer);
      return priorSection
        ? `${priorSection}\n\n> ℹ️ Not updated in this run.`
        : stub;
    },
  );
}

/** Create or update the single summary assembled after parallel reviewers finish. */
export async function upsertCombinedSummary(
  octokit: Octokit,
  ref: PullRef,
  body: string,
): Promise<void> {
  const self = await getSelfLogin(octokit);
  const comments = await listIssueComments(octokit, ref);
  const prior = comments
    .reverse()
    .find(
      (comment) =>
        comment.user?.login === self &&
        comment.body?.includes(COMBINED_SUMMARY_MARKER),
    );
  const mergedBody = preserveSkippedSummarySections(body, prior?.body);
  const currentReviewers = new Set(
    [
      ...mergedBody.matchAll(
        /<!-- loupe:summary:([^\s]+) sha=[0-9a-f]{7,40} -->/g,
      ),
    ].map((match) => match[1]),
  );
  const retainedMarkers = comments
    .filter((comment) => comment.user?.login === self)
    .flatMap((comment) => [
      ...(comment.body?.matchAll(
        /<!-- loupe:summary:([^\s]+) sha=[0-9a-f]{7,40} -->/g,
      ) ?? []),
    ])
    .filter((match) => match[1] && !currentReviewers.has(match[1]))
    .map((match) => match[0]);
  const markedBody = [
    mergedBody.trim(),
    ...new Set(retainedMarkers),
    COMBINED_SUMMARY_MARKER,
  ].join("\n\n");
  if (prior) {
    await octokit.issues.updateComment({
      owner: ref.owner,
      repo: ref.repo,
      comment_id: prior.id,
      body: markedBody,
    });
  } else {
    await octokit.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.pull_number,
      body: markedBody,
    });
  }

  // Preserve legacy comments for history, but tag them as stale only after the
  // replacement exists. Updating is best-effort and never invalidates a review.
  for (const comment of comments) {
    if (
      comment.id !== prior?.id &&
      comment.user?.login === self &&
      comment.body?.includes("<!-- loupe:summary:") &&
      !comment.body.includes(COMBINED_SUMMARY_MARKER) &&
      !comment.body.includes("<!-- loupe:summary:stale -->")
    ) {
      try {
        await octokit.issues.updateComment({
          owner: ref.owner,
          repo: ref.repo,
          comment_id: comment.id,
          body: `${comment.body.trim()}\n\n> ℹ️ This legacy reviewer summary is stale. Loupe now publishes a single combined summary.\n\n<!-- loupe:summary:stale -->`,
        });
      } catch {
        // The combined summary is already live; a legacy-tagging failure must
        // not turn a completed review into a failed one.
      }
    }
  }
}

export async function postReview(
  octokit: Octokit,
  ref: PullRef,
  review: ReviewOutput,
  inline: readonly Finding[],
  dropped: readonly Note[],
  logger: Logger,
  opts: PostReviewOptions,
): Promise<string> {
  // Snapshot first, post second, clean up last: a failed post must never leave
  // the PR with its old comments gone and no replacement.
  // Snapshot first, post second, clean up last: a failed post must never leave
  // the PR with its old comments gone and no replacement. An empty refresh set
  // means "clean up nothing" (unknown history) — skip the lookup entirely.
  const prior =
    opts.refreshPaths?.size === 0
      ? EMPTY_SNAPSHOT
      : await snapshotPriorComments(
          octokit,
          ref,
          opts.reviewerName,
          opts.priorComments ?? "resolve",
          logger,
          scopeFor(opts.refreshPaths, opts.headPaths),
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

  if (!opts.deferSummary) {
    const self = await getSelfLogin(octokit);
    const comments = await listIssueComments(octokit, ref);
    const priorSummary = comments
      .reverse()
      .find(
        (comment) =>
          comment.user?.login === self &&
          comment.body?.includes(summaryMarkerPrefix(opts.reviewerName)) &&
          !comment.body.includes(COMBINED_SUMMARY_MARKER) &&
          !comment.body.includes("<!-- loupe:summary:stale -->"),
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
  }

  await cleanupPriorComments(octokit, ref, prior, logger);
  return summaryBody;
}
