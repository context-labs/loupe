import { commentableLines, type DiffFile } from "./diff";
import type { Finding } from "./types";

export type ValidationResult = {
  /** Findings whose (path, line) is inline-commentable on the PR. */
  readonly inline: readonly Finding[];
  /** Findings pointing off-diff — surfaced in the summary body instead. */
  readonly dropped: readonly Finding[];
};

/**
 * How far a finding's line may be snapped to the nearest commentable line before
 * we give up and demote it to a note. Models (especially agentic ones reading
 * whole files) routinely land a few lines off the exact diff line; snapping keeps
 * those as real inline comments instead of losing them to the summary.
 */
const SNAP_WINDOW = 10;

/**
 * Split findings into inline review comments and off-diff notes. GitHub only
 * accepts comments on lines in the diff (an off-diff comment 422s the whole
 * review), so a finding whose exact line isn't commentable is snapped to the
 * nearest commentable line in the same file within SNAP_WINDOW; only findings
 * with no nearby anchor (or on an unchanged file) degrade to a summary note.
 */
export function validateFindings(
  findings: readonly Finding[],
  files: readonly DiffFile[],
): ValidationResult {
  const allowed = commentableLines(files);
  const sorted = new Map<string, number[]>();
  for (const [path, set] of allowed) {
    sorted.set(
      path,
      [...set].sort((a, b) => a - b),
    );
  }

  const inline: Finding[] = [];
  const dropped: Finding[] = [];
  for (const f of findings) {
    const set = allowed.get(f.path);
    if (set?.has(f.line)) {
      inline.push(f);
      continue;
    }
    const near = set
      ? nearestLine(sorted.get(f.path) ?? [], f.line)
      : undefined;
    if (near !== undefined && Math.abs(near - f.line) <= SNAP_WINDOW) {
      inline.push({ ...f, line: near });
    } else {
      dropped.push(f);
    }
  }
  return { inline, dropped };
}

function nearestLine(
  lines: readonly number[],
  target: number,
): number | undefined {
  let best: number | undefined;
  let bestDist = Infinity;
  for (const l of lines) {
    const d = Math.abs(l - target);
    if (d < bestDist) {
      bestDist = d;
      best = l;
    }
  }
  return best;
}
