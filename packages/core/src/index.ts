import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Harness } from "@loupe/harness";
import type { Logger } from "@loupe/logger";

import {
  fetchConventions,
  fetchPullContext,
  makeOctokit,
  postReview,
  type PullRef,
} from "./github";
import { parseReviewOutput } from "./parse";
import type { Finding } from "./types";
import {
  buildSystemPrompt,
  buildUserPrompt,
  type ReasoningEffort,
} from "./prompt";
import { validateFindings } from "./validate";

export * from "./types";
export * from "./diff";
export * from "./prompt";
export * from "./parse";
export * from "./validate";
export * from "./github";

export type ReviewRequest = {
  readonly token: string;
  readonly ref: PullRef;
  readonly harness: Harness;
  readonly workdir: string;
  /** Secrets to inject into the harness subprocess (e.g. ANTHROPIC_API_KEY). */
  readonly harnessEnv: Record<string, string>;
  /** Convention doc paths to pull from the target repo, in priority order. */
  readonly conventionPaths: readonly string[];
  /**
   * Restrict the review to a subdirectory of the repo (e.g. "inference").
   * Only changed files under it are reviewed, convention docs are read from it,
   * and the harness runs with it as its working directory.
   */
  readonly subdir?: string;
  /** Compute and log the review without posting it to the PR. */
  readonly dryRun?: boolean;
  /** Model id passed to the harness (e.g. "kimi-k3"). */
  readonly model?: string;
  /** Reasoning effort baked into the system prompt (default medium). */
  readonly reasoning: ReasoningEffort;
  /** Custom reviewer guidance replacing the default; contract is still appended. */
  readonly guidance?: string;
  /** Named reviewer profile; labels the posted review (e.g. "migrations"). */
  readonly reviewerName?: string;
  /** Only review changed files matching these globs (in addition to subdir). */
  readonly include?: readonly string[];
  /** Exclude changed files matching these globs. */
  readonly exclude?: readonly string[];
  readonly logger: Logger;
};

export type ReviewResult = {
  readonly inlineCount: number;
  readonly droppedCount: number;
  readonly requestedChanges: boolean;
  readonly summary: string;
  readonly inline: readonly Finding[];
  readonly dropped: readonly Finding[];
};

/** End-to-end: fetch PR + conventions, run the harness, post the review. */
export async function runReview(req: ReviewRequest): Promise<ReviewResult> {
  const { logger } = req;
  const subdir = req.subdir?.replace(/^\/+|\/+$/g, "");
  const prefix = subdir ? `${subdir}/` : "";
  const conventionPaths = req.conventionPaths.map((p) => `${prefix}${p}`);

  logger.info("Reviewing pull request", {
    repo: `${req.ref.owner}/${req.ref.repo}`,
    pull: req.ref.pull_number,
    reviewer: req.reviewerName ?? "default",
    harness: req.harness.name,
    subdir: subdir ?? null,
  });

  const octokit = makeOctokit(req.token, logger);
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

  const include = req.include?.map((g) => new Bun.Glob(g));
  const exclude = req.exclude?.map((g) => new Bun.Glob(g));
  const files = pull.files.filter((f) => {
    if (subdir && !f.path.startsWith(prefix)) return false;
    if (include && !include.some((g) => g.match(f.path))) return false;
    if (exclude && exclude.some((g) => g.match(f.path))) return false;
    return true;
  });

  if (files.length === 0) {
    logger.info("No changed files in scope; nothing to review", {
      subdir: subdir ?? null,
    });
    return {
      inlineCount: 0,
      droppedCount: 0,
      requestedChanges: false,
      summary: "No changed files in scope.",
      inline: [],
      dropped: [],
    };
  }

  const systemPrompt = buildSystemPrompt({
    guidance: req.guidance,
    reasoning: req.reasoning,
  });
  const userPrompt = buildUserPrompt({
    title: pull.title,
    description: pull.description,
    files,
    conventions: conventions.text,
  });

  // The harness runs where the repo is checked out. Scope to the subdir only if
  // it actually exists on disk; fall back to the workdir (or cwd) so a run
  // without a local checkout — the whole diff is in the prompt — still spawns.
  const scoped = subdir ? join(req.workdir, subdir) : req.workdir;
  const harnessCwd = existsSync(scoped)
    ? scoped
    : existsSync(req.workdir)
      ? req.workdir
      : process.cwd();

  logger.info("Running harness", {
    harness: req.harness.name,
    model: req.model ?? "(harness default)",
    reasoning: req.reasoning,
    filesInScope: files.length,
    promptChars: systemPrompt.length + userPrompt.length,
    cwd: harnessCwd,
  });
  const stdout = await req.harness.review({
    systemPrompt,
    userPrompt,
    model: req.model,
    workdir: harnessCwd,
    env: req.harnessEnv,
    logger,
  });

  const review = parseReviewOutput(stdout);
  const { inline, dropped } = validateFindings(review.findings, files);
  if (dropped.length > 0) {
    logger.warn("Some findings could not anchor to the diff", {
      dropped: dropped.length,
    });
  }

  const requestedChanges = inline.some((f) => f.severity === "blocker");
  const verdict = requestedChanges ? "REQUEST_CHANGES" : "COMMENT";
  const result: ReviewResult = {
    inlineCount: inline.length,
    droppedCount: dropped.length,
    requestedChanges,
    summary: review.summary,
    inline,
    dropped,
  };

  if (req.dryRun) {
    logger.info("Dry run — not posting review", {
      verdict,
      summary: review.summary,
    });
    return result;
  }

  await postReview(octokit, req.ref, review, inline, dropped, req.reviewerName);
  logger.info("Posted review", {
    reviewer: req.reviewerName ?? "default",
    inline: inline.length,
    dropped: dropped.length,
    verdict,
  });

  return result;
}
