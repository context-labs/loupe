import { describe, expect, it, vi } from "vitest";

import {
  checkPrOpen,
  checkPublishable,
  cleanupStrandedThreads,
  getLastReviewed,
  listOpenLoupeFindings,
  postReview,
  upsertCombinedSummary,
} from "../src/github";

const ref = { owner: "context-labs", repo: "loupe", pull_number: 13 };
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
};
const output = {
  summary: "Looks good overall.",
  findings: [],
  concerns: [],
  highlights: ["Small change"],
};

type Comment = {
  id: number;
  body?: string | null;
  user?: { login: string };
  path?: string;
};

type Thread = {
  id: string;
  path: string;
  line?: number | null;
  isResolved?: boolean;
  viewerCanResolve?: boolean;
  root?: { body: string; login: string; reply?: boolean; url?: string } | null;
};

function threadNode(t: Thread) {
  return {
    id: t.id,
    path: t.path,
    line: t.line ?? null,
    isResolved: t.isResolved ?? false,
    viewerCanResolve: t.viewerCanResolve ?? true,
    comments: {
      nodes: t.root
        ? [
            {
              body: t.root.body,
              url: t.root.url ?? "https://example.test/thread",
              author: { login: t.root.login },
              replyTo: t.root.reply ? { id: "parent" } : null,
            },
          ]
        : [],
    },
  };
}

function octokit({
  issueComments = [],
  reviewComments = [],
  reviews = [],
  threadPages = [[]],
  login = "loupe-bot",
}: {
  issueComments?: Comment[];
  reviewComments?: Comment[];
  reviews?: Comment[];
  /** Review-thread pages returned by successive GraphQL queries. */
  threadPages?: Thread[][];
  login?: string;
} = {}) {
  let page = 0;
  return {
    graphql: vi.fn(async (query: string, _vars?: Record<string, unknown>) => {
      if (query.includes("resolveReviewThread")) return {};
      const nodes = (threadPages[page] ?? []).map(threadNode);
      const hasNextPage = page < threadPages.length - 1;
      page++;
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: {
                hasNextPage,
                endCursor: hasNextPage ? `c${page}` : null,
              },
              nodes,
            },
          },
        },
      };
    }),
    paginate: vi.fn(async (method: unknown) => {
      if (method === api.issues.listComments) return issueComments;
      if (method === api.pulls.listReviewComments) return reviewComments;
      if (method === api.pulls.listReviews) return reviews;
      return [];
    }),
    users: {
      getAuthenticated: vi.fn(async () => ({ data: { login } })),
    },
    issues: {
      listComments: vi.fn(),
      createComment: vi.fn(async (_input?: { body: string }) => ({})),
      updateComment: vi.fn(async () => ({})),
      deleteComment: vi.fn(async () => ({})),
    },
    pulls: {
      listReviewComments: vi.fn(),
      listReviews: vi.fn(),
      deleteReviewComment: vi.fn(),
      createReview: vi.fn(async () => ({})),
    },
  };
}
let api: ReturnType<typeof octokit>;
const bot = { login: "loupe-bot" };

