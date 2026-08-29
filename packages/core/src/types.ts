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

const severitySchema = z
  .string()
  .transform(
    (s): Severity => SEVERITY_ALIASES[s.toLowerCase().trim()] ?? "warning",
  );

/**
 * A single review finding, anchored to a line in the new version of a file.
 * `line` is the line number in the file as it exists after the PR (RIGHT side
 * of the diff) — GitHub only accepts inline comments on lines in the diff.
 */
export const findingSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  severity: severitySchema,
  body: z.string(),
});
export type Finding = z.infer<typeof findingSchema>;

/** The harness must emit exactly this: a JSON object with a `findings` array. */
export const reviewOutputSchema = z.object({
  summary: z.string(),
  findings: z.array(findingSchema),
});
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;
