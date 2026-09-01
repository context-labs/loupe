# loupe

A harness- and model-agnostic AI pull-request reviewer. Define as many focused
reviewers as you want, run them from your terminal or as a GitHub Action, and
get **real GitHub reviews with inline, line-anchored comments** — not just a
wall-of-text PR comment.

**Docs:** [`docs/`](docs/README.md) — user guide, configuration, credentials,
GitHub Action, and the maintainer architecture reference.

## Why loupe

- **One reviewer is a blurry reviewer.** A single mega-prompt that tries to
  catch bugs *and* migration risk *and* security *and* conventions does none of
  them well. loupe lets you define **multiple focused reviewers** — each with its
  own prompt, file globs, model, and reasoning effort — so a bug-hunter reads the
  source, a migration-risk reviewer reads the SQL, a security reviewer reads the
  auth code. Each posts its own labeled review, and a reviewer whose globs match
  nothing stays quiet.
- **Any harness, any model — your choice, not the vendor's.** loupe drives the
  agent CLI you already use — [whip](https://github.com/context-labs/whip),
  Claude, Codex — as a subprocess, and any model those can reach. Pick the
  harness, model, and effort *per reviewer*. Hosted reviewers like Bugbot lock
  you to their backend and their model; loupe doesn't — point it at a frontier
  closed model, a fast open one, or a whole panel of them.
- **Local and CI are the same engine.** The exact review that runs in the GitHub
  Action runs from your terminal with one command — `--dry-run` to preview
  without posting. No separate local path to drift, no "works in CI only".
- **It reads the repo's own rules.** loupe enforces each repo's
  `CLAUDE.md` / `AGENTS.md` at review time — no vendored rulebook to copy around
  and keep in sync.
- **A panel of models for the hard calls.** Agentic reviewers can fan out
  subagents across a diverse set of models to independently double- or
  triple-confirm a suspected bug before flagging it — fewer false positives, and
  the confident ones land as inline comments.

## How it works

```
pull_request event  (or `loupe review` locally, or an @loupe comment)
  └─ @loupe/action        reads config from env/flags, resolves harness credentials
       ├─ @loupe/core     fetch PR + conventions → build prompt → run harness →
       │                  parse + validate findings against the diff →
       │                  POST /pulls/{n}/reviews (inline comments + rich body)
       ├─ @loupe/harness  the agent CLI as a subprocess (whip, claude, codex, …)
       └─ @loupe/credentials  provider chain: env → dotenv → infisical → your own
```

A finding must anchor to a line that appears in the diff (GitHub 422s the whole
review otherwise); off-diff findings snap to the nearest changed line or degrade
to notes in the summary rather than failing the run. The review body is rendered
from structured output — summary, concerns, highlights, and an optional
diagram — not a restatement of the diff.

## Run it locally

```bash
bun install
# whip self-authenticates from its own local login — no keys to wire:
bun run packages/action/src/cli.ts review owner/repo#123 --harness whip

# or bring a key for a hosted harness:
ANTHROPIC_API_KEY=sk-... \
  bun run packages/action/src/cli.ts review owner/repo#123 --harness claude
```

Token comes from `--token`, else `GITHUB_TOKEN`, else `gh auth token`.

Key flags (defaults in parens): `--harness` (whip), `--model` (kimi-k3),
`--reasoning low|medium|high` (low), `--profile quiet|chill|assertive` (chill),
`--config <path>` (focused reviewers), `--reviewer <name>` (run just one),
`--prompt-file <path>` (custom guidance), `--dir` (subdir scope), `--ensemble`
(multi-model majority), `--timezone`, `--max-turns` (agentic loop cap),
`--no-verify`, `--no-agentic`,
`--providers env,dotenv,infisical`, `--dry-run`.

Use `--dry-run` (with `LOG_LEVEL=debug` to see raw harness output) to compute and
log a review without posting — the safe way to test.

## Focused reviewers (`.loupe.json`)

Instead of one generic reviewer, define several — each with its own prompt, the
file globs it applies to, and optional model/reasoning/profile. loupe runs every
reviewer whose globs match a changed file and posts each as its own labeled
review (`🔍 loupe · migrations`). A reviewer whose globs match nothing is skipped.

```json
{
  "skills": [".agents/skills/i-have-adhd"],
  "reviewers": [
    {
      "name": "bugs",
      "promptFile": "reviewers/bugs.md",
      "include": ["**/*.ts", "**/*.tsx"],
      "exclude": ["**/*.test.ts", "**/tests/**"],
      "reasoning": "medium"
    },
    {
      "name": "migrations",
      "promptFile": "reviewers/migrations.md",
      "include": ["**/migrations/**/*.sql", "**/migrations/**/migration.ts"],
      "reasoning": "high"
    }
  ]
}
```

Per-reviewer keys: `prompt`/`promptFile`, `include`/`exclude`, `model`,
`reasoning`, `profile`, `agentic`, `verify`, `ensemble`, `skills`,
`pathInstructions`. Top-level `skills` apply to every reviewer.

### Top-level config — keep review policy out of the workflow

The config file also carries the **review defaults** that used to be repeated in
every workflow file: `harness`, `model`, `reasoning`, `profile`, `timezone`,
`dir`, and `maxTurns` (the agentic tool-loop cap; also per-reviewer). Precedence
is **Action input / CLI flag → `.loupe.json` → built-in
default**, so a workflow can still override, but by default the policy lives with
the repo.

It can also declare the **whip provider + model panel** under `whip`, so the
workflow no longer hand-writes `~/.whip/config.json` in a CI step. loupe
materializes it into a throwaway `WHIP_HOME` at review time (never touching a
developer's real `~/.whip`); only the API key *value* stays in the workflow —
its env-var name is in the config.

```json
{
  "harness": "whip",
  "model": "kimi-k3",
  "timezone": "PST",
  "dir": "inference",
  "whip": {
    "provider": {
      "name": "inference-net",
      "baseUrl": "https://api.inference.net/v1",
      "apiKeyEnv": "INFERENCE_API_KEY"
    },
    "models": ["kimi-k3", "glm-5.3-flash", "gpt-5.6-luna"]
  },
  "reviewers": [{ "name": "bugs", "promptFile": "reviewers/bugs.md" }]
}
```

With that, the whole workflow is just: checkout → install the harness binary →
`context-labs/loupe@v0` with `config: .loupe.json` and the secret in `env`. See
Variant D in `.github/workflows/review.example.yml`.

```bash
loupe review owner/repo#123 --config .loupe.json
loupe review owner/repo#123 --config .loupe.json --reviewer migrations
```

See `examples/.loupe.json` and `examples/reviewers/` for a ready bug-hunter +
migration-risk pair.

## Custom reviewer prompt

The system prompt is layered. `--prompt-file` (CLI) / `prompt-file` input
(Action) / a reviewer's `promptFile` replaces only the **guidance** layer
(persona + priorities). loupe always appends the reasoning note, profile
directive, tool-access directive, repo conventions, and the JSON output
contract — so a custom prompt can't break parsing or trigger tool loops. Write
only persona/priorities; never the JSON schema. See `examples/loupe-prompt.md`.

## GitHub integration

`action.yml` is a composite Action. Copy `.github/workflows/review.example.yml`
into a consuming repo, or register it once at the org level. A second workflow on
comment events gives you **`@loupe` chat**: `@loupe review` (re-review),
`@loupe fix <what>` (loupe edits the branch and pushes a commit),
`@loupe <question>` (Q&A grounded in the diff), and `@loupe help`. Inputs mirror
the CLI flags: `harness`, `model`, `reasoning`, `profile`, `config`, `reviewer`,
`prompt-file`, `dir`, `skills`, `ensemble`, `timezone`, `verify`, `full`,
`convention-paths`, `credential-providers`, `github-token`.

## Scope to a subdirectory

For a monorepo, restrict the review to one folder — only changed files under it
are reviewed, conventions are read from it (`inference/AGENTS.md`), and the
harness runs there:

```bash
loupe review context-labs/monorepo#6046 --harness whip --dir inference
```

In the Action, set the `dir` input (or `LOUPE_DIR`).

## Credentials

Harnesses that self-authenticate need no provider at all: `whip` reviews using
its own local login (`~/.whip/`), so `loupe review --harness whip` just works
once `whip auth inference-net login` has been run.

Otherwise `LOUPE_CREDENTIAL_PROVIDERS` is an ordered chain; first hit wins:

- `env` — `process.env` (default; works with plain GitHub secrets)
- `dotenv` — a `.env` file
- `infisical` — the Infisical CLI (`LOUPE_INFISICAL_ENV`, `LOUPE_INFISICAL_PROJECT_ID`)

Add your own by implementing `CredentialProvider` from `@loupe/credentials`.

## Logging

Structured logging via winston. `LOG_LEVEL` (`debug|info|warn|error`, default
`info`); pretty locally, JSON under `CI=true`. Set `OTEL_EXPORTER_OTLP_ENDPOINT`
to also export logs to an OTLP collector — otherwise logs stay stdout-only, so no
collector is needed to run.

## Dev

```
bun install
task check   # format + lint + tsc + test
```

Bun workspace monorepo: `@loupe/credentials`, `@loupe/harness`, `@loupe/logger`,
`@loupe/core`, `@loupe/action`. Tooling mirrors the inference monorepo
(oxlint / oxfmt / typescript-7 / Taskfile).