describe("GitHub review publishing", () => {
  it("creates a persistent summary and an inline-only review", async () => {
    api = octokit();
    await postReview(
      api as never,
      ref,
      output,
      [{ path: "src/a.ts", line: 2, severity: "warning", body: "Check this" }],
      [],
      logger,
      { reviewerName: "code", headSha: "a".repeat(40), fileCount: 1 },
    );

    expect(api.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "",
        comments: [
          expect.objectContaining({
            body: expect.stringContaining("<!-- loupe:code sha="),
          }),
        ],
      }),
    );
    expect(api.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringMatching(
          /Last reviewed commit: \[`aaaaaaa`\]\(https:\/\/github\.com\/context-labs\/loupe\/commit\/a{40}\)[\s\S]*<!-- loupe:summary:code sha=/,
        ),
      }),
    );
  });

  it("updates the matching reviewer's summary in place", async () => {
    api = octokit({
      issueComments: [
        {
          id: 7,
          body: `old\n\n<!-- loupe:summary:code sha=${"b".repeat(40)} -->`,
          user: bot,
        },
        {
          id: 8,
          body: `other\n\n<!-- loupe:summary:security sha=${"c".repeat(40)} -->`,
          user: bot,
        },
      ],
    });
    await postReview(api as never, ref, output, [], [], logger, {
      reviewerName: "code",
      headSha: "d".repeat(40),
      fileCount: 1,
    });

    expect(api.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 7,
        body: expect.stringContaining(
          `Last reviewed commit: [\`ddddddd\`](https://github.com/context-labs/loupe/commit/${"d".repeat(40)})`,
        ),
      }),
    );
    expect(api.issues.createComment).not.toHaveBeenCalled();
    expect(api.pulls.createReview).not.toHaveBeenCalled();
  });

  it("does not update a human comment that quotes the summary marker", async () => {
    api = octokit({
      issueComments: [
        {
          id: 9,
          body: `quoting loupe:\n<!-- loupe:summary:code sha=${"b".repeat(40)} -->`,
          user: { login: "alice" },
        },
      ],
    });
    await postReview(api as never, ref, output, [], [], logger, {
      reviewerName: "code",
      headSha: "d".repeat(40),
      fileCount: 1,
    });

    expect(api.issues.updateComment).not.toHaveBeenCalled();
    expect(api.issues.createComment).toHaveBeenCalled();
  });

  it("posts a marker-only changes-requested review for a blocker concern", async () => {
    api = octokit();
    await postReview(
      api as never,
      ref,
      {
        ...output,
        concerns: [
          {
            severity: "blocker",
            title: "Unsafe migration",
            detail: "This can lock the table.",
          },
        ],
      },
      [],
      [],
      logger,
      { reviewerName: "code", headSha: "e".repeat(40), fileCount: 1 },
    );

    expect(api.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "REQUEST_CHANGES",
        body: expect.stringContaining("<!-- loupe:code sha="),
        comments: [],
      }),
    );
  });
});

describe("getLastReviewedSha", () => {
  it("reads the reviewed SHA from the persistent summary", async () => {
    api = octokit({
      issueComments: [
        {
          id: 7,
          body: `summary\n<!-- loupe:summary:code sha=${"e".repeat(40)} -->`,
          user: bot,
        },
      ],
    });
    await expect(getLastReviewed(api as never, ref, "code")).resolves.toEqual({
      unknown: false,
      sha: "e".repeat(40),
    });
  });

  it("ignores a human summary comment that quotes the marker", async () => {
    api = octokit({
      issueComments: [
        {
          id: 7,
          body: `summary\n<!-- loupe:summary:code sha=${"e".repeat(40)} -->`,
          user: bot,
        },
        {
          id: 8,
          body: `quoting: <!-- loupe:summary:code sha=${"9".repeat(40)} -->`,
          user: { login: "alice" },
        },
      ],
    });
    await expect(getLastReviewed(api as never, ref, "code")).resolves.toEqual({
      unknown: false,
      sha: "e".repeat(40),
    });
  });

  it("falls back to legacy review markers", async () => {
    api = octokit({
      reviews: [
        {
          id: 9,
          body: `legacy\n<!-- loupe:code sha=${"f".repeat(40)} -->`,
          user: bot,
        },
      ],
    });
    await expect(getLastReviewed(api as never, ref, "code")).resolves.toEqual({
      unknown: false,
      sha: "f".repeat(40),
    });
  });

  it("ignores a human review that quotes the marker", async () => {
    api = octokit({
      reviews: [
        {
          id: 9,
          body: `<!-- loupe:code sha=${"1".repeat(40)} -->`,
          user: bot,
        },
        {
          id: 10,
          body: `quoting: <!-- loupe:code sha=${"2".repeat(40)} -->`,
          user: { login: "alice" },
        },
      ],
    });
    await expect(getLastReviewed(api as never, ref, "code")).resolves.toEqual({
      unknown: false,
      sha: "1".repeat(40),
    });
  });
});

