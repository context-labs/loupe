# What the agent sees


The agent gets two messages and a working directory. Nothing else. It has no GitHub token and no PR URL.

## Layout

This page expands the **Build context and run agent** box in [A review run](./review-run.md#pipeline).

| Input | Changes per | Contains |
| --- | --- | --- |
| System prompt | reviewer | Guidance, review procedure, skills, conventions, reasoning/profile/tool directives, and the JSON output contract |
| User message | PR or push | PR description, path instructions, reassessment scope, call sites, file tree, and diff location or inline diff |
| Working directory | run | Scoped checkout plus the generated `pr.diff` file |

## System prompt, in order

Order matters for caching. Everything here is identical across PRs for a given reviewer, so the provider reuses the cached prefix. `-cache-key loupe/<owner>/<repo>/<reviewer>` names that prefix.

1. **Guidance.** The reviewer's `prompt` or `promptFile`, verbatim. It replaces loupe's default guidance when set.
2. **Procedure.** Always appended, even under custom guidance: locate and read the callers of every changed export before judging, follow thin wrappers one more hop, treat a newly interactive or blocking call inside a spinner or other terminal-owning wrapper as a defect. `procedure: false` removes it.
3. **Skills.** Each path in `skills` is read from the checkout. A directory means its `SKILL.md`. A missing skill logs a warning and is skipped.
4. **Conventions.** Every convention doc that exists at the PR head, concatenated under `# <path>` headers. Fetched via the GitHub API, not the checkout.
5. **Reasoning note.** One sentence, only when `reasoning` is configured. The same value goes to the harness natively.
6. **Profile directive.** Which severities to report.
7. **Tool directive.** Agentic: you have the checkout, read hunks from the diff file on demand, spend the turn budget on callers and contracts first, use subagents only for genuinely parallel work, then stop and emit JSON. Headless (verify pass, retry, chat): no tools, diff is inline.
8. **Output contract.** One JSON object, not wrapped in a code fence: `summary`, `concerns[]`, `highlights[]`, optional `diagram`, `findings[]` with `path`, `line` (new-file line, must be in the diff), `severity`, `body`. `summary`, `detail`, and `body` are GitHub Markdown and may hold paragraphs and fenced code blocks.

## User message

- Environment line with the current date and time in the configured `timezone`.
- When `dir` names one directory and the harness runs inside it: "Your working directory is `<dir>/` inside the repository. Listed paths are repository-relative; drop the prefix when opening files, report `path` exactly as listed." With several directories the harness runs at the repo root and no note is needed.
- PR title and body.
- `pathInstructions` whose glob matches at least one reassessed file, one bullet each.
- On an incremental run: "Files to reassess", then "the other listed files are context".
- **Call sites of changed exports.** Computed mechanically before the agent starts: every exported value the diff touches (declaration lines, hunk headers, hunk context), its callers in the same package, then the functions enclosing those calls and their callers, up to three hops. Each site carries four lines of preceding context, so a `withProgress(` wrapping the caller is visible in the prompt. Test files, strings, comments, and vendored dirs are skipped. This is what lets a five-turn agent reach a bug three files away from the diff.
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
