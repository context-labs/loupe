# @loupe chat

Any PR comment containing `@loupe` (case-insensitive, word boundary) starts the chat job. Review-thread comments count too. The text after the mention is the instruction.

## Dispatch

```mermaid
flowchart TD
    B[comment body] --> M{contains @loupe?}
    M -->|no| X[ignore]
    M -->|yes| I[instruction = body minus mention]
    I --> H{empty or starts with help}
    H -->|yes| HELP[post help comment]
    H -->|no| R{starts with review}
    R -->|yes| ACK1[post 🔍 ack] --> RV[runReviews full = true]
    RV --> EDIT[edit ack into completion line: head SHA, per-reviewer verdicts]
    R -->|no| F{starts with fix}
    F -->|yes| ACK2[post 🔧 ack] --> FIX[runFix]
    F -->|no| Q[free-form question]
    RV -->|throws| ERR[post ⚠️ failure comment]
    FIX -->|throws| ERR
    Q -->|throws| ERR
```

Question, help, fix, and failure replies are top-level issue comments. The review command updates its ack in place when it finishes, and the review pipeline may resolve or delete this reviewer's prior inline comments according to `priorComments`.

## `@loupe review`

Same pipeline as a push, with `full` forced. See [First run vs later runs](./first-vs-incremental.md#forced-full-run). All configured reviewers run in parallel, then one combined summary is updated in place. When the run finishes the "🔍 On it" ack is edited into a completion line: the head SHA, one verdict per reviewer, and a note when no changed file fell under the config's configured directories. A reviewer that fails is represented in the combined summary and gets its own failure comment; the job exits nonzero.

## `@loupe <question>`

The chat job fetches the PR and its changed files, then makes one headless agent call with the question and full inline diff. The prose answer is posted as a top-level issue comment.

Headless: no tools, no checkout access, whole PR diff inlined regardless of reviewer globs. No reviewer guidance, skills, or conventions are included. The answer is prose, not JSON.

## `@loupe fix` and `@loupe fix <what>`

Bare `@loupe fix` (or `@loupe fix all`) gathers every unresolved inline finding
posted by a configured Loupe reviewer for the current PR head and gives them to
one fixer. `@loupe fix <what>` keeps the targeted-instruction behavior.

The fix path is longer because it can write to the branch:

1. For bare/all fix, collect current unresolved Loupe-owned inline threads; stop if there are none.
2. Post a “🔧 On it” acknowledgement and fetch the PR.
3. Refuse forked PRs, which the Actions token cannot push to.
4. Check out the exact PR head, give one agent all findings (or the explicit instruction) and the changed-file list, and let it edit the checkout.
5. If files changed, commit as loupe. Re-fetch the branch, verify its head is unchanged, then make a normal fast-forward push.
6. Ask the user to run `@loupe review`. The token-authored push does not trigger the review workflow.

- Commit message: `loupe: <first 60 chars of instruction>`. Author `loupe <loupe@users.noreply.github.com>`.
- The push does **not** trigger a new review run. Pushes made with the Actions token do not fire `pull_request` workflows. Ask for `@loupe review` after.
- A push rejected by branch protection posts a comment saying so. The chat job needs `contents: write`.

## Failure comment

Any thrown error after the ack posts:

```
⚠️ I couldn't complete the <review|fix|answer> — <first 500 chars of error>

See the Actions run logs for details.
```

Next: [Configuration](../configuration.md) for every knob, or back to the [index](./README.md).
