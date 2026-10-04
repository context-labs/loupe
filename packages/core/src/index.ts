import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HarnessError,
  isNonRetryableHarnessError,
  type Harness,
  type HarnessTraceEvent,
} from "@loupe/harness";
import type { Logger } from "@loupe/logger";
import type { Octokit } from "@octokit/rest";
import picomatch from "picomatch";

import {
  changedFilesBetween,
  checkPublishable,
  cleanupStrandedThreads,
  fetchConventions,
  fetchPullContext,
  getLastReviewed,
  postReview,
  type PriorComments,
  type PullRef,
  type ReviewDiagnostics,
  type SkipReason,
} from "./github";
import {
  bodySimilarity,
  dedupeNotes,
  majority,
  mergeEnsemble,
  SIMILARITY_THRESHOLD,
} from "./ensemble";
import { reviewOutput, verdictsOutput } from "./output";
import { outcomeText, parseReviewOutput, parseVerification } from "./parse";
import {
  severityRank,
  severitiesForProfile,
  type Concern,
  type Finding,
  type Note,
  type Profile,
  type ReviewOutput,
  type Severity,
} from "./types";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildVerifySystemPrompt,
  buildVerifyUserPrompt,
  type ReasoningEffort,
} from "./prompt";
import {
  changedExports,
  transitiveCallSites,
  renderCallSites,
} from "./callsites";
import { renderDiff, type DiffFile } from "./diff";
import { validateFindings } from "./validate";

/**
 * Write the full unified diff to a throwaway temp file and return its path, so
 * an agentic review can read hunks from it on demand instead of carrying the
 * whole diff inline in every turn's prompt.
 */
function writeDiffFile(files: readonly DiffFile[], logger: Logger): string {
  const dir = mkdtempSync(join(tmpdir(), "loupe-diff-"));
  const path = join(dir, "pr.diff");
  writeFileSync(path, renderDiff(files));
  logger.debug("Wrote diff file for agentic exploration", {
    path,
    files: files.length,
  });
  return path;
}

export * from "./types";
export * from "./diff";
export * from "./prompt";
export * from "./parse";
export * from "./validate";
export * from "./github";
export * from "./ensemble";
export * from "./callsites";
export * from "./output";

export type ReviewRequest = {
  /** Authenticated GitHub client; see makeOctokit. */
  readonly octokit: Octokit;
  readonly ref: PullRef;
  readonly harness: Harness;
  readonly workdir: string;
  /** Provider the models are routed through (the whip block's); empty uses the daemon's default. */
  readonly provider?: string;
  /** Convention doc paths to pull from the target repo, in priority order. */
  readonly conventionPaths: readonly string[];
  /**
   * Restrict the review to one or more repo directories (e.g. ["inference",
   * "elixir_engine"]). Only changed files under them are reviewed and
   * convention docs are read from each. With one dir the harness runs inside
   * it; with several it runs at the repo root so the agent sees every dir.
   */
  readonly dirs?: readonly string[];
  /** Compute and log the review without posting it to the PR. */
  readonly dryRun?: boolean;
  /** Model id passed to the harness (e.g. "kimi-k3"). */
  readonly model?: string;
  /**
   * Reasoning effort, passed to the harness natively and noted in the prompt.
   * Omitted: the harness's own default applies and no note is added.
   */
  readonly reasoning?: ReasoningEffort;
  /** Custom reviewer guidance replacing the default; contract is still appended. */
  readonly guidance?: string;
  /** Named reviewer profile; labels the posted review (e.g. "migrations"). */
  readonly reviewerName?: string;
  /** Only review changed files matching these globs (in addition to dirs). */
  readonly include?: readonly string[];
  /** Exclude changed files matching these globs. */
  readonly exclude?: readonly string[];
  /** Let the harness use tools to explore the checkout (needs a real workdir). */
  readonly agentic?: boolean;
  /** Noise profile: quiet (blockers) | chill (default) | assertive (all). */
  readonly profile?: Profile;
  /** Per-glob extra review instructions applied to matching changed files. */
  readonly pathInstructions?: readonly { glob: string; instruction: string }[];
  /** Second-opinion verification pass to drop false positives (default true). */
  readonly verify?: boolean;
  /** Force a full review instead of the incremental delta since last review. */
  readonly full?: boolean;
  /**
   * Run the review with several models (on the harness) and keep only findings a
   * majority agree on; minority findings are surfaced as lower-confidence. The
   * verification pass still runs after the merge: majority agreement filters
   * cross-model noise but not the outside-diff class (several models can agree
   * on a claim the surrounding code refutes). Needs >= 2 models to take effect.
   */
  readonly ensembleModels?: readonly string[];
  /**
   * Skill docs to fold into the reviewer — paths (relative to the checkout) to a
   * SKILL.md or a skill directory (SKILL.md is appended). E.g.
   * ".agents/skills/i-have-adhd" to enforce that output style.
   */
  readonly skills?: readonly string[];
  /** Timezone label for the review's environment line (e.g. "PST"). */
  readonly timezone?: string;
  /** Cap on the agentic tool loop passed to the harness (default 10). */
  readonly maxTurns?: number;
  /**
   * Max inline comments posted per review (default 10). When there are more
   * findings, they are ranked by severity (blocker > warning > nit), the top
   * ones go inline, and the rest are listed in a collapsed section of the
   * summary. A demoted blocker still triggers a REQUEST_CHANGES verdict.
   */
  readonly maxComments?: number;
  /** What to do with this reviewer's prior inline comments (default resolve). */
  readonly priorComments?: PriorComments;
  /** Append the always-on review procedure to the system prompt (default true). */
  readonly procedure?: boolean;
  /** Post inline findings now, but let the caller aggregate the summary. */
  readonly deferSummary?: boolean;
  /**
   * Send a stable prompt-cache key to the harness so the provider reuses the
   * cached system prefix across runs. Default true (a real cost win for models
   * whose endpoint honors it). Set false for a reviewer whose model rejects
   * `prompt_cache_key` as an unrecognized argument; those models cache the
   * stable prefix automatically by prefix match, so the key adds nothing and
   * its presence can 400. The whip harness also self-heals a cache-key 400 by
   * retrying without the key, so this flag only skips that wasted round-trip.
   */
  readonly promptCache?: boolean;
  /**
   * Optional trace sink forwarded to every harness call this review makes
   * (its primary run, one-shot fallback, each ensemble model, and the
   * verification pass). When unset, no trace events are emitted.
   */
  readonly trace?: (event: HarnessTraceEvent) => void;
  readonly logger: Logger;
};

