# Plan: Issue #34 — Classify quota and rate-limit failures as typed errors

## Summary

Quota / rate-limit failures (HTTP 402 Payment Required, 429, "insufficient
balance", etc.) currently surface as opaque string errors. The agentic to
one-shot fallback retries them unconditionally (doubling wasted billing calls),
and the GitHub Action exposes no output a consuming workflow can branch on — so
~120 runs can fail silently over 42 hours with every job green.

This plan adds a typed error kind for quota/rate-limit failures, suppresses the
retry for that kind, and exposes an action output so workflows can gate on it.

Branch: fix/issue34-classify-quota-errors
Worktree: /Users/anishthite/loupe-issue34

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

All three construct a plain Error with the raw message. There is no error class
anywhere in packages/*/src (confirmed: grep for 402|429|quota|balance returns
nothing).

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

### Step 1 — Typed error kind (packages/harness/src/index.ts)

Add an exported error class and a classifier near the top of the file:

    export class QuotaError extends Error {
      readonly kind = "quota";
      readonly status?: number;
      constructor(message: string, status?: number) {
        super(message);
        this.name = "QuotaError";
        this.status = status;
      }
    }

    // True when a message/status looks like a provider quota or rate-limit hit.
    export function isQuotaError(err: unknown): boolean {
      if (err instanceof QuotaError) return true;
      const msg = err instanceof Error ? err.message : String(err);
      return /\b(402|429|payment required|insufficient balance|quota|rate limit|billing)\b/i.test(msg);
    }

QuotaError lives in the harness package (where provider output is first parsed).
Construction sites to update, keeping the existing message text but wrapping as
QuotaError when the message matches, else a plain Error:

- L111 (runCli close handler): classify the "exited {code}: {stderr}" message.
- L217 (whip "error" event): classify the "whip error: {json}" message.
- L241 (whip close handler): classify the "whip exited {code}: {stderr}" message.

A small helper avoids duplicating the test at each site:

    function rejectClassified(reject, message, status?) {
      reject(isQuotaLike(message, status) ? new QuotaError(message, status) : new Error(message));
    }

Re-export QuotaError / isQuotaError from @loupe/core if core needs the symbol
directly (it does, for Step 2).

### Step 2 — Suppress retry for the typed kind (packages/core/src/index.ts)

At L300-306, re-throw immediately when the failure is a quota/rate-limit error
so a billing failure costs one call per reviewer, not two:

    try {
      stdout = await run(agentic);
    } catch (err) {
      if (!agentic || isQuotaError(err)) throw err;
      logger.warn("Agentic review failed; retrying one-shot from the diff", {
        error: err instanceof Error ? err.message : String(err),
      });
      stdout = await run(false);
    }

Import isQuotaError from @loupe/harness.

### Step 3 — Action output (action.yml + packages/action/src/main.ts)

Composite actions surface outputs by writing name=value lines to $GITHUB_OUTPUT
from a step. Two changes:

a. packages/action/src/main.ts — write a "status" output on completion and on
   failure. Add a helper and call it from the success path (after runReviews
   resolves) and the .catch:

      function setOutput(name, value) {
        const file = process.env["GITHUB_OUTPUT"];
        if (!file) return;            // no-op when not running under the action
        appendFileSync(file, name + "=" + value + "\n");
      }

   - On success: setOutput("status", "ok").
   - In .catch: setOutput("status", "quota") when isQuotaError(err), else
     setOutput("status", "failed"); then set process.exitCode = 1 as today.

   runReviews currently returns void and propagates thrown errors to the
   .catch, so no signature change is needed — classification lives in
   isQuotaError.

b. action.yml — declare the output and give the run step an id so workflows can
   read steps.<id>.outputs.status:

      outputs:
        status:
          description: "ok | quota | failed"
          value: ${{ steps.loupe-run.outputs.status }}

   The final composite step needs id: loupe-run.

### Step 4 — Docs (docs/github-action.md, docs/releases.md)

- Add a "Branching on failure" section showing how to read
  steps.loupe.outputs.status and act on "quota" (e.g. ping a channel, requeue)
  vs "failed". Note that continue-on-error: true still keeps reviews advisory
  but the output is now visible.
- Note in docs/releases.md that the advisory posture now also exposes status.

### Step 5 — Tests

- packages/harness/tests/quota-error.test.ts (new):
  - isQuotaError matches "402 Payment Required", "429", "insufficient balance",
    "quota exceeded", "rate limit exceeded"; rejects "exited 1: syntax error"
    and a generic "whip error: boom".
  - runCli/runWhipStreaming spawn real processes and are hard to unit-test
    deterministically, so cover the classifier exhaustively and the construction
    path via the unit-tested rejectClassified helper instead of spawning.
- packages/core/tests (extend or add): verify the retry is skipped for a
  QuotaError thrown by the harness — mock the harness review to throw a
  QuotaError once and assert run(false) is not called.
- packages/action/tests (new if absent): verify setOutput writes to a temp
  $GITHUB_OUTPUT and the main catch maps QuotaError to "quota".

---

## Files touched

| File | Change |
|---|---|
| packages/harness/src/index.ts | Add QuotaError, isQuotaError; classify at L111/L217/L241 |
| packages/core/src/index.ts | Guard retry at L300-306 with isQuotaError |
| packages/action/src/main.ts | setOutput helper; write status on success + catch |
| action.yml | outputs.status + id: loupe-run on the run step |
| docs/github-action.md | "Branching on failure" section |
| docs/releases.md | Note the new status output |
| packages/harness/tests/quota-error.test.ts | New classifier tests |
| packages/core/tests/*.test.ts | Retry-skip test |
| packages/action/tests/*.test.ts | New output mapping tests |

## Verification

    cd /Users/anishthite/loupe-issue34
    bun install --frozen-lockfile
    task check          # format + lint + tsc + vitest

## Out of scope

- Tracing / structured logging of provider errors (issue #19, adjacent).
- Alerting integrations (a workflow concern, enabled by the new output).
- Changing the default continue-on-error: true advisory posture.
