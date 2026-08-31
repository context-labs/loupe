import type { Logger } from "@loupe/logger";

import type { Config } from "./config";
import { loadReviewers } from "./reviewers";
import { formatResult, reviewPullRequest } from "./run";

/**
 * Run the configured review(s) for a PR — either the reviewer profiles from
 * `.loupe.json`, or a single default review. Shared by the pull_request entry
 * (main) and the `@loupe review` chat command. `overrideFull` forces a whole-PR
 * review regardless of config.
 */
export async function runReviews(
  config: Config,
  logger: Logger,
  overrideFull?: boolean,
): Promise<void> {
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
    subdir: config.subdir,
    verify: config.verify,
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
    for (const r of reviewers) {
      const result = await reviewPullRequest({
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
          (config.ensembleModels.length ? config.ensembleModels : undefined),
        skills: r.skills ?? (config.skills.length ? config.skills : undefined),
        logger,
      });
      logger.info(`[${r.name}] ${formatResult(result)}`);
    }
    return;
  }

  const result = await reviewPullRequest({
    ...base,
    model: config.model,
    reasoning: config.reasoning,
    profile: config.profile,
    guidance: config.guidance,
    ensembleModels: config.ensembleModels.length
      ? config.ensembleModels
      : undefined,
    skills: config.skills.length ? config.skills : undefined,
    logger,
  });
  logger.info(formatResult(result));
}
