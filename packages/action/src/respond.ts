import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  buildChatSystemPrompt,
  buildChatUserPrompt,
  buildFixFindingsUserPrompt,
  buildFixSystemPrompt,
  buildFixUserPrompt,
  fetchPullContext,
  listOpenLoupeFindings,
  makeOctokit,
  postIssueComment,
  updateIssueComment,
  type OpenLoupeFinding,
  type PullRef,
  type ReviewResult,
} from "@loupe/core";
import { resolveCredentials } from "@loupe/credentials";
import { getHarness } from "@loupe/harness";
import type { Logger } from "@loupe/logger";
import type { Octokit } from "@octokit/rest";
import { z } from "zod";

import type { Config } from "./config";
import {
  CombinedSummaryPublicationError,
  runReviews,
  type ReviewerOutcome,
} from "./orchestrate";
import { loadReviewers } from "./reviewers";

const MENTION = /@loupe\b/i;

/**
 * Post a visible failure comment so a command that throws after its ack never
 * reads as silence. The full stack lives in the Actions run logs; the comment
 * carries the short reason so a maintainer knows it errored (and where to look).
 */
async function postFailure(
  octokit: Octokit,
  ref: PullRef,
  what: string,
  err: unknown,
  logger: Logger,
): Promise<void> {
  const reason = err instanceof Error ? err.message : String(err);
  logger.error(`Chat command failed: ${what}`, { error: reason });
  await postIssueComment(
    octokit,
    ref,
    `⚠️ I couldn't complete the ${what} — ${reason.slice(0, 500)}\n\nSee the Actions run logs for details.`,
  );
}

/** One reviewer's line in the re-review completion comment. */
function outcomeLine(o: ReviewerOutcome): string {
  if (!o.ok) return `${o.name}: ⚠️ failed (see the failure comment)`;
  const r: ReviewResult = o.result;
  if (
    r.inlineCount === 0 &&
    r.summary.startsWith("No changed files in scope")
  ) {
    return `${o.name}: no changed files in scope`;
  }
  const n = (s: "blocker" | "warning" | "nit"): number =>
    r.inline.filter((f) => f.severity === s).length;
  const bits = [
    n("blocker") ? `🔴 ${n("blocker")}` : "",
    n("warning") ? `🟡 ${n("warning")}` : "",
    n("nit") ? `🔵 ${n("nit")}` : "",
  ].filter(Boolean);
  const verdict = bits.length ? bits.join(" ") : "✅ no issues";
  return `${o.name}: ${verdict}${r.requestedChanges ? " (changes requested)" : ""}`;
}

/**
 * The comment that replaces the "On it" ack once a forced re-review finishes.
 * Summaries are updated in place higher up the thread, so without this the
 * only evidence a re-review ran is an "edited" label the reader never sees.
 */
export function renderReviewCompletion(
  outcomes: readonly ReviewerOutcome[],
  headSha: string,
  dirs: readonly string[] | undefined,
): string {
  const lines = outcomes.map((o) => `- ${outcomeLine(o)}`).join("\n");
  const noneInScope =
    outcomes.length > 0 &&
    outcomes.every(
      (o) => o.ok && o.result.summary.startsWith("No changed files in scope"),
    );
  const scopeNote = noneInScope
    ? `\n\nNothing to review: this loupe config covers ${dirs?.length ? dirs.map((d) => `\`${d}/\``).join(", ") : "the whole repo"} and no changed file is under it.`
    : "\n\nThe combined Loupe summary above was updated in place.";
  return `✅ Re-review of \`${headSha.slice(0, 7)}\` done.\n\n${lines}${scopeNote}`;
}

