#!/usr/bin/env bun
import { createRootLogger, shutdownLogger } from "@loupe/logger";

import { loadConfig } from "./config";
import { setOutput, statusForError, statusForOutcomes } from "./output";
import { runReviews } from "./orchestrate";
import { handleComment } from "./respond";

const logger = createRootLogger("loupe-action");

const COMMENT_EVENTS = new Set([
  "issue_comment",
  "pull_request_review_comment",
]);

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.eventName && COMMENT_EVENTS.has(config.eventName)) {
    await handleComment(config, logger);
    return;
  }
  const outcomes = await runReviews(config, logger);
  if (outcomes.some((o) => !o.ok)) process.exitCode = 1;
  setOutput("status", statusForOutcomes(outcomes));
}

main()
  .catch((err: unknown) => {
    logger.error("loupe failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    setOutput("status", statusForError(err));
    process.exitCode = 1;
  })
  .finally(() => shutdownLogger());