describe("postReview prior-comment cleanup", () => {
  it("with delete: removes only loupe's own marked comments, never a human quoting the marker", async () => {
    api = octokit({
      reviewComments: [
        {
          id: 1,
          body: `finding\n\n<!-- loupe:code sha=${"a".repeat(40)} -->`,
          user: bot,
        },
        {
          id: 2,
          body: `this one is real:\n<!-- loupe:code sha=${"a".repeat(40)} -->`,
          user: { login: "alice" },
        },
        { id: 3, body: "unrelated", user: bot },
      ],
    });
    await postReview(api as never, ref, output, [], [], logger, {
      reviewerName: "code",
      headSha: "d".repeat(40),
      fileCount: 1,
      priorComments: "delete",
    });
    expect(api.pulls.deleteReviewComment).toHaveBeenCalledTimes(1);
    expect(api.pulls.deleteReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 1 }),
    );
  });

  it("falls back to github-actions[bot] when the token cannot call GET /user", async () => {
    api = octokit();
    api.users.getAuthenticated.mockRejectedValue(
      new Error("Resource not accessible by integration"),
    );
    api.paginate.mockImplementation(async (method: unknown) => {
      if (method === api.pulls.listReviewComments) {
        return [
          {
            id: 1,
            body: `<!-- loupe:code sha=${"a".repeat(40)} -->`,
            user: { login: "github-actions[bot]" },
          },
          {
            id: 2,
            body: `<!-- loupe:code sha=${"a".repeat(40)} -->`,
            user: { login: "alice" },
          },
        ];
      }
      return [];
    });
    await postReview(api as never, ref, output, [], [], logger, {
      reviewerName: "code",
      headSha: "d".repeat(40),
      fileCount: 1,
      priorComments: "delete",
    });
    expect(api.pulls.deleteReviewComment).toHaveBeenCalledTimes(1);
    expect(api.pulls.deleteReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 1 }),
    );
  });

  it("deletes only after the replacement review and summary are posted", async () => {
    const order: string[] = [];
    api = octokit({
      reviewComments: [
        { id: 1, body: `<!-- loupe:code sha=${"a".repeat(40)} -->`, user: bot },
      ],
    });
    api.pulls.createReview.mockImplementation(async () => {
      order.push("createReview");
      return {};
    });
    api.issues.createComment.mockImplementation(async () => {
      order.push("createComment");
      return {};
    });
    api.pulls.deleteReviewComment.mockImplementation(async () => {
      order.push("delete");
    });
    await postReview(
      api as never,
      ref,
      output,
      [{ path: "src/a.ts", line: 2, severity: "warning", body: "x" }],
      [],
      logger,
      {
        reviewerName: "code",
        headSha: "d".repeat(40),
        fileCount: 1,
        priorComments: "delete",
      },
    );
    expect(order).toEqual(["createReview", "createComment", "delete"]);
  });

  it("with an empty refresh set: cleans up nothing", async () => {
    api = octokit({
      reviewComments: [
        { id: 1, body: `<!-- loupe:code sha=${"a".repeat(40)} -->`, user: bot },
      ],
    });
    await postReview(api as never, ref, output, [], [], logger, {
      reviewerName: "code",
      headSha: "d".repeat(40),
      fileCount: 1,
      priorComments: "delete",
      refreshPaths: new Set(),
    });
    expect(api.pulls.deleteReviewComment).not.toHaveBeenCalled();
    expect(api.graphql).not.toHaveBeenCalled();
    expect(api.issues.createComment).toHaveBeenCalled(); // publishing still happens
  });

  it("with keep: never touches prior comments but still publishes", async () => {
    api = octokit({
      reviewComments: [
        { id: 1, body: `<!-- loupe:code sha=${"a".repeat(40)} -->`, user: bot },
      ],
    });
    await postReview(api as never, ref, output, [], [], logger, {
      reviewerName: "code",
      headSha: "d".repeat(40),
      fileCount: 1,
      priorComments: "keep",
    });
    expect(api.pulls.deleteReviewComment).not.toHaveBeenCalled();
    expect(api.graphql).not.toHaveBeenCalled();
    expect(api.issues.createComment).toHaveBeenCalled();
  });
});

