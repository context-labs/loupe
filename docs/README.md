# loupe docs

AI pull-request reviewer: inline, line-anchored comments with a
COMMENT / REQUEST_CHANGES verdict. Harness-agnostic, reviews against each repo's
own conventions, runs its focused reviewers agentically by default.

## How it works

Start at [how-it-works/README.md](how-it-works/README.md): triggers, the review pipeline, what the agent sees, the GitHub review and comment objects loupe creates and edits, first vs incremental runs, and `@loupe` chat. Mermaid diagrams throughout.

## User docs

- [Guide](guide.md) — install, run a review locally, CLI flags, dry-run.
- [Configuration](configuration.md) — `.loupe.json` reviewer profiles, model,
  reasoning, agentic mode, custom prompts, conventions.
- [Credentials](credentials.md) — the provider chain and per-harness auth.
- [GitHub Action](github-action.md) — wire loupe into CI, inputs, secrets.
- [Releases & versioning](releases.md) — how to pin/select a version (`@v0` vs a
  pinned tag vs a SHA) and how maintainers cut a release.

## Maintainer docs

- [Architecture](architecture.md) — packages, the review pipeline, key files,
  how to extend (new harness, new credential provider).
