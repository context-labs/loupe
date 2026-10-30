#!/usr/bin/env bun
import { createRootLogger, shutdownLogger } from "@loupe/logger";

import { loadConfig } from "./config";
import { setOutput, statusForError, statusForOutcomes } from "./output";
import { runReviews, CombinedSummaryPublicationError } from "./orchestrate";
import { handleComment } from "./respond";

const logger = createRootLogger("loupe-action");

const COMMENT_EVENTS = new Set([
  "issue_comment",
  "pull_request_review_comment",
]);

async function main(): Promise<void> {
  const config = loadConfig();
  // loupe is a shared action; a consumer could wire it on pull_request_target,
  // which runs with base-repo secrets while checking out attacker-controlled PR
  // head content — exactly the combination loupe's defenses assume never holds.
  // Refuse outright rather than silently running with secrets exposed.
  if (config.eventName === "pull_request_target") {
    throw new Error(
      "loupe refuses to run on pull_request_target: it exposes base-repo " +
        "secrets to attacker-controlled PR head content. Use pull_request " +
        "(fork PRs get a read-only token and no secrets) instead.",
    );
  }
  if (config.eventName && COMMENT_EVENTS.has(config.eventName)) {
    // Chat-triggered reviews (@loupe review) run runReviews inside
    // handleComment; return their outcomes so a chat-triggered quota/rate-limit
    // failure surfaces as status too, closing the same silent-green gap.
    const outcomes = await handleComment(config, logger);
    if (outcomes) setOutput("status", statusForOutcomes(outcomes));
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
    // The reviewers may have finished before the summary post threw; if so,
    // surface the run's real status from those outcomes rather than a blanket
    // "failed", which would hide a quota/rate-limit failure this change targets.
    // summaryFailed=true means all-ok reviewers still report "failed" (the
    // summary never posted, so the run did not complete) unless a reviewer hit a
    // more actionable kind (quota/rate-limit) that outranks it.
    setOutput(
      "status",
      err instanceof CombinedSummaryPublicationError
        ? statusForOutcomes(err.outcomes, true)
        : statusForError(err),
    );
    process.exitCode = 1;
  })
  .finally(() => shutdownLogger());
