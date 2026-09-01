#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import type { Profile, ReasoningEffort } from "@loupe/core";
import { createRootLogger, shutdownLogger } from "@loupe/logger";
import { Command } from "commander";

import { resolveProviders } from "./config";
import { loadReviewers, loadSettings } from "./reviewers";
import { formatResult, renderReview, reviewPullRequest } from "./run";

const REASONING: readonly ReasoningEffort[] = ["low", "medium", "high"];

function parseReasoning(raw: string): ReasoningEffort {
  if ((REASONING as readonly string[]).includes(raw))
    return raw as ReasoningEffort;
  throw new Error(`Invalid --reasoning "${raw}". Use: ${REASONING.join(", ")}`);
}

const PROFILES: readonly Profile[] = ["quiet", "chill", "assertive"];

function parseProfile(raw: string): Profile {
  if ((PROFILES as readonly string[]).includes(raw)) return raw as Profile;
  throw new Error(`Invalid --profile "${raw}". Use: ${PROFILES.join(", ")}`);
}

/** Parse owner/repo/number from a GitHub PR URL or an owner/repo#N shorthand. */
function parsePr(input: string): {
  owner: string;
  repo: string;
  pullNumber: number;
} {
  const match =
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(input) ??
    /^([^/]+)\/([^#]+)#(\d+)$/.exec(input);
  const [, owner, repo, number] = match ?? [];
  if (owner && repo && number) {
    return { owner, repo, pullNumber: Number(number) };
  }
  throw new Error(
    `Could not parse PR "${input}". Use a PR URL or owner/repo#123.`,
  );
}

/** GITHUB_TOKEN env, else the gh CLI's token. */
function resolveToken(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const res = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  const token = res.status === 0 ? res.stdout.trim() : "";
  if (!token) {
    throw new Error(
      "No token: set GITHUB_TOKEN, pass --token, or run `gh auth login`.",
    );
  }
  return token;
}

const program = new Command();

program
  .name("loupe")
  .description("AI PR reviewer that posts inline comments")
  .version("0.1.0");

program
  .command("review")
  .description("Review a pull request and post inline comments")
  .argument("<pr>", "PR URL (github.com/owner/repo/pull/N) or owner/repo#N")
  .option("-H, --harness <name>", "agent CLI to review with (default whip)")
  .option("-m, --model <name>", "model id for the harness (default kimi-k3)")
  .option(
    "-r, --reasoning <level>",
    "reasoning effort: low|medium|high (default low)",
  )
  .option(
    "--prompt-file <path>",
    "custom reviewer guidance replacing the default (output contract still enforced)",
  )
  .option("-p, --providers <spec>", "credential provider chain", "env,dotenv")
  .option("-t, --token <token>", "GitHub token (else GITHUB_TOKEN or gh)")
  .option(
    "-w, --workdir <dir>",
    "repo checkout the harness may read",
    process.cwd(),
  )
  .option(
    "-c, --conventions <paths>",
    "convention docs to enforce",
    "CLAUDE.md,AGENTS.md,.loupe.md,CONTRIBUTING.md",
  )
  .option(
    "-d, --dir <subdir>",
    "restrict review to a repo subdirectory (e.g. inference)",
  )
  .option(
    "--config <path>",
    "reviewer-profiles config (.loupe.json) — runs each matching reviewer",
  )
  .option("--reviewer <name>", "run only this named reviewer from --config")
  .option(
    "--no-agentic",
    "review one-shot from the diff only, instead of exploring the checkout with tools",
  )
  .option(
    "--profile <name>",
    "noise profile: quiet|chill|assertive (default chill)",
  )
  .option("--timezone <tz>", "timezone label for the review environment line")
  .option(
    "--ensemble <models>",
    "comma-separated models to ensemble; keep findings a majority agree on",
  )
  .option(
    "--skills <paths>",
    "comma-separated skill paths (SKILL.md or skill dir) to fold into the reviewer",
  )
  .option("--max-turns <n>", "cap the agentic tool loop (default 10)", (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0)
      throw new Error(`Invalid --max-turns "${v}". Use a positive integer.`);
    return n;
  })
  .option("--no-verify", "skip the second-opinion verification pass")
  .option(
    "--full",
    "review the whole PR instead of the incremental delta",
    false,
  )
  .option("--dry-run", "compute and log the review without posting it", false)
  .option("--infisical-env <env>", "Infisical environment slug")
  .option("--infisical-project <id>", "Infisical project id")
  .action(
    async (
      pr: string,
      opts: {
        harness?: string;
        model?: string;
        reasoning?: string;
        promptFile?: string;
        providers: string;
        token?: string;
        workdir: string;
        conventions: string;
        dir?: string;
        config?: string;
        reviewer?: string;
        agentic: boolean;
        profile?: string;
        timezone?: string;
        maxTurns?: number;
        ensemble?: string;
        skills?: string;
        verify: boolean;
        full: boolean;
        dryRun: boolean;
        infisicalEnv?: string;
        infisicalProject?: string;
      },
    ) => {
      const logger = createRootLogger("loupe-cli");
      try {
        const { owner, repo, pullNumber } = parsePr(pr);
        // Top-level review defaults from .loupe.json; a flag overrides the file,
        // the file overrides loupe's built-in default.
        const settings = opts.config ? loadSettings(opts.config) : {};
        const harnessName = opts.harness ?? settings.harness ?? "whip";
        const model = opts.model ?? settings.model ?? "kimi-k3";
        const reasoning = parseReasoning(
          opts.reasoning ?? settings.reasoning ?? "low",
        );
        const profile = parseProfile(
          opts.profile ?? settings.profile ?? "chill",
        );
        const timezone = opts.timezone ?? settings.timezone ?? "UTC";
        const subdir = opts.dir ?? settings.dir;
        const maxTurns = opts.maxTurns ?? settings.maxTurns;
        const ensembleModels = opts.ensemble
          ? opts.ensemble
              .split(",")
              .map((m) => m.trim())
              .filter(Boolean)
          : undefined;
        const skills = opts.skills
          ? opts.skills
              .split(",")
              .map((m) => m.trim())
              .filter(Boolean)
          : undefined;
        const base = {
          token: resolveToken(opts.token),
          owner,
          repo,
          pullNumber,
          harnessName,
          workdir: opts.workdir,
          conventionPaths: opts.conventions
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean),
          providers: resolveProviders(opts.providers, {
            env: opts.infisicalEnv,
            projectId: opts.infisicalProject,
          }),
          subdir,
          dryRun: opts.dryRun,
          verify: opts.verify,
          full: opts.full,
          ensembleModels,
          skills,
          timezone,
          maxTurns,
          whipConfig: settings.whip,
        };

        if (opts.config) {
          let reviewers = loadReviewers(opts.config);
          if (opts.reviewer) {
            reviewers = reviewers.filter((r) => r.name === opts.reviewer);
            if (reviewers.length === 0) {
              throw new Error(`No reviewer named "${opts.reviewer}" in config`);
            }
          }
          logger.info("Running reviewers", {
            reviewers: reviewers.map((r) => r.name),
          });
          // Sequential: harnesses are heavy and may share rate limits.
          for (const r of reviewers) {
            const result = await reviewPullRequest({
              ...base,
              reviewerName: r.name,
              guidance: r.guidance,
              include: r.include,
              exclude: r.exclude,
              agentic: r.agentic ?? opts.agentic,
              model: r.model ?? model,
              reasoning: r.reasoning ? parseReasoning(r.reasoning) : reasoning,
              profile: r.profile ?? profile,
              verify: r.verify ?? opts.verify,
              pathInstructions: r.pathInstructions,
              ensembleModels: r.ensemble ?? ensembleModels,
              skills: r.skills ?? skills,
              maxTurns: r.maxTurns ?? maxTurns,
              logger,
            });
            logger.info(`[${r.name}] ${formatResult(result)}`);
            if (opts.dryRun) console.log(renderReview(result));
          }
          return;
        }

        const result = await reviewPullRequest({
          ...base,
          agentic: opts.agentic,
          model,
          reasoning,
          profile,
          guidance: opts.promptFile
            ? readFileSync(opts.promptFile, "utf8")
            : undefined,
          logger,
        });
        logger.info(formatResult(result));
        if (opts.dryRun) console.log(renderReview(result));
      } finally {
        await shutdownLogger();
      }
    },
  );

program.parseAsync().catch((err: unknown) => {
  console.error("loupe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
