# Credentials

The whip daemon holds the model credentials; loupe never sends a model key
itself. loupe's job is to make sure the daemon it attaches to has one.

## Locally

Your own whip login (`whipcode auth inference-net`, stored under
`~/.whipcode`). loupe attaches to your running daemon over its Unix socket, or
starts one, and ignores the config's `whip` block when its `apiKeyEnv` is not
set — so `loupe review` just works and a developer's real `~/.whipcode` is never
modified. Every session still names the block's provider, so its models resolve
even when the daemon's default provider is another; the provider must be
configured in your daemon.

## In CI

The `.loupe.json` `whip` block names the provider and the env var it reads the
key from (`apiKeyEnv`). loupe resolves that variable through the provider
chain, writes the block into a throwaway `WHIPCODE_HOME`, starts a dedicated
daemon there with the key in its environment, and stops it when the run ends.

Set the chain with `--providers` (CLI) or `LOUPE_CREDENTIAL_PROVIDERS` (Action),
comma-separated; the first provider to return the value wins:

| Provider | Reads from |
|---|---|
| `env` | `process.env` (default; works with plain CI secrets). |
| `dotenv` | a `.env` file (missing file is not an error). |
| `infisical` | the Infisical CLI (`infisical secrets get`), with `--infisical-env` / `--infisical-project`. |

Add your own by implementing `CredentialProvider` (`{ name, get(key) }`) from
`@loupe/credentials`.

Resolution is **best-effort**: if no provider supplies the key, loupe logs a
warning and falls back to the local login, and a genuinely missing credential
surfaces as the daemon's own auth error (visible at `LOG_LEVEL=debug`).

The resolved values are also what the review trace scrubs from every payload
before it reaches the Actions step summary; see [Review traces](review-traces.md).
