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
| `profile` | no | Noise profile: `quiet` (blockers) \| `chill` (default) \| `assertive` (all). |
| `verify` | no | `false` to skip the verification pass (default on). |
| `pathInstructions` | no | `[{ glob, instruction }]` extra review instructions for matching files. |
| `ensemble` | no | `["kimi-k3","glm-5.2-fast"]` — run several models, keep findings a majority agree on. |
| `skills` | no | Paths to skill docs (a `SKILL.md` or a skill dir) folded into the reviewer, e.g. `[".agents/skills/i-have-adhd"]` to enforce a terse output style. |

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

## Skills

A reviewer can load repo skill docs into its own behavior via `skills` (config)
or `--skills` (CLI): each entry is a path (relative to the checkout) to a
`SKILL.md` or a skill directory. loupe reads them and folds them into the system
prompt — so, for example, `[".agents/skills/i-have-adhd"]` makes the reviewer
adopt that terse output style. This is how you enhance the underlying agent
harness with your repo's own skills.

## Signal-to-noise features

- **Verification pass** (on by default) — after findings are produced, a cheap
  second inference judges each one real or not against the diff; rejected
  findings are dropped. Turn off with `verify: false` / `--no-verify`.
- **Ensemble** — run the review across several models (`ensemble` /
  `--ensemble`); only findings a majority agree on are posted, the rest go to a
  lower-confidence section. Supersedes the verification pass. Higher precision at
  N× the review cost.
- **Noise profile** — `quiet` posts only blockers, `chill` (default) blockers +
  warnings, `assertive` everything. Both prompt-level and a hard severity
  filter.
- **Path instructions** — per-glob natural-language guidance injected only when
  a matching file changed (e.g. "in `**/*.sql`, flag full-table locks").
- **Incremental review** — on a re-review, loupe reviews only the files changed
  since its last review of the PR and replaces only those comments; comments on
  untouched files are kept. `--full` / `full: true` forces a whole-PR review.
- **Walkthrough** — each review includes a collapsible changed-files table and,
  when useful, a Mermaid sequence diagram.

## What a review looks like

loupe posts a real GitHub **review** (not a plain comment): a structured body
plus inline, line-anchored comments.

- **Body** — a stat line (🔴/🟡/🔵 counts · files), the summary, a **Concerns**
  section (PR-level callouts not tied to a line), optional **Highlights**, a
  collapsible **Walkthrough** table, an optional Mermaid diagram, and an "Other
  notes" section for findings that couldn't be anchored.
- **Inline comments** — one per `finding`, on the exact diff line. If the model's
  line is a few off (common in agentic mode), loupe **snaps it to the nearest
  commentable line** rather than demoting it to a note, so findings land inline.

## Severities

Findings use `blocker` \| `warning` \| `nit`. Models often emit off-scale values
(`major`, `critical`, `minor`, …); loupe normalizes them and defaults unknowns to
`warning`. Any `blocker` among inline findings makes the verdict
`REQUEST_CHANGES`.
