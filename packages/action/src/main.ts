#!/usr/bin/env bun
import { loadConfig } from "./config";
import { formatResult, reviewPullRequest } from "./run";

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
  });
  console.log(formatResult(result));
}

main().catch((err: unknown) => {
  console.error("loupe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