export type ReviewResult = {
  readonly inlineCount: number;
  readonly droppedCount: number;
  readonly requestedChanges: boolean;
  readonly summary: string;
  readonly inline: readonly Finding[];
  /** Findings ranked out by the comment cap; listed collapsed in the summary. */
  readonly overflow: readonly Finding[];
  readonly dropped: readonly Note[];
  readonly diagnostics: ReviewDiagnostics;
  /** Rich per-reviewer Markdown used by the action's combined summary. */
  readonly summaryBody?: string;
  /** Present only when this run actually reviewed and published the PR head. */
  readonly reviewedHeadSha?: string;
  /**
   * Present when findings were computed but not published because the PR was no
   * longer safe to post onto (merged, closed, or the head moved since the review
   * started). The reviewer stays silent on GitHub rather than commenting on a
   * dead diff. See issue #39.
   */
  readonly skipped?: { readonly reason: SkipReason };
};

/** Default cap on inline comments posted per review; extras go to the summary. */
const DEFAULT_MAX_COMMENTS = 10;

const CLEAN_DIAGNOSTICS: ReviewDiagnostics = {
  mode: "agentic",
  verify: "skipped",
  incremental: "full",
  malformedDropped: { findings: 0, concerns: 0 },
  outOfScopeDropped: 0,
  profileDropped: 0,
  verifyDropped: 0,
  crossReviewerDropped: 0,
  offDiff: 0,
  cappedDropped: 0,
  salvagedFindings: 0,
  degradedLegs: [],
};

/**
 * A completed review that hasn't been posted yet — everything `postReview`
 * needs, captured during the produce phase so a caller can deduplicate across
 * reviewers before publishing. `empty` marks the no-op cases (no files in
 * scope, no incremental delta) that carry nothing to post.
 */
export type ProducedReview = {
  readonly reviewerName?: string;
  readonly review: ReviewOutput;
  readonly inline: readonly Finding[];
  readonly uncertain: readonly Finding[];
  /** Findings ranked out by the comment cap; listed in the summary's collapsed section. */
  readonly overflow: readonly Finding[];
  /** The effective maxComments cap applied when ranking overflow out. */
  readonly commentCap?: number;
  readonly dropped: readonly Note[];
  readonly diagnostics: ReviewDiagnostics;
  /** PR head SHA to stamp in the marker. */
  readonly headSha: string;
  /** Prior-comment cleanup scope (paths reassessed this run). */
  readonly refreshPaths: ReadonlySet<string>;
  /** Full PR file list at head (for stranded-thread sweeping). */
  readonly headPaths: ReadonlySet<string>;
  /** Files in scope, for the stat line. */
  readonly fileCount: number;
  /** Nothing to post (no files in scope / no delta since last review). */
  readonly empty?: { readonly summary: string };
};

/**
 * Apply the inline comment cap at result/publish time — after verification,
 * ensemble merge, and cross-reviewer dedupe have finalized the finding set —
 * so unique findings are only demoted once duplicates have had their chance
 * to vacate slots. Ranks by severity (blocker > warning > nit); ties keep
 * the incoming order. Findings beyond the cap are the `overflow`, listed
 * collapsed in the summary and still counted by the verdict and tallies.
 */
export function applyCommentCap(
  inline: readonly Finding[],
  cap: number,
): { inline: readonly Finding[]; overflow: readonly Finding[] } {
  if (inline.length <= cap) return { inline, overflow: [] };
  const ranked = [...inline].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
  );
  return { inline: ranked.slice(0, cap), overflow: ranked.slice(cap) };
}

/**
 * Build a {@link ReviewResult} from a produced review, optionally overriding
 * the inline findings and diagnostics (after cross-reviewer dedupe). The
 * requested-changes verdict is recomputed from the (possibly deduped) inline
 * set so a reviewer whose only blocker was a duplicate doesn't request changes.
 */
