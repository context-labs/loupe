import { z } from "zod";

/**
 * A single review finding, anchored to a line in the new version of a file.
 * `line` is the line number in the file as it exists after the PR (RIGHT side
 * of the diff) — GitHub only accepts inline comments on lines in the diff.
 */
export const findingSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  severity: z.enum(["blocker", "warning", "nit"]),
  body: z.string(),
});
export type Finding = z.infer<typeof findingSchema>;

/** The harness must emit exactly this: a JSON object with a `findings` array. */
export const reviewOutputSchema = z.object({
  summary: z.string(),
  findings: z.array(findingSchema),
});
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;
