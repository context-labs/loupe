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

See `.github/workflows/review.example.yml` for whip / claude / custom-prompt
variants. The live monorepo wiring is `inference/.loupe/` + the
`inference--loupe-review.yml` workflow.

## Inputs

`harness`, `model`, `reasoning`, `prompt-file`, `config`, `reviewer`, `dir`,
`convention-paths`, `credential-providers`, `github-token`. Each maps to a
`LOUPE_*` env var (see below); config/prompt paths resolve against
`GITHUB_WORKSPACE` (the checkout), not the action's own directory.

## Env vars

The entrypoint reads only these (parsed in `packages/action/src/config.ts`):
`GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_EVENT_PATH`, `GITHUB_WORKSPACE`,
`LOUPE_PR_NUMBER`, `LOUPE_HARNESS`, `LOUPE_MODEL`, `LOUPE_REASONING`,
`LOUPE_PROMPT_FILE`, `LOUPE_CONFIG`, `LOUPE_REVIEWER`, `LOUPE_DIR`,
`LOUPE_CONVENTION_PATHS`, `LOUPE_CREDENTIAL_PROVIDERS`, `LOUPE_INFISICAL_ENV`,
`LOUPE_INFISICAL_PROJECT_ID`.

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
