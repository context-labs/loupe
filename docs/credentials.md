# Credentials

loupe resolves the secrets a harness needs through an ordered **provider chain**;
the first provider to return a value for a key wins. Resolved values are injected
into the harness subprocess env.

## Providers

Set the chain with `--providers` (CLI) or `LOUPE_CREDENTIAL_PROVIDERS` (Action),
comma-separated:

| Provider | Reads from |
|---|---|
| `env` | `process.env` (default; works with plain CI secrets). |
| `dotenv` | a `.env` file (missing file is not an error). |
| `infisical` | the Infisical CLI (`infisical secrets get`), with `--infisical-env` / `--infisical-project`. |

Add your own by implementing `CredentialProvider` (`{ name, get(key) }`) from
`@loupe/credentials`.

## Per-harness auth

Each harness declares `credentialKeys` — the env vars it wants forwarded:

| Harness | Keys | Notes |
|---|---|---|
| `whip` | (none) | Self-authenticates. Reads `INFERENCE_API_KEY` if present, else its own local login (`~/.whip`). inference.net is its built-in default provider. |
| `claude` | `ANTHROPIC_API_KEY` | Falls back to the local `claude` login if the key is absent. |
| `codex` | `OPENAI_API_KEY` | — |

Resolution is **best-effort**: loupe forwards whatever keys the chain can supply
and does not hard-fail on a missing one — a locally-logged-in harness self-auths,
and a genuinely missing key surfaces as the harness's own auth error (visible at
`LOG_LEVEL=debug`).

## In CI

The harness runs on the runner, so its key must reach the job env. With whip +
inference.net, expose `INFERENCE_API_KEY` to the job (e.g. via Infisical) and the
`env` provider forwards it. See [github-action.md](github-action.md).

## Repo-supplied provider block (`.loupe.json` `whip`)

`.loupe.json` is read from the checked-out PR head, so on a fork/untrusted PR
the `whip.provider` block is attacker-controlled. It selects where model traffic
goes (`baseUrl`) and which env var's value is sent as the credential
(`apiKeyEnv`), so it is constrained:

- `baseUrl` must be an `https:` URL.
- Host allow-list — env `LOUPE_ALLOWED_PROVIDER_HOSTS` (comma-separated, Action
  only). **Set** → the `baseUrl` host must be a member or the run fails.
  **Unset/empty** → any host is allowed but a warning is logged. Opt-in so
  existing deployments keep working; set it on repos that accept fork PRs.
- `apiKeyEnv` must be an env-var name and may not name a job-infrastructure
  secret (`GITHUB_*`, `GH_*`, `ACTIONS_*`, `RUNNER_*`, `AWS_*`, `AZURE_*`,
  `GOOGLE_*`, `GCP_*`, `INFISICAL_*`, `LOUPE_*`) — those are present in the job
  env but are never a provider key, and naming one would send it to `baseUrl`.

The local CLI does not apply these (its config is the operator's own, not an
untrusted PR).
