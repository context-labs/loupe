# Plan: Issue #34 — Classify quota and rate-limit failures as typed errors

## Summary

Quota / rate-limit failures (HTTP 402 Payment Required, 429, "insufficient
balance", etc.) currently surface as opaque string errors. The agentic to
one-shot fallback retries them unconditionally (doubling wasted billing calls),
and the GitHub Action exposes no output a consuming workflow can branch on — so
~120 runs can fail silently over 42 hours with every job green.

This plan wraps every harness-layer failure in a general HarnessError carrying a
categorical kind, suppresses the retry for non-retryable kinds (quota,
rate-limit), and exposes an action output so workflows can gate on it.

Branch: fix/issue34-classify-quota-errors
Worktree: /Users/anishthite/loupe-issue34

---

## Design choice: general HarnessError + kind, not a dedicated QuotaError

Instead of a single-purpose QuotaError class, every harness-layer failure is a
HarnessError with a kind discriminant. Rationale:

- Uniform envelope. All three harness reject sites (runCli non-zero exit, whip
  NDJSON error event, whip non-zero exit) become HarnessError, so a caller can
  tell "the harness subprocess failed" from unrelated errors (octokit, config)
  with one instanceof, instead of a mix of HarnessError and bare Error.
- Extensible without class proliferation. The issue covers quota (402) AND
  rate-limit (429), which have different operational semantics. A kind union
  separates them now; adding timeout/spawn later is one union member, not a new
  class plus a new isXxxError function. Exhaustive switches on kind get TS
  checking.
- A retryable boolean would be ambiguous (retryable with backoff vs retryable
  with a mode switch?), kind is not. The classifier is categorical; core decides
  per-kind whether the agentic-to-one-shot fallback applies.
- kind "unknown" preserves today's behavior exactly for anything we cannot
  classify (still retries, still exits 1). No behavior change except for the
  quota/rate-limit cases the issue targets.

---

## Root-cause findings (current HEAD e76dcd1)

Line numbers are against the current repo (issue #34's line refs are slightly
stale).

### 1. Provider errors become plain strings
File: packages/harness/src/index.ts

- L111 — runCli non-zero exit rejects with a bare Error built from cmd, code,
  and the first 2000 chars of stderr.
- L217 — whip NDJSON "error" event rejects with a bare Error built from
  JSON.stringify(event["error"]).
- L241 — whip non-zero exit rejects with a bare Error built from code + stderr.
- L106 / L235 — child.on("error", reject) forwards raw spawn errors (ENOENT,
  etc.) as bare Errors too.

All construct a plain Error. No error class exists anywhere in packages/*/src
(confirmed: grep for 402|429|quota|balance returns nothing).

### 2. Unconditional agentic-to-one-shot retry
File: packages/core/src/index.ts

- L300-306 — the review try/catch: on any failure from the agentic pass, if the
  reviewer is agentic it logs a warning and calls run(false) for a one-shot
  diff-only retry. The catch is type-blind, so a 402 from the agentic pass
  triggers a second (also doomed) one-shot call per reviewer.

### 3. No action output; docs hide the exit code
- action.yml — no outputs block. The composite step only sets env vars and runs
  "bun run packages/action/src/main.ts".
- packages/action/src/main.ts L25-29 — the .catch sets process.exitCode = 1 but
  nothing writes to $GITHUB_OUTPUT.
- Docs recommend continue-on-error: true (docs/github-action.md:22,
  docs/releases.md:33), which suppresses the exit code entirely.

---

## Implementation

### Step 1 — HarnessError + kind classifier (packages/harness/src/errors.ts, new)

New file, re-exported from packages/harness/src/index.ts:

    export type HarnessErrorKind =
      | "quota"        // 402, insufficient balance, billing — not retryable
      | "rate-limit"   // 429, rate limit exceeded — mode-switch retry won't help
      | "unknown";     // unclassified (crash, parse failure, transient) — preserves today's retry
      // future: | "timeout" | "spawn"

    /**
     * Every failure from a harness subprocess is wrapped in HarnessError so
     * callers can distinguish harness failures from other errors and branch on
     * kind. kind "unknown" preserves today's behavior for unclassified errors.
     */
    export class HarnessError extends Error {
      readonly kind: HarnessErrorKind;
      readonly status?: number;
      constructor(message: string, kind: HarnessErrorKind = "unknown", status?: number) {
        super(message);
        this.name = "HarnessError";
        this.kind = kind;
        this.status = status;
      }
    }

    /** Map a raw harness message + optional HTTP status to an error kind. */
    export function classifyHarnessError(message: string, status?: number): HarnessErrorKind {
      const s = (message + (status != null ? " " + status : "")).toLowerCase();
      if (/\b(402|payment required|insufficient balance|quota|billing)\b/.test(s)) return "quota";
      if (/\b(429|rate limit|too many requests)\b/.test(s)) return "rate-limit";
      return "unknown";
    }

    /** Kinds where the agentic->one-shot fallback must NOT fire. */
    const NON_RETRYABLE: readonly HarnessErrorKind[] = ["quota", "rate-limit"];

    export function isNonRetryableHarnessError(err: unknown): boolean {
      return err instanceof HarnessError && NON_RETRYABLE.includes(err.kind);
    }

### Step 2 — Wrap the reject sites (packages/harness/src/index.ts)

Import HarnessError + classifyHarnessError from ./errors. Replace the three
reject(new Error(...)) sites, keeping the existing message text:

- L111 (runCli close): reject(new HarnessError(message, classifyHarnessError(message))).
- L217 (whip "error" event): reject(new HarnessError(message, classifyHarnessError(message))).
- L241 (whip close): reject(new HarnessError(message, classifyHarnessError(message))).

Also wrap the spawn-error forwards for envelope uniformity (minor):

- L106 / L235: child.on("error", (e) => reject(new HarnessError(e instanceof Error ? e.message : String(e)))).

Status extraction (optional, best-effort): if the message contains an HTTP
status digit, pass it as the third arg so HarnessError.status is populated for
telemetry. Not required for the retry/output logic.

### Step 3 — Suppress retry for non-retryable kinds (packages/core/src/index.ts)

At L300-306, re-throw immediately when the failure is a non-retryable harness
error so a billing failure costs one call per reviewer, not two:

    try {
      stdout = await run(agentic);
    } catch (err) {
      if (!agentic || isNonRetryableHarnessError(err)) throw err;
      logger.warn("Agentic review failed; retrying one-shot from the diff", {
        error: err instanceof Error ? err.message : String(err),
        kind: err instanceof HarnessError ? err.kind : undefined,
      });
      stdout = await run(false);
    }

Import isNonRetryableHarnessError + HarnessError from @loupe/harness. kind
"unknown" still retries, preserving today's behavior for unclassified errors.

### Step 4 — Action output (action.yml + packages/action/src/main.ts)

Composite actions surface outputs by writing name=value lines to $GITHUB_OUTPUT
from a step. Two changes:

a. packages/action/src/main.ts — write a "status" output on completion and on
   failure. Add a helper and a kind-to-status mapper:

      function setOutput(name, value) {
        const file = process.env["GITHUB_OUTPUT"];
        if (!file) return;            // no-op when not running under the action
        appendFileSync(file, name + "=" + value + "\n");
      }

      function statusForError(err) {
        if (err instanceof HarnessError) {
          if (err.kind === "quota") return "quota";
          if (err.kind === "rate-limit") return "rate-limit";
        }
        return "failed";
      }

   - On success (after runReviews resolves): setOutput("status", "ok").
   - In .catch: setOutput("status", statusForError(err)); then set
     process.exitCode = 1 as today.

   runReviews returns void and propagates thrown errors to the .catch, so no
   signature change is needed.

   Output values: ok | quota | rate-limit | failed. quota and rate-limit are
   exposed distinctly so a workflow can route them differently (ping #billing
   for quota, auto-requeue for rate-limit). If matching the issue's single-kind
   framing is preferred, collapse both to "quota" — a one-line change in
   statusForError. Distinct is the default recommendation.

b. action.yml — declare the output and give the run step an id so workflows can
   read steps.<id>.outputs.status:

      outputs:
        status:
          description: "ok | quota | rate-limit | failed"
          value: ${{ steps.loupe-run.outputs.status }}

   The final composite step needs id: loupe-run.

### Step 5 — Docs (docs/github-action.md, docs/releases.md)

- Add a "Branching on failure" section showing how to read
  steps.loupe.outputs.status and act on "quota" (ping a channel, requeue) vs
  "rate-limit" (auto-requeue with backoff) vs "failed". Note that
  continue-on-error: true still keeps reviews advisory but the output is now
  visible.
- Note in docs/releases.md that the advisory posture now also exposes status.

### Step 6 — Tests

- packages/harness/tests/errors.test.ts (new):
  - classifyHarnessError maps "402 Payment Required", "insufficient balance",
    "quota exceeded" -> "quota"; "429", "rate limit exceeded",
    "too many requests" -> "rate-limit"; "exited 1: syntax error",
    "whip error: boom" -> "unknown".
  - HarnessError carries kind + status; isNonRetryableHarnessError is true only
    for HarnessError with kind in {quota, rate-limit}, false for kind "unknown"
    and for bare Errors.
  - runCli/runWhipStreaming spawn real processes and are hard to unit-test
    deterministically, so cover the classifier + guard exhaustively instead of
    spawning.
- packages/core/tests (extend or add): verify the retry is skipped for a
  non-retryable HarnessError — mock the harness review to throw a
  HarnessError(kind "quota") once and assert run(false) is not called; assert a
  HarnessError(kind "unknown") still triggers run(false).
- packages/action/tests (new if absent): verify setOutput writes to a temp
  $GITHUB_OUTPUT and statusForError maps HarnessError kinds correctly.

---

## Files touched

| File | Change |
|---|---|
| packages/harness/src/errors.ts | NEW: HarnessError, HarnessErrorKind, classifyHarnessError, isNonRetryableHarnessError |
| packages/harness/src/index.ts | Import + wrap reject sites at L106/L111/L217/L235/L241 |
| packages/core/src/index.ts | Guard retry at L300-306 with isNonRetryableHarnessError |
| packages/action/src/main.ts | setOutput + statusForError; write status on success + catch |
| action.yml | outputs.status + id: loupe-run on the run step |
| docs/github-action.md | "Branching on failure" section |
| docs/releases.md | Note the new status output |
| packages/harness/tests/errors.test.ts | New classifier + guard tests |
| packages/core/tests/*.test.ts | Retry-skip vs retry-unknown test |
| packages/action/tests/*.test.ts | New output mapping tests |

## Verification

    cd /Users/anishthite/loupe-issue34
    bun install --frozen-lockfile
    task check          # format + lint + tsc + vitest

## Out of scope

- Tracing / structured logging of provider errors (issue #19, adjacent).
- Alerting integrations (a workflow concern, enabled by the new output).
- Changing the default continue-on-error: true advisory posture.
- Backoff retry for rate-limit (the kind is in place; the retry policy is a
  follow-up).
