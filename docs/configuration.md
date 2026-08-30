# Configuration

## Reviewer profiles (`.loupe.json`)

Define focused reviewers in a repo's `.loupe.json`. loupe runs every reviewer
whose globs match a changed file and posts each as its own labeled review
(`🔍 loupe · <name>`). A reviewer that matches nothing is skipped.

```json
{
  "reviewers": [
    {
      "name": "code",
      "promptFile": "reviewers/bugs.md",
      "exclude": ["**/*.lock", "**/*.generated.ts", "**/dist/**"],
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

### Reviewer fields

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Label on the posted review; also the comment marker for de-dup. |
| `prompt` or `promptFile` | one | Reviewer guidance. `promptFile` resolves relative to the config file. |
| `include` | no | Globs; reviewer runs only when a changed file matches. **Omit = the whole PR.** |
| `exclude` | no | Globs removed from scope (lockfiles, generated output, …). |
| `model` | no | Overrides the run's model for this reviewer. |
| `reasoning` | no | `low` \| `medium` \| `high`. |
| `agentic` | no | `false` to run one-shot; omitted = agentic (the default). |

Globs are matched with `Bun.Glob` against repo-relative paths. `include` also
composes with `--dir` (subdir scope).

Run all matching reviewers, or one:

```bash
loupe review owner/repo#123 --config .loupe.json
loupe review owner/repo#123 --config .loupe.json --reviewer migrations
```

## The system prompt (three layers)

Every review's system prompt is assembled from:

1. **Reviewer guidance** — the persona/priorities. Default is a high-signal
   senior-reviewer prompt; a reviewer's `prompt`/`promptFile` (or `--prompt-file`)
   replaces this layer only.
2. **Reasoning note** — from `reasoning` / `--reasoning`.
3. **Tool directive + output contract** — always appended by loupe. This is why
   a custom prompt can never break JSON parsing or change tool behavior. Write
   only persona/priorities in a custom prompt, never the JSON schema.

## Agentic vs one-shot

- **Agentic (default):** the harness gets the checkout and uses tools to inspect
  the real schema/code, not just the diff (higher turn budget). Needs a real
  checkout as workdir — CI checks the repo out; locally pass `--workdir`.
- **One-shot:** `"agentic": false` (or `--no-agentic`) — reviews from the diff
  alone. Faster and cheaper; good for a general bug pass.

Agentic gives richer, grounded findings (it can read related migrations, callers,
indexes) at the cost of more model round-trips per review.

## Conventions

loupe reads the target repo's own docs at the PR head and injects them into the
review — no vendored rules. Default paths:
`CLAUDE.md, AGENTS.md, .loupe.md, CONTRIBUTING.md` (override with `--conventions`
or `LOUPE_CONVENTION_PATHS`). With `--dir`, paths resolve under the subdir
(`inference/AGENTS.md`).

## Severities

Findings use `blocker` \| `warning` \| `nit`. Models often emit off-scale values
(`major`, `critical`, `minor`, …); loupe normalizes them and defaults unknowns to
`warning`. Any `blocker` among inline findings makes the verdict
`REQUEST_CHANGES`.
