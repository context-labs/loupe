import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Harness } from "@loupe/harness";
import type { Logger } from "@loupe/logger";

import {
  changedFilesBetween,
  fetchConventions,
  fetchPullContext,
  getLastReviewedSha,
  makeOctokit,
  postReview,
  type PullRef,
} from "./github";
import { majority, mergeEnsemble } from "./ensemble";
import { parseReviewOutput, parseVerification } from "./parse";
import {
  severitiesForProfile,
  type Finding,
  type Profile,
  type ReviewOutput,
} from "./types";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildVerifySystemPrompt,
  buildVerifyUserPrompt,
  type ReasoningEffort,
} from "./prompt";
import { validateFindings } from "./validate";

export * from "./types";
export * from "./diff";
export * from "./prompt";
export * from "./parse";
export * from "./validate";
export * from "./github";
export * from "./ensemble";

export type ReviewRequest = {
  readonly token: string;
  readonly ref: PullRef;
  readonly harness: Harness;
  readonly workdir: string;
  /** Secrets to inject into the harness subprocess (e.g. ANTHROPIC_API_KEY). */
  readonly harnessEnv: Record<string, string>;
  /** Convention doc paths to pull from the target repo, in priority order. */
  readonly conventionPaths: readonly string[];
  /**
   * Restrict the review to a subdirectory of the repo (e.g. "inference").
   * Only changed files under it are reviewed, convention docs are read from it,
   * and the harness runs with it as its working directory.
   */
  readonly subdir?: string;
  /** Compute and log the review without posting it to the PR. */
  readonly dryRun?: boolean;
  /** Model id passed to the harness (e.g. "kimi-k3"). */
  readonly model?: string;
  /** Reasoning effort baked into the system prompt (default medium). */
  readonly reasoning: ReasoningEffort;
  /** Custom reviewer guidance replacing the default; contract is still appended. */
  readonly guidance?: string;
  /** Named reviewer profile; labels the posted review (e.g. "migrations"). */
  readonly reviewerName?: string;
  /** Only review changed files matching these globs (in addition to subdir). */
  readonly include?: readonly string[];
  /** Exclude changed files matching these globs. */
  readonly exclude?: readonly string[];
  /** Let the harness use tools to explore the checkout (needs a real workdir). */
  readonly agentic?: boolean;
  /** Noise profile: quiet (blockers) | chill (default) | assertive (all). */
  readonly profile?: Profile;
  /** Per-glob extra review instructions applied to matching changed files. */
  readonly pathInstructions?: readonly { glob: string; instruction: string }[];
  /** Second-opinion verification pass to drop false positives (default true). */
  readonly verify?: boolean;
  /** Force a full review instead of the incremental delta since last review. */
  readonly full?: boolean;
  /**
   * Run the review with several models (on the harness) and keep only findings a
   * majority agree on; minority findings are surfaced as lower-confidence.
   * Supersedes the verification pass. Needs >= 2 models to take effect.
   */
  readonly ensembleModels?: readonly string[];
  readonly logger: Logger;
};

export type ReviewResult = {
  readonly inlineCount: number;
  readonly droppedCount: number;
  readonly requestedChanges: boolean;
  readonly summary: string;
  readonly inline: readonly Finding[];
  readonly dropped: readonly Finding[];
};

