import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Profile, ReasoningEffort } from "@loupe/core";
import {
  dotenvProvider,
  envProvider,
  infisicalProvider,
  type CredentialProvider,
} from "@loupe/credentials";
import { z } from "zod";

/**
 * All environment reading happens here, parsed with Zod, then passed inward as
 * typed values. Nothing downstream touches process.env.
 */
const envSchema = z.object({
  GITHUB_TOKEN: z.string().min(1, "GITHUB_TOKEN is required"),
  GITHUB_REPOSITORY: z.string().regex(/^[^/]+\/[^/]+$/, "expected owner/repo"),
  GITHUB_EVENT_PATH: z.string().optional(),
  GITHUB_EVENT_NAME: z.string().optional(),
  GITHUB_WORKSPACE: z.string().optional(),
  LOUPE_PR_NUMBER: z.coerce.number().int().positive().optional(),
  LOUPE_HARNESS: z.string().default("whip"),
  LOUPE_MODEL: z.string().default("kimi-k3"),
  LOUPE_REASONING: z.enum(["low", "medium", "high"]).default("medium"),
  LOUPE_PROMPT_FILE: z.string().optional(),
  LOUPE_CONVENTION_PATHS: z
    .string()
    .default("CLAUDE.md,AGENTS.md,.loupe.md,CONTRIBUTING.md"),
  LOUPE_CREDENTIAL_PROVIDERS: z.string().default("env"),
  LOUPE_INFISICAL_ENV: z.string().optional(),
  LOUPE_INFISICAL_PROJECT_ID: z.string().optional(),
  LOUPE_DIR: z.string().optional(),
  LOUPE_CONFIG: z.string().optional(),
  LOUPE_REVIEWER: z.string().optional(),
  LOUPE_PROFILE: z.enum(["quiet", "chill", "assertive"]).default("chill"),
  LOUPE_VERIFY: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  LOUPE_FULL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LOUPE_ENSEMBLE: z.string().default(""),
});

export type Config = {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly harnessName: string;
  readonly workdir: string;
  readonly conventionPaths: readonly string[];
  readonly providers: readonly CredentialProvider[];
  readonly subdir?: string;
  readonly model: string;
  readonly reasoning: ReasoningEffort;
  readonly guidance?: string;
  readonly configPath?: string;
  readonly reviewerFilter?: string;
  readonly profile: Profile;
  readonly verify: boolean;
  readonly full: boolean;
  readonly ensembleModels: readonly string[];
  readonly eventName?: string;
  readonly eventPath?: string;
};

export function loadConfig(): Config {
  const env = envSchema.parse(process.env);
  const [owner, repo] = env.GITHUB_REPOSITORY.split("/") as [string, string];
  const workdir = env.GITHUB_WORKSPACE ?? process.cwd();
  // Config/prompt paths are relative to the checked-out repo, not the action's
  // own cwd (the composite action runs from its own directory).
  const inWorkspace = (p: string): string => resolve(workdir, p);

  return {
    token: env.GITHUB_TOKEN,
    owner,
    repo,
    pullNumber: resolvePullNumber(env.LOUPE_PR_NUMBER, env.GITHUB_EVENT_PATH),
    harnessName: env.LOUPE_HARNESS,
    workdir,
    conventionPaths: env.LOUPE_CONVENTION_PATHS.split(",")
      .map((p) => p.trim())
      .filter(Boolean),
    providers: buildProviders(env),
    subdir: env.LOUPE_DIR,
    model: env.LOUPE_MODEL,
    reasoning: env.LOUPE_REASONING,
    guidance: env.LOUPE_PROMPT_FILE
      ? readFileSync(inWorkspace(env.LOUPE_PROMPT_FILE), "utf8")
      : undefined,
    configPath: env.LOUPE_CONFIG ? inWorkspace(env.LOUPE_CONFIG) : undefined,
    reviewerFilter: env.LOUPE_REVIEWER,
    profile: env.LOUPE_PROFILE,
    verify: env.LOUPE_VERIFY,
    full: env.LOUPE_FULL,
    ensembleModels: env.LOUPE_ENSEMBLE.split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    eventName: env.GITHUB_EVENT_NAME,
    eventPath: env.GITHUB_EVENT_PATH,
  };
}

function resolvePullNumber(
  explicit: number | undefined,
  eventPath: string | undefined,
): number {
  if (explicit) return explicit;
  if (eventPath) {
    const event: unknown = JSON.parse(readFileSync(eventPath, "utf8"));
    // pull_request events carry pull_request.number; issue_comment on a PR
    // carries issue.number; pull_request_review_comment carries pull_request.
    const parsed = z
      .object({
        pull_request: z.object({ number: z.number() }).optional(),
        issue: z.object({ number: z.number() }).optional(),
      })
      .safeParse(event);
    const n = parsed.success
      ? (parsed.data.pull_request?.number ?? parsed.data.issue?.number)
      : undefined;
    if (n) return n;
  }
  throw new Error(
    "Could not determine PR number: set LOUPE_PR_NUMBER or run on a pull_request/comment event",
  );
}

/** Build a provider chain from a comma-separated spec like "env,dotenv,infisical". */
export function resolveProviders(
  spec: string,
  infisical: { env?: string; projectId?: string } = {},
): readonly CredentialProvider[] {
  return spec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((name) => {
      switch (name) {
        case "env":
          return envProvider();
        case "dotenv":
          return dotenvProvider();
        case "infisical":
          return infisicalProvider(infisical);
        default:
          throw new Error(`Unknown credential provider "${name}"`);
      }
    });
}

function buildProviders(
  env: z.infer<typeof envSchema>,
): readonly CredentialProvider[] {
  return resolveProviders(env.LOUPE_CREDENTIAL_PROVIDERS, {
    env: env.LOUPE_INFISICAL_ENV,
    projectId: env.LOUPE_INFISICAL_PROJECT_ID,
  });
}
