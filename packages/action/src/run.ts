import { runReview, type ReviewResult } from "@loupe/core";
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

  const harnessEnv = await resolveCredentials(
    harness.credentialKeys,
    input.providers,
  );
  const missing = harness.credentialKeys.filter((k) => !(k in harnessEnv));
  if (missing.length > 0) {
    throw new Error(
      `Missing credentials for harness "${harness.name}": ${missing.join(", ")}. ` +
        `Checked providers: ${input.providers.map((p) => p.name).join(", ")}`,
    );
  }
  logger.debug("Harness ready", {
    harness: harness.name,
    resolvedKeys: Object.keys(harnessEnv),
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