/** End-to-end: fetch PR + conventions, run the harness, post the review. */
export async function runReview(req: ReviewRequest): Promise<ReviewResult> {
  const { logger } = req;
  const subdir = req.subdir?.replace(/^\/+|\/+$/g, "");
  const prefix = subdir ? `${subdir}/` : "";
  const conventionPaths = req.conventionPaths.map((p) => `${prefix}${p}`);

  logger.info("Reviewing pull request", {
    repo: `${req.ref.owner}/${req.ref.repo}`,
    pull: req.ref.pull_number,
    reviewer: req.reviewerName ?? "default",
    harness: req.harness.name,
    subdir: subdir ?? null,
  });

  const octokit = makeOctokit(req.token, logger);
  logger.debug("Fetching PR context and conventions", { conventionPaths });
  const [pull, conventions] = await Promise.all([
    fetchPullContext(octokit, req.ref),
    fetchConventions(octokit, req.ref, conventionPaths),
  ]);

  logger.info("Loaded PR", {
    title: pull.title,
    changedFiles: pull.files.length,
    conventionsFound: conventions.found,
  });
  if (conventions.found.length === 0) {
    logger.warn("No convention docs resolved; reviewing with defaults", {
      checked: conventionPaths,
    });
  }

  const include = req.include?.map((g) => new Bun.Glob(g));
  const exclude = req.exclude?.map((g) => new Bun.Glob(g));
  const scopedFiles = pull.files.filter((f) => {
    if (subdir && !f.path.startsWith(prefix)) return false;
    if (include && !include.some((g) => g.match(f.path))) return false;
    if (exclude && exclude.some((g) => g.match(f.path))) return false;
    return true;
  });

  const emptyResult = (summary: string): ReviewResult => ({
    inlineCount: 0,
    droppedCount: 0,
    requestedChanges: false,
    summary,
    inline: [],
    dropped: [],
  });

  if (scopedFiles.length === 0) {
    logger.info("No changed files in scope; nothing to review", {
      subdir: subdir ?? null,
    });
    return emptyResult("No changed files in scope.");
  }

  // Incremental review: only re-review files changed since this reviewer's last
  // review of the PR, and only replace comments on those files (comments on
  // untouched files are kept). Full review (--full / first run) reviews all.
  let files = scopedFiles;
  let refreshPaths: Set<string> | undefined;
  if (!req.full) {
    const priorSha = await getLastReviewedSha(
      octokit,
      req.ref,
      req.reviewerName,
    );
    if (priorSha && priorSha !== pull.headSha) {
      try {
        const delta = await changedFilesBetween(
          octokit,
          req.ref,
          priorSha,
          pull.headSha,
        );
        files = scopedFiles.filter((f) => delta.has(f.path));
        refreshPaths = new Set(files.map((f) => f.path));
        logger.info("Incremental review", {
          priorSha: priorSha.slice(0, 9),
          headSha: pull.headSha.slice(0, 9),
          deltaInScope: files.length,
        });
        if (files.length === 0) {
          logger.info(
            "No in-scope files changed since last review; keeping prior comments",
          );
          return emptyResult("No in-scope changes since the last review.");
        }
      } catch (err) {
        logger.warn("Incremental compare failed; doing a full review", {
          error: err instanceof Error ? err.message : String(err),
        });
        files = scopedFiles;
      }
    }
  }

  // Agentic (explore the checkout with tools) is the default; a reviewer opts
  // out with agentic: false to run one-shot from the diff alone.
  const agentic = req.agentic ?? true;
  const profile = req.profile ?? "chill";

  // Per-glob instructions that apply to at least one file in scope.
  const pathInstructions = (req.pathInstructions ?? [])
    .filter((pi) => {
      const g = new Bun.Glob(pi.glob);
      return files.some((f) => g.match(f.path));
    })
    .map((pi) => `(${pi.glob}) ${pi.instruction}`);

  const systemPrompt = buildSystemPrompt({
    guidance: req.guidance,
    reasoning: req.reasoning,
    agentic,
    profile,
  });
  const userPrompt = buildUserPrompt({
    title: pull.title,
    description: pull.description,
    files,
    conventions: conventions.text,
    pathInstructions,
  });

  // The harness runs where the repo is checked out. Scope to the subdir only if
  // it actually exists on disk; fall back to the workdir (or cwd) so a run
  // without a local checkout — the whole diff is in the prompt — still spawns.
  const scoped = subdir ? join(req.workdir, subdir) : req.workdir;
  const harnessCwd = existsSync(scoped)
    ? scoped
    : existsSync(req.workdir)
      ? req.workdir
      : process.cwd();

  if (agentic && !existsSync(scoped)) {
    logger.warn(
      "Agentic review has no matching checkout on disk; the agent can't inspect real files. Pass --workdir pointing at a checkout, or set agentic: false.",
      { scoped, fallbackCwd: harnessCwd },
    );
  }

  // Noise profile: hard-filter by severity (the prompt asks too, this enforces).
  const keep = new Set(severitiesForProfile(profile));

  // Run one model and return its (profile-filtered, diff-anchored) findings.
  const produceOne = async (
    model: string | undefined,
  ): Promise<{
    inline: Finding[];
    review: ReviewOutput;
    dropped: Finding[];
  }> => {
    logger.info("Running harness", {
      harness: req.harness.name,
      model: model ?? "(harness default)",
      agentic,
      filesInScope: files.length,
      cwd: harnessCwd,
    });
    const run = (useAgentic: boolean): Promise<string> =>
      req.harness.review({
        systemPrompt: useAgentic
          ? systemPrompt
          : buildSystemPrompt({
              guidance: req.guidance,
              reasoning: req.reasoning,
              agentic: false,
              profile,
            }),
        userPrompt,
        model,
        agentic: useAgentic,
        workdir: harnessCwd,
        env: req.harnessEnv,
        logger,
      });
    let stdout: string;
    try {
      stdout = await run(agentic);
    } catch (err) {
      // Agentic runs can run away (hit the tool-turn cap) or otherwise fail;
      // fall back to a one-shot diff-only review so we still post something.
      if (!agentic) throw err;
      logger.warn("Agentic review failed; retrying one-shot from the diff", {
        error: err instanceof Error ? err.message : String(err),
      });
      stdout = await run(false);
    }
    const review = parseReviewOutput(stdout);
    const validated = validateFindings(review.findings, files);
    return {
      inline: validated.inline.filter((f) => keep.has(f.severity)),
      review,
      dropped: [...validated.dropped],
    };
  };

  const ensemble =
    req.ensembleModels && req.ensembleModels.length >= 2
      ? req.ensembleModels
      : undefined;

  let review: ReviewOutput;
  let dropped: Finding[];
  let inline: Finding[];
  let uncertain: Finding[] = [];

  if (ensemble) {
    logger.info("Ensemble review", { models: ensemble });
    const [firstModel, ...restModels] = ensemble;
    const firstRun = await produceOne(firstModel);
    const runs = [firstRun];
    for (const model of restModels) runs.push(await produceOne(model)); // sequential
    review = firstRun.review;
    dropped = firstRun.dropped;
    const merged = mergeEnsemble(
      runs.map((r) => r.inline),
      majority(ensemble.length),
    );
    inline = [...merged.confirmed];
    uncertain = [...merged.uncertain];
    logger.info("Ensemble merged", {
      confirmed: inline.length,
      uncertain: uncertain.length,
    });
  } else {
    const one = await produceOne(req.model);
    review = one.review;
    dropped = one.dropped;
    inline = one.inline;
    // Verification pass: a cheap second opinion that drops false positives.
    if (req.verify !== false && inline.length > 0) {
      inline = await verifyInline(req, files, inline, harnessCwd);
    }
  }

  if (dropped.length > 0) {
    logger.warn("Some findings could not anchor to the diff", {
      dropped: dropped.length,
    });
  }

  // Ensemble minority findings go in a collapsed lower-confidence section.
  const uncertainNote =
    uncertain.length > 0
      ? `\n\n<details><summary>Lower-confidence findings (raised by a minority of models)</summary>\n\n${uncertain
          .map((f) => `- \`${f.path}:${f.line}\` [${f.severity}] ${f.body}`)
          .join("\n")}\n\n</details>`
      : "";
  const reviewForPost: ReviewOutput = {
    ...review,
    summary: `${review.summary}${uncertainNote}`,
  };

  const requestedChanges = [...inline, ...review.concerns].some(
    (f) => f.severity === "blocker",
  );
  const verdict = requestedChanges ? "REQUEST_CHANGES" : "COMMENT";
  const result: ReviewResult = {
    inlineCount: inline.length,
    droppedCount: dropped.length,
    requestedChanges,
    summary: review.summary,
    inline,
    dropped,
  };

  if (req.dryRun) {
    logger.info("Dry run — not posting review", {
      verdict,
      profile,
      inline: inline.length,
      uncertain: uncertain.length,
      summary: review.summary,
    });
    return result;
  }

  await postReview(octokit, req.ref, reviewForPost, inline, dropped, logger, {
    reviewerName: req.reviewerName,
    headSha: pull.headSha,
    refreshPaths,
    fileCount: files.length,
  });
  logger.info("Posted review", {
    reviewer: req.reviewerName ?? "default",
    inline: inline.length,
    dropped: dropped.length,
    verdict,
  });

  return result;
}

/** Ask the harness to verify each finding against the diff; drop the ones it
 * judges not real. One-shot (never agentic). Fail-open: on any error keep all. */
async function verifyInline(
  req: ReviewRequest,
  files: readonly { path: string; patch: string | undefined }[],
  findings: readonly Finding[],
  harnessCwd: string,
): Promise<Finding[]> {
  try {
    const stdout = await req.harness.review({
      systemPrompt: buildVerifySystemPrompt(),
      userPrompt: buildVerifyUserPrompt(findings, files),
      model: req.model,
      agentic: false,
      workdir: harnessCwd,
      env: req.harnessEnv,
      logger: req.logger,
    });
    const verdicts = parseVerification(stdout);
    const kept = findings.filter((_, i) => verdicts.get(i) !== false);
    req.logger.info("Verification pass", {
      before: findings.length,
      after: kept.length,
      dropped: findings.length - kept.length,
    });
    return kept;
  } catch (err) {
    req.logger.warn("Verification pass failed; keeping all findings", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [...findings];
  }
}
