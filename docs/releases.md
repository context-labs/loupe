# Releases & versioning

loupe ships as a **GitHub composite Action that runs from source** — there is no
build artifact or published package. `action.yml` does `bun install` and runs the
TypeScript directly, so **a release is just a git tag.** Consumers reference the
action by a git ref:

```yaml
- uses: context-labs/loupe@v0 # a ref: moving major tag, exact version, or SHA
```

## How consumers select a version

| Ref | Resolves to | Use when |
|-----|-------------|----------|
| `@v0` | the **latest** `v0.x.y` (a moving tag) | internal repos that want fixes automatically — **recommended default** |
| `@v0.10.1` | that **exact** version, forever | you need reproducible, pinned behavior |
| `@<full-sha>` | that exact commit | maximum immutability (a tag can be force-moved; a SHA cannot) |
| `@main` | the tip of `main` | not recommended — unreleased, may break |

GitHub resolves the ref to a commit SHA **when a workflow run starts**. So a run
already in flight keeps the code it started with; the next run after a tag moves
picks up the new code.

### The `@v0` moving-tag tradeoff

`@v0` always points at the newest `v0.x.y`. That means:

- ✅ consumers get bug fixes and features without editing their workflow.
- ⚠️ it is **mutable** — a release force-moves it (see below). There is a
  ~1-minute window where a run that started just before the move finishes on the
  old code. This is expected; it is not a rollback hazard because the action is
  advisory (`continue-on-error`) in every consuming workflow.

If you need runs to be perfectly reproducible, pin an exact version (`@v0.10.1`)
or a SHA instead of `@v0`.

## Cutting a release (maintainers)

Prerequisite: the change is merged to `main` and CI is green.

```bash
git checkout main && git pull

# 1. Tag the exact version (semver; loupe is pre-1.0, so breaking changes bump MINOR).
git tag v0.11.0
git push origin v0.11.0

# 2. Move the major tag so @v0 consumers get it.
git tag -f v0
git push -f origin v0
```

That's the whole release. No build, no publish step — the tag *is* the release,
because the action runs from the checked-out source.

Verify:

```bash
git ls-remote --tags origin | grep -E 'refs/tags/v0$|v0\.11\.0'
# both should point at the same commit
```

### Versioning policy

- **Pre-1.0** (current): the version is `v0.MINOR.PATCH`. Bump **MINOR** for
  features or behavior changes, **PATCH** for fixes. `@v0` tracks all of these.
- **At 1.0**: introduce a `v1` moving tag alongside `v0`; keep `v0` pointing at
  the last `v0.x` so existing consumers don't break. Consumers opt into `v1`
  when ready.

### Don't

- Don't delete a published version tag — someone may have pinned it.
- Don't move `@v0` to a commit that isn't a tagged version; always tag the
  version first, then move `v0` to it, so every state `@v0` has pointed at is
  recoverable by its `v0.x.y` tag.