export function reviewResultFromProduced(
  produced: ProducedReview,
  inline: readonly Finding[] = produced.inline,
  diagnostics: ReviewDiagnostics = produced.diagnostics,
): ReviewResult {
  if (produced.empty) {
    return {
      inlineCount: 0,
      droppedCount: 0,
      requestedChanges: false,
      summary: produced.empty.summary,
      inline: [],
      overflow: [],
      dropped: [],
      diagnostics,
    };
  }
  const capped = applyCommentCap(
    inline,
    produced.commentCap ?? DEFAULT_MAX_COMMENTS,
  );
  const requestedChanges = [
    ...capped.inline,
    ...capped.overflow,
    ...produced.review.concerns,
  ].some((f) => f.severity === "blocker");
  return {
    inlineCount: capped.inline.length,
    droppedCount: produced.dropped.length,
    requestedChanges,
    summary: produced.review.summary,
    inline: capped.inline,
    overflow: capped.overflow,
    dropped: produced.dropped,
    diagnostics: { ...diagnostics, cappedDropped: capped.overflow.length },
  };
}

/** Options for {@link publishReview} that let a caller adjust what gets posted. */
export type PublishOptions = {
  /** Override inline findings (e.g. after cross-reviewer dedupe). */
  readonly inline?: readonly Finding[];
  /** Override diagnostics (e.g. with crossReviewerDropped filled in). */
  readonly diagnostics?: ReviewDiagnostics;
  /** What to do with prior inline comments (default resolve). */
  readonly priorComments?: PriorComments;
  /** Let a higher-level orchestrator publish one summary for all reviewers. */
  readonly deferSummary?: boolean;
};

/**
 * Post a produced review as inline comments + (unless deferred) a summary.
 * A caller that deduplicated across reviewers passes the deduped `inline` and
 * updated `diagnostics` so only the surviving findings post and the run-details
 * line reflects the suppressed duplicates.
 */
export async function publishReview(
  octokit: Octokit,
  ref: PullRef,
  produced: ProducedReview,
  logger: Logger,
  opts?: PublishOptions,
): Promise<string> {
  // Apply the comment cap here, on the deduped set, so what posts inline,
  // what renders as the summary's overflow section, and what the caller's
  // ReviewResult reports are consistent — and unique findings are only demoted
  // after cross-reviewer dedupe has had its chance to free slots.
  const uncapped = opts?.inline ?? produced.inline;
  const { inline, overflow } = applyCommentCap(
    uncapped,
    produced.commentCap ?? DEFAULT_MAX_COMMENTS,
  );
  const diagnostics = opts?.diagnostics ?? produced.diagnostics;
  const reviewForPost = reviewForPosting(
    produced.review,
    produced.uncertain,
    overflow,
    produced.commentCap ?? DEFAULT_MAX_COMMENTS,
  );
  return postReview(
    octokit,
    ref,
    reviewForPost,
    inline,
    produced.dropped,
    logger,
    {
      reviewerName: produced.reviewerName,
      headSha: produced.headSha,
      refreshPaths: produced.refreshPaths,
      headPaths: produced.headPaths,
      fileCount: produced.fileCount,
      overflow,
      priorComments: opts?.priorComments,
      diagnostics,
      deferSummary: opts?.deferSummary,
    },
  );
}

