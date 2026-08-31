import { z } from "zod";

export type Severity = "blocker" | "warning" | "nit";

/**
 * Models don't reliably stick to our three severities — they emit "major",
 * "critical", "minor", "info", etc. Map common synonyms onto our scale rather
 * than rejecting the whole review; unknown values default to warning.
 */
const SEVERITY_ALIASES: Record<string, Severity> = {
  blocker: "blocker",
  critical: "blocker",
  high: "blocker",
  error: "blocker",
  warning: "warning",
  major: "warning",
  medium: "warning",
  moderate: "warning",
  nit: "nit",
  minor: "nit",
  low: "nit",
  info: "nit",
  trivial: "nit",
  suggestion: "nit",
};

// Severity is often missing or off-scale; never let that reject a finding.
const severitySchema = z
  .string()
  .optional()
  .transform(
    (s): Severity =>
      s ? (SEVERITY_ALIASES[s.toLowerCase().trim()] ?? "warning") : "warning",
  );

/**
 * A single review finding, anchored to a line in the new version of a file.
 * `line` is the line number in the file as it exists after the PR (RIGHT side
 * of the diff) — GitHub only accepts inline comments on lines in the diff.
 */
export const findingSchema = z.object({
  path: z.string(),
  line: z.coerce.number().int().positive(),
  severity: severitySchema,
  body: z.string(),
});
export type Finding = z.infer<typeof findingSchema>;

/** Per-file note for the PR walkthrough. */
export const walkthroughItemSchema = z.object({
  path: z.string(),
  summary: z.string(),
});
export type WalkthroughItem = z.infer<typeof walkthroughItemSchema>;

/** A major, PR-level callout that isn't tied to a single diff line. */
export const concernSchema = z.object({
  title: z.string(),
  detail: z.string(),
  severity: severitySchema,
});
export type Concern = z.infer<typeof concernSchema>;

/**
 * The harness's JSON: a summary, findings, and optional walkthrough material.
 * Findings and walkthrough items are validated individually by the parser so one
 * malformed entry can't reject the whole review — keep the arrays loose here.
 */
export const reviewOutputSchema = z.object({
  summary: z.string().default(""),
  findings: z.array(z.unknown()).default([]),
  walkthrough: z.array(z.unknown()).default([]),
  concerns: z.array(z.unknown()).default([]),
  highlights: z.array(z.string()).default([]),
  // Optional Mermaid sequence diagram (body only, no fences).
  diagram: z.string().optional(),
});
export type ReviewOutput = {
  readonly summary: string;
  readonly findings: readonly Finding[];
  readonly walkthrough: readonly WalkthroughItem[];
  readonly concerns: readonly Concern[];
  readonly highlights: readonly string[];
  readonly diagram?: string;
};

/** Review noise profile: which severities to keep. */
export type Profile = "quiet" | "chill" | "assertive";
const PROFILE_KEEP: Record<Profile, readonly Severity[]> = {
  quiet: ["blocker"],
  chill: ["blocker", "warning"],
  assertive: ["blocker", "warning", "nit"],
};
export function severitiesForProfile(profile: Profile): readonly Severity[] {
  return PROFILE_KEEP[profile];
}

/** One verdict from the verification pass, keyed by finding index. */
export const verdictSchema = z.object({
  index: z.coerce.number().int().nonnegative(),
  real: z.boolean(),
  reason: z.string().optional(),
});
export const verificationSchema = z.object({
  verdicts: z.array(verdictSchema).default([]),
});
