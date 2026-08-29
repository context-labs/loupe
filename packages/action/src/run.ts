import {
  runReview,
  type ReasoningEffort,
  type ReviewResult,
} from "@loupe/core";
import {
  resolveCredentials,
  type CredentialProvider,
} from "@loupe/credentials";
import { getHarness } from "@loupe/harness";
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
  readonly subdir?: string;
  readonly dryRun?: boolean;
  readonly model?: string;
  readonly reasoning: ReasoningEffort;
  readonly guidance?: string;
  readonly reviewerName?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly logger: Logger;
};

/** Resolve the harness + its credentials, then review. Shared by Action and CLI. */
export async function reviewPullRequest(
  input: RunInput,
): Promise<ReviewResult> {
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

  return runReview({
    token: input.token,
    ref: {
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
    },
    harness,
    workdir: input.workdir,
    harnessEnv,
    conventionPaths: input.conventionPaths,
    subdir: input.subdir,
    dryRun: input.dryRun,
    model: input.model,
    reasoning: input.reasoning,
    guidance: input.guidance,
    reviewerName: input.reviewerName,
    include: input.include,
    exclude: input.exclude,
    logger,
  });
}

export function formatResult(result: ReviewResult): string {
  return (
    `loupe: ${result.inlineCount} inline comment(s)` +
    (result.droppedCount > 0
      ? `, ${result.droppedCount} off-diff note(s)`
      : "") +
    (result.requestedChanges ? " — requested changes" : "")
  );
}

const SEVERITY_MARK: Record<string, string> = {
  blocker: "🔴",
  warning: "🟡",
  nit: "🔵",
};

/** Human-readable rendering of a dry-run review for the terminal. */
export function renderReview(result: ReviewResult): string {
  const lines = [`\nSummary: ${result.summary}\n`];
  for (const f of [...result.inline, ...result.dropped]) {
    lines.push(`${SEVERITY_MARK[f.severity] ?? "•"} ${f.path}:${f.line}`);
    lines.push(`   ${f.body}\n`);
  }
  return lines.join("\n");
}