describe("postReview resolve policy (default)", () => {
  const marker = `<!-- loupe:code sha=${"a".repeat(40)} -->`;
  const resolveCalls = () =>
    api.graphql.mock.calls
      .filter(([q]) => (q as string).includes("resolveReviewThread"))
      .map(([, vars]) => (vars as { threadId: string }).threadId);

  it("resolves only loupe-rooted threads with this reviewer's marker on refreshed paths, across pages", async () => {
    api = octokit({
      threadPages: [
        [
          {
            id: "t-mine",
            path: "src/a.ts",
            root: { body: `x ${marker}`, login: "loupe-bot" },
          },
          {
            id: "t-other-reviewer",
            path: "src/a.ts",
            root: {
              body: "<!-- loupe:docs sha=aaaaaaa -->",
              login: "loupe-bot",
            },
          },
          {
            id: "t-human",
            path: "src/a.ts",
            root: { body: `quote ${marker}`, login: "alice" },
          },
          {
            id: "t-resolved",
            path: "src/a.ts",
            isResolved: true,
            root: { body: marker, login: "loupe-bot" },
          },
          {
            id: "t-denied",
            path: "src/a.ts",
            viewerCanResolve: false,
            root: { body: marker, login: "loupe-bot" },
          },
          {
            id: "t-reply-root",
            path: "src/a.ts",
            root: { body: marker, login: "loupe-bot", reply: true },
          },
          {
            id: "t-off-path",
            path: "src/z.ts",
            root: { body: marker, login: "loupe-bot" },
          },
        ],
        [
          {
            id: "t-page2",
            path: "src/b.ts",
            root: { body: marker, login: "loupe-bot" },
          },
        ],
      ],
    });
    await postReview(api as never, ref, output, [], [], logger, {
      reviewerName: "code",
      headSha: "d".repeat(40),
      fileCount: 2,
      refreshPaths: new Set(["src/a.ts", "src/b.ts"]),
    });
    expect(resolveCalls()).toEqual(["t-mine", "t-page2"]);
    expect(api.pulls.deleteReviewComment).not.toHaveBeenCalled();
  });

  it("a failed resolution does not stop the next one, and never falls back to delete", async () => {
    api = octokit({
      threadPages: [
        [
          {
            id: "t1",
            path: "src/a.ts",
            root: { body: marker, login: "loupe-bot" },
          },
          {
            id: "t2",
            path: "src/a.ts",
            root: { body: marker, login: "loupe-bot" },
          },
        ],
      ],
    });
    const base = api.graphql.getMockImplementation()!;
    api.graphql.mockImplementation(
      async (q: string, vars?: Record<string, unknown>) => {
        if (q.includes("resolveReviewThread") && vars?.["threadId"] === "t1") {
          throw new Error("boom");
        }
        return base(q, vars);
      },
    );
    await postReview(api as never, ref, output, [], [], logger, {
      reviewerName: "code",
      headSha: "d".repeat(40),
      fileCount: 1,
    });
    expect(resolveCalls()).toEqual(["t1", "t2"]);
    expect(api.pulls.deleteReviewComment).not.toHaveBeenCalled();
  });

  it("a failed thread lookup leaves everything in place and still publishes", async () => {
    api = octokit();
    api.graphql.mockRejectedValue(new Error("graphql down"));
    await postReview(api as never, ref, output, [], [], logger, {
      reviewerName: "code",
      headSha: "d".repeat(40),
      fileCount: 1,
    });
    expect(api.issues.createComment).toHaveBeenCalled();
  });
});

describe("getLastReviewed failure", () => {
  it("reports unknown, not 'no prior review', when the lookup throws", async () => {
    api = octokit();
    api.paginate.mockRejectedValue(new Error("rate limited"));
    await expect(getLastReviewed(api as never, ref, "code")).resolves.toEqual({
      unknown: true,
      reason: "rate limited",
    });
  });
});

