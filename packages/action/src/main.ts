#!/usr/bin/env bun
import { createRootLogger, shutdownLogger } from "@loupe/logger";

import { loadConfig } from "./config";
import { loadReviewers } from "./reviewers";
import { formatResult, reviewPullRequest } from "./run";

const logger = createRootLogger("loupe-action");

async function main(): Promise<void> {
  const config = loadConfig();
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
  };

  // Multi-reviewer mode: run each profile from .loupe.json whose globs match.
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
        model: r.model ?? config.model,
        reasoning: r.reasoning ?? config.reasoning,
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
    guidance: config.guidance,
    logger,
  });
  logger.info(formatResult(result));
}

main()
  .catch((err: unknown) => {
    logger.error("loupe failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  })
  .finally(() => shutdownLogger());
