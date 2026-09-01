import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Profile, ReasoningEffort } from "@loupe/core";
import {
  dotenvProvider,
  envProvider,
  infisicalProvider,
  type CredentialProvider,
} from "@loupe/credentials";
import type { WhipConfig } from "@loupe/harness";
import { z } from "zod";

import { loadSettings, type LoupeSettings } from "./reviewers";

/** An empty string from an unset Action input counts as "not provided". */
const optionalInput = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

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
  // Movable defaults: an unset input yields "" → undefined here, so a value in
  // .loupe.json can win. Precedence (input → file → builtin) resolves below.
  LOUPE_HARNESS: optionalInput,
  LOUPE_MODEL: optionalInput,
  LOUPE_REASONING: optionalInput,
  LOUPE_PROMPT_FILE: z.string().optional(),
  LOUPE_CONVENTION_PATHS: z
    .string()
    .default("CLAUDE.md,AGENTS.md,.loupe.md,CONTRIBUTING.md"),
  LOUPE_CREDENTIAL_PROVIDERS: z.string().default("env"),
  LOUPE_INFISICAL_ENV: z.string().optional(),
  LOUPE_INFISICAL_PROJECT_ID: z.string().optional(),
  LOUPE_DIR: optionalInput,
  LOUPE_CONFIG: z.string().optional(),
  LOUPE_REVIEWER: z.string().optional(),
  LOUPE_PROFILE: optionalInput,
  LOUPE_VERIFY: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  LOUPE_FULL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LOUPE_ENSEMBLE: z.string().default(""),
  LOUPE_SKILLS: z.string().default(""),
  LOUPE_TIMEZONE: optionalInput,
  LOUPE_MAX_TURNS: optionalInput,
});

function asMaxTurns(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid max-turns "${v}". Use a positive integer.`);
  }
  return n;
}

const REASONING = ["low", "medium", "high"] as const;
const PROFILES = ["quiet", "chill", "assertive"] as const;

function asReasoning(v: string | undefined): ReasoningEffort | undefined {
  if (v === undefined) return undefined;
  if ((REASONING as readonly string[]).includes(v)) return v as ReasoningEffort;
  throw new Error(`Invalid reasoning "${v}". Use: ${REASONING.join(", ")}`);
}

function asProfile(v: string | undefined): Profile | undefined {
  if (v === undefined) return undefined;
  if ((PROFILES as readonly string[]).includes(v)) return v as Profile;
  throw new Error(`Invalid profile "${v}". Use: ${PROFILES.join(", ")}`);
}

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
  readonly skills: readonly string[];
  readonly timezone: string;
  readonly whipConfig?: WhipConfig;
  readonly maxTurns?: number;
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

  const configPath = env.LOUPE_CONFIG
    ? inWorkspace(env.LOUPE_CONFIG)
    : undefined;
  // Top-level review defaults from .loupe.json. Precedence for the movable
  // settings: Action input (explicit) → file → loupe's built-in default.
  const file: LoupeSettings = configPath ? loadSettings(configPath) : {};

  return {
    token: env.GITHUB_TOKEN,
    owner,
    repo,
    pullNumber: resolvePullNumber(env.LOUPE_PR_NUMBER, env.GITHUB_EVENT_PATH),
    harnessName: env.LOUPE_HARNESS ?? file.harness ?? "whip",
    workdir,
    conventionPaths: env.LOUPE_CONVENTION_PATHS.split(",")
      .map((p) => p.trim())
      .filter(Boolean),
    providers: buildProviders(env),
    subdir: env.LOUPE_DIR ?? file.dir,
    model: env.LOUPE_MODEL ?? file.model ?? "kimi-k3",
    reasoning: asReasoning(env.LOUPE_REASONING) ?? file.reasoning ?? "low",
    guidance: env.LOUPE_PROMPT_FILE
      ? readFileSync(inWorkspace(env.LOUPE_PROMPT_FILE), "utf8")
      : undefined,
    configPath,
    reviewerFilter: env.LOUPE_REVIEWER,
    profile: asProfile(env.LOUPE_PROFILE) ?? file.profile ?? "chill",
    verify: env.LOUPE_VERIFY,
    full: env.LOUPE_FULL,
    ensembleModels: env.LOUPE_ENSEMBLE.split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    skills: env.LOUPE_SKILLS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    timezone: env.LOUPE_TIMEZONE ?? file.timezone ?? "UTC",
    maxTurns: asMaxTurns(env.LOUPE_MAX_TURNS) ?? file.maxTurns,
    whipConfig: file.whip,
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