describe("summary rendering", () => {
  it("renders Markdown note bodies as blocks and flags a degraded run", async () => {
    api = octokit();
    await postReview(
      api as never,
      ref,
      output,
      [],
      [
        {
          path: "src/a.ts",
          line: 99,
          severity: "warning",
          body: "Para one.\n\n```ts\nx();\n```",
        },
      ],
      logger,
      {
        reviewerName: "code",
        headSha: "d".repeat(40),
        fileCount: 1,
        diagnostics: {
          mode: "fallback",
          verify: "invalid",
          incremental: "unknown",
          malformedDropped: { findings: 1, concerns: 0 },
          outOfScopeDropped: 0,
          profileDropped: 0,
          verifyDropped: 0,
          crossReviewerDropped: 0,
          offDiff: 1,
          salvagedFindings: 0,
          degradedLegs: [],
        },
      },
    );
    const body = (
      api.issues.createComment.mock.calls[0]![0] as { body: string }
    ).body;
    expect(body).toContain("⚠️ degraded run");
    expect(body).toContain("Para one.\n\n```ts\nx();\n```");
    expect(body).toContain("<summary>Run details</summary>");
    expect(body).toContain("headless fallback");
  });

  it("renders a salvaged note with no line as a bare path, capped and flagged", async () => {
    api = octokit();
    await postReview(
      api as never,
      ref,
      output,
      [],
      [{ path: "src/a.ts", severity: "warning", body: "Race on retry." }],
      logger,
      {
        reviewerName: "code",
        headSha: "d".repeat(40),
        fileCount: 1,
        diagnostics: {
          mode: "agentic",
          verify: "skipped",
          incremental: "full",
          malformedDropped: { findings: 0, concerns: 0 },
          outOfScopeDropped: 0,
          profileDropped: 0,
          verifyDropped: 0,
          crossReviewerDropped: 0,
          offDiff: 1,
          salvagedFindings: 1,
          degradedLegs: [],
        },
      },
    );
    const body = (
      api.issues.createComment.mock.calls[0]![0] as { body: string }
    ).body;
    expect(body).toContain("<summary>Other notes (1)</summary>");
    expect(body).toContain("`src/a.ts`");
    expect(body).toContain("_unanchored_");
    expect(body).not.toContain("undefined");
    expect(body).toContain("1 salvaged from malformed finding(s)");
    // Salvage is lossy parse, so the run is flagged degraded even with zero
    // genuinely-malformed findings.
    expect(body).toContain("⚠️ degraded run");
  });
});

describe("open Loupe findings", () => {
  it("collects unresolved findings from configured reviewers across incremental heads", async () => {
    const sha = "a".repeat(40);
    api = octokit({
      threadPages: [
        [
          {
            id: "current",
            path: "src/a.ts",
            line: 12,
            root: {
              body: `🟡 **warning** fix this\n\n<!-- loupe:code sha=${sha} -->`,
              login: "loupe-bot",
            },
          },
          {
            id: "resolved",
            path: "src/b.ts",
            isResolved: true,
            root: {
              body: `old\n\n<!-- loupe:code sha=${sha} -->`,
              login: "loupe-bot",
            },
          },
          {
            id: "human",
            path: "src/c.ts",
            root: {
              body: `quoted <!-- loupe:code sha=${sha} -->`,
              login: "human",
            },
          },
          {
            id: "stale",
            path: "src/d.ts",
            root: {
              body: `stale\n\n<!-- loupe:code sha=${"b".repeat(40)} -->`,
              login: "loupe-bot",
            },
          },
        ],
      ],
    });

    await expect(
      listOpenLoupeFindings(api as never, ref, sha, new Set(["code"])),
    ).resolves.toEqual([
      {
        reviewer: "code",
        path: "src/a.ts",
        line: 12,
        body: "🟡 **warning** fix this",
        sha,
        url: "https://example.test/thread",
      },
      {
        reviewer: "code",
        path: "src/d.ts",
        body: "stale",
        sha: "b".repeat(40),
        url: "https://example.test/thread",
      },
    ]);
  });
});

