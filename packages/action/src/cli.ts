#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

import { createRootLogger, shutdownLogger } from "@loupe/logger";
import { Command } from "commander";

import { resolveProviders } from "./config";
import { formatResult, reviewPullRequest } from "./run";

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
  .option("-H, --harness <name>", "agent CLI to review with", "claude")
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
  .option("--dry-run", "compute and log the review without posting it", false)
  .option("--infisical-env <env>", "Infisical environment slug")
  .option("--infisical-project <id>", "Infisical project id")
  .action(
    async (
      pr: string,
      opts: {
        harness: string;
        providers: string;
        token?: string;
        workdir: string;
        conventions: string;
        dir?: string;
        dryRun: boolean;
        infisicalEnv?: string;
        infisicalProject?: string;
      },
    ) => {
      const logger = createRootLogger("loupe-cli");
      try {
        const { owner, repo, pullNumber } = parsePr(pr);
        const result = await reviewPullRequest({
          token: resolveToken(opts.token),
          owner,
          repo,
          pullNumber,
          harnessName: opts.harness,
          workdir: opts.workdir,
          conventionPaths: opts.conventions
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean),
          providers: resolveProviders(opts.providers, {
            env: opts.infisicalEnv,
            projectId: opts.infisicalProject,
          }),
          subdir: opts.dir,
          dryRun: opts.dryRun,
          logger,
        });
        logger.info(formatResult(result));
      } finally {
        await shutdownLogger();
      }
    },
  );

program.parseAsync().catch((err: unknown) => {
  console.error("loupe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
