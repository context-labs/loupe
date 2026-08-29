#!/usr/bin/env bun
import { runReview } from "@loupe/core";
import { resolveCredentials } from "@loupe/credentials";
import { getHarness } from "@loupe/harness";

import { loadConfig } from "./config";

async function main(): Promise<void> {
  const config = loadConfig();
  const harness = getHarness(config.harnessName);

  if (!(await harness.available())) {
    throw new Error(
      `Harness "${harness.name}" CLI is not installed on this runner.`,
    );
  }

  const harnessEnv = await resolveCredentials(
    harness.credentialKeys,
    config.providers,
  );
  const missing = harness.credentialKeys.filter((k) => !(k in harnessEnv));
  if (missing.length > 0) {
    throw new Error(
      `Missing credentials for harness "${harness.name}": ${missing.join(", ")}. ` +
        `Checked providers: ${config.providers.map((p) => p.name).join(", ")}`,
    );
  }

  const result = await runReview({
    token: config.token,
    ref: {
      owner: config.owner,
      repo: config.repo,
      pull_number: config.pullNumber,
    },
    harness,
    workdir: config.workdir,
    harnessEnv,
    conventionPaths: config.conventionPaths,
  });

  console.log(
    `loupe: posted ${result.inlineCount} inline comment(s)` +
      (result.droppedCount > 0
        ? `, ${result.droppedCount} off-diff note(s)`
        : "") +
      (result.requestedChanges ? " — requested changes" : ""),
  );
}

main().catch((err: unknown) => {
  console.error("loupe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
