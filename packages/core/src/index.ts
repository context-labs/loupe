import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Harness, WhipConfig } from "@loupe/harness";
import type { Logger } from "@loupe/logger";
import type { Octokit } from "@octokit/rest";
import picomatch from "picomatch";

import {
  changedFilesBetween,
  fetchConventions,
  fetchPullContext,
  getLastReviewed,
  postReview,
  type PriorComments,
  type PullRef,
  type ReviewDiagnostics,
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
import {
  changedExports,
  transitiveCallSites,
  renderCallSites,
} from "./callsites";
import { renderDiff, type DiffFile } from "./diff";
import { validateFindings } from "./validate";

/**
 * Write the full unified diff to a throwaway temp file and return its path, so
 * an agentic review can read hunks from it on demand instead of carrying the
 * whole diff inline in every turn's prompt.
 */
function writeDiffFile(files: readonly DiffFile[], logger: Logger): string {
  const dir = mkdtempSync(join(tmpdir(), "loupe-diff-"));
  const path = join(dir, "pr.diff");
  writeFileSync(path, renderDiff(files));
  logger.debug("Wrote diff file for agentic exploration", {
    path,
    files: files.length,
  });
  return path;
}

export * from "./types";
export * from "./diff";
export * from "./prompt";
export * from "./parse";
export * from "./validate";
export * from "./github";
export * from "./ensemble";
export * from "./callsites";

export type ReviewRequest = {
  /** Authenticated GitHub client; see makeOctokit. */
  readonly octokit: Octokit;
  readonly ref: PullRef;
  readonly harness: Harness;
  readonly workdir: string;
  /** Secrets to inject into the harness subprocess (e.g. ANTHROPIC_API_KEY). */
  readonly harnessEnv: Record<string, string>;
  /** whip provider/model catalog to materialize into a throwaway WHIP_HOME. */
  readonly whipConfig?: WhipConfig;
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
  /**
   * Reasoning effort, passed to the harness natively and noted in the prompt.
   * Omitted: the harness's own default applies and no note is added.
   */
  readonly reasoning?: ReasoningEffort;
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
  /**
   * Skill docs to fold into the reviewer — paths (relative to the checkout) to a
   * SKILL.md or a skill directory (SKILL.md is appended). E.g.
   * ".agents/skills/i-have-adhd" to enforce that output style.
   */
  readonly skills?: readonly string[];
  /** Timezone label for the review's environment line (e.g. "PST"). */
  readonly timezone?: string;
  /** Cap on the agentic tool loop passed to the harness (default 10). */
  readonly maxTurns?: number;
  /** What to do with this reviewer's prior inline comments (default resolve). */
  readonly priorComments?: PriorComments;
  /** Append the always-on review procedure to the system prompt (default true). */
  readonly procedure?: boolean;
  readonly logger: Logger;
};

export type ReviewResult = {
  readonly inlineCount: number;
  readonly droppedCount: number;
  readonly requestedChanges: boolean;
  readonly summary: string;
  readonly inline: readonly Finding[];
  readonly dropped: readonly Finding[];
  readonly diagnostics: ReviewDiagnostics;
};

const CLEAN_DIAGNOSTICS: ReviewDiagnostics = {
  mode: "agentic",
  verify: "skipped",
  incremental: "full",
  malformedDropped: { findings: 0, concerns: 0 },
  outOfScopeDropped: 0,
  profileDropped: 0,
  verifyDropped: 0,
  offDiff: 0,
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

  const { octokit } = req;
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

  const include = req.include
    ? picomatch([...req.include], { dot: true })
    : undefined;
  const exclude = req.exclude
    ? picomatch([...req.exclude], { dot: true })
    : undefined;
  const scopedFiles = pull.files.filter((f) => {
    if (subdir && !f.path.startsWith(prefix)) return false;
    if (include && !include(f.path)) return false;
    if (exclude && exclude(f.path)) return false;
    return true;
  });

  const emptyResult = (summary: string): ReviewResult => ({
    inlineCount: 0,
    droppedCount: 0,
    requestedChanges: false,
    summary,
    inline: [],
    dropped: [],
    diagnostics: {
      ...CLEAN_DIAGNOSTICS,
      mode: (req.agentic ?? true) ? "agentic" : "headless",
    },
  });

  if (scopedFiles.length === 0) {
    logger.info("No changed files in scope; nothing to review", {
      subdir: subdir ?? null,
    });
    return emptyResult("No changed files in scope.");
  }

  // Incremental review: reassess only the in-scope files changed since this
  // reviewer's last review of the PR, and clean up only comments on those
  // files. The full in-scope PR diff still goes on disk as context. A failed
  // history lookup or compare means "unknown": review everything but leave
  // every prior comment alone, since we cannot tell what they covered.
  let files = scopedFiles;
  let refreshPaths = new Set(scopedFiles.map((f) => f.path));
  let incremental: ReviewDiagnostics["incremental"] = "full";
  if (!req.full) {
    const last = await getLastReviewed(octokit, req.ref, req.reviewerName);
    if (last.unknown) {
      logger.warn(
        "Could not read prior review history; full review, keeping prior comments",
        {
          error: last.reason,
        },
      );
      refreshPaths = new Set();
      incremental = "unknown";
    } else if (last.sha && last.sha !== pull.headSha) {
      try {
        const delta = await changedFilesBetween(
          octokit,
          req.ref,
          last.sha,
          pull.headSha,
        );
        files = scopedFiles.filter((f) => delta.has(f.path));
        refreshPaths = new Set(files.map((f) => f.path));
        incremental = "delta";
        logger.info("Incremental review", {
          priorSha: last.sha.slice(0, 9),
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
        logger.warn(
          "Incremental compare failed; full review, keeping prior comments",
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
        files = scopedFiles;
        refreshPaths = new Set();
        incremental = "unknown";
      }
    }
  }
  const focus = new Set(files.map((f) => f.path));

  // Agentic (explore the checkout with tools) is the default; a reviewer opts
  // out with agentic: false to run one-shot from the diff alone.
  const agentic = req.agentic ?? true;
  const profile = req.profile ?? "chill";

  // Per-glob instructions that apply to at least one file being reassessed.
  const pathInstructions = (req.pathInstructions ?? [])
    .filter((pi) => {
      const match = picomatch(pi.glob, { dot: true });
      return files.some((f) => match(f.path));
    })
    .map((pi) => `(${pi.glob}) ${pi.instruction}`);

  const skills = loadSkills(req.workdir, req.skills, logger);
  if (skills.length > 0) {
    logger.info("Loaded skills", { count: skills.length });
  }

  const promptOpts = {
    guidance: req.guidance,
    reasoning: req.reasoning,
    profile,
    skills,
    procedure: req.procedure,
    conventions: conventions.text,
  };
  const systemPrompt = buildSystemPrompt({ ...promptOpts, agentic });
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

  // Agentic reviews with a real checkout get a changed-file TREE of every
  // in-scope PR file plus a diff file holding all their patches, and a focus
  // list when only some are being reassessed. Headless reviews (and agentic
  // with no checkout) inline only the files under review.
  const treeMode = agentic && existsSync(scoped);
  const diffPath = treeMode ? writeDiffFile(scopedFiles, logger) : undefined;
  // Callers of the exports this diff changes, found mechanically in the
  // checkout so the agent does not spend its turn budget grepping for them.
  // Diff paths are repo-relative; the checkout cwd is the subdir, so strip the
  // prefix to exclude/grep and add it back when rendering.
  const changed = treeMode
    ? changedExports(scopedFiles).map((c) => ({
        ...c,
        file: c.file.slice(prefix.length),
      }))
    : [];
  const callSites = treeMode
    ? renderCallSites(
        transitiveCallSites(
          harnessCwd,
          changed,
          new Set(scopedFiles.map((f) => f.path.slice(prefix.length))),
        ),
        prefix,
      )
    : "";
  if (callSites) {
    logger.info("Located call sites of changed exports", {
      exports: changed.map((c) => c.name),
    });
  }
  const commonPrompt = {
    title: pull.title,
    description: pull.description,
    pathInstructions,
    timezone: req.timezone,
  };
  const headlessUserPrompt = buildUserPrompt({ ...commonPrompt, files });
  const agenticUserPrompt = diffPath
    ? buildUserPrompt({
        ...commonPrompt,
        files: scopedFiles,
        diffPath,
        cwdSubdir: subdir && harnessCwd === scoped ? subdir : undefined,
        callSites,
        focusPaths: files.length < scopedFiles.length ? [...focus] : undefined,
      })
    : headlessUserPrompt;

  // Stable prompt-cache key per repo+reviewer so whip reuses the cached system
  // prefix across runs (and its own turns within a run).
  const cacheKey = `loupe/${req.ref.owner}/${req.ref.repo}/${req.reviewerName ?? "default"}`;

  // Noise profile: hard-filter by severity (the prompt asks too, this enforces).
  const keep = new Set(severitiesForProfile(profile));

  const counts = {
    mode: (agentic ? "agentic" : "headless") as ReviewDiagnostics["mode"],
    malformedFindings: 0,
    malformedConcerns: 0,
    outOfScope: 0,
    profileDropped: 0,
  };

  // Run one model and return its (scope-, profile-filtered, diff-anchored)
  // findings. A subprocess failure OR unparseable output from the agentic run
  // falls back once to a one-shot diff-only review so something still posts;
  // the fallback's own failure propagates.
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
    const run = (useAgentic: boolean) =>
      req.harness
        .review({
          systemPrompt: useAgentic
            ? systemPrompt
            : buildSystemPrompt({ ...promptOpts, agentic: false }),
          userPrompt: useAgentic ? agenticUserPrompt : headlessUserPrompt,
          model,
          agentic: useAgentic,
          workdir: harnessCwd,
          env: req.harnessEnv,
          whipConfig: req.whipConfig,
          maxTurns: req.maxTurns,
          reasoning: req.reasoning,
          cacheKey,
          logger,
        })
        .then(parseReviewOutput);
    let parsed;
    try {
      parsed = await run(agentic);
    } catch (err) {
      if (!agentic) throw err;
      logger.warn("Agentic review failed; retrying one-shot from the diff", {
        error: err instanceof Error ? err.message : String(err),
      });
      counts.mode = "fallback";
      parsed = await run(false);
    }
    counts.malformedFindings += parsed.malformedFindings;
    counts.malformedConcerns += parsed.malformedConcerns;
    // Incremental runs reassess only the focus files; a finding anchored on a
    // context file would duplicate a prior comment we deliberately kept.
    const inScope = parsed.review.findings.filter((f) => focus.has(f.path));
    counts.outOfScope += parsed.review.findings.length - inScope.length;
    const validated = validateFindings(inScope, files);
    const inline = validated.inline.filter((f) => keep.has(f.severity));
    counts.profileDropped += validated.inline.length - inline.length;
    return { inline, review: parsed.review, dropped: [...validated.dropped] };
  };

  const ensemble =
    req.ensembleModels && req.ensembleModels.length >= 2
      ? req.ensembleModels
      : undefined;

  let review: ReviewOutput;
  let dropped: Finding[];
  let inline: Finding[];
  let uncertain: Finding[] = [];
  let verify: ReviewDiagnostics["verify"] = "skipped";
  let verifyDropped = 0;

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
      const v = await verifyInline(req, files, inline, harnessCwd);
      verify = v.status;
      verifyDropped = inline.length - v.kept.length;
      inline = v.kept;
    }
  }

  if (dropped.length > 0) {
    logger.warn("Some findings could not anchor to the diff", {
      dropped: dropped.length,
    });
  }

  const diagnostics: ReviewDiagnostics = {
    mode: counts.mode,
    verify,
    incremental,
    malformedDropped: {
      findings: counts.malformedFindings,
      concerns: counts.malformedConcerns,
    },
    outOfScopeDropped: counts.outOfScope,
    profileDropped: counts.profileDropped,
    verifyDropped,
    offDiff: dropped.length,
  };

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
    diagnostics,
  };

  if (req.dryRun) {
    logger.info("Dry run — not posting review", {
      verdict,
      profile,
      inline: inline.length,
      uncertain: uncertain.length,
      summary: review.summary,
      diagnostics,
    });
    return result;
  }

  await postReview(octokit, req.ref, reviewForPost, inline, dropped, logger, {
    reviewerName: req.reviewerName,
    headSha: pull.headSha,
    refreshPaths,
    fileCount: files.length,
    priorComments: req.priorComments,
    diagnostics,
  });
  logger.info("Posted review", {
    reviewer: req.reviewerName ?? "default",
    inline: inline.length,
    dropped: dropped.length,
    verdict,
    diagnostics,
  });

  return result;
}

