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
import { buildPrompt } from "./prompt";
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
  readonly logger: Logger;
};

export type ReviewResult = {
  readonly inlineCount: number;
  readonly droppedCount: number;
  readonly requestedChanges: boolean;
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

  const files = subdir
    ? pull.files.filter((f) => f.path.startsWith(prefix))
    : pull.files;

  if (files.length === 0) {
    logger.info("No changed files in scope; nothing to review", {
      subdir: subdir ?? null,
    });
    return { inlineCount: 0, droppedCount: 0, requestedChanges: false };
  }

  const prompt = buildPrompt({
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
    filesInScope: files.length,
    promptChars: prompt.length,
    cwd: harnessCwd,
  });
  const stdout = await req.harness.review({
    prompt,
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

  if (req.dryRun) {
    logger.info("Dry run — not posting review", {
      summary: review.summary,
      inline: inline.map(
        (f) => `${f.path}:${f.line} [${f.severity}] ${f.body}`,
      ),
      dropped: dropped.length,
      verdict,
    });
    return {
      inlineCount: inline.length,
      droppedCount: dropped.length,
      requestedChanges,
    };
  }

  await postReview(octokit, req.ref, review, inline, dropped);
  logger.info("Posted review", {
    inline: inline.length,
    dropped: dropped.length,
    verdict,
  });

  return {
    inlineCount: inline.length,
    droppedCount: dropped.length,
    requestedChanges,
  };
}
