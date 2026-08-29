#!/usr/bin/env bun
import { createRootLogger, shutdownLogger } from "@loupe/logger";

import { loadConfig } from "./config";
import { formatResult, reviewPullRequest } from "./run";

const logger = createRootLogger("loupe-action");

async function main(): Promise<void> {
  const config = loadConfig();
  const result = await reviewPullRequest({
    token: config.token,
    owner: config.owner,
    repo: config.repo,
    pullNumber: config.pullNumber,
    harnessName: config.harnessName,
    workdir: config.workdir,
    conventionPaths: config.conventionPaths,
    providers: config.providers,
    subdir: config.subdir,
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