/** Attach the collapsed lower-confidence (ensemble minority) section to a review. */
function reviewForPosting(
  review: ReviewOutput,
  uncertain: readonly Finding[],
  overflow: readonly Finding[] = [],
  maxComments?: number,
): ReviewOutput {
  const uncertainNote =
    uncertain.length > 0
      ? `\n\n<details><summary>Lower-confidence findings (raised by a minority of models)</summary>\n\n${uncertain
          .map((f) => `- \`${f.path}:${f.line}\` [${f.severity}] ${f.body}`)
          .join("\n")}\n\n</details>`
      : "";
  // Findings demoted by the comment cap go in a collapsed section too, so
  // nothing is lost — they are just no longer inline comments.
  const cap = maxComments ?? DEFAULT_MAX_COMMENTS;
  const overflowNote =
    overflow.length > 0
      ? `\n\n<details><summary>Additional findings (ranked below the ${cap}-comment cap)</summary>\n\n${overflow
          .map((f) => `- \`${f.path}:${f.line}\` [${f.severity}] ${f.body}`)
          .join("\n")}\n\n</details>`
      : "";
  return {
    ...review,
    summary: `${review.summary}${uncertainNote}${overflowNote}`,
  };
}

/**
 * Merge concerns across ensemble legs (issue #40): concerns aren't line-
 * anchored, so agreement is decided on title + detail similarity. Legs
 * raising a similar concern collapse to the strongest representative —
 * highest severity (per the canonical SEV order, not string comparison),
 * then fullest detail — while dissimilar ones are all kept, so a concern
 * raised by only one model is never silently discarded just because it
 * wasn't first. Order-preserving and deterministic.
 */

/**
 * Title similarity needs a stricter gate than finding bodies:
 * {@link SIMILARITY_THRESHOLD} was calibrated on multi-sentence bodies, but
 * titles are short prefixes that share vocabulary by convention ("Retry budget
 * is shared across request paths" vs "Retry loop has no backoff" share
 * headword trigrams without being the same concern). Calibration on title
 * pairs: genuine rewordings score >= ~0.39, distinct prefix-sharing titles
 * mostly < 0.1 with one observed false-positive pair at 0.409 ("Missing error
 * handling in the parser" vs "Missing null check in the parser"). So require
 * high title similarity OR moderately-similar titles that share the same
 * first headword AND corroborate on detail.
 */
const CONCERN_TITLE_THRESHOLD = 0.4;
/** Detail similarity needed to corroborate a title match. A title-only match
 * merges "Missing error handling…" with "Missing null check…" (0.409), so the
 * detail must independently agree: true reworded pairs score ~0.24, distinct
 * issues sharing a prefix ~0.1. */
const CONCERN_DETAIL_THRESHOLD = 0.15;

/** Two concerns are the same claim when their titles are closely similar AND
 * the details corroborate, or when titles overlap moderately with the same
 * first headword and the details strongly corroborate. Both branches demand
 * detail agreement: unlike findings, a missed concern merge keeps BOTH (the
 * inclusive outcome — nothing is lost), while a false merge silently drops a
 * model's concern, so this gate errs strict. */
function concernSimilar(a: Concern, b: Concern): boolean {
  const titleSim = bodySimilarity(a.title, b.title);
  const detailSim = bodySimilarity(a.detail, b.detail);
  if (
    titleSim >= CONCERN_TITLE_THRESHOLD &&
    detailSim >= SIMILARITY_THRESHOLD
  ) {
    return true;
  }
  return (
    titleSim >= SIMILARITY_THRESHOLD &&
    firstWord(a.title) === firstWord(b.title) &&
    detailSim >= CONCERN_DETAIL_THRESHOLD
  );
}

function firstWord(s: string): string {
  return s.trim().toLowerCase().split(/\s+/)[0] ?? "";
}

function mergeEnsembleConcerns(
  concernLists: readonly (readonly Concern[])[],
): Concern[] {
  const SEV_ORDER: Record<Severity, number> = {
    blocker: 2,
    warning: 1,
    nit: 0,
  };
  const flat: Concern[] = concernLists.flat();
  const out: Concern[] = [];
  for (const concern of flat) {
    const idx = out.findIndex((kept) => concernSimilar(kept, concern));
    const kept = idx >= 0 ? out[idx] : undefined;
    if (!kept) {
      out.push(concern);
      continue;
    }
    // Merge into the strongest representative — but NEVER allow a severity
    // downgrade: a later model's nit with a longer writeup must not replace
    // the first raiser's blocker (Bugbot: the posted concern and the
    // requested-changes verdict would silently drop). Longer detail only
    // upgrades within the same severity.
    const higherSev = SEV_ORDER[concern.severity] > SEV_ORDER[kept.severity];
    if (higherSev) {
      out[idx] = concern;
    } else if (
      SEV_ORDER[concern.severity] === SEV_ORDER[kept.severity] &&
      concern.detail.length > kept.detail.length
    ) {
      out[idx] = concern;
    }
  }
  return out;
}

/**
 * Union highlights across ensemble legs (issue #40), deduped by normalized
 * text. Order-preserving: first leg's highlights first.
 */
function mergeHighlights(lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of lists.flat()) {
    const key = h.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(h);
    }
  }
  return out;
}

/** Run the harness and produce a review without posting it. */
export async function produceReview(
  req: ReviewRequest,
): Promise<ProducedReview> {
  const { logger } = req;
  const dirs = (req.dirs ?? [])
    .map((d) => d.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  // A single dir scopes the harness cwd and the path prefix; several dirs share
  // the repo root, so no prefix is stripped and no cwd note is needed.
  const subdir = dirs.length === 1 ? dirs[0] : undefined;
  const prefix = subdir ? `${subdir}/` : "";
  const prefixes = dirs.map((d) => `${d}/`);
  const conventionPaths =
    dirs.length > 0
      ? dirs.flatMap((d) => req.conventionPaths.map((p) => `${d}/${p}`))
      : [...req.conventionPaths];

  logger.info("Reviewing pull request", {
    repo: `${req.ref.owner}/${req.ref.repo}`,
    pull: req.ref.pull_number,
    reviewer: req.reviewerName ?? "default",
    harness: req.harness.name,
    dirs,
  });

  const { octokit } = req;
  logger.debug("Fetching PR context and conventions", { conventionPaths });
  const [pull, conventions] = await Promise.all([
    fetchPullContext(octokit, req.ref),
    fetchConventions(octokit, req.ref, conventionPaths),
  ]);

  logger.info("Loaded PR", {
    title: pull.title,
    changedFiles: pull.files.length,
    conventionsFound: conventions.found,
  });
  if (conventions.found.length === 0) {
    logger.warn("No convention docs resolved; reviewing with defaults", {
      checked: conventionPaths,
    });
  }

  const include = req.include
    ? picomatch([...req.include], { dot: true })
    : undefined;
  const exclude = req.exclude
    ? picomatch([...req.exclude], { dot: true })
    : undefined;
  const scopedFiles = pull.files.filter((f) => {
    if (prefixes.length > 0 && !prefixes.some((p) => f.path.startsWith(p))) {
      return false;
    }
    if (include && !include(f.path)) return false;
    if (exclude && exclude(f.path)) return false;
    return true;
  });

  const emptyDiagnostics: ReviewDiagnostics = {
    ...CLEAN_DIAGNOSTICS,
    mode: (req.agentic ?? true) ? "agentic" : "headless",
  };

  // Nothing to post: no files in scope, or no delta since the last review.
  // These still return a ProducedReview so a caller can build a ReviewResult,
  // but `empty` marks that there is nothing to publish.
  const emptyProduced = (summary: string): ProducedReview => ({
    reviewerName: req.reviewerName,
    review: { summary, findings: [], concerns: [], highlights: [] },
    inline: [],
    uncertain: [],
    overflow: [],
    dropped: [],
    diagnostics: emptyDiagnostics,
    headSha: pull.headSha,
    refreshPaths: new Set(),
    headPaths: pull.headPaths,
    fileCount: 0,
    empty: { summary },
  });

  if (scopedFiles.length === 0) {
    logger.info("No changed files in scope; nothing to review", { dirs });
    return emptyProduced("No changed files in scope.");
  }

  // Incremental review: reassess only the in-scope files changed since this
  // reviewer's last review of the PR, and clean up only comments on those
  // files. The full in-scope PR diff still goes on disk as context. A failed
  // history lookup or compare means "unknown": review everything but leave
  // every prior comment alone, since we cannot tell what they covered.
  let files = scopedFiles;
  let refreshPaths = new Set(scopedFiles.map((f) => f.path));
  let incremental: ReviewDiagnostics["incremental"] = "full";
  if (!req.full) {
    const last = await getLastReviewed(octokit, req.ref, req.reviewerName);
    if (last.unknown) {
      logger.warn(
        "Could not read prior review history; full review, keeping prior comments",
        {
          error: last.reason,
        },
      );
      refreshPaths = new Set();
      incremental = "unknown";
    } else if (last.sha && last.sha !== pull.headSha) {
      try {
        const delta = await changedFilesBetween(
          octokit,
          req.ref,
          last.sha,
          pull.headSha,
        );
        files = scopedFiles.filter((f) => delta.has(f.path));
        refreshPaths = new Set(files.map((f) => f.path));
        incremental = "delta";
        logger.info("Incremental review", {
          priorSha: last.sha.slice(0, 9),
          headSha: pull.headSha.slice(0, 9),
          deltaInScope: files.length,
        });
        if (files.length === 0) {
          logger.info(
            "No in-scope files changed since last review; keeping prior comments",
          );
          // Even with nothing to reassess, threads stranded by a rename or
          // deletion since the last review would otherwise sit there forever,
          // since no scoped refresh will ever reach them. Skipped on dry runs,
          // which must not mutate the PR.
          if (!req.dryRun) {
            await cleanupStrandedThreads(
              octokit,
              req.ref,
              pull.headPaths,
              logger,
              {
                reviewerName: req.reviewerName,
                priorComments: req.priorComments,
              },
            );
          }
          return emptyProduced("No in-scope changes since the last review.");
        }
      } catch (err) {
        logger.warn(
          "Incremental compare failed; full review, keeping prior comments",
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
        files = scopedFiles;
        refreshPaths = new Set();
        incremental = "unknown";
      }
    }
  }
  const focus = new Set(files.map((f) => f.path));

  // Agentic (explore the checkout with tools) is the default; a reviewer opts
  // out with agentic: false to run one-shot from the diff alone.
  const agentic = req.agentic ?? true;
  const profile = req.profile ?? "chill";

  // Per-glob instructions that apply to at least one file being reassessed.
  const pathInstructions = (req.pathInstructions ?? [])
    .filter((pi) => {
      const match = picomatch(pi.glob, { dot: true });
      return files.some((f) => match(f.path));
    })
    .map((pi) => `(${pi.glob}) ${pi.instruction}`);

  const skills = loadSkills(req.workdir, req.skills, logger);
  if (skills.length > 0) {
    logger.info("Loaded skills", { count: skills.length });
  }

  const promptOpts = {
    guidance: req.guidance,
    reasoning: req.reasoning,
    profile,
    skills,
    procedure: req.procedure,
    conventions: conventions.text,
  };
  const systemPrompt = buildSystemPrompt({ ...promptOpts, agentic });
  // The harness runs where the repo is checked out. Scope to the subdir only if
  // it actually exists on disk; fall back to the workdir (or cwd) so a run
  // without a local checkout — the whole diff is in the prompt — still spawns.
  const scoped = subdir ? join(req.workdir, subdir) : req.workdir;
  const hasCheckout = existsSync(scoped);
  const harnessCwd = hasCheckout
    ? scoped
    : existsSync(req.workdir)
      ? req.workdir
      : process.cwd();

  if (agentic && !hasCheckout) {
    logger.warn(
      "Agentic review has no matching checkout on disk; the agent can't inspect real files. Pass --workdir pointing at a checkout, or set agentic: false.",
      { scoped, fallbackCwd: harnessCwd },
    );
  }

  // Agentic reviews with a real checkout get a changed-file TREE of every
  // in-scope PR file plus a diff file holding all their patches, and a focus
  // list when only some are being reassessed. Headless reviews (and agentic
  // with no checkout) inline only the files under review.
  const treeMode = agentic && existsSync(scoped);
  const diffPath = treeMode ? writeDiffFile(scopedFiles, logger) : undefined;
  // Callers of the exports this diff changes, found mechanically in the
  // checkout so the agent does not spend its turn budget grepping for them.
  // Diff paths are repo-relative; the checkout cwd is the subdir, so strip the
  // prefix to exclude/grep and add it back when rendering.
  const changed = treeMode
    ? changedExports(scopedFiles).map((c) => ({
        ...c,
        file: c.file.slice(prefix.length),
      }))
    : [];
  const callSites = treeMode
    ? renderCallSites(
        transitiveCallSites(
          harnessCwd,
          changed,
          new Set(scopedFiles.map((f) => f.path.slice(prefix.length))),
        ),
        prefix,
      )
    : "";
  if (callSites) {
    logger.info("Located call sites of changed exports", {
      exports: changed.map((c) => c.name),
    });
  }
  const commonPrompt = {
    title: pull.title,
    description: pull.description,
    pathInstructions,
    timezone: req.timezone,
  };
  const headlessUserPrompt = buildUserPrompt({ ...commonPrompt, files });
  const agenticUserPrompt = diffPath
    ? buildUserPrompt({
        ...commonPrompt,
        files: scopedFiles,
        diffPath,
        cwdSubdir: subdir && harnessCwd === scoped ? subdir : undefined,
        callSites,
        focusPaths: files.length < scopedFiles.length ? [...focus] : undefined,
      })
    : headlessUserPrompt;

  // Stable prompt-cache key per repo+reviewer so whip reuses the cached system
  // prefix across runs (and its own turns within a run). Omitted when a
  // reviewer opted out of prompt caching (promptCache:false) — a model whose
  // endpoint rejects prompt_cache_key. whip then never sends -cache-key, so no
  // 400 and no self-heal retry. Those models cache the prefix by match anyway.
  const cacheKey =
    req.promptCache !== false
      ? `loupe/${req.ref.owner}/${req.ref.repo}/${req.reviewerName ?? "default"}`
      : undefined;

  // Noise profile: hard-filter by severity (the prompt asks too, this enforces).
  const keep = new Set(severitiesForProfile(profile));

  const counts = {
    mode: (agentic ? "agentic" : "headless") as ReviewDiagnostics["mode"],
    malformedFindings: 0,
    malformedConcerns: 0,
    salvagedFindings: 0,
    outOfScope: 0,
    profileDropped: 0,
  };

  // Run one model and return its (scope-, profile-filtered, diff-anchored)
  // findings. A subprocess failure OR unparseable output from the agentic run
  // falls back once to a one-shot diff-only review so something still posts;
  // the fallback's own failure propagates. `tag` labels the provenance of the
  // pass on trace events ("primary" for the single/majority model, "ensemble"
  // for an additional ensemble model); the model id is appended when known.
  const produceOne = async (
    model: string | undefined,
    tag = "primary",
  ): Promise<{
    inline: Finding[];
    review: ReviewOutput;
    dropped: Note[];
  }> => {
    logger.info("Running harness", {
      harness: req.harness.name,
      model: model ?? "(harness default)",
      agentic,
      tag,
      filesInScope: files.length,
      cwd: harnessCwd,
    });
    const run = (useAgentic: boolean, phase: string) =>
      req.harness
        .review({
          agent: "reviewer",
          output: reviewOutput,
          name: req.reviewerName,
          systemPrompt: useAgentic
            ? systemPrompt
            : buildSystemPrompt({ ...promptOpts, agentic: false }),
          userPrompt: useAgentic ? agenticUserPrompt : headlessUserPrompt,
          model,
          provider: req.provider,
          agentic: useAgentic,
          workdir: harnessCwd,
          maxTurns: req.maxTurns,
          reasoning: req.reasoning,
          cacheKey,
          trace: req.trace,
          phase,
          logger,
        })
        .then((outcome) => parseReviewOutput(outcomeText(outcome)));
    let parsed;
    try {
      parsed = await run(agentic, model ? `${tag}:${model}` : tag);
    } catch (err) {
      // Agentic runs can run away (hit the tool-turn cap) or otherwise fail;
      // fall back to a one-shot diff-only review so we still post something.
      // A quota/rate-limit failure is not helped by switching modes (same
      // provider, same billing/throttle), so re-throw immediately instead of
      // spending a second doomed call per reviewer.
      if (!agentic || isNonRetryableHarnessError(err)) throw err;
      logger.warn("Agentic review failed; retrying one-shot from the diff", {
        error: err instanceof Error ? err.message : String(err),
        kind: err instanceof HarnessError ? err.kind : undefined,
      });
      // Set the fallback mode only once the headless retry actually resolves.
      // In an ensemble, this runs per leg against shared counts; a leg that
      // dies on the fallback too must not leave "fallback" behind to taint the
      // survivors' mode (otherwise a fully-agentic survivor review renders as
      // "headless fallback (agentic run failed)" in Run details).
      parsed = await run(false, model ? `fallback:${model}` : "fallback");
      counts.mode = "fallback";
    }
    counts.malformedFindings += parsed.malformedFindings;
    counts.malformedConcerns += parsed.malformedConcerns;
    // Incremental runs reassess only the focus files; a finding anchored on a
    // context file would duplicate a prior comment we deliberately kept.
    const inScope = parsed.review.findings.filter((f) => focus.has(f.path));
    counts.outOfScope += parsed.review.findings.length - inScope.length;
    // Salvaged findings have no anchor to validate, so they go straight to the
    // off-diff notes — under the same scope rule as everything else.
    const salvaged = parsed.salvagedFindings.filter((f) => focus.has(f.path));
    counts.salvagedFindings += salvaged.length;
    counts.outOfScope += parsed.salvagedFindings.length - salvaged.length;
    const validated = validateFindings(inScope, files);
    const inline = validated.inline.filter((f) => keep.has(f.severity));
    counts.profileDropped += validated.inline.length - inline.length;
    return {
      inline,
      review: parsed.review,
      dropped: [...validated.dropped, ...salvaged],
    };
  };

  const ensemble =
    req.ensembleModels && req.ensembleModels.length >= 2
      ? req.ensembleModels
      : undefined;

  let review: ReviewOutput;
  let dropped: Note[];
  let inline: Finding[];
  let uncertain: Finding[] = [];
  let verify: ReviewDiagnostics["verify"] = "skipped";
  let verifyDropped = 0;
  // Models that failed and were dropped from an ensemble merge so the
  // surviving legs' findings still post. Stays empty for a non-ensemble run or
  // a fully-successful one; populated per leg below. Surfaced on the summary as
  // a degraded-run note so a lost leg never reads as silence.
  let failedLegs: string[] = [];

  if (ensemble) {
    logger.info("Ensemble review", { models: ensemble });
    const runs: { inline: Finding[]; review: ReviewOutput; dropped: Note[] }[] =
      [];
    for (const model of ensemble) {
      try {
        runs.push(await produceOne(model, "ensemble"));
      } catch (err) {
        const legModel = model ?? "(harness default)";
        failedLegs.push(legModel);
        logger.warn("Ensemble leg failed; degrading to remaining models", {
          model: legModel,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Borrow the review narrative (summary) from the first surviving leg, not
    // the first configured leg — the first leg may be one that failed. Merging
    // prose summaries across models reads worse than picking one, so the first
    // survivor's summary wins (tradeoff: later legs' summaries are dropped).
    // If no leg survived, let the reviewer-level failure path post the ⚠️
    // comment and exit 1 rather than posting a vacuous "clean" review.
    const [firstSurvivor] = runs;
    if (!firstSurvivor) {
      throw new Error(`all ensemble models failed: ${failedLegs.join(", ")}`);
    }
    // Union the structured parts across ALL surviving legs instead of keeping
    // only the first survivor's — issues #40/#41: every surviving model's
    // off-diff notes, concerns, and highlights deserve to surface, and the
    // offDiff diagnostic must count the union, not one leg's slice.
    review = {
      ...firstSurvivor.review,
      concerns: mergeEnsembleConcerns(runs.map((r) => r.review.concerns)),
      highlights: mergeHighlights(runs.map((r) => r.review.highlights)),
    };
    dropped = dedupeNotes(runs.map((r) => r.dropped));
    // Keep the majority threshold relative to the configured panel, not the
    // survivors: a lone survivor's findings have models.size < threshold and
    // flow into the existing lower-confidence section — the honest claim for a
    // degraded ensemble, never a false "majority confirmed".
    const merged = mergeEnsemble(
      runs.map((r) => r.inline),
      majority(ensemble.length),
    );
    inline = [...merged.confirmed];
    uncertain = [...merged.uncertain];
    logger.info("Ensemble merged", {
      confirmed: inline.length,
      uncertain: uncertain.length,
      degradedLegs: failedLegs,
    });
  } else {
    const one = await produceOne(req.model);
    review = one.review;
    dropped = one.dropped;
    inline = one.inline;
  }

  // Verification pass: a second opinion that drops false positives. Runs after
  // both a single-model review and an ensemble merge — majority agreement
  // filters cross-model noise but not the outside-diff class (several models
  // can agree on a claim the surrounding code refutes), so the verifier still
  // reads the checkout and marks `real: false` when it does. When the review
  // was agentic and a real checkout exists, verify agentic too so the verifier
  // can read the surrounding code that refutes (or confirms) each finding
  // — instead of acquitting outside-diff claims it can't see.
  if (req.verify !== false && inline.length > 0) {
    const v = await verifyInline(
      req,
      files,
      inline,
      harnessCwd,
      agentic,
      hasCheckout,
      subdir && harnessCwd === scoped ? subdir : undefined,
    );
    verify = v.status;
    verifyDropped = inline.length - v.kept.length;
    inline = v.kept;
  }

  if (dropped.length > 0) {
    logger.warn("Some findings could not anchor to the diff", {
      dropped: dropped.length,
    });
  }

  const diagnostics: ReviewDiagnostics = {
    mode: counts.mode,
    verify,
    incremental,
    malformedDropped: {
      findings: counts.malformedFindings,
      concerns: counts.malformedConcerns,
    },
    outOfScopeDropped: counts.outOfScope,
    profileDropped: counts.profileDropped,
    verifyDropped,
    crossReviewerDropped: 0,
    offDiff: dropped.length,
    cappedDropped: 0,
    salvagedFindings: counts.salvagedFindings,
    degradedLegs: failedLegs,
  };

  const produced: ProducedReview = {
    reviewerName: req.reviewerName,
    review,
    inline,
    uncertain,
    overflow: [],
    commentCap: req.maxComments ?? DEFAULT_MAX_COMMENTS,
    dropped,
    diagnostics,
    headSha: pull.headSha,
    refreshPaths,
    headPaths: pull.headPaths,
    fileCount: files.length,
  };

  logger.info("Review produced", {
    reviewer: req.reviewerName ?? "default",
    inline: inline.length,
    uncertain: uncertain.length,
    dropped: dropped.length,
    profile,
    diagnostics,
  });

  return produced;
}

/**
 * End-to-end: produce a review and post it immediately. A single-reviewer run
 * (or the CLI) uses this; the multi-reviewer orchestrator calls
 * {@link produceReview} for each reviewer, deduplicates the union, then posts
 * via {@link publishReview} so the same reworded claim posts once.
 */
export async function runReview(req: ReviewRequest): Promise<ReviewResult> {
  const { logger } = req;
  const produced = await produceReview(req);

  if (produced.empty) {
    const result = reviewResultFromProduced(produced);
    if (req.dryRun) logger.info("Dry run — nothing to post");
    return result;
  }

  const result = reviewResultFromProduced(produced);
  if (req.dryRun) {
    logger.info("Dry run — not posting review", {
      profile: req.profile ?? "chill",
      inline: produced.inline.length,
      uncertain: produced.uncertain.length,
      summary: produced.review.summary,
      diagnostics: produced.diagnostics,
    });
    return result;
  }

  // The review ran for minutes; the PR can merge, close, or receive a new push
  // in that window. Re-read it right before publishing and stay silent if it is
  // no longer safe to post onto — findings anchored to a dead diff read as the
  // author ignoring a tool they never had a chance to act on (issue #39). The
  // findings stay on the result for the trace; only the GitHub writes are
  // suppressed. The check itself failing open: a lookup error proceeds to post,
  // since a stale-but-correct finding is better than a silent dropped review.
  const publishable = await checkPublishable(
    req.octokit,
    req.ref,
    produced.headSha,
  ).catch((err: unknown) => {
    logger.warn("Publishability check failed; posting anyway", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { publishable: true } as const;
  });
  if (!publishable.publishable) {
    logger.warn("Skipping publish — PR no longer safe to post onto", {
      reviewer: req.reviewerName ?? "default",
      reason: publishable.reason,
      inline: produced.inline.length,
      dropped: produced.dropped.length,
    });
    return { ...result, skipped: { reason: publishable.reason } };
  }

  const summaryBody = await publishReview(
    req.octokit,
    req.ref,
    produced,
    req.logger,
    {
      priorComments: req.priorComments,
      deferSummary: req.deferSummary,
    },
  );
  logger.info("Posted review", {
    reviewer: req.reviewerName ?? "default",
    inline: produced.inline.length,
    dropped: produced.dropped.length,
    diagnostics: produced.diagnostics,
  });

  return { ...result, summaryBody, reviewedHeadSha: produced.headSha };
}

/** Ask the harness to judge each finding real or not; drop the ones it rejects.
 * Agentic when the review was agentic and a real checkout exists (reads the
 * surrounding code to confirm or refute each finding); one-shot from the diff
 * otherwise. Fail-open: an error or an incomplete/invalid verdict set keeps
 * every finding and reports why. */
async function verifyInline(
  req: ReviewRequest,
  files: readonly { path: string; patch: string | undefined }[],
  findings: readonly Finding[],
  harnessCwd: string,
  agentic: boolean,
  hasCheckout: boolean,
  cwdSubdir?: string,
): Promise<{ kept: Finding[]; status: ReviewDiagnostics["verify"] }> {
  const verifyAgentic = agentic && hasCheckout;
  try {
    const outcome = await req.harness.review({
      agent: "verifier",
      output: verdictsOutput,
      systemPrompt: buildVerifySystemPrompt({ agentic: verifyAgentic }),
      userPrompt: buildVerifyUserPrompt(findings, files, {
        cwdSubdir: verifyAgentic ? cwdSubdir : undefined,
      }),
      model: req.model,
      provider: req.provider,
      agentic: verifyAgentic,
      workdir: harnessCwd,
      maxTurns: req.maxTurns,
      reasoning: req.reasoning,
      cacheKey:
        req.promptCache !== false
          ? `loupe/${req.ref.owner}/${req.ref.repo}/${req.reviewerName ?? "default"}/verify`
          : undefined,
      trace: req.trace,
      phase: req.model ? `verify:${req.model}` : "verify",
      logger: req.logger,
    });
    const result = parseVerification(outcomeText(outcome), findings.length);
    if (!result.valid) {
      req.logger.warn("Verification output invalid; keeping all findings", {
        reasons: result.reasons,
      });
      return { kept: [...findings], status: "invalid" };
    }
    const kept: Finding[] = [];
    findings.forEach((f, i) => {
      const v = result.verdicts.get(i);
      if (v?.real === false) {
        req.logger.info("Verification rejected a finding", {
          path: f.path,
          line: f.line,
          reason: v.reason,
        });
      } else {
        kept.push(f);
      }
    });
    req.logger.info("Verification pass", {
      before: findings.length,
      after: kept.length,
      dropped: findings.length - kept.length,
      agentic: verifyAgentic,
    });
    return { kept, status: "passed" };
  } catch (err) {
    req.logger.warn("Verification pass failed; keeping all findings", {
      error: err instanceof Error ? err.message : String(err),
      agentic: verifyAgentic,
    });
    return { kept: [...findings], status: "failed" };
  }
}

/**
 * Load skill docs from the checkout to fold into the reviewer. Each entry is a
 * path to a SKILL.md or a skill directory (SKILL.md is appended). Best-effort:
 * a missing skill is warned and skipped, never fatal.
 */
function loadSkills(
  workdir: string,
  paths: readonly string[] | undefined,
  logger: Logger,
): string[] {
  const out: string[] = [];
  for (const p of paths ?? []) {
    try {
      const abs = join(workdir, p);
      const file =
        existsSync(abs) && statSync(abs).isDirectory()
          ? join(abs, "SKILL.md")
          : abs;
      out.push(readFileSync(file, "utf8"));
    } catch {
      logger.warn("Could not load skill; skipping", { skill: p });
    }
  }
  return out;
}
