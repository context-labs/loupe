import { describe, expect, it, vi } from "vitest";

import { getLastReviewedSha, postReview } from "../src/github";

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
};

function octokit({
  issueComments = [],
  reviewComments = [],
  reviews = [],
  login = "loupe-bot",
}: {
  issueComments?: Comment[];
  reviewComments?: Comment[];
  reviews?: Comment[];
  login?: string;
} = {}) {
  return {
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
      createComment: vi.fn(async () => ({})),
      updateComment: vi.fn(async () => ({})),
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
    await expect(getLastReviewedSha(api as never, ref, "code")).resolves.toBe(
      "e".repeat(40),
    );
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
    await expect(getLastReviewedSha(api as never, ref, "code")).resolves.toBe(
      "e".repeat(40),
    );
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
    await expect(getLastReviewedSha(api as never, ref, "code")).resolves.toBe(
      "f".repeat(40),
    );
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
    await expect(getLastReviewedSha(api as never, ref, "code")).resolves.toBe(
      "1".repeat(40),
    );
  });
});

describe("postReview prior-comment cleanup", () => {
  it("deletes only loupe's own marked comments, never a human quoting the marker", async () => {
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
    });
    expect(api.pulls.deleteReviewComment).toHaveBeenCalledTimes(1);
    expect(api.pulls.deleteReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 1 }),
    );
  });
});
