# First run vs later runs


The only state loupe keeps is a SHA inside its own comments. Each reviewer keeps its own.

## Decision

```mermaid
flowchart TD
    S[Start reviewer] --> F{full forced?}
    F -->|"@loupe review or full: true"| FULL
    F -->|no| R[Find newest summary comment by me with loupe:summary:reviewer marker]
    R -->|none| R2[Fallback: newest review body by me with loupe:reviewer marker]
    R2 -->|none| FULL[Full run]
    R -->|sha found| C{"sha equals head?"}
    R2 -->|sha found| C
    C -->|yes| FULL
    C -->|no| CMP[repos.compareCommits sha..head]
    CMP -->|error| FULL
    CMP -->|delta| INC[Incremental run over in-scope delta files]
    INC -->|0 files| KEEP[Post nothing, keep prior comments]
```

The "sha equals head" case happens on `reopened` or `ready_for_review` with no new commits, and on a manual re-run. Treating it as a full run means the review is recomputed and replaced, not skipped.

## First run

```mermaid
sequenceDiagram
    autonumber
    participant GH as GitHub
    participant L as loupe (one reviewer)
    participant W as agent
    GH->>L: pull_request opened, head = A
    L->>GH: listComments, listReviews
    Note over L: no markers → full run over all in-scope files
    L->>W: review 12 files
    W-->>L: 3 findings
    L->>GH: createReview COMMENT + 3 inline (marker sha=A)
    L->>GH: createComment summary (marker summary sha=A)
```

## Second push

```mermaid
sequenceDiagram
    autonumber
    participant GH as GitHub
    participant L as loupe (one reviewer)
    participant W as agent
    GH->>L: pull_request synchronize, head = B
    L->>GH: listComments → summary marker sha=A
    L->>GH: compareCommits A..B → 2 files changed
    Note over L: incremental: review only those 2 files
    L->>W: review 2 files
    W-->>L: 1 finding
    L->>GH: listReviewComments → delete my comments on those 2 files only
    L->>GH: createReview COMMENT + 1 inline (marker sha=B)
    L->>GH: updateComment summary (stats for 2 files, marker sha=B)
```

Comments on the other 10 files from the first run are untouched. GitHub shows them as outdated if their lines moved.

## Push that changes nothing in scope

Head moves to C, `compareCommits B..C` returns only files outside this reviewer's globs. The reviewer logs "keeping prior comments" and makes no writes. The summary still says `sha=B`, so the next push compares from B, not C.

## Forced full run

`@loupe review` calls the same pipeline with `full = true`. Every in-scope file is reviewed, every prior inline comment for this reviewer is deleted, and the summary is rewritten with a fresh stat line.

## Consequences worth knowing

- **The summary stat line reflects the last run only.** After an incremental run over 2 files it says "2 files", not the PR total.
- **A stale `REQUEST_CHANGES` review persists.** Fixing the blocker and pushing yields a new `COMMENT` review. The old request stays until dismissed.
- **Deleting the summary comment resets the reviewer to first-run behavior** on the next push, unless an older review body still carries a marker.
- **N reviewers, N SHAs.** A reviewer whose globs never matched has no summary on the PR, so its first match is a full run.

Next: [@loupe chat](./chat.md).
