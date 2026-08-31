import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Profile, ReasoningEffort } from "@loupe/core";
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
    baseUrl: z.string().min(1),
    apiKeyEnv: z.string().min(1),
    label: z.string().optional(),
  }),
  models: z.array(z.string().min(1)).min(1),
  defaultModel: z.string().optional(),
});

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
  dir: z.string().optional(),
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
  readonly dir?: string;
  readonly whip?: z.infer<typeof whipConfigSchema>;
};

/** Read only the top-level settings from a config file (not the reviewers). */
export function loadSettings(configPath: string): LoupeSettings {
  const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  const c = configSchema.parse(raw);
  return {
    harness: c.harness,
    model: c.model,
    reasoning: c.reasoning,
    profile: c.profile,
    timezone: c.timezone,
    dir: c.dir,
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
};

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
      (r.promptFile
        ? readFileSync(resolve(dir, r.promptFile), "utf8")
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
  }));
}
