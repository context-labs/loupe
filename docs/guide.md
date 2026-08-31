# Guide

## What loupe does

1. Fetches a PR's changed files (with patches) and the repo's convention docs.
2. Filters the files to each reviewer's scope (subdir + globs).
3. Builds a system prompt (reviewer guidance + reasoning + tool directive +
   JSON output contract) and a user prompt (PR metadata + conventions + diff).
4. Runs a harness (an agent CLI) to produce findings as JSON.
5. Validates each finding's `path:line` against the diff — off-diff findings
   degrade to summary notes so a bad line never rejects the review.
6. Posts one review per reviewer: inline comments + a summary, with a
   `REQUEST_CHANGES` verdict if any inline finding is a `blocker`, else
   `COMMENT`. Never `APPROVE`.

## Install

```bash
bun install
```

Requires [Bun](https://bun.sh) 1.3.14 and a harness CLI on `PATH` (default:
[whip](https://github.com/context-labs/whip); also `claude`, `codex`).

## Run a review locally

```bash
# defaults: whip harness, kimi-k3, low reasoning, agentic
bun run packages/action/src/cli.ts review owner/repo#123

# PR URL also works
bun run packages/action/src/cli.ts review https://github.com/owner/repo/pull/123
```

Always start with `--dry-run` — it computes and prints the review without posting:

```bash
LOG_LEVEL=debug bun run packages/action/src/cli.ts review owner/repo#123 --dry-run
```

## GitHub token

Resolved in order: `--token` → `GITHUB_TOKEN` → `gh auth token`. Needs
`pull-requests: write` to post.

## CLI flags

| Flag | Default | Purpose |
|---|---|---|
| `-H, --harness <name>` | `whip` | Agent CLI: `whip`, `claude`, `codex`. |
| `-m, --model <name>` | `kimi-k3` | Model id passed to the harness. |
| `-r, --reasoning <level>` | `low` | `low` \| `medium` \| `high`. |
| `--no-agentic` | (agentic on) | Review one-shot from the diff, no tool use. |
| `--profile <name>` | `chill` | Noise: `quiet` \| `chill` \| `assertive`. |
| `--no-verify` | (verify on) | Skip the verification pass. |
| `--timezone <tz>` | `UTC` | Timezone label for the review environment line (e.g. `PST`). |
| `--ensemble <models>` | — | Run several models; keep findings a majority agree on. |
| `--full` | off | Whole-PR review instead of the incremental delta. |
| `-d, --dir <subdir>` | — | Restrict to a subdirectory (e.g. `inference`). |
| `--config <path>` | — | `.loupe.json` reviewer profiles; runs each match. |
| `--reviewer <name>` | — | Run only one named reviewer from `--config`. |
| `--prompt-file <path>` | — | Custom reviewer guidance (single-reviewer mode). |
| `-c, --conventions <paths>` | `CLAUDE.md,AGENTS.md,.loupe.md,CONTRIBUTING.md` | Repo docs to enforce. |
| `-p, --providers <spec>` | `env,dotenv` | Credential provider chain. |
| `-w, --workdir <dir>` | cwd | Repo checkout the harness may explore. |
| `--dry-run` | off | Compute + print, do not post. |
| `-t, --token <token>` | — | GitHub token override. |
| `--infisical-env`, `--infisical-project` | — | Infisical provider options. |

## Logging

`LOG_LEVEL` = `debug` \| `info` (default) \| `warn` \| `error`. Pretty locally,
JSON under `CI=true`. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to also export logs to an
OTLP collector. During a run you see live `thinking` and `streaming reply`
progress, plus `tool call` lines in agentic mode.
