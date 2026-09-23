# Review traces (GitHub Actions step summary)

When loupe runs a review it already streams live progress through its logger.
**Review traces** take the same normalized harness events a step further and
render a bounded, readable Markdown transcript into the GitHub Actions **step
summary** (`GITHUB_STEP_SUMMARY`) once every reviewer has finished — so a
completion has an audit trail of what each reviewer actually did: the reasoning
it emitted (collapsed), the tools it called and their results, the reply text it
generated, and its final result or diagnostic.

This is observability only. It **never issues model calls** and writes **no
trace files into the repo** (nothing is committed to the checkout); it only
appends pre-captured events to the Actions summary file at the very end after
all outcomes have completed.

## What lands in the summary

For every reviewer (or the single default review), the summary gets one section
(`### \`<reviewer>\``) containing:

- **metadata** — the harness (`whip`, `claude`, …), model, and phase labels
  (`primary`, `fallback`, `ensemble:<model>`, `verify`) carried on the events,
  when present;
- **reasoning** — a collapsed `<details>` block with the total reasoning char
  count and the head of the aggregated reasoning text (bounded);
- **reply** — a collapsed `<details>` block with the emitted assistant text
  (the review JSON), bounded;
- **tools** — a numbered list of observable tool calls with their arguments,
  each followed by its result, both safe-Markdown-escaped and truncated;
- **result** — a `done` event (final output, collapsed + bounded) or an `error`
  event (the diagnostic), or a note that no terminal event was received.

Output is **bounded**: tool args/results and reply blobs are truncated, reasoning
is head-only, each reviewer section and the whole file have a character cap. The
step summary is free of unbounded dumps; "full detail is in the job logs" is
real, because the harness's raw stderr/stdout and structured events are still
logged as before.

Known **secrets don't leak**: the harness hands the resolved credential values
(e.g. `ANTHROPIC_API_KEY`) to the subprocess via its env, and those exact values
are scrubbed (`[REDACTED]`) from any reasoning delta, tool arg/result or reply
text before it reaches the summary. Values shorter than the noise floor are left
alone, so nothing important is needlessly removed.

Escaping keeps the summary valid Markdown even when a tool returns backticks,
angles, or hashes: blob content is placed in fenced blocks and backticks are
escaped so they cannot close an unrelated fence.

### Non-Whip harnesses

The reasoning/tool transcript comes from **whip's** structured NDJSON event log.
If a reviewer runs a different harness (`claude`, `codex`), that log doesn't
exist, so its section carries no per-step detail — instead it states **explicitly
that detailed reasoning and per-tool traces are Whip-only** and that the reviewer
ran the non-whip harness by name, so the note is never mistaken for a run that
silently produced nothing. The final `done`/`error` result still renders.

## When it runs

The summary is produced **automatically when `GITHUB_STEP_SUMMARY` is set** and
at least one reviewer emitted trace events. In GitHub Actions that variable is
always present, so no extra workflow configuration is needed — the trace just
shows up. Outside Actions it is a **no-op** unless you set the variable yourself,
which is exactly how you verify locally.

## Local verification (no real review, no model calls)

You can render and write a trace without running a model at all — the renderer
and writer are exported and testable in isolation.

```bash
GITHUB_STEP_SUMMARY=/tmp/loupe-summary.md <anything that runs reviews>
```

Pointing `GITHUB_STEP_SUMMARY` at a scratch file is enough to make the Action
append its trace there on a normal run (pull_request or `@loupe review`).

To eyeball the exact summary output offline — no checkout, no harness, no model —
a **fixture preview** renders realistic whip/ensemble/error/non-whip reviewer
traces and writes them to a path (plain file write, never `GITHUB_STEP_SUMMARY`):

```bash
bun run trace:preview                # print to stdout
bun run trace:preview /tmp/trace.md  # write to a file
```

To sanity-check the rendering, the unit tests exercise the renderer and writer
directly (`packages/action/tests/trace.test.ts`), and the harness's raw-event →
normalized-event mapping plus secret scrubbing is covered by
`packages/harness/tests/trace.test.ts`:

```bash
bun run test
```

## Architecture boundaries

- `@loupe/harness` owns **capture/normalization** — the whip NDJSON event log is
  mapped to the normalized `HarnessTraceEvent` union and emitted through the
  optional `HarnessContext.trace` callback. It also scrubs the run's known
  credential values from every emitted payload. Nothing here knows about GitHub.
- `@loupe/core` owns **threading** — the trace callback is forwarded through
  `ReviewRequest` into every harness call (the primary agentic run, the one-shot
  fallback, each ensemble model, and the verification pass), with a `phase`
  label on each. Nothing here knows about Actions either.
- `@loupe/action` owns **rendering/writing** — `packages/action/src/trace.ts`
  collects per-reviewer events into per-reviewer arrays (safe with parallel
  reviewers, since each reviewer writes only its own buffer), renders bounded
  Markdown, and appends it to `GITHUB_STEP_SUMMARY` after all outcomes complete.

A writer/renderer that doesn't touch a subprocess means review traces are a
pure, offline transformation from already-captured events — trivially safe to
exercise locally and unintrusive in CI.