describe("combined summary", () => {
  it("preserves a skipped reviewer's previous section", async () => {
    const sha = "a".repeat(40);
    api = octokit({
      issueComments: [
        {
          id: 2,
          body: `# Loupe\n\n---\n\n## code\n\nPrevious findings\n\n---\n\nStill part of code review\n\n<!-- loupe:summary:code sha=${sha} -->\n\n---\n\nUse fix\n\n<!-- loupe:summary:combined -->`,
          user: bot,
        },
      ],
    });
    await upsertCombinedSummary(
      api as never,
      ref,
      "# Loupe\n\n---\n\n## code\n\n_Not run: No in-scope changes since the last review._\n\n---\n\nUse fix",
    );
    const update = api.issues.updateComment.mock.calls[0] as unknown as [
      { body: string },
    ];
    const body = update[0].body;
    expect(body).toContain("Previous findings");
    expect(body).toContain("Still part of code review");
    expect(body).toContain("Not updated in this run");
    expect(body).toContain(`<!-- loupe:summary:code sha=${sha} -->`);
    expect(body).not.toContain("_Not run:");
  });

  it("preserves a skipped reviewer previous section when the skip is a freshness Skipped stub (head moved)", async () => {
    const sha = "a".repeat(40);
    api = octokit({
      issueComments: [
        {
          id: 2,
          body: `# Loupe

---

## code

Previous findings

---

Still part of code review

<!-- loupe:summary:code sha=${sha} -->

---

Use fix

<!-- loupe:summary:combined -->`,
          user: bot,
        },
      ],
    });
    // A head-moved freshness skip renders a Skipped stub with no SHA marker and
    // no summaryBody. The PR is still open (head-moved != merged/closed), so the
    // summary gate lets upsert run; this stub must be restored from the prior
    // section rather than wiping the reviewer previous findings.
    await upsertCombinedSummary(
      api as never,
      ref,
      "# Loupe\n\n---\n\n## code\n\n⏸️ Skipped: the PR head moved before loupe could publish. Findings were computed but not posted.\n\n---\n\nUse fix",
    );
    const update = api.issues.updateComment.mock.calls[0] as unknown as [
      { body: string },
    ];
    const body = update[0].body;
    expect(body).toContain("Previous findings");
    expect(body).toContain("Still part of code review");
    expect(body).toContain("Not updated in this run");
    expect(body).toContain(`<!-- loupe:summary:code sha=${sha} -->`);
    expect(body).not.toContain("Skipped:");
  });

  it("restores a marked skipped section inside exactly one boundary pair", async () => {
    const sha = "a".repeat(40);
    api = octokit({
      issueComments: [
        {
          id: 2,
          body: `# Loupe\n\n---\n\n<!-- loupe:section:code:start -->\n## code\n\nPrevious findings\n\n<!-- loupe:summary:code sha=${sha} -->\n<!-- loupe:section:code:end -->\n\n---\n\n<!-- loupe:section:security:start -->\n## security\n\nSecurity details\n\n<!-- loupe:summary:security sha=${sha} -->\n<!-- loupe:section:security:end -->\n\n---\n\nUse \`@loupe fix\`\n\n<!-- loupe:summary:combined -->`,
          user: bot,
        },
      ],
    });
    await upsertCombinedSummary(
      api as never,
      ref,
      `# Loupe\n\n---\n\n<!-- loupe:section:code:start -->\n## code\n\n_Not run: No changes._\n<!-- loupe:section:code:end -->\n\n---\n\n<!-- loupe:section:security:start -->\n## security\n\nNew security result\n\n<!-- loupe:summary:security sha=${sha} -->\n<!-- loupe:section:security:end -->\n\n---\n\nUse \`@loupe fix\``,
    );
    const update = api.issues.updateComment.mock.calls[0] as unknown as [
      { body: string },
    ];
    const updated = update[0].body;
    expect(updated).toContain("Previous findings");
    expect(updated).toContain("New security result");
    expect(updated).not.toContain("Security details");
    expect(updated.match(/loupe:section:code:start/g)).toHaveLength(1);
    expect(updated.match(/loupe:section:code:end/g)).toHaveLength(1);
    expect(updated).not.toContain("_Not run: No changes._");
  });

  it("does not let a retained marker swallow later reviewer sections", async () => {
    const sha = "a".repeat(40);
    api = octokit({
      issueComments: [
        {
          id: 2,
          body: `# Loupe\n\n---\n\n## code\n\nNo marker in this section\n\n---\n\n## security\n\nSecurity details\n\n<!-- loupe:summary:security sha=${sha} -->\n\n---\n\nUse \`@loupe fix\`\n\n<!-- loupe:summary:code sha=${sha} -->\n\n<!-- loupe:summary:combined -->`,
          user: bot,
        },
      ],
    });
    await upsertCombinedSummary(
      api as never,
      ref,
      "# Loupe\n\n---\n\n## code\n\n_Not run: No changes._\n\n---\n\nUse `@loupe fix`",
    );
    const update = api.issues.updateComment.mock.calls[0] as unknown as [
      { body: string },
    ];
    expect(update[0].body).toContain("_Not run: No changes._");
    expect(update[0].body).not.toContain("Security details");
  });

  it("marks legacy summaries stale without deleting them", async () => {
    api = octokit({
      issueComments: [
        {
          id: 3,
          body: `legacy\n\n<!-- loupe:summary:code sha=${"a".repeat(40)} -->`,
          user: bot,
        },
      ],
    });
    await upsertCombinedSummary(api as never, ref, "# New summary");
    expect(api.issues.deleteComment).not.toHaveBeenCalled();
    expect(api.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 3,
        body: expect.stringContaining("<!-- loupe:summary:stale -->"),
      }),
    );
  });

  it("updates only the bot-authored combined summary", async () => {
    api = octokit({
      issueComments: [
        {
          id: 1,
          body: "quoted <!-- loupe:summary:combined -->",
          user: { login: "human" },
        },
        { id: 2, body: "old <!-- loupe:summary:combined -->", user: bot },
      ],
    });
    await upsertCombinedSummary(api as never, ref, "# New summary");
    expect(api.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 2,
        body: expect.stringContaining("# New summary"),
      }),
    );
    expect(api.issues.createComment).not.toHaveBeenCalled();
  });
});

