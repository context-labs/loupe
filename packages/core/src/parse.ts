import { reviewOutputSchema, type ReviewOutput } from "./types";

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
  const candidate = extractLastJsonObject(stdout);
  if (!candidate) {
    throw new Error(
      `No JSON object found in harness output:\n${stdout.slice(0, 1000)}`,
    );
  }
  const parsed: unknown = JSON.parse(candidate);
  return reviewOutputSchema.parse(parsed);
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
