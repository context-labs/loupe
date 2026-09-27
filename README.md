# loupe

An AI pull-request reviewer built on [whip](https://github.com/context-labs/whip).
Define as many focused reviewers as you want, run them from your terminal or as
a GitHub Action, and get **real GitHub reviews with inline, line-anchored
comments** — not just a wall-of-text PR comment.

**Docs:** [`docs/`](docs/README.md) — user guide, configuration, credentials,
GitHub Action, and the maintainer architecture reference.

## Why loupe

- **One reviewer is a blurry reviewer.** A single mega-prompt that tries to
  catch bugs _and_ migration risk _and_ security _and_ conventions does none of
  them well. loupe lets you define **multiple focused reviewers** — each with its
  own prompt, file globs, model, and reasoning effort — so a bug-hunter reads the
  source, a migration-risk reviewer reads the SQL, a security reviewer reads the
  auth code. Each posts its own labeled review, and a reviewer whose globs match
  nothing stays quiet.
- **Any model, your choice.** Each reviewer is a whip agent, so it runs on any
  model whip can reach — a frontier closed model, a fast open one, or a panel
  of them for an ensemble. Pick the model and effort _per reviewer_. Hosted
  reviewers like Bugbot lock you to their backend and their model; loupe
  doesn't.
- **Local and CI are the same engine.** The exact review that runs in the GitHub
  Action runs from your terminal with one command — `--dry-run` to preview
  without posting. No separate local path to drift, no "works in CI only".
- **It reads the repo's own rules.** loupe enforces each repo's
  `CLAUDE.md` / `AGENTS.md` at review time — no vendored rulebook to copy around
  and keep in sync.
- **The runtime enforces the review contract.** Each reviewer is a whip agent
  definition with the review schema as its output contract: the daemon
  validates the reviewer's final message against it and corrects it once.
  Reviewers hold read-only authority, and an agentic verify pass reads the
  checkout to refute findings the surrounding code does not support.

## How it works

```
pull_request event  (or `loupe review` locally, or an @loupe comment)
  └─ @loupe/action        reads config from env/flags, brings up whip
       ├─ @loupe/harness  starts or attaches to the whip daemon (Unix socket),
       │                  builds each reviewer as an agent definition with an
       │                  output contract, runs one turn per review via the SDK
       ├─ @loupe/core     fetch PR + conventions → build prompt → run the turn →
       │                  parse + validate findings against the diff →
       │                  POST /pulls/{n}/reviews (inline comments, empty body)
       │                  POST/PATCH /issues/{n}/comments (persistent summary)
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
# the whip daemon self-authenticates from its own local login — no keys to wire:
bun run packages/action/src/cli.ts review owner/repo#123 --dry-run
```

loupe attaches to the running whip daemon over its Unix socket, starting one if
needed. Token comes from `--token`, else `GITHUB_TOKEN`, else `gh auth token`.
The binary is `whipcode` on `PATH`; `LOUPE_WHIP_BIN` names another, and when
neither exists loupe downloads the pinned release it was built against. With a
`--config` whose `whip` block names a provider, models are routed through that
provider, so it must be configured in your daemon.

Key flags (defaults in parens): `--model` (kimi-k3),
`--reasoning low|medium|high` (whip's default; set on the session), `--profile quiet|chill|assertive` (chill),
`--config <path>` (focused reviewers), `--reviewer <name>` (run just one),
`--prompt-file <path>` (custom guidance), `--dir` (subdir scope), `--ensemble`
(multi-model majority), `--timezone`, `--max-turns` (agentic loop cap),
`--max-comments` (inline comment cap; extras ranked into the summary),
`--no-verify`, `--no-agentic`,
`--providers env,dotenv,infisical`, `--dry-run`.

Use `--dry-run` (with `LOG_LEVEL=debug` to see every cell and tool call) to
compute and log a review without posting — the safe way to test.

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
every workflow file: `model`, `reasoning`, `profile`, `timezone`,
`dir`, and `maxTurns` (the agentic tool-loop cap; also per-reviewer), plus
`maxComments` (the inline comment cap; also per-reviewer). Precedence
is **Action input / CLI flag → `.loupe.json` → built-in
default**, so a workflow can still override, but by default the policy lives with
the repo.

It also declares the **whip provider + model panel** under `whip`. In CI, when
the provider's API key is in the environment, loupe writes that block into a
throwaway `WHIPCODE_HOME`, starts a dedicated daemon there, and stops it
afterwards — never touching a developer's real `~/.whipcode`. Locally, without
the key, loupe uses your own whip login instead. Only the API key _value_ stays
in the workflow; its env-var name is in the config. Every session names the
block's provider, so the models resolve even on a daemon whose default provider
is another.

```json
{
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

With that, the whole workflow is just: checkout → install whipcode →
`context-labs/loupe@v0` with `config: .loupe.json` and the secret in `env`. See
Variant C in `examples/review.example.yml`.

```bash
loupe review owner/repo#123 --config .loupe.json
loupe review owner/repo#123 --config .loupe.json --reviewer migrations
```

See `examples/.loupe.json` and `examples/reviewers/` for a ready bug-hunter +
migration-risk pair.

## Custom reviewer prompt

The system prompt is layered. `--prompt-file` (CLI) / `prompt-file` input
(Action) / a reviewer's `promptFile` replaces only the **guidance** layer
(persona + priorities). loupe always appends the review procedure (check
callers first; `procedure: false` removes it), the profile directive,
tool-access directive, repo conventions, and the JSON output contract, plus a
reasoning note when `reasoning` is set — and the whip daemon validates the
final message against that contract — so a custom prompt can't break parsing
or widen what the agent may do. Write only persona/priorities; never the JSON
schema. See `examples/loupe-prompt.md`.

## GitHub integration

Pin the action by ref: `@v0` tracks the latest `v0.x.y` (recommended), or pin an
exact `@v0.10.1` / a SHA for reproducibility — see
[docs/releases.md](docs/releases.md).

`action.yml` is a composite Action. Copy `examples/review.example.yml`
into a consuming repo, or register it once at the org level. A second workflow on
comment events gives you **`@loupe` chat**: `@loupe review` (re-review),
`@loupe fix` (fix every open Loupe finding in one commit), `@loupe fix <what>`
(make a specific edit and push it), `@loupe <question>` (Q&A grounded in the diff), and `@loupe help`. Inputs mirror
the CLI flags: `model`, `reasoning`, `profile`, `config`, `reviewer`,
`prompt-file`, `dir`, `skills`, `ensemble`, `timezone`, `verify`, `full`,
`convention-paths`, `credential-providers`, `github-token`.

## Scope to a subdirectory

For a monorepo, restrict the review to one folder — only changed files under it
are reviewed, conventions are read from it (`inference/AGENTS.md`), and the
agent works there:

```bash
loupe review context-labs/monorepo#6046 --dir inference
```

In the Action, set the `dir` input (or `LOUPE_DIR`).

## Credentials

The whip daemon holds the model credentials. Locally that is your whip login
(`whipcode auth inference-net`), so `loupe review` just works. In CI the `whip`
block's `apiKeyEnv` names the variable the daemon reads; loupe resolves it
through `LOUPE_CREDENTIAL_PROVIDERS`, an ordered chain where the first hit
wins:

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
`@loupe/core`, `@loupe/action`, plus the vendored `@whip/protocol` and
`@whip/sdk` under `vendor/` (refresh with `task vendor:whip WHIP=<whip checkout>`;
the release and commit are in `vendor/@whip/VERSION`). Tooling mirrors the
inference monorepo (oxlint / oxfmt / typescript-7 / Taskfile).
