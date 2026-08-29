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

/**
 * The harness's JSON: a summary plus a findings array. Findings are validated
 * individually by the parser so one malformed entry can't reject the whole
 * review — keep the array loose here.
 */
export const reviewOutputSchema = z.object({
  summary: z.string().default(""),
  findings: z.array(z.unknown()).default([]),
});
export type ReviewOutput = {
  readonly summary: string;
  readonly findings: readonly Finding[];
};
