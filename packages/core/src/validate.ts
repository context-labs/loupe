import { commentableLines, type DiffFile } from "./diff";
import type { Finding } from "./types";

export type ValidationResult = {
  /** Findings whose (path, line) is inline-commentable on the PR. */
  readonly inline: readonly Finding[];
  /** Findings pointing off-diff — surfaced in the summary body instead. */
  readonly dropped: readonly Finding[];
};

/**
 * Split findings into those GitHub will accept as inline comments and those it
 * won't. Posting an off-diff comment 422s the entire review, so a hallucinated
 * line number must never reach the API — it degrades to a summary note.
 */
export function validateFindings(
  findings: readonly Finding[],
  files: readonly DiffFile[],
): ValidationResult {
  const allowed = commentableLines(files);
  const inline: Finding[] = [];
  const dropped: Finding[] = [];
  for (const f of findings) {
    if (allowed.get(f.path)?.has(f.line)) inline.push(f);
    else dropped.push(f);
  }
  return { inline, dropped };
}
