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
| `reasoning` | no | `low` \| `medium` \| `high`. Passed to the harness natively (whip `defaultEffort` in the materialized `WHIP_HOME`, `claude --effort`, codex `model_reasoning_effort`) and noted in the prompt. Unset = the harness's own default. whip without a `whip` config block keeps its own default effort; only the prompt note applies. |
| `agentic` | no | `false` to run one-shot; omitted = agentic (the default). |
| `profile` | no | Noise profile: `quiet` (blockers) \| `chill` (default) \| `assertive` (all). |
| `verify` | no | `false` to skip the verification pass (default on). |
| `pathInstructions` | no | `[{ glob, instruction }]` extra review instructions for matching files. |
| `ensemble` | no | `["kimi-k3","glm-5.2-fast"]` — run several models, keep findings a majority agree on. |
| `skills` | no | Paths to skill docs (a `SKILL.md` or a skill dir) folded into the reviewer, e.g. `[".agents/skills/i-have-adhd"]` to enforce a terse output style. |
| `priorComments` | no | What happens to this reviewer's earlier inline comments on a re-review: `resolve` (default: resolve the thread, history kept) \| `delete` \| `keep` (leave them, new comments accumulate). Also a top-level default and the `prior-comments` Action input / `--prior-comments` flag. |

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

Load your repo's skill docs into the reviewer. Each entry is a path (relative to
the checkout) to a `SKILL.md` or a skill directory; loupe reads them and folds
them into the system prompt. This is how you enhance the underlying agent harness
with your repo's own skills — the skills live in the **consuming repo**, not in
loupe.

Two scopes:
- **Top-level `skills`** in `.loupe.json` — applied to **every** reviewer.
- **Per-reviewer `skills`** — added on top for one reviewer. `--skills` /
  `LOUPE_SKILLS` add more at the CLI/Action level. All sources are merged.

```json
{
  "skills": [".agents/skills/i-have-adhd"],
  "reviewers": [
    { "name": "code", "promptFile": "reviewers/bugs.md" },
    { "name": "migrations", "promptFile": "reviewers/migrations.md",
      "skills": [".agents/skills/db-safety"] }
  ]
}
```

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
- **Incremental review** — on a re-review, loupe reassesses only the in-scope
  files changed since its last review of the PR. The whole in-scope PR diff is
  still written to disk as context, and the prompt names the files to reassess.
  Findings anchored on other files are dropped (counted in the run details).
  Prior comments are cleaned up only on the reassessed files, per
  `priorComments`. `--full` / `full: true` forces a whole-PR review. If the
  history lookup or compare fails, loupe does a full review and touches no
  prior comment.
- **Run details** — every summary carries a collapsed `Run details` block:
  the review mode (agentic, headless, or fallback), the verification status, the scope, and
  how many findings were dropped as malformed, out of scope, below the noise
  profile, or rejected by verification. The stat line shows `⚠️ degraded run`
  when the review lost something.
- **Reviewer failures are visible** — a reviewer that throws posts a
  `⚠️ loupe · <name> could not complete this review` comment (no marker, no
  SHA) and the job exits 1; the other reviewers still run.

## What a review looks like

loupe posts inline, line-anchored findings as a real GitHub **review** with an
empty body. It separately maintains one summary issue comment per reviewer,
updating that comment in place on every re-review so stale summaries do not
accumulate in the timeline.

- **Summary comment** — a stat line (🔴/🟡/🔵 counts · files), the summary, a
  **Concerns** section (PR-level risks not tied to a line), optional
  **Highlights**, an optional Mermaid diagram (only for a genuinely complex
  flow), and an "Other notes" section for findings that couldn't be anchored.
- **Inline comments** — one per `finding`, on the exact diff line. If the model's
  line is a few off (common in agentic mode), loupe **snaps it to the nearest
  commentable line** rather than demoting it to a note, so findings land inline.

## Severities

Findings use `blocker` \| `warning` \| `nit`. Models often emit off-scale values
(`major`, `critical`, `minor`, …); loupe normalizes them and defaults unknowns to
`warning`. Any `blocker` among inline findings makes the verdict
`REQUEST_CHANGES`.
