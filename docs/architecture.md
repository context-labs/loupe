# Architecture (maintainers)

Bun monorepo, `workspace:*` packages. Tooling: oxlint (type-aware), oxfmt,
`typescript-7` (`tsc --build`), vitest. Run everything with `task check`.

## Packages

```
packages/
├─ credentials/  provider chain (env → dotenv → infisical → custom)
├─ harness/      the whip daemon, its SDK client, and the agent definitions
├─ logger/       winston structured logging + opt-in OTLP export
├─ core/         the review engine (no CLI/Action concerns)
└─ action/       CLI + GitHub Action entry, config, reviewer-profile loading
vendor/@whip/    prebuilt @whip/protocol and @whip/sdk (see VERSION)
```

Dependency direction: `action` → `core` → (`harness`, `logger`); `harness` →
`logger`, `@whip/sdk`; `credentials` and `logger` are leaves. `core` knows
nothing about the CLI, env vars, or `.loupe.json` — those live in `action`.

## The review pipeline

`runReview()` in `packages/core/src/index.ts` is the whole engine:

1. **Scope** — normalize `subdir`; prefix convention paths with it.
2. **Fetch** (parallel) — `fetchPullContext` (PR + changed files with patches)
   and `fetchConventions` (repo docs at the PR head). Octokit's own logging is
   routed to `logger.debug` so expected 404s (probing optional docs) stay quiet.
3. **Filter** — keep files under `subdir` and matching `include`/`exclude`
   (`Bun.Glob`). No files in scope → return early (reviewer skipped).
4. **Prompt** — `agentic = req.agentic ?? true`. `buildSystemPrompt` layers
   guidance + reasoning note + tool directive (headless vs agentic) + output
   contract; `buildUserPrompt` is PR metadata + conventions + rendered diff.
5. **Run** — pick `harnessCwd` (subdir if it exists on disk, else workdir, else
   cwd; warn in agentic mode if absent). Call `harness.review(ctx)` with
   `agent: "reviewer"` and the review schema as `output`: the harness builds
   the agent definition, serves it, and runs one turn on a session pinned to
   it. The daemon validates the final message against the schema and corrects
   it once.
6. **Parse** — `outcomeText` takes the turn's validated `output` (or its final
   text when the turn cap answered past the check); `parseReviewOutput`
   extracts the last JSON object and validates each finding independently
   (one malformed finding is dropped, not fatal).
7. **Validate** — `validateFindings` splits findings into `inline` (their
   `path:line` is in the diff) and `dropped` (off-diff → summary notes). This is
   what prevents a hallucinated line from 422-ing the whole review.
