import { makeOctokit, postIssueComment, type ReviewResult } from "@loupe/core";
import type { Logger } from "@loupe/logger";

import type { Config } from "./config";
import { loadReviewers } from "./reviewers";
import { formatResult, reviewPullRequest, type RunInput } from "./run";

/** What one reviewer did: its result, or the failure that was reported on the PR. */
export type ReviewerOutcome =
  | { readonly name: string; readonly ok: true; readonly result: ReviewResult }
  | { readonly name: string; readonly ok: false; readonly error: string };

/**
 * Run one reviewer, reporting its own failure on the PR so a broken reviewer
 * never reads as silence. The failure comment carries a bounded reason and no
 * marker or SHA, so it can never be mistaken for a review or advance
 * incremental state.
 */
async function runOne(
  config: Config,
  input: RunInput,
  label: string,
  logger: Logger,
): Promise<ReviewerOutcome> {
  try {
    const result = await reviewPullRequest(input);
    logger.info(`[${label}] ${formatResult(result)}`);
    return { name: label, ok: true, result };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(`[${label}] review failed`, { error: reason });
    try {
      await postIssueComment(
        makeOctokit(config.token, logger),
        {
          owner: config.owner,
          repo: config.repo,
          pull_number: config.pullNumber,
        },
        `⚠️ loupe · ${label} could not complete this review — ${reason.split("\n")[0]?.slice(0, 300)}\n\nSee the Actions run logs for details.`,
      );
    } catch (postErr) {
      logger.warn(`[${label}] could not post the failure comment`, {
        error: postErr instanceof Error ? postErr.message : String(postErr),
      });
    }
    return { name: label, ok: false, error: reason };
  }
}

/**
 * Run the configured review(s) for a PR — either the reviewer profiles from
 * `.loupe.json`, or a single default review. Shared by the pull_request entry
 * (main) and the `@loupe review` chat command. `overrideFull` forces a whole-PR
 * review regardless of config. Reviewer failures are reported on the PR here
 * and returned as outcomes. Only setup errors (bad config) reject.
 */
export async function runReviews(
  config: Config,
  logger: Logger,
  overrideFull?: boolean,
): Promise<ReviewerOutcome[]> {
  const full = overrideFull ?? config.full;
  const base = {
    token: config.token,
    owner: config.owner,
    repo: config.repo,
    pullNumber: config.pullNumber,
    harnessName: config.harnessName,
    workdir: config.workdir,
    conventionPaths: config.conventionPaths,
    providers: config.providers,
    dirs: config.dirs,
    verify: config.verify,
    whipConfig: config.whipConfig,
    maxTurns: config.maxTurns,
    full,
  };

  if (config.configPath) {
    let reviewers = loadReviewers(config.configPath);
    if (config.reviewerFilter) {
      reviewers = reviewers.filter((r) => r.name === config.reviewerFilter);
    }
    logger.info("Running reviewers", {
      reviewers: reviewers.map((r) => r.name),
    });
    return Promise.all(
      reviewers.map((r) =>
        runOne(
          config,
          {
            ...base,
            reviewerName: r.name,
            guidance: r.guidance,
            include: r.include,
            exclude: r.exclude,
            agentic: r.agentic,
            model: r.model ?? config.model,
            reasoning: r.reasoning ?? config.reasoning,
            profile: r.profile ?? config.profile,
            verify: r.verify ?? config.verify,
            pathInstructions: r.pathInstructions,
            ensembleModels:
              r.ensemble ??
              (config.ensembleModels.length
                ? config.ensembleModels
                : undefined),
            skills: [...new Set([...(r.skills ?? []), ...config.skills])],
            timezone: config.timezone,
            maxTurns: r.maxTurns ?? config.maxTurns,
            priorComments: r.priorComments ?? config.priorComments,
            procedure: r.procedure ?? config.procedure,
            logger,
          },
          r.name,
          logger,
        ),
      ),
    );
  }

  return [
    await runOne(
      config,
      {
        ...base,
        model: config.model,
        reasoning: config.reasoning,
        profile: config.profile,
        guidance: config.guidance,
        ensembleModels: config.ensembleModels.length
          ? config.ensembleModels
          : undefined,
        skills: config.skills.length ? config.skills : undefined,
        timezone: config.timezone,
        priorComments: config.priorComments,
        procedure: config.procedure,
        logger,
      },
      "default",
      logger,
    ),
  ];
}