const HELP = `**loupe commands** (mention \`@loupe\`):
- \`@loupe review\` — re-review the whole PR now.
- \`@loupe fix\` — fix all open Loupe findings and push one commit.
- \`@loupe fix <what to change>\` — make a specific change and push a commit.
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
  findings?: readonly OpenLoupeFinding[],
  expectedHead?: string,
): Promise<void> {
  const { data: pr } = await octokit.pulls.get(ref);
  if (expectedHead && pr.head.sha !== expectedHead) {
    throw new Error(
      "The PR changed while findings were being collected. Please run `@loupe fix` again.",
    );
  }
  if (pr.head.repo?.full_name !== pr.base.repo.full_name) {
    await postIssueComment(
      octokit,
      ref,
      "I can't push fixes to a fork's branch. Please pull the change in yourself.",
    );
    return;
  }
  const headRef = pr.head.ref;
  const originalHead = pr.head.sha;
  const cwd = config.workdir;

  git(cwd, ["fetch", "origin", headRef]);
  const fetchedHead = git(cwd, ["rev-parse", "FETCH_HEAD"]);
  if (fetchedHead !== originalHead) {
    throw new Error(
      "The PR changed before the fix started. Please run `@loupe fix` again.",
    );
  }
  git(cwd, ["checkout", "-B", headRef, originalHead]);

  const harness = getHarness(config.harnessName);
  const env = await resolveCredentials(
    harness.credentialKeys,
    config.providers,
  );
  const pull = await fetchPullContext(octokit, ref);
  logger.info("Fix: running agentic harness", { chars: instruction.length });
  await harness.review({
    systemPrompt: buildFixSystemPrompt(),
    userPrompt: findings
      ? buildFixFindingsUserPrompt(findings, pull.files)
      : buildFixUserPrompt(instruction, pull.files),
    model: config.model,
    agentic: true,
    workdir: cwd,
    env,
    whipConfig: config.whipConfig,
    maxTurns: config.maxTurns,
    reasoning: config.reasoning,
    cacheKey: `loupe/${config.owner}/${config.repo}/fix`,
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
  git(cwd, ["fetch", "origin", headRef]);
  if (git(cwd, ["rev-parse", "FETCH_HEAD"]) !== originalHead) {
    await postIssueComment(
      octokit,
      ref,
      "I made the change, but the PR branch changed while I was working. I did not push over the newer commit; run `@loupe fix` again.",
    );
    return;
  }
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
    const ackId = await postIssueComment(
      octokit,
      ref,
      "🔍 On it — re-reviewing this PR.",
    );
    try {
      // Reviewer failures are already reported per reviewer by runReviews;
      // only a setup error reaches the catch below.
      const outcomes = await runReviews(config, logger, true);
      if (outcomes.some((o) => !o.ok)) process.exitCode = 1;
      const { data: pr } = await octokit.pulls.get(ref);
      await updateIssueComment(
        octokit,
        ref,
        ackId,
        renderReviewCompletion(outcomes, pr.head.sha, config.dirs),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error("Chat command failed: review", { error: reason });
      process.exitCode = 1;
      await updateIssueComment(
        octokit,
        ref,
        ackId,
        err instanceof CombinedSummaryPublicationError
          ? `⚠️ Re-review finished, but Loupe could not publish the combined summary — ${reason.slice(0, 500)}\n\nSee the Actions run logs for details.`
          : `⚠️ Loupe could not complete the re-review — ${reason.slice(0, 500)}\n\nSee the Actions run logs for details.`,
      );
    }
    return;
  }

  const fixMatch = /^fix\b[:\s]*(.*)/is.exec(instruction);
  if (fixMatch) {
    logger.info("Chat command: fix");
    const ackId = await postIssueComment(
      octokit,
      ref,
      "🔧 Got it — preparing the fix and collecting the current findings.",
    );
    try {
      const requested = fixMatch[1]?.trim() ?? "";
      let findings: readonly OpenLoupeFinding[] | undefined;
      let findingsHead: string | undefined;
      if (!requested || /^all$/i.test(requested)) {
        const { data: pr } = await octokit.pulls.get(ref);
        findingsHead = pr.head.sha;
        const configured = config.configPath
          ? loadReviewers(config.configPath)
              .filter(
                (reviewer) =>
                  !config.reviewerFilter ||
                  reviewer.name === config.reviewerFilter,
              )
              .map((reviewer) => reviewer.name)
          : ["default"];
        findings = await listOpenLoupeFindings(
          octokit,
          ref,
          pr.head.sha,
          new Set(configured),
        );
        if (findings.length === 0) {
          await updateIssueComment(
            octokit,
            ref,
            ackId,
            "✅ There are no open Loupe findings for the current PR head.",
          );
          return;
        }
      }
      await updateIssueComment(
        octokit,
        ref,
        ackId,
        findings
          ? `🔧 Fixing ${findings.length} open finding${findings.length === 1 ? "" : "s"} from ${new Set(findings.map((finding) => finding.reviewer)).size} reviewer${new Set(findings.map((finding) => finding.reviewer)).size === 1 ? "" : "s"}. I’ll update this PR when the commit is pushed.`
          : "🔧 Working on the requested change now. I’ll update this PR when the commit is pushed.",
      );
      await runFix(
        config,
        octokit,
        ref,
        findings ? "fix all open Loupe findings" : requested,
        logger,
        findings,
        findingsHead,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error("Chat command failed: fix", { error: reason });
      await updateIssueComment(
        octokit,
        ref,
        ackId,
        `⚠️ I couldn't complete the fix — ${reason.slice(0, 500)}\n\nSee the Actions run logs for details.`,
      );
    }
    return;
  }

  // Free-form question → answer from the diff.
  logger.info("Chat question", { chars: instruction.length });
  try {
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
      whipConfig: config.whipConfig,
      maxTurns: config.maxTurns,
      reasoning: config.reasoning,
      cacheKey: `loupe/${config.owner}/${config.repo}/chat`,
      logger,
    });
    const answer = stdout.trim() || "I couldn't produce an answer for that.";
    await postIssueComment(octokit, ref, answer);
  } catch (err) {
    await postFailure(octokit, ref, "answer", err, logger);
  }
}
