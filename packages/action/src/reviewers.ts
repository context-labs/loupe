import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  resolveWithin,
  type PriorComments,
  type Profile,
  type ReasoningEffort,
} from "@loupe/core";
import type { Logger } from "@loupe/logger";
import { z } from "zod";

/**
 * A named reviewer profile from a repo's `.loupe.json`. Each reviewer is a
 * focused reviewer — its own guidance prompt, the file globs it applies to, and
 * optional model/reasoning overrides — so a repo can run, say, a bug-hunting
 * reviewer over source and a migration-risk reviewer over SQL in one pass.
 */
const reviewerSchema = z
  .object({
    name: z.string().min(1),
    /** Inline reviewer guidance, or... */
    prompt: z.string().optional(),
    /** ...a path to a guidance file, relative to the config file. */
    promptFile: z.string().optional(),
    /** Only run this reviewer when changed files match these globs. */
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    model: z.string().optional(),
    reasoning: z.enum(["low", "medium", "high"]).optional(),
    /** Let this reviewer use tools to explore the checkout (needs a workdir). */
    agentic: z.boolean().optional(),
    /** Noise profile: quiet | chill | assertive. */
    profile: z.enum(["quiet", "chill", "assertive"]).optional(),
    /** Second-opinion verification pass to cut false positives (default true). */
    verify: z.boolean().optional(),
    /** Per-glob extra review instructions. */
    pathInstructions: z
      .array(z.object({ glob: z.string(), instruction: z.string() }))
      .optional(),
    /** Models to ensemble (>= 2 keeps only findings a majority agree on). */
    ensemble: z.array(z.string()).optional(),
    /** Skill docs (paths to SKILL.md or a skill dir) to fold into the reviewer. */
    skills: z.array(z.string()).optional(),
    /** Cap on the agentic tool loop for this reviewer (default 10). */
    maxTurns: z.number().int().positive().optional(),
    /** Max inline comments for this reviewer; extras go to the summary (default 10). */
    maxComments: z.number().int().positive().optional(),
    /** What to do with this reviewer's prior inline comments on a re-review. */
    priorComments: z.enum(["resolve", "delete", "keep"]).optional(),
    /** false = drop the always-on review procedure from this reviewer's prompt. */
    procedure: z.boolean().optional(),
    /** false = don't send a prompt-cache key for this reviewer (for models whose
     * endpoint rejects `prompt_cache_key` as an unrecognized argument). */
    promptCache: z.boolean().optional(),
    /** Directory or directories this reviewer covers; overrides the top-level `dir`. */
    dir: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .refine((r) => !(r.prompt && r.promptFile), {
    message: "reviewer has both prompt and promptFile; use one",
  });

/** whip provider + model panel, so the review workflow needn't hand-write
 * ~/.whip/config.json in a CI step. loupe materializes it into a throwaway
 * WHIP_HOME at review time. */
const whipConfigSchema = z.object({
  provider: z.object({
    name: z.string().min(1),
    // This block comes from the reviewed PR's config and selects where model
    // traffic (and the chosen credential) goes, so constrain it: an https URL
    // only (host is further checked against an operator allow-list in
    // loadSettings), and an env-var *name* shape so a PR can't exfiltrate an
    // arbitrary secret by naming its variable.
    baseUrl: z
      .string()
      .url()
      .refine((u) => new URL(u).protocol === "https:", {
        message: "provider baseUrl must be an https URL",
      }),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "apiKeyEnv must be an env-var name"),
    label: z.string().optional(),
  }),
  models: z.array(z.string().min(1)).min(1),
  defaultModel: z.string().optional(),
});

/** Operator-controlled constraints for the PR-supplied whip provider block. */
export type WhipGuard = {
  /** Permitted provider hosts; empty = allow any (with a warning). */
  readonly allowedProviderHosts: readonly string[];
  readonly logger: Logger;
};

/**
 * Job-infrastructure secrets that are present in the harness env (it inherits
 * `process.env`) but are never a legitimate model-provider key. `apiKeyEnv` is
 * the variable whose VALUE whip sends to `baseUrl` as the credential, so a PR
 * that names one of these would exfiltrate the job's own token/cloud creds to
 * the provider host. Rejected on the untrusted-PR path regardless of the host
 * allow-list — a shape check alone (any UPPER_SNAKE name) does not stop this.
 */
const BLOCKED_API_KEY_ENVS: readonly RegExp[] = [
  /^GITHUB_/,
  /^GH_/,
  /^ACTIONS_/,
  /^RUNNER_/,
  /^AWS_/,
  /^AZURE_/,
  /^GOOGLE_/,
  /^GCP_/,
  /^INFISICAL_/,
  /^LOUPE_/,
];

/**
 * Enforce the operator constraints on the PR-supplied whip provider block.
 * `apiKeyEnv` may never name a job-infrastructure secret. For the host:
 * a NON-EMPTY allow-list is a hard requirement (host must be a member); an
 * UNSET/empty list preserves current behavior but warns, so there is a safe
 * opt-in without breaking existing deployments. baseUrl is already a validated
 * https URL by the schema.
 */
function enforceWhipGuard(
  whip: z.infer<typeof whipConfigSchema>,
  guard: WhipGuard,
): void {
  const apiKeyEnv = whip.provider.apiKeyEnv;
  if (BLOCKED_API_KEY_ENVS.some((re) => re.test(apiKeyEnv))) {
    throw new Error(
      `provider apiKeyEnv "${apiKeyEnv}" names a job-infrastructure secret and cannot be used as a provider credential`,
    );
  }
  const host = new URL(whip.provider.baseUrl).host.toLowerCase();
  if (guard.allowedProviderHosts.length === 0) {
    guard.logger.warn(
      "Using an unvalidated model provider host from repo config; set LOUPE_ALLOWED_PROVIDER_HOSTS to restrict it",
      { host },
    );
    return;
  }
  if (!guard.allowedProviderHosts.includes(host)) {
    throw new Error(
      `provider baseUrl host "${host}" is not in the allowed provider hosts`,
    );
  }
}

const configSchema = z.object({
  reviewers: z.array(reviewerSchema).min(1),
  /** Skills applied to every reviewer (merged with each reviewer's own). */
  skills: z.array(z.string()).optional(),
  // Top-level review defaults. Action inputs / CLI flags override these; these
  // in turn override loupe's built-in defaults. Keeps harness/model/timezone/dir
  // with the repo's review policy instead of duplicated across workflow files.
  harness: z.string().optional(),
  model: z.string().optional(),
  reasoning: z.enum(["low", "medium", "high"]).optional(),
  profile: z.enum(["quiet", "chill", "assertive"]).optional(),
  timezone: z.string().optional(),
  /** One directory or several; several are reviewed together from the repo root. */
  dir: z.union([z.string(), z.array(z.string())]).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxComments: z.number().int().positive().optional(),
  priorComments: z.enum(["resolve", "delete", "keep"]).optional(),
  procedure: z.boolean().optional(),
  /** false = let the same finding post from multiple reviewers (no dedup). */
  crossReviewerDedup: z.boolean().optional(),
  promptCache: z.boolean().optional(),
  whip: whipConfigSchema.optional(),
});

/** The top-level, non-reviewer settings from a .loupe.json — review defaults a
 * repo declares once instead of repeating them in every workflow file. */
export type LoupeSettings = {
  readonly harness?: string;
  readonly model?: string;
  readonly reasoning?: ReasoningEffort;
  readonly profile?: Profile;
  readonly timezone?: string;
  readonly dirs?: readonly string[];
  readonly maxTurns?: number;
  readonly maxComments?: number;
  readonly priorComments?: PriorComments;
  readonly procedure?: boolean;
  readonly crossReviewerDedup?: boolean;
  readonly promptCache?: boolean;
  readonly whip?: z.infer<typeof whipConfigSchema>;
};

/**
 * Read only the top-level settings from a config file (not the reviewers).
 * `guard`, when supplied, validates the PR-supplied whip provider host; callers
 * on the untrusted-PR path (the Action) pass it, so it stays optional for the
 * local CLI whose config is the operator's own.
 */
export function loadSettings(
  configPath: string,
  guard?: WhipGuard,
): LoupeSettings {
  const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  const c = configSchema.parse(raw);
  if (c.whip && guard) enforceWhipGuard(c.whip, guard);
  return {
    harness: c.harness,
    model: c.model,
    reasoning: c.reasoning,
    profile: c.profile,
    timezone: c.timezone,
    dirs: asDirs(c.dir),
    maxTurns: c.maxTurns,
    maxComments: c.maxComments,
    priorComments: c.priorComments,
    procedure: c.procedure,
    crossReviewerDedup: c.crossReviewerDedup,
    promptCache: c.promptCache,
    whip: c.whip,
  };
}

export type Reviewer = {
  readonly name: string;
  readonly guidance?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly model?: string;
  readonly reasoning?: ReasoningEffort;
  readonly agentic?: boolean;
  readonly profile?: Profile;
  readonly verify?: boolean;
  readonly pathInstructions?: readonly { glob: string; instruction: string }[];
  readonly ensemble?: readonly string[];
  readonly skills?: readonly string[];
  readonly maxTurns?: number;
  readonly maxComments?: number;
  readonly priorComments?: PriorComments;
  readonly procedure?: boolean;
  readonly promptCache?: boolean;
  readonly dirs?: readonly string[];
};

/** Normalize the `dir` setting (string or list) into a list; undefined stays undefined. */
export function asDirs(
  dir: string | readonly string[] | undefined,
): readonly string[] | undefined {
  if (dir === undefined) return undefined;
  const list = (typeof dir === "string" ? dir.split(",") : dir)
    .map((d) => d.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/**
 * Load and resolve reviewer profiles from a local config file (the checked-out
 * repo's `.loupe.json`, or a path passed to --config). promptFile paths resolve
 * relative to the config file.
 */
export function loadReviewers(configPath: string): Reviewer[] {
  const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  const config = configSchema.parse(raw);
  const dir = dirname(configPath);
  const topSkills = config.skills ?? [];
  return config.reviewers.map((r) => ({
    name: r.name,
    guidance:
      r.prompt ??
      // promptFile comes from the reviewed PR's config, so contain it to the
      // config's own directory before reading it as a reviewer system prompt.
      (r.promptFile
        ? readFileSync(resolveWithin(dir, r.promptFile), "utf8")
        : undefined),
    include: r.include,
    exclude: r.exclude,
    model: r.model,
    reasoning: r.reasoning,
    agentic: r.agentic,
    profile: r.profile,
    verify: r.verify,
    pathInstructions: r.pathInstructions,
    ensemble: r.ensemble,
    // Top-level skills apply to every reviewer, plus any reviewer-specific ones.
    skills: [...new Set([...topSkills, ...(r.skills ?? [])])],
    maxTurns: r.maxTurns,
    maxComments: r.maxComments,
    priorComments: r.priorComments,
    procedure: r.procedure,
    promptCache: r.promptCache,
    dirs: asDirs(r.dir),
  }));
}