/**
 * Ask the harness to judge each finding real or not; drop the ones it rejects.
 * One-shot (never agentic). Fail-open: an error or an incomplete/invalid
 * verdict set keeps every finding and reports why.
 */
async function verifyInline(
  req: ReviewRequest,
  files: readonly { path: string; patch: string | undefined }[],
  findings: readonly Finding[],
  harnessCwd: string,
): Promise<{ kept: Finding[]; status: ReviewDiagnostics["verify"] }> {
  try {
    const stdout = await req.harness.review({
      systemPrompt: buildVerifySystemPrompt(),
      userPrompt: buildVerifyUserPrompt(findings, files),
      model: req.model,
      agentic: false,
      workdir: harnessCwd,
      env: req.harnessEnv,
      whipConfig: req.whipConfig,
      maxTurns: req.maxTurns,
      reasoning: req.reasoning,
      cacheKey: `loupe/${req.ref.owner}/${req.ref.repo}/${req.reviewerName ?? "default"}/verify`,
      logger: req.logger,
    });
    const result = parseVerification(stdout, findings.length);
    if (!result.valid) {
      req.logger.warn("Verification output invalid; keeping all findings", {
        reasons: result.reasons,
      });
      return { kept: [...findings], status: "invalid" };
    }
    const kept: Finding[] = [];
    findings.forEach((f, i) => {
      const v = result.verdicts.get(i);
      if (v?.real === false) {
        req.logger.info("Verification rejected a finding", {
          path: f.path,
          line: f.line,
          reason: v.reason,
        });
      } else {
        kept.push(f);
      }
    });
    req.logger.info("Verification pass", {
      before: findings.length,
      after: kept.length,
      dropped: findings.length - kept.length,
    });
    return { kept, status: "passed" };
  } catch (err) {
    req.logger.warn("Verification pass failed; keeping all findings", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { kept: [...findings], status: "failed" };
  }
}

/**
 * Load skill docs from the checkout to fold into the reviewer. Each entry is a
 * path to a SKILL.md or a skill directory (SKILL.md is appended). Best-effort:
 * a missing skill is warned and skipped, never fatal.
 */
function loadSkills(
  workdir: string,
  paths: readonly string[] | undefined,
  logger: Logger,
): string[] {
  const out: string[] = [];
  for (const p of paths ?? []) {
    try {
      const abs = join(workdir, p);
      const file =
        existsSync(abs) && statSync(abs).isDirectory()
          ? join(abs, "SKILL.md")
          : abs;
      out.push(readFileSync(file, "utf8"));
    } catch {
      logger.warn("Could not load skill; skipping", { skill: p });
    }
  }
  return out;
}