describe("stranded-thread cleanup", () => {
  const marker = `<!-- loupe:code sha=${"a".repeat(40)} -->`;
  const resolveCalls = () =>
    api.graphql.mock.calls
      .filter(([q]) => (q as string).includes("resolveReviewThread"))
      .map(([, vars]) => (vars as { threadId: string }).threadId);

  it("sweeps a thread stranded at a renamed file's old path, even out of scope", async () => {
    // src/old.ts was renamed to src/new.ts, which is outside this reviewer's
    // refresh scope. The thread at the vanished old path must still be swept.
    api = octokit({
      threadPages: [
        [
          {
            id: "t-stranded",
            path: "src/old.ts",
            root: { body: marker, login: "loupe-bot" },
          },
          {
            id: "t-alive",
            path: "src/a.ts",
            root: { body: marker, login: "loupe-bot" },
          },
        ],
      ],
    });
    await postReview(api as never, ref, output, [], [], logger, {
      reviewerName: "code",
      headSha: "d".repeat(40),
      fileCount: 1,
      refreshPaths: new Set(["src/a.ts"]),
      headPaths: new Set(["src/new.ts", "src/a.ts"]),
    });
    expect(resolveCalls()).toEqual(["t-stranded", "t-alive"]);
  });

  it("does not sweep threads on paths that still exist at head", async () => {
    api = octokit({
      threadPages: [
        [
          {
            id: "t-off-scope",
            path: "src/z.ts",
            root: { body: marker, login: "loupe-bot" },
          },
        ],
      ],
    });
    await postReview(api as never, ref, output, [], [], logger, {
      reviewerName: "code",
      headSha: "d".repeat(40),
      fileCount: 1,
      refreshPaths: new Set(["src/a.ts"]),
      headPaths: new Set(["src/z.ts", "src/a.ts"]),
    });
    expect(resolveCalls()).toEqual([]);
  });

  it("cleanupStrandedThreads resolves only stranded threads when nothing is reassessed", async () => {
    api = octokit({
      threadPages: [
        [
          {
            id: "t-stranded",
            path: "gone.ts",
            root: { body: marker, login: "loupe-bot" },
          },
          {
            id: "t-alive",
            path: "kept.ts",
            root: { body: marker, login: "loupe-bot" },
          },
        ],
      ],
    });
    await cleanupStrandedThreads(
      api as never,
      ref,
      new Set(["kept.ts"]),
      logger,
      {
        reviewerName: "code",
      },
    );
    expect(resolveCalls()).toEqual(["t-stranded"]);
  });
});

