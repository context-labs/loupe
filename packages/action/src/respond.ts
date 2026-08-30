import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  buildChatSystemPrompt,
  buildChatUserPrompt,
  buildFixSystemPrompt,
  buildFixUserPrompt,
  fetchPullContext,
  makeOctokit,
  postIssueComment,
  type PullRef,
} from "@loupe/core";
import { resolveCredentials } from "@loupe/credentials";
import { getHarness } from "@loupe/harness";
import type { Logger } from "@loupe/logger";
import type { Octokit } from "@octokit/rest";
import { z } from "zod";

import type { Config } from "./config";
import { runReviews } from "./orchestrate";

const MENTION = /@loupe\b/i;

const HELP = `**loupe commands** (mention \`@loupe\`):
- \`@loupe review\` — re-review the whole PR now.
- \`@loupe fix <what to change>\` — make the change and push a commit to this PR.
- \`@loupe <question>\` — ask about this PR (e.g. "is the retry loop safe?").
- \`@loupe help\` — this message.`;

/** Run a git command in the checkout; returns trimmed stdout ("" on failure). */
function git(cwd: string, args: readonly string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : "";
}

/**
 * `@loupe fix`: check out the PR branch, let the agentic harness make the
 * requested change, then commit and push it back to the PR. Refuses on forks
 * (no push access) and reports when nothing changed.
 */
async function runFix(
  config: Config,
  octokit: Octokit,
  ref: PullRef,
  instruction: string,
  logger: Logger,
): Promise<void> {
  const { data: pr } = await octokit.pulls.get(ref);
  if (pr.head.repo?.full_name !== pr.base.repo.full_name) {
    await postIssueComment(
      octokit,
      ref,
      "I can't push fixes to a fork's branch. Please pull the change in yourself.",
    );
    return;
  }
  const headRef = pr.head.ref;
  const cwd = config.workdir;

  git(cwd, ["fetch", "origin", headRef]);
  git(cwd, ["checkout", "-B", headRef, "FETCH_HEAD"]);

  const harness = getHarness(config.harnessName);
  const env = await resolveCredentials(
    harness.credentialKeys,
    config.providers,
  );
  const pull = await fetchPullContext(octokit, ref);
  logger.info("Fix: running agentic harness", { chars: instruction.length });
  await harness.review({
    systemPrompt: buildFixSystemPrompt(),
    userPrompt: buildFixUserPrompt(instruction, pull.files),
    model: config.model,
    agentic: true,
    workdir: cwd,
    env,
    logger,
  });

  if (!git(cwd, ["status", "--porcelain"])) {
    await postIssueComment(
      octokit,
      ref,
      "I looked at it but didn't make any changes — nothing to fix, or I wasn't sure how.",
    );
    return;
  }

  git(cwd, ["config", "user.name", "loupe"]);
  git(cwd, ["config", "user.email", "loupe@users.noreply.github.com"]);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", `loupe: ${instruction.slice(0, 60)}`]);
  const token = config.token;
  const pushUrl = `https://x-access-token:${token}@github.com/${ref.owner}/${ref.repo}.git`;
  const push = spawnSync("git", ["push", pushUrl, `HEAD:${headRef}`], {
    cwd,
    encoding: "utf8",
  });
  if (push.status !== 0) {
    logger.warn("Fix push failed", { stderr: push.stderr.slice(0, 500) });
    await postIssueComment(
      octokit,
      ref,
      "I made the change but couldn't push it (branch protection or permissions). The job needs `contents: write`.",
    );
    return;
  }
  const sha = git(cwd, ["rev-parse", "--short", "HEAD"]);
  await postIssueComment(
    octokit,
    ref,
    `✅ Pushed a fix to \`${headRef}\` (\`${sha}\`). Re-review with \`@loupe review\`.`,
  );
}

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

  const fixMatch = /^fix\b[:\s]*(.*)/is.exec(instruction);
  if (fixMatch) {
    logger.info("Chat command: fix");
    await postIssueComment(octokit, ref, "🔧 On it — working on a fix.");
    await runFix(
      config,
      octokit,
      ref,
      fixMatch[1]?.trim() || instruction,
      logger,
    );
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
