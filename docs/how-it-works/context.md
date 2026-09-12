# What the agent sees


The agent gets two messages and a working directory. Nothing else. It has no GitHub token and no PR URL.

## Layout

```mermaid
flowchart LR
    subgraph SYS["System prompt: stable per reviewer, prompt-cached"]
        direction TB
        G[Reviewer guidance: prompt or promptFile]
        SK[Skills: SKILL.md bodies]
        CV[Convention docs: CLAUDE.md, AGENTS.md, ...]
        RN[Reasoning note: low / medium / high]
        PD[Profile directive: quiet / chill / assertive]
        AD[Tool directive: agentic or headless]
        OC[Output contract: one JSON object]
    end
    subgraph USR["User message: per PR"]
        direction TB
        ENV[Environment line: date and time]
        CW[cwd note: how repo-relative paths map onto dir]
        TI[PR title and description]
        PI[pathInstructions matching reassessed files]
        FO[Files to reassess, on an incremental run]
        TR[Tree of all in-scope PR files and path to pr.diff]
    end
    subgraph CWD["Working directory"]
        CO[checkout, scoped to dir if set]
        DF["/tmp/loupe-diff-*/pr.diff"]
    end
```

## System prompt, in order

Order matters for caching. Everything here is identical across PRs for a given reviewer, so the provider reuses the cached prefix. `-cache-key loupe/<owner>/<repo>/<reviewer>` names that prefix.

1. **Guidance.** The reviewer's `prompt` or `promptFile`, verbatim. It replaces loupe's default guidance when set.
2. **Skills.** Each path in `skills` is read from the checkout. A directory means its `SKILL.md`. A missing skill logs a warning and is skipped.
3. **Conventions.** Every convention doc that exists at the PR head, concatenated under `# <path>` headers. Fetched via the GitHub API, not the checkout.
4. **Reasoning note.** One sentence, only when `reasoning` is configured. The same value goes to the harness natively.
5. **Profile directive.** Which severities to report.
6. **Tool directive.** Agentic: you have the checkout, read hunks from the diff file on demand, spend the turn budget on callers and contracts first, use subagents only for genuinely parallel work, then stop and emit JSON. Headless (verify pass, retry, chat): no tools, diff is inline.
7. **Output contract.** One JSON object, not wrapped in a code fence: `summary`, `concerns[]`, `highlights[]`, optional `diagram`, `findings[]` with `path`, `line` (new-file line, must be in the diff), `severity`, `body`. `summary`, `detail`, and `body` are GitHub Markdown and may hold paragraphs and fenced code blocks.

## User message

- Environment line with the current date and time in the configured `timezone`.
- When `dir` is set and the harness runs inside it: "Your working directory is `<dir>/` inside the repository. Listed paths are repository-relative; drop the prefix when opening files, report `path` exactly as listed."
- PR title and body.
- `pathInstructions` whose glob matches at least one reassessed file, one bullet each.
- On an incremental run: "Files to reassess", then "the other listed files are context".
- **Agentic:** a tree of every in-scope PR file and the absolute path of `pr.diff`. The diff is not inlined so it is not re-sent on every turn.
- **Headless:** the rendered diff of the reassessed files, `### <path>` then the unified patch.

## What is in the diff file

Every in-scope PR file's current patch, on every run. On an incremental run the prompt narrows the *target* to the reassessed files; the rest is context. See [First run vs later runs](./first-vs-incremental.md).

## What is not there

- No GitHub credentials, PR number, or API access. The agent cannot post or read comments.
- No prior loupe findings. Each run reviews fresh.
- No files outside `dir` when it is set. The working directory is the subdir.
- Severities outside the profile, even if emitted. The filter runs after parsing.

Next: [GitHub objects](./github-objects.md).