/** A minimal Octokit whose only call is `pulls.get`; enough for checkPublishable. */
function pullOctokit(pr: { merged?: boolean; state?: string; head: string }) {
  return {
    pulls: {
      get: vi.fn(async () => ({ data: { ...pr, head: { sha: pr.head } } })),
    },
  };
}

describe("checkPublishable", () => {
  const HEAD = "0".repeat(40);

  it("is publishable for an open, unmerged PR at the reviewed head", async () => {
    const api = pullOctokit({ state: "open", head: HEAD });
    await expect(checkPublishable(api as never, ref, HEAD)).resolves.toEqual({
      publishable: true,
    });
    expect(api.pulls.get).toHaveBeenCalledWith(ref);
  });

  it("is not publishable when the PR has merged", async () => {
    const api = pullOctokit({ state: "closed", merged: true, head: HEAD });
    await expect(checkPublishable(api as never, ref, HEAD)).resolves.toEqual({
      publishable: false,
      reason: "merged",
    });
  });

  it("is not publishable when the PR is closed but not merged", async () => {
    const api = pullOctokit({ state: "closed", merged: false, head: HEAD });
    await expect(checkPublishable(api as never, ref, HEAD)).resolves.toEqual({
      publishable: false,
      reason: "closed",
    });
  });

  it("is not publishable when the head has moved since the review started", async () => {
    const api = pullOctokit({ state: "open", head: "1".repeat(40) });
    await expect(checkPublishable(api as never, ref, HEAD)).resolves.toEqual({
      publishable: false,
      reason: "head-moved",
    });
  });

  it("checks merged before head movement, so a merged PR reports merged", async () => {
    const api = pullOctokit({
      state: "closed",
      merged: true,
      head: "1".repeat(40),
    });
    await expect(checkPublishable(api as never, ref, HEAD)).resolves.toEqual({
      publishable: false,
      reason: "merged",
    });
  });
});

describe("checkPrOpen", () => {
  const HEAD = "0".repeat(40);

  it("is open for an unmerged, open PR (and ignores the head)", async () => {
    const api = pullOctokit({
      state: "open",
      merged: false,
      head: "1".repeat(40),
    });
    await expect(checkPrOpen(api as never, ref)).resolves.toEqual({
      open: true,
    });
  });

  it("is not open when the PR has merged", async () => {
    const api = pullOctokit({
      state: "closed",
      merged: true,
      head: HEAD,
    });
    await expect(checkPrOpen(api as never, ref)).resolves.toEqual({
      open: false,
      reason: "merged",
    });
  });

  it("is not open when the PR was closed but not merged", async () => {
    const api = pullOctokit({
      state: "closed",
      merged: false,
      head: HEAD,
    });
    await expect(checkPrOpen(api as never, ref)).resolves.toEqual({
      open: false,
      reason: "closed",
    });
  });

  it("does not skip on a head move: a moved-but-open PR stays open", async () => {
    const api = pullOctokit({
      state: "open",
      merged: false,
      head: "2".repeat(40),
    });
    await expect(checkPrOpen(api as never, ref)).resolves.toEqual({
      open: true,
    });
  });
});
