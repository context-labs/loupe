import {
  checkPrOpen,
  makeOctokit,
  postIssueComment,
  upsertCombinedSummary,
  type ReviewResult,
  type SkipReason,
} from "@loupe/core";
import { HarnessError, type HarnessErrorKind } from "@loupe/harness";
import type { Logger } from "@loupe/logger";

import type { Config } from "./config";
import { loadReviewers } from "./reviewers";
import { formatResult, reviewPullRequest, type RunInput } from "./run";
import {
  createTraceCollector,
  writeReviewsTraceToSummary,
  type ReviewerTrace,
} from "./trace";

/** What one reviewer did: its result, or the failure that was reported on the PR. */
export class CombinedSummaryPublicationError extends Error {
  /** The reviewer outcomes from the completed run, recoverable when the
   * combined summary failed to post so a caller can still surface status. */
  readonly outcomes: readonly ReviewerOutcome[];
  constructor(cause: unknown, outcomes: readonly ReviewerOutcome[]) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "CombinedSummaryPublicationError";
    this.cause = cause;
    this.outcomes = outcomes;
  }
}

export type ReviewerOutcome =
  | { readonly name: string; readonly ok: true; readonly result: ReviewResult }
  | {
      readonly name: string;
      readonly ok: false;
      readonly error: string;
      /** The classified HarnessError kind, if the failure was a harness error. */
      readonly kind?: HarnessErrorKind;
    };

/**
 * Run one reviewer, reporting its own failure on the PR so a broken reviewer
 * never reads as silence. The failure comment carries a bounded reason and no
 * marker or SHA, so it can never be mistaken for a review or advance
 * incremental state. `onTrace` receives the reviewer's normalized harness
 * events (if the caller wants to record them).
 */
async function runOne(
  config: Config,
  input: RunInput,
  label: string,
  logger: Logger,
  onTrace?: (e: Parameters<NonNullable<RunInput["trace"]>>[0]) => void,
): Promise<ReviewerOutcome> {
  try {
    const result = await reviewPullRequest({
      ...input,
      trace: onTrace,
    });
    logger.info(`[${label}] ${formatResult(result)}`);
    return { name: label, ok: true, result };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // The harness already classified its own failures when it built the
    // HarnessError, so carry that kind through. Don't re-classify arbitrary
    // error strings here — an Octokit 402/429 or a config error mentioning
    // "billing" would otherwise be misrouted to a quota/rate-limit status a
    // workflow routes to #billing. Non-harness failures stay undefined (failed).
    const kind = err instanceof HarnessError ? err.kind : undefined;
    logger.error(`[${label}] review failed`, { error: reason, kind });
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
    return { name: label, ok: false, error: reason, kind };
  }
}

/** Human phrasing for a pre-publish skip, for the combined summary and re-review comment. */
export function skipReasonText(reason: SkipReason): string {
  if (reason === "merged") return "merged";
  if (reason === "closed") return "closed";
  return "head moved";
}

export function renderCombinedSummary(
  outcomes: readonly ReviewerOutcome[],
): string {
  const sections = outcomes.map((outcome) => {
    const start = `<!-- loupe:section:${outcome.name}:start -->`;
    const end = `<!-- loupe:section:${outcome.name}:end -->`;
    let content: string;
    if (!outcome.ok) {
      content = `## ${outcome.name}\n\n⚠️ Reviewer failed: ${outcome.error.split("\n")[0]?.slice(0, 300)}`;
    } else if (outcome.result.skipped) {
      content = `## ${outcome.name}\n\n⏸️ Skipped: the PR ${skipReasonText(outcome.result.skipped.reason)} before loupe could publish. Findings were computed but not posted.`;
    } else if (!outcome.result.summaryBody) {
      content = `## ${outcome.name}\n\n_Not run: ${outcome.result.summary}_`;
    } else {
      content = outcome.result.summaryBody.replace(
        /^### 🔍 [^\n]+\n\n/,
        `## ${outcome.name}\n\n`,
      );
    }
    return `${start}\n${content}\n${end}`;
  });
  return [
    "# 🔍 Loupe review",
    ...sections,
    "Use `@loupe fix` to address all open findings.",
  ].join("\n\n---\n\n");
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
  const ref = {
    owner: config.owner,
    repo: config.repo,
    pull_number: config.pullNumber,
  };
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

  const reviewersDone: {
    readonly run: Promise<ReviewerOutcome>;
    readonly readTrace: () => ReviewerTrace;
  }[] = [];

  if (config.configPath) {
    let reviewers = loadReviewers(config.configPath);
    if (config.reviewerFilter) {
      reviewers = reviewers.filter((r) => r.name === config.reviewerFilter);
    }
    logger.info("Running reviewers", {
      reviewers: reviewers.map((r) => r.name),
    });
    for (const r of reviewers) {
      const collector = createTraceCollector(r.name, config.harnessName);
      reviewersDone.push({
        run: runOne(
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
            deferSummary: true,
            logger,
          },
          r.name,
          logger,
          collector.emit,
        ),
        readTrace: collector.read,
      });
    }
  } else {
    const collector = createTraceCollector("default", config.harnessName);
    reviewersDone.push({
      run: runOne(
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
          deferSummary: true,
          logger,
        },
        "default",
        logger,
        collector.emit,
      ),
      readTrace: collector.read,
    });
  }

  // All reviewers run concurrently. Each writes only into its own collector
  // array, so there is no shared mutable buffer to race on. Wait for every
  // outcome (success or failure) before touching the summary: the trace must
  // reflect the whole run, including reviewers that errored mid-stream.
  const outcomes = await Promise.all(reviewersDone.map((r) => r.run));
  const traces = reviewersDone.map((r) => r.readTrace());

  // Offline, no model calls: append the captured transcripts to the step
  // summary after outcomes have completed. No-op unless GITHUB_STEP_SUMMARY is
  // set (e.g. local runs can point it at a scratch file).
  try {
    writeReviewsTraceToSummary(traces);
  } catch (err) {
    logger.warn("Could not write the review traces to the step summary", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Gate the combined summary on the PR being still open (issue #39). The
  // summary carries finding summaries and must not land on a PR that merged or
  // closed while the reviewers were running; the prior summary (posted when the
  // PR was open) stays in place rather than being overwritten on a dead diff.
  // A head move is deliberately NOT checked here: head movement is already
  // handled per reviewer (`checkPublishable` anchors on each reviewer's own
  // fetched head), and a run-start head anchor would race the reviewers' own
  // fetches and falsely skip a summary whose inline comments are valid on the
  // current head. Fails open: a transient API error posts rather than dropping
  // a completed review's summary.
  const open = await checkPrOpen(makeOctokit(config.token, logger), ref).catch(
    () => ({ open: true }) as const,
  );
  if (!open.open) {
    logger.warn("Skipping combined summary — PR is no longer open", {
      reason: open.reason,
    });
    return outcomes;
  }

  try {
    await upsertCombinedSummary(
      makeOctokit(config.token, logger),
      ref,
      renderCombinedSummary(outcomes),
    );
  } catch (err) {
    // The reviewers already finished; carry their outcomes so a caller can
    // still surface the run's status even when the summary failed to post.
    throw new CombinedSummaryPublicationError(err, outcomes);
  }
  return outcomes;
}
