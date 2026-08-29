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

Token comes from `--token`, else `GITHUB_TOKEN`, else `gh auth token`. Flags:
`--harness`, `--providers env,dotenv,infisical`, `--conventions`, `--workdir`,
`--infisical-env`, `--infisical-project`.

## Credentials

`LOUPE_CREDENTIAL_PROVIDERS` is an ordered chain; first hit wins. Ships with:

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
