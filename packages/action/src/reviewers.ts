import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { ReasoningEffort } from "@loupe/core";
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
  })
  .refine((r) => !(r.prompt && r.promptFile), {
    message: "reviewer has both prompt and promptFile; use one",
  });

const configSchema = z.object({ reviewers: z.array(reviewerSchema).min(1) });

export type Reviewer = {
  readonly name: string;
  readonly guidance?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly model?: string;
  readonly reasoning?: ReasoningEffort;
  readonly agentic?: boolean;
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
  }));
}
