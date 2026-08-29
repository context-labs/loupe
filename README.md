# loupe

AI pull-request reviewer that posts **inline, line-anchored comments** (with an
Approve-less `COMMENT` / `REQUEST_CHANGES` verdict), is **harness-agnostic**
(review with the Claude, Codex, … agent CLIs), and enforces **each repo's own
conventions** by reading its `CLAUDE.md` / `AGENTS.md` at review time — no
vendored rules, nothing to keep in sync.

## How it works

```
pull_request event
  └─ @loupe/action        reads config from env, resolves harness credentials
       ├─ @loupe/core     fetch PR + conventions → prompt → run harness →
       │                  validate findings against the diff → POST /pulls/{n}/reviews
       ├─ @loupe/harness  the agent CLI as a subprocess (claude, codex, …)
       └─ @loupe/credentials  provider chain: env → dotenv → infisical → your own
```

A finding must anchor to a line that appears in the diff; GitHub 422s the whole
review otherwise, so off-diff findings degrade to notes in the summary rather
than failing the run.

## Use it in a repo

See `.github/workflows/review.example.yml`. Minimal:

```yaml
- uses: actions/checkout@v4
- uses: your-org/loupe@v0
  with: { harness: claude }
  env: { ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} }
```

## Run it locally (end-to-end test)

```bash
bun install
ANTHROPIC_API_KEY=sk-... \
  bun run packages/action/src/cli.ts review https://github.com/owner/repo/pull/123
# or the shorthand:
bun run packages/action/src/cli.ts review owner/repo#123 --harness claude
```

Token comes from `--token`, else `GITHUB_TOKEN`, else `gh auth token`.

Key flags (defaults in parens): `--harness` (whip), `--model` (kimi-k3),
`--reasoning low|medium|high` (medium), `--prompt-file <path>` (custom reviewer
guidance), `--dir` (subdir scope), `--providers env,dotenv,infisical` (env),
`--dry-run`, `--conventions`, `--workdir`, `--infisical-env`,
`--infisical-project`.

```bash
# defaults: whip + kimi-k3 + medium
bun run packages/action/src/cli.ts review owner/repo#123

# pick model + effort + a different harness
bun run packages/action/src/cli.ts review owner/repo#123 \
  --harness claude --model claude-opus-4-8 --reasoning high

# bring your own reviewer prompt
bun run packages/action/src/cli.ts review owner/repo#123 \
  --prompt-file examples/loupe-prompt.md
```

Use `--dry-run` to compute and log the review (with `LOG_LEVEL=debug` to see the
raw harness output) without posting anything — the safe way to test.

## Custom reviewer prompt

The system prompt has three layers. `--prompt-file` (CLI) / `prompt-file` input
(Action) / `LOUPE_PROMPT_FILE` replaces only the first:

1. **Reviewer guidance** — persona and priorities. Default is a high-signal
   senior-reviewer prompt; your file replaces it.
2. **Reasoning note** — from `--reasoning`, always appended.
3. **Output contract + headless directive** — always appended; this is why a
   custom prompt can't break JSON parsing or trigger tool loops.

See `examples/loupe-prompt.md` for the shape — write only persona/priorities,
never the JSON schema.

## GitHub integration

`action.yml` is a composite Action. Copy `.github/workflows/review.example.yml`
into a consuming repo (it has three ready variants: internal whip, external
claude-with-secret, and custom-prompt), or register it once at the org level as
a required workflow so it applies to every repo. Inputs mirror the CLI flags:
`harness`, `model`, `reasoning`, `prompt-file`, `dir`, `convention-paths`,
`credential-providers`, `github-token`.

## Scope to a subdirectory

For a monorepo, restrict the review to one folder — only changed files under it
are reviewed, conventions are read from it (`inference/AGENTS.md`), and the
harness runs there:

```bash
bun run packages/action/src/cli.ts review context-labs/monorepo#6046 \
  --harness whip --dir inference
```

In the Action, set the `dir` input (or `LOUPE_DIR`).

## Logging

Structured logging via winston. `LOG_LEVEL` (`debug|info|warn|error`, default
`info`) controls verbosity; pretty output locally, JSON under `CI=true`. Set
`OTEL_EXPORTER_OTLP_ENDPOINT` to also export logs to an OTLP collector (via the
winston→OpenTelemetry bridge, same as the monorepo) — otherwise logs stay
stdout-only, so no collector is needed to run.

## Credentials

`LOUPE_CREDENTIAL_PROVIDERS` is an ordered chain; first hit wins. Ships with:

Harnesses that self-authenticate need no provider at all. `whip` reviews using
its own local login (`~/.whip/`), so `loupe review --harness whip` just works
once `whip auth inference-net login` has been run — no keys to wire.

- `env` — `process.env` (default; works with plain GitHub secrets)
- `dotenv` — a `.env` file
- `infisical` — the Infisical CLI (`LOUPE_INFISICAL_ENV`, `LOUPE_INFISICAL_PROJECT_ID`)

Add your own by implementing `CredentialProvider` from `@loupe/credentials`.

## Dev

```
bun install
task check   # format + lint + tsc + test
```

## Status: v0.1

Working: claude harness, inline review posting, convention-reading, credential
chain (env/dotenv/infisical). Codex harness is wired but unverified end-to-end.
Not yet: incremental review on `synchronize` (re-reviews the full diff each run),
comment de-duplication across runs, cost controls.
