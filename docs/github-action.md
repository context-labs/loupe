# GitHub Action

`action.yml` is a composite action: it sets up Bun, installs loupe's deps, and
runs the reviewer against the PR. The harness CLI must be installed by the
consuming workflow (it is not bundled).

## Minimal workflow

```yaml
name: loupe
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    paths: ["**"]
permissions:
  contents: read
  pull-requests: write # required to post the review
jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    continue-on-error: true # advisory: never block a PR
    steps:
      - uses: actions/checkout@v4
      - name: Install whip
        run: |
          curl -fsSL -o whip https://github.com/context-labs/whip/releases/download/v0.4.1/whip-linux-x64
          chmod +x whip && sudo mv whip /usr/local/bin/whip
      - uses: context-labs/loupe@v0
        with:
          harness: whip
          model: kimi-k3
          config: .loupe.json
        env:
          INFERENCE_API_KEY: ${{ secrets.INFERENCE_API_KEY }}
```

See `examples/review.example.yml` for whip / claude / custom-prompt
variants. The live monorepo wiring is `inference/.loupe/` + the
`inference--loupe-review.yml` workflow.

## Chat: `@loupe` in PR comments

Add a second job triggered by comment events so people can talk to loupe:

```yaml
on:
  issue_comment: { types: [created] }
  pull_request_review_comment: { types: [created] }
jobs:
  chat:
    if: >-
      github.event.issue.pull_request != null &&
      contains(github.event.comment.body, '@loupe')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: context-labs/loupe@v0
        with: { harness: whip, config: .loupe.json }
        env: { INFERENCE_API_KEY: ${{ secrets.INFERENCE_API_KEY }} }
```

Commands: `@loupe review` (re-review the whole PR), `@loupe fix` (fix all open
Loupe findings in one commit), `@loupe fix <what>` (make a specific change and
push it to the PR branch), `@loupe <question>` (answer grounded
in the diff), `@loupe help`. loupe auto-detects the comment event and switches to
chat mode; a comment without `@loupe` is ignored.

`@loupe fix` needs the chat job to have `permissions: contents: write` (to push)
and only works on same-repo branches, not forks.

## Inputs

`harness`, `model`, `reasoning`, `profile`, `verify`, `full`, `prompt-file`,
`config`, `reviewer`, `dir`, `convention-paths`, `credential-providers`,
`ensemble`, `skills`, `timezone`, `max-turns`, `prior-comments` (default
`resolve`), `cross-reviewer-dedup` (default `true`), `prompt-cache` (default
`true`), `github-token`. Each maps to a `LOUPE_*` env var (see below);
config/prompt paths resolve against `GITHUB_WORKSPACE` (the checkout), not the
action's own directory.

## Env vars

The entrypoint reads only these (parsed in `packages/action/src/config.ts`):
`GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_EVENT_PATH`, `GITHUB_WORKSPACE`,
`LOUPE_PR_NUMBER`, `LOUPE_HARNESS`, `LOUPE_MODEL`, `LOUPE_REASONING`,
`LOUPE_PROMPT_FILE`, `LOUPE_CONFIG`, `LOUPE_REVIEWER`, `LOUPE_DIR`,
`LOUPE_CONVENTION_PATHS`, `LOUPE_CREDENTIAL_PROVIDERS`, `LOUPE_INFISICAL_ENV`,
`LOUPE_INFISICAL_PROJECT_ID`, `LOUPE_PROFILE`, `LOUPE_VERIFY`, `LOUPE_FULL`,
`LOUPE_ENSEMBLE`, `LOUPE_SKILLS`, `LOUPE_TIMEZONE`, `LOUPE_MAX_TURNS`,
`LOUPE_PRIOR_COMMENTS`, `LOUPE_CROSS_REVIEWER_DEDUP`, `LOUPE_PROMPT_CACHE`.
Comment/chat mode is auto-detected from `GITHUB_EVENT_NAME` (`issue_comment` /
`pull_request_review_comment`), which the runner sets.

## Review traces in the step summary

After every reviewer finishes, loupe appends a bounded Markdown **review trace**
to the Actions step summary (`GITHUB_STEP_SUMMARY`) — the reasoning each
reviewer emitted (collapsed), its tool calls/results, reply text, and final
result/error. It is automatic (the action already sets `GITHUB_STEP_SUMMARY`),
offline (no model calls), and writes nothing into the repo. For local
verification, set `GITHUB_STEP_SUMMARY=/tmp/loupe-summary.md`. See
[Review traces](review-traces.md).

## Private-repo action access

To use the private `context-labs/loupe` action from another org repo without
publishing it, set loupe's Actions access to the org:

```bash
gh api -X PUT repos/context-labs/loupe/actions/permissions/access \
  -f access_level=organization
```

## Recommended posture

- **Advisory:** `continue-on-error: true`, not a required check — findings are PR
  comments, never a merge gate.
- **Cadence:** `ready_for_review` + skip drafts + `concurrency: cancel-in-progress`
  so drafts are ignored and rapid pushes collapse to the latest commit.
- **De-dup:** loupe deletes each reviewer's prior comments before re-posting, so
  re-reviews replace rather than accumulate.
## Branching on failure

The action exposes a `status` output so a workflow can detect a failed review
even while `continue-on-error: true` keeps it advisory. Give the step an id and
read `steps.<id>.outputs.status`:

```yaml
- id: loupe-run
  uses: context-labs/loupe@v0
  continue-on-error: true
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
- if: steps.loupe-run.outputs.status == 'quota'
  run: |
    echo "loupe hit a billing/quota limit — ping #billing"
    # e.g. send a Slack alert or open a tracking issue
- if: steps.loupe-run.outputs.status == 'rate-limit'
  run: echo "loupe was throttled; consider requeuing with backoff"
```

`status` is one of `ok | quota | rate-limit | failed`:

- `ok` — review completed and was posted.
- `quota` — the provider rejected the call for a billing reason (HTTP 402,
  insufficient balance, quota exceeded). The one-shot fallback is **not**
  retried for this kind, so it costs one call per reviewer, not two.
- `rate-limit` — the provider throttled the call (HTTP 429, rate limit
  exceeded). Also not retried via the mode-switch fallback.
- `failed` — any other failure (harness crash, transient error, etc.). The
  agentic→one-shot fallback still runs for unclassified errors.
