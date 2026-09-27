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
  connect,
  ensureDaemon,
  envSecretValues,
  whipHarness,
  type DaemonHandle,
  type Harness,
  type HarnessTraceEvent,
  type WhipClient,
  type WhipConfig,
} from "@loupe/harness";
import type { Logger } from "@loupe/logger";

export type RunInput = {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
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
  readonly maxComments?: number;
  readonly priorComments?: PriorComments;
  readonly procedure?: boolean;
  readonly promptCache?: boolean;
  readonly deferSummary?: boolean;
  /** Optional trace sink forwarded to every harness call this review makes. */
  readonly trace?: (event: HarnessTraceEvent) => void;
  readonly logger: Logger;
};

/** What bringing whip up needs: the `whip` block and where its key comes from. */
export type WhipOptions = {
  readonly whipConfig?: WhipConfig;
  readonly providers: readonly CredentialProvider[];
  readonly logger: Logger;
};

type Whip = {
  readonly harness: Harness;
  readonly client: WhipClient;
  readonly daemon: DaemonHandle;
};

/**
 * One daemon and one client per process, shared by every reviewer that runs
 * concurrently in it. The first caller brings whip up: resolve the provider's
 * API key through the credential chain, make sure a daemon is running (a
 * dedicated one when the `whip` block's key is available), and connect. The
 * memoized promise makes every caller await the same bring-up; a failed one
 * clears so the next attempt is fresh. `releaseWhip` lets go of it all.
 */
let shared: Promise<Whip> | undefined;

export function resolveHarness(opts: WhipOptions): Promise<Harness> {
  shared ??= bringUp(opts).catch((err: unknown) => {
    shared = undefined;
    throw err;
  });
  return shared.then((w) => w.harness);
}

async function bringUp(opts: WhipOptions): Promise<Whip> {
  const credentials = opts.whipConfig
    ? await resolveCredentials(
        [opts.whipConfig.provider.apiKeyEnv],
        opts.providers,
      )
    : {};
  const daemon = await ensureDaemon({
    whipConfig: opts.whipConfig,
    credentials,
    logger: opts.logger,
  });
  const client = await connect(daemon, opts.logger);
  // Known secrets (the resolved credential values handed to the daemon) are
  // scrubbed from every trace payload so an API key that surfaces in a tool
  // result or reasoning chunk never lands in the summary.
  return {
    harness: whipHarness(client, envSecretValues(daemon.env)),
    client,
    daemon,
  };
}

/** Close the shared client and stop a daemon loupe started; a no-op otherwise. */
export async function releaseWhip(): Promise<void> {
  const pending = shared;
  shared = undefined;
  if (!pending) return;
  const whip = await pending.catch(() => undefined);
  if (!whip) return;
  whip.client.close();
  await whip.daemon.stop();
}

/** Build a ReviewRequest from a RunInput (shared by produce/publish/run). */
async function buildRequest(input: RunInput): Promise<ReviewRequest> {
  const { logger } = input;
  const harness = await resolveHarness(input);
  return {
    octokit: makeOctokit(input.token, logger),
    ref: {
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
    },
    harness,
    workdir: input.workdir,
    // The desktop daemon's default provider may not carry the model, so every
    // session names the whip block's provider explicitly.
    provider: input.whipConfig?.provider.name,
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
    maxComments: input.maxComments,
    priorComments: input.priorComments,
    procedure: input.procedure,
    promptCache: input.promptCache,
    deferSummary: input.deferSummary,
    trace: input.trace,
    logger,
  };
}

/** Bring whip up, then review end-to-end. Shared by Action and CLI. */
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
    (result.diagnostics.cappedDropped > 0
      ? `, ${result.diagnostics.cappedDropped} capped (in summary)`
      : "") +
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
  if (d.cappedDropped > 0) {
    lines.push(
      `Capped by the comment cap (see summary): ${d.cappedDropped} finding(s) ranked below the cut`,
    );
  }
  for (const f of [...result.inline, ...result.dropped]) {
    lines.push(`${SEVERITY_MARK[f.severity] ?? "•"} ${anchorLabel(f)}`);
    lines.push(`   ${f.body}\n`);
  }
  for (const f of result.overflow) {
    lines.push(
      `${SEVERITY_MARK[f.severity] ?? "•"} ${anchorLabel(f)} [capped]`,
    );
    lines.push(`   ${f.body}\n`);
  }
  return lines.join("\n");
}
