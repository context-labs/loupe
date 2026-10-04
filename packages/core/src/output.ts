import { z } from "zod";

/**
 * The wire contracts loupe's agents answer under. The daemon derives JSON
 * Schema from these, tells the model the shape in its runtime guide, validates
 * the final message, and corrects it once. Severities stay strings here and
 * are normalized loupe-side (see types.ts), because an enum mismatch would
 * cost a correction round for a synonym we already understand.
 */

const severity = z.string().describe('"blocker" | "warning" | "nit"');

export const findingOutput = z.object({
  path: z
    .string()
    .describe("Repo-relative file path, exactly as shown in the diff"),
  line: z
    .number()
    .int()
    .describe(
      "Line number in the NEW version of the file; must be a changed or context line shown in the diff",
    ),
  severity: severity.optional(),
  body: z.string().describe("The problem on THIS line and the fix"),
});

export const concernOutput = z.object({
  title: z
    .string()
    .describe("Short title of a PR-level issue not tied to any single line"),
  detail: z.string().describe("The problem and the fix"),
  severity: severity.optional(),
});

/** A reviewer's final message. */
export const reviewOutput = z.object({
  summary: z.string().describe("What this PR does + your verdict"),
  concerns: z
    .array(concernOutput)
    .optional()
    .describe(
      "PR-level issues not tied to any single line. Usually empty; prefer findings.",
    ),
  highlights: z
    .array(z.string())
    .optional()
    .describe("Short clauses; only if genuinely notable. Usually empty."),
  diagram: z
    .string()
    .optional()
    .describe(
      "Mermaid diagram body (no code fences); ONLY for a genuinely complex new control/data flow. Usually omit.",
    ),
  findings: z
    .array(findingOutput)
    .describe("Line-anchored issues; each becomes an inline comment."),
});

/** The verification pass's final message. */
export const verdictsOutput = z.object({
  verdicts: z
    .array(
      z.object({
        index: z.number().int(),
        real: z.boolean(),
        reason: z.string().optional(),
      }),
    )
    .describe("One verdict per finding index."),
});
