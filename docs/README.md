# loupe docs

AI pull-request reviewer: inline, line-anchored comments with a
COMMENT / REQUEST_CHANGES verdict. Harness-agnostic, reviews against each repo's
own conventions, runs its focused reviewers agentically by default.

## User docs

- [Guide](guide.md) — install, run a review locally, CLI flags, dry-run.
- [Configuration](configuration.md) — `.loupe.json` reviewer profiles, model,
  reasoning, agentic mode, custom prompts, conventions.
- [Credentials](credentials.md) — the provider chain and per-harness auth.
- [GitHub Action](github-action.md) — wire loupe into CI, inputs, secrets.

## Maintainer docs

- [Architecture](architecture.md) — packages, the review pipeline, key files,
  how to extend (new harness, new credential provider).