8. **Post** — dry-run logs and returns; otherwise a pre-publish freshness check
   re-reads the PR and skips the per-reviewer publish if it has merged, closed,
   or had its head move since that reviewer fetched the PR (findings were computed
   but are not posted onto a diff nobody can act on; issue #39). `postReview` then
   deletes this reviewer's prior inline comments, creates an empty-body review
   containing the new inline findings, and creates or updates the reviewer's
   marker-identified summary issue comment. Blockers produce `REQUEST_CHANGES`;
   other inline reviews use `COMMENT`. After all parallel reviewers finish, a
   lighter check gates the combined summary against only a merge or close (a head
   move is already handled per reviewer and needs no separate anchor).

### core files

- `types.ts` — `Finding` / severity Zod schema (with alias normalization) and
  the loose review-output schema.
- `diff.ts` — `commentableLines` parses hunk headers to the RIGHT-side line set
  GitHub will accept comments on; `renderDiff` formats the diff for the prompt.
- `prompt.ts` — default guidance, the system-prompt layers, user prompt, the
  verifier / chat / fix prompts.
- `output.ts` — the zod output contracts: the review and the verifier's
  verdicts. The daemon derives JSON Schema from them and shows the model the
  shape in its runtime guide.
- `parse.ts` — `outcomeText`, brace-depth JSON extraction + per-finding
  `safeParse`.
- `validate.ts` — inline vs dropped split.
- `github.ts` — Octokit factory, PR/convention fetch, `postReview` + comment
  de-dup markers.

## The harness seam

`packages/harness/src/index.ts`:

- `Harness` = `{ name, review(ctx) → RunOutcome }`. `review` runs one turn to
  completion and returns `{ text, output, usage }`: the final message and,
  under an output contract, the value the daemon validated. Parsing findings
  out of it is the core's job.
- `HarnessContext` = `{ agent, output?, name?, systemPrompt, userPrompt,
  model?, provider?, agentic?, workdir, maxTurns?, reasoning?, cacheKey?,
  trace?, phase?, logger }`. `agent` picks the loupe agent (`reviewer`,
  `verifier`, `chat`, `fixer`); `agentFor(ctx)` builds its definition.
- `whipHarness(client, secrets)` is the one implementation: `runAgent` serves
  the definition from this process, opens a session (`cwd`, model, provider,
  `permission_mode: automatic`; `headless`, `max_turns`, `cache_key`;
  `session.effort` when `reasoning` is set), runs `session.run(prompt)`, and
  deletes the session. Turn events feed `RunProgress` (the live log) and,
  through `turnEventToTrace`, the trace sink. A failed turn or SDK error is
  rethrown as a `HarnessError` classified by `classifyHarnessError`.

The rest of the package:

- `daemon.ts` — `resolveWhipBinary` (`LOUPE_WHIP_BIN`, then `whipcode` on
  PATH, else the pinned `PINNED_WHIP_TAG` release downloaded once, single-
  flighted); `ensureDaemon`: `whipcode daemon status --json`, start if needed,
  return the Unix socket. With a `whip` config block whose `apiKeyEnv` is set,
  `materializeWhipHome` writes a throwaway home and a dedicated daemon runs
  there until `stop()`; otherwise the local daemon is used and left running.
  The home variable follows the binary name (`WHIPCODE_HOME`).
- `client.ts` — `connect` (SDK client over `unixSocket`), `serveAgent`
  (`client.agents.serve`, or only `register` for a definition with no hooks;
  `runtime.sessions.create` pins each session to the served revision), and
  `runAgent`, the one-turn convenience.
- `agents.ts` — `reviewerAgent` (`context` + `files` when agentic, read-only
  capability, the review schema as `output`), `verifierAgent` (the same shape,
  the verdicts schema), `chatAgent` (diff only, prose), `fixerAgent` (`files`
  + `shell` with write and shell capabilities, hook-guarded). Ids carry a hash
  of the canonical document (`loupe-<name>-<8 hex>`): a new session takes an
  id's most recently created revision, so two variants sharing an id would
  hand a session the wrong one; the hash keeps that from arising.
- `hooks.ts` — pure decision functions: `reviewerBeforeTool` (deny edits, so
  an attempt shows up as a hook decision), `fixerBeforeTool` (no git history
  commands, recursive deletes, sudo, or pipes to a shell; edits stay inside
  the checkout).
- `progress.ts` — `RunProgress` maps turn events to the run log (throttled
  `thinking` / `streaming reply`, one line per cell and host call, hook
  decisions, a `run finished` line with tokens and cost); `turnEventToTrace`
  maps them to `HarnessTraceEvent`s for the step summary.
- `errors.ts`, `trace.ts` — `HarnessError` and its kinds; the trace event
  union and secret redaction.

## action files

- `config.ts` — the only place that reads `process.env`; parses with Zod and
  resolves `LOUPE_CONFIG`/`LOUPE_PROMPT_FILE` against `GITHUB_WORKSPACE`.
- `run.ts` — `resolveHarness`: one daemon and one client per process, shared
  by every reviewer (resolve the provider key through the credential chain,
  `ensureDaemon`, `connect`, `whipHarness`); `releaseWhip` closes the client
  and stops a daemon loupe started. `reviewPullRequest` calls `runReview` on
  it. Plus `formatResult` / `renderReview`.
- `reviewers.ts` — loads/validates `.loupe.json` into resolved `Reviewer[]`
  (reads `promptFile` relative to the config).
- `cli.ts` — commander CLI (single-reviewer or `--config` loop).
- `main.ts` — Action entry: same single/loop logic driven by env.

## Extending

- **New agent** — a definition builder in `harness/src/agents.ts`, a case in
  `agentFor`, and a `HarnessContext.agent` kind. Hooks are pure functions in
  `hooks.ts` with a test; returning nothing allows unchanged, hooks only
  narrow.
- **Refresh the SDK** — `task vendor:whip WHIP=<whip checkout>` rebuilds and
  recopies `vendor/@whip` and records the release, commit, and wire protocol
  in `VERSION`. Bump `PINNED_WHIP_TAG` and the workflows' install step with it.
- **New credential provider** — implement `CredentialProvider`, add a case to
  `resolveProviders` in `action/src/config.ts`.
- **New reviewer** — edit `.loupe.json`. No code change.

## Tests

Vitest, beside the code (`packages/*/tests`). The load-bearing logic covered:
hunk→commentable-line parsing, off-diff finding rejection, JSON extraction,
empty-output error, severity normalization, the review pipeline against a fake
harness, hook decision tables, definition ids, daemon planning, the event → log
and event → trace mappings, and the runner itself against `@whip/sdk/testing`'s
scripted daemon (serve, pinned creation, configure, effort, run, multi-session,
failure). Run `task test` (or `task check`). Live behavior is checked with
`loupe review … --dry-run` against a real PR.
