import {
  anchorLabel,
  isDegraded,
  makeOctokit,
  produceReview,
  publishReview,
  reviewResultFromProduced,
  runReview,
  type Finding,
  type PriorComments,
  type ProducedReview,
  type Profile,
  type ReasoningEffort,
  type ReviewDiagnostics,
  type ReviewRequest,
  type ReviewResult,
} from "@loupe/core";
import {
  resolveCredentials,
  type CredentialProvider,
} from "@loupe/credentials";
import {
  getHarness,
  type HarnessTraceEvent,
  type WhipConfig,
} from "@loupe/harness";
import type { Logger } from "@loupe/logger";

export type RunInput = {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly harnessName: string;
  readonly workdir: string;
  readonly conventionPaths: readonly string[];
  readonly providers: readonly CredentialProvider[];
  readonly dirs?: readonly string[];
  readonly dryRun?: boolean;
  readonly model?: string;
  readonly reasoning?: ReasoningEffort;
  readonly guidance?: string;
  readonly reviewerName?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly agentic?: boolean;
  readonly profile?: Profile;
  readonly verify?: boolean;
  readonly full?: boolean;
  readonly pathInstructions?: readonly { glob: string; instruction: string }[];
  readonly ensembleModels?: readonly string[];
  readonly skills?: readonly string[];
  readonly timezone?: string;
  readonly whipConfig?: WhipConfig;
  readonly maxTurns?: number;
  readonly priorComments?: PriorComments;
  readonly procedure?: boolean;
  readonly deferSummary?: boolean;
  /** Optional trace sink forwarded to every harness call this review makes. */
  readonly trace?: (event: HarnessTraceEvent) => void;
  readonly logger: Logger;
};

/** Resolve the harness, verify it is installed, and forward its env. */
async function resolveHarness(input: RunInput): Promise<{
  harness: ReturnType<typeof getHarness>;
  harnessEnv: Record<string, string>;
}> {
  const { logger } = input;
  const harness = getHarness(input.harnessName);
  if (!(await harness.available())) {
    throw new Error(`Harness "${harness.name}" CLI is not installed.`);
  }
  // Best-effort: forward whatever credential keys the providers can supply.
  // We don't hard-fail on a missing key — harnesses often self-authenticate
  // from a local login (whip via ~/.whip, claude via its own login). If a key
  // is genuinely required and absent, the harness surfaces its own auth error.
  const harnessEnv = await resolveCredentials(
    harness.credentialKeys,
    input.providers,
  );
  const missing = harness.credentialKeys.filter((k) => !(k in harnessEnv));
  logger.debug("Harness ready", {
    harness: harness.name,
    forwardedKeys: Object.keys(harnessEnv),
    missingKeys: missing,
    providers: input.providers.map((p) => p.name),
  });
  return { harness, harnessEnv };
}

/** Build a ReviewRequest from a RunInput (shared by produce/publish/run). */
async function buildRequest(input: RunInput): Promise<ReviewRequest> {
  const { logger } = input;
  const { harness, harnessEnv } = await resolveHarness(input);
  return {
    octokit: makeOctokit(input.token, logger),
    ref: {
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
    },
    harness,
    workdir: input.workdir,
    harnessEnv,
    whipConfig: input.whipConfig,
    conventionPaths: input.conventionPaths,
    dirs: input.dirs,
    dryRun: input.dryRun,
    model: input.model,
    reasoning: input.reasoning,
    guidance: input.guidance,
    reviewerName: input.reviewerName,
    include: input.include,
    exclude: input.exclude,
    agentic: input.agentic,
    profile: input.profile,
    verify: input.verify,
    full: input.full,
    pathInstructions: input.pathInstructions,
    ensembleModels: input.ensembleModels,
    skills: input.skills,
    timezone: input.timezone,
    maxTurns: input.maxTurns,
    priorComments: input.priorComments,
    procedure: input.procedure,
    deferSummary: input.deferSummary,
    trace: input.trace,
    logger,
  };
}

/** Resolve the harness + credentials, then review end-to-end. Shared by Action and CLI. */
export async function reviewPullRequest(
  input: RunInput,
): Promise<ReviewResult> {
  return runReview(await buildRequest(input));
}

/**
 * Produce a review without posting it. The multi-reviewer orchestrator calls
 * this for every reviewer, deduplicates the union of their inline findings,
 * then posts the survivors via {@link publishReviewPullRequest}.
 */
export async function produceReviewPullRequest(
  input: RunInput,
): Promise<ProducedReview> {
  return produceReview(await buildRequest(input));
}

/**
 * Post a produced review as inline comments + (unless deferred) a summary. The
 * orchestrator passes the deduped inline set and updated diagnostics so only
 * surviving findings post. Returns the summary body (empty when deferred).
 */
export async function publishReviewPullRequest(
  input: RunInput,
  produced: ProducedReview,
  inline: readonly Finding[],
  diagnostics: ReviewDiagnostics,
): Promise<string> {
  const { logger } = input;
  return publishReview(
    makeOctokit(input.token, logger),
    {
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
    },
    produced,
    logger,
    {
      inline,
      diagnostics,
      priorComments: input.priorComments,
      deferSummary: input.deferSummary,
    },
  );
}

/** Build a ReviewResult from a produced review (optionally with deduped inline). */
export function resultFromProduced(
  produced: ProducedReview,
  inline: readonly Finding[] = produced.inline,
  diagnostics: ReviewDiagnostics = produced.diagnostics,
): ReviewResult {
  return reviewResultFromProduced(produced, inline, diagnostics);
}

export function formatResult(result: ReviewResult): string {
  const d = result.diagnostics;
  return (
    `loupe: ${result.inlineCount} inline comment(s)` +
    (result.droppedCount > 0
      ? `, ${result.droppedCount} off-diff note(s)`
      : "") +
    (result.requestedChanges ? " — requested changes" : "") +
    (isDegraded(d)
      ? ` — degraded (mode=${d.mode}, verify=${d.verify}, scope=${d.incremental}, malformed=${d.malformedDropped.findings + d.malformedDropped.concerns})`
      : "")
  );
}

const SEVERITY_MARK: Record<string, string> = {
  blocker: "🔴",
  warning: "🟡",
  nit: "🔵",
};

/** Human-readable rendering of a dry-run review for the terminal. */
export function renderReview(result: ReviewResult): string {
  const d = result.diagnostics;
  const lines = [
    `\nSummary: ${result.summary}\n`,
    `Run: mode=${d.mode} verify=${d.verify} scope=${d.incremental} malformed=${d.malformedDropped.findings}/${d.malformedDropped.concerns} outOfScope=${d.outOfScopeDropped} profile=${d.profileDropped} verifyDropped=${d.verifyDropped} crossReviewerDropped=${d.crossReviewerDropped}\n`,
  ];
  for (const f of [...result.inline, ...result.dropped]) {
    lines.push(`${SEVERITY_MARK[f.severity] ?? "•"} ${anchorLabel(f)}`);
    lines.push(`   ${f.body}\n`);
  }
  return lines.join("\n");
}
