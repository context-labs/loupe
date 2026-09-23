import { appendFileSync } from "node:fs";

import { HarnessError, type HarnessErrorKind } from "@loupe/harness";

import type { ReviewerOutcome } from "./orchestrate";

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
 * everything else is a generic "failed". Used for setup errors that reject the
 * whole run (per-reviewer failures are carried as outcomes, not thrown).
 */
export function statusForError(err: unknown): string {
  return kindToStatus(err instanceof HarnessError ? err.kind : undefined);
}

/**
 * Derive the overall `status` from the per-reviewer outcomes. If every reviewer
 * succeeded and the summary posted, the run is `ok`. Otherwise the status
 * reflects the most actionable failure kind across the reviewers
 * (quota > rate-limit > failed), so a workflow branches on the worst thing that
 * happened rather than needing to inspect each. `summaryFailed` covers a
 * combined-summary publication failure: even when every reviewer succeeded, a
 * failed post means the run did not complete, so it is `failed` unless a
 * reviewer hit a more actionable kind (quota/rate-limit) that outranks it.
 */
export function statusForOutcomes(
  outcomes: readonly ReviewerOutcome[],
  summaryFailed = false,
): string {
  if (outcomes.every((o) => o.ok) && !summaryFailed) return "ok";
  let worst: HarnessErrorKind | undefined;
  for (const o of outcomes) {
    if (o.ok) continue;
    if (o.kind && outranks(o.kind, worst)) worst = o.kind;
  }
  return kindToStatus(worst);
}

function kindToStatus(kind: HarnessErrorKind | undefined): string {
  if (kind === "quota") return "quota";
  if (kind === "rate-limit") return "rate-limit";
  return "failed";
}

const RANK: Record<HarnessErrorKind, number> = {
  quota: 3,
  "rate-limit": 2,
  unknown: 1,
};

function outranks(
  a: HarnessErrorKind,
  b: HarnessErrorKind | undefined,
): boolean {
  return b == null || RANK[a] > RANK[b];
}
