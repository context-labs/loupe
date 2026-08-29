import { runReview, type ReviewResult } from "@loupe/core";
import {
  resolveCredentials,
  type CredentialProvider,
} from "@loupe/credentials";
import { getHarness } from "@loupe/harness";

export type RunInput = {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly harnessName: string;
  readonly workdir: string;
  readonly conventionPaths: readonly string[];
  readonly providers: readonly CredentialProvider[];
};

/** Resolve the harness + its credentials, then review. Shared by Action and CLI. */
export async function reviewPullRequest(
  input: RunInput,
): Promise<ReviewResult> {
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
  });
}

export function formatResult(result: ReviewResult): string {
  return (
    `loupe: posted ${result.inlineCount} inline comment(s)` +
    (result.droppedCount > 0
      ? `, ${result.droppedCount} off-diff note(s)`
      : "") +
    (result.requestedChanges ? " — requested changes" : "")
  );
}
