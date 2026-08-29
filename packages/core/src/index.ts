import type { Harness } from "@loupe/harness";

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
};

export type ReviewResult = {
  readonly inlineCount: number;
  readonly droppedCount: number;
  readonly requestedChanges: boolean;
};

/** End-to-end: fetch PR + conventions, run the harness, post the review. */
export async function runReview(req: ReviewRequest): Promise<ReviewResult> {
  const octokit = makeOctokit(req.token);
  const [pull, conventions] = await Promise.all([
    fetchPullContext(octokit, req.ref),
    fetchConventions(octokit, req.ref, req.conventionPaths),
  ]);

  const prompt = buildPrompt({
    title: pull.title,
    description: pull.description,
    files: pull.files,
    conventions,
  });

  const stdout = await req.harness.review({
    prompt,
    workdir: req.workdir,
    env: req.harnessEnv,
  });

  const review = parseReviewOutput(stdout);
  const { inline, dropped } = validateFindings(review.findings, pull.files);
  await postReview(octokit, req.ref, review, inline, dropped);

  return {
    inlineCount: inline.length,
    droppedCount: dropped.length,
    requestedChanges: inline.some((f) => f.severity === "blocker"),
  };
}
