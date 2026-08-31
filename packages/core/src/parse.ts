import { jsonrepair } from "jsonrepair";

import {
  findingSchema,
  reviewOutputSchema,
  verificationSchema,
  walkthroughItemSchema,
  type ReviewOutput,
} from "./types";

/**
 * Parse JSON, repairing LLM-malformed output (truncation, unescaped chars in
 * freeform strings, trailing commas) rather than throwing. Models routinely emit
 * *almost* valid JSON; a strict parse would drop the whole review.
 */
function parseLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(jsonrepair(text));
  }
}

/**
 * Pull the review JSON out of a harness's raw stdout. CLIs wrap output in prose
 * or code fences, so we grab the last balanced {...} block and validate it.
 * Throws if no valid review object is found — a malformed review is a hard
 * failure, not a silent empty review.
 */
export function parseReviewOutput(stdout: string): ReviewOutput {
  if (stdout.trim().length === 0) {
    throw new Error(
      "Harness produced no output. It may have failed to authenticate, hit a " +
        "turn/timeout limit, or exited without emitting a review. Re-run with " +
        "LOG_LEVEL=debug to see the harness stdout/stderr.",
    );
  }
  // Prefer the last balanced {...}; if none closes (truncated output), fall back
  // to everything from the first "{" so jsonrepair can complete it.
  const start = stdout.indexOf("{");
  if (start === -1) {
    throw new Error(
      `No JSON object found in harness output:\n${stdout.slice(0, 1000)}`,
    );
  }
  const candidate = extractLastJsonObject(stdout) ?? stdout.slice(start);
  const parsed: unknown = parseLenient(candidate);
  const { summary, findings, walkthrough, diagram } =
    reviewOutputSchema.parse(parsed);
  // Validate each finding/walkthrough item independently; drop malformed ones
  // rather than rejecting the entire review.
  const validFindings = findings.flatMap((f) => {
    const result = findingSchema.safeParse(f);
    return result.success ? [result.data] : [];
  });
  const validWalkthrough = walkthrough.flatMap((w) => {
    const result = walkthroughItemSchema.safeParse(w);
    return result.success ? [result.data] : [];
  });
  return {
    summary,
    findings: validFindings,
    walkthrough: validWalkthrough,
    diagram: diagram?.trim() ? diagram.trim() : undefined,
  };
}

/** Parse the verification pass output into a map of finding index → real?. */
export function parseVerification(stdout: string): Map<number, boolean> {
  const map = new Map<number, boolean>();
  const candidate = extractLastJsonObject(stdout);
  if (!candidate) return map;
  let parsed: unknown;
  try {
    parsed = parseLenient(candidate);
  } catch {
    return map;
  }
  const result = verificationSchema.safeParse(parsed);
  if (!result.success) return map;
  for (const v of result.data.verdicts) map.set(v.index, v.real);
  return map;
}

/** Scan for the last top-level {...} by brace-depth, ignoring string contents. */
function extractLastJsonObject(text: string): string | undefined {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let last: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) last = text.slice(start, i + 1);
    }
  }
  return last;
}
