/**
 * A changed file in the PR: its path and the unified-diff patch GitHub gives us.
 * `patch` can be undefined for binary or too-large files.
 */
export type DiffFile = {
  readonly path: string;
  readonly patch: string | undefined;
};

/**
 * The RIGHT-side line numbers in each file that GitHub will accept an inline
 * comment on — i.e. added (`+`) and context (` `) lines within a hunk. A
 * comment on any other line makes the whole createReview call 422, so we use
 * this to drop off-diff findings before posting.
 */
export function commentableLines(
  files: readonly DiffFile[],
): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const file of files) {
    if (!file.patch) continue;
    const lines = new Set<number>();
    let newLine = 0;
    for (const raw of file.patch.split("\n")) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (header) {
        newLine = Number(header[1]);
        continue;
      }
      if (raw.startsWith("-")) continue; // deleted line — not on RIGHT side
      if (raw.startsWith("+") || raw.startsWith(" ")) {
        lines.add(newLine);
        newLine += 1;
      }
      // "\ No newline at end of file" and empty lines don't advance the counter
    }
    map.set(file.path, lines);
  }
  return map;
}

/** Count added / removed lines in a patch (diff `+`/`-` lines, not hunk headers). */
function patchStats(patch: string | undefined): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  if (!patch) return { added, removed };
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

/**
 * A compact tree of just the changed files with their line counts — what an
 * AGENTIC reviewer gets instead of the full inline diff. The agent then reads
 * each file's hunks (and the surrounding code) with its own tools, so a large
 * PR's diff isn't re-sent in every turn's prompt.
 */
export function renderFileTree(files: readonly DiffFile[]): string {
  return files
    .map((f) => {
      const { added, removed } = patchStats(f.patch);
      const counts = f.patch
        ? ` (+${added} −${removed})`
        : " (binary/too large)";
      return `- ${f.path}${counts}`;
    })
    .join("\n");
}

/** Compact text of the diff for the prompt: path headers + patches. */
export function renderDiff(files: readonly DiffFile[]): string {
  return files
    .map((f) =>
      f.patch
        ? `### ${f.path}\n${f.patch}`
        : `### ${f.path}\n(no textual diff — binary or too large)`,
    )
    .join("\n\n");
}
