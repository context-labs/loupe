import { appendFileSync } from "node:fs";

import { HarnessError } from "@loupe/harness";

/**
 * Write a `name=value` line to `$GITHUB_OUTPUT` so a consuming workflow can
 * branch on it (e.g. `steps.loupe-run.outputs.status`). No-op when the env var
 * is unset, so the CLI path and unit tests are unaffected.
 */
export function setOutput(name: string, value: string): void {
  const file = process.env["GITHUB_OUTPUT"];
  if (!file) return;
  appendFileSync(file, `${name}=${value}\n`);
}

/**
 * Map a thrown error to the action's `status` output value. Quota and
 * rate-limit harness failures are surfaced distinctly so a workflow can route
 * them differently (ping #billing for quota, auto-requeue for rate-limit);
 * everything else is a generic "failed".
 */
export function statusForError(err: unknown): string {
  if (err instanceof HarnessError) {
    if (err.kind === "quota") return "quota";
    if (err.kind === "rate-limit") return "rate-limit";
  }
  return "failed";
}
