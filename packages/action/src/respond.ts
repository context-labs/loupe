import { readFileSync } from "node:fs";

import {
  buildChatSystemPrompt,
  buildChatUserPrompt,
  fetchPullContext,
  makeOctokit,
  postIssueComment,
} from "@loupe/core";
import { resolveCredentials } from "@loupe/credentials";
import { getHarness } from "@loupe/harness";
import type { Logger } from "@loupe/logger";
import { z } from "zod";

import type { Config } from "./config";
import { runReviews } from "./orchestrate";

const MENTION = /@loupe\b/i;

const HELP = `**loupe commands** (mention \`@loupe\`):
- \`@loupe review\` — re-review the whole PR now.
- \`@loupe <question>\` — ask about this PR (e.g. "is the retry loop safe?").
- \`@loupe help\` — this message.`;

/** Extract the triggering comment body from the GitHub event payload. */
function readCommentBody(eventPath: string): string | undefined {
  const event: unknown = JSON.parse(readFileSync(eventPath, "utf8"));
  const parsed = z
    .object({ comment: z.object({ body: z.string() }).optional() })
    .safeParse(event);
  return parsed.success ? parsed.data.comment?.body : undefined;
}

/**
 * Handle an `@loupe` mention on a PR comment: dispatch a command
 * (`review` / `help`) or answer a free-form question grounded in the diff.
 * A comment without the mention is ignored.
 */
export async function handleComment(
  config: Config,
  logger: Logger,
): Promise<void> {
  if (!config.eventPath) return;
  const body = readCommentBody(config.eventPath);
  if (!body || !MENTION.test(body)) {
    logger.info("Comment does not mention @loupe; ignoring");
    return;
  }

  const instruction = body.replace(MENTION, "").trim();
  const ref = {
    owner: config.owner,
    repo: config.repo,
    pull_number: config.pullNumber,
  };
  const octokit = makeOctokit(config.token, logger);

  if (/^help\b/i.test(instruction) || instruction.length === 0) {
    await postIssueComment(octokit, ref, HELP);
    return;
  }

  if (/^(full\s+)?review\b/i.test(instruction)) {
    logger.info("Chat command: review");
    await postIssueComment(octokit, ref, "🔍 On it — re-reviewing this PR.");
    await runReviews(config, logger, true);
    return;
  }

  // Free-form question → answer from the diff.
  logger.info("Chat question", { chars: instruction.length });
  const harness = getHarness(config.harnessName);
  const env = await resolveCredentials(
    harness.credentialKeys,
    config.providers,
  );
  const pull = await fetchPullContext(octokit, ref);
  const stdout = await harness.review({
    systemPrompt: buildChatSystemPrompt(),
    userPrompt: buildChatUserPrompt(instruction, pull.files),
    model: config.model,
    agentic: false,
    workdir: config.workdir,
    env,
    logger,
  });
  const answer = stdout.trim() || "I couldn't produce an answer for that.";
  await postIssueComment(octokit, ref, answer);
}
