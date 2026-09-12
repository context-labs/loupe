import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Harness, HarnessContext } from "@loupe/harness";
import { describe, expect, it, vi } from "vitest";

import { runReview, type ReviewRequest } from "../src/index";

const ref = { owner: "acme", repo: "app", pull_number: 7 };
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
};
logger.child.mockReturnValue(logger);

const patchA =
  "@@ -1,2 +1,3 @@\n line\n+export async function selectThing() {}\n line2";
const patchB = "@@ -10,2 +10,3 @@\n line\n+changed in B\n line2";
const prFiles = [
  { filename: "svc/a.ts", patch: patchA },
  { filename: "svc/b.ts", patch: patchB },
];
const marker = `<!-- loupe:code sha=${SHA_A} -->`;

/** A checkout with the `svc` subdir so the review runs in tree mode. */
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "loupe-e2e-"));
  mkdirSync(join(dir, "svc", "cmd"), { recursive: true });
  writeFileSync(join(dir, "svc", "package.json"), "{}");
  writeFileSync(
    join(dir, "svc", "cmd", "run.ts"),
    "await withProgress(() => selectThing());\n",
  );
  return dir;
}

type FakeGitHub = {
  /** Summary comment carrying the last-reviewed marker, if any. */
  priorSummarySha?: string;
  /** Files GitHub reports changed between prior and head. */
  compare?: string[] | Error;
  /** Review threads on the PR, one per path, rooted by loupe with the marker. */
  threads?: string[];
  /** Makes the FIRST issue-comment listing throw (the history lookup). */
  listCommentsError?: Error;
};

function fakeOctokit(gh: FakeGitHub) {
  const calls: string[] = [];
  const graphql = vi.fn(
    async (query: string, vars?: Record<string, unknown>) => {
      if (query.includes("resolveReviewThread")) {
        calls.push(`resolve:${String(vars?.["threadId"])}`);
        return {};
      }
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: (gh.threads ?? []).map((path) => ({
                id: `thread:${path}`,
                path,
                isResolved: false,
                viewerCanResolve: true,
                comments: {
                  nodes: [
                    {
                      body: `old ${marker}`,
                      author: { login: "bot" },
                      replyTo: null,
                    },
                  ],
                },
              })),
            },
          },
        },
      };
    },
  );
  const api = {
    graphql,
    users: {
      getAuthenticated: vi.fn(async () => ({ data: { login: "bot" } })),
    },
    pulls: {
      get: vi.fn(async () => ({
        data: { title: "Change A and B", body: "desc", head: { sha: SHA_B } },
      })),
      listFiles: vi.fn(),
      listReviews: vi.fn(),
      listReviewComments: vi.fn(),
      createReview: vi.fn(async () => {
        calls.push("createReview");
        return {};
      }),
      deleteReviewComment: vi.fn(),
    },
    issues: {
      listComments: vi.fn(),
      createComment: vi.fn(async (_input: { body: string }) => {
        calls.push("createComment");
        return {};
      }),
      updateComment: vi.fn(async (_input: { body: string }) => {
        calls.push("updateComment");
        return {};
      }),
    },
    repos: {
      getContent: vi.fn(async () => {
        throw new Error("404");
      }),
      compareCommits: vi.fn(async () => {
        if (gh.compare instanceof Error) throw gh.compare;
        return {
          data: { files: (gh.compare ?? []).map((filename) => ({ filename })) },
        };
      }),
    },
    paginate: vi.fn(async (method: unknown) => {
      if (method === api.pulls.listFiles) return prFiles;
      if (method === api.issues.listComments) {
        if (gh.listCommentsError) {
          const err = gh.listCommentsError;
          gh.listCommentsError = undefined;
          throw err;
        }
        return gh.priorSummarySha
          ? [
              {
                id: 1,
                user: { login: "bot" },
                body: `### summary\n\n<!-- loupe:summary:code sha=${gh.priorSummarySha} -->`,
              },
            ]
          : [];
      }
      return [];
    }),
    calls,
  };
  return api;
}

/**
 * A harness that records every prompt and answers from a script keyed by
 * prompt kind: the agentic review, the headless retry, and the verify pass.
 */
function fakeHarness(script: {
  agentic: string | Error;
  headless?: string;
  verify?: string;
}) {
  const contexts: HarnessContext[] = [];
  const harness: Harness = {
    name: "fake",
    credentialKeys: [],
    available: async () => true,
    review: async (ctx) => {
      contexts.push(ctx);
      if (ctx.systemPrompt.startsWith("You are a strict reviewer verifying")) {
        return script.verify ?? "";
      }
      if (ctx.agentic) {
        if (script.agentic instanceof Error) throw script.agentic;
        return script.agentic;
      }
      return script.headless ?? "";
    },
  };
  return { harness, contexts };
}

function request(
  api: ReturnType<typeof fakeOctokit>,
  harness: Harness,
  workdir: string,
  extra: Partial<ReviewRequest> = {},
): ReviewRequest {
  return {
    octokit: api as never,
    ref,
    harness,
    workdir,
    harnessEnv: {},
    conventionPaths: ["AGENTS.md"],
    subdir: "svc",
    reviewerName: "code",
    logger,
    ...extra,
  };
}

const reviewJson = (findings: object[]) =>
  JSON.stringify({
    summary: "reviewed",
    findings,
    concerns: [],
    highlights: [],
  });
const verifyAll = (n: number) =>
  JSON.stringify({
    verdicts: Array.from({ length: n }, (_, i) => ({ index: i, real: true })),
  });

describe("runReview end to end", () => {
  it("incremental run: whole in-scope diff on disk, only B reassessed, A findings dropped, cleanup scoped to B after posting", async () => {
    const api = fakeOctokit({
      priorSummarySha: SHA_A,
      compare: ["svc/b.ts"],
      threads: ["svc/a.ts", "svc/b.ts"],
    });
    const { harness, contexts } = fakeHarness({
      agentic: reviewJson([
        { path: "svc/b.ts", line: 11, severity: "warning", body: "B is wrong" },
        { path: "svc/a.ts", line: 2, severity: "warning", body: "A is wrong" },
      ]),
      verify: verifyAll(1),
    });
    const workdir = checkout();

    const result = await runReview(request(api, harness, workdir));

    // The agent ran in the subdir and saw: the whole in-scope diff on disk,
    // a tree of both files, a focus list naming only B, and the cwd mapping.
    const agenticCtx = contexts[0]!;
    expect(agenticCtx.agentic).toBe(true);
    expect(agenticCtx.workdir).toBe(join(workdir, "svc"));
    const diffPath = /`(\/[^`]*pr\.diff)`/.exec(agenticCtx.userPrompt)?.[1];
    expect(diffPath !== undefined && existsSync(diffPath)).toBe(true);
    const diskDiff = readFileSync(diffPath!, "utf8");
    expect(diskDiff).toContain("### svc/a.ts");
    expect(diskDiff).toContain("### svc/b.ts");
    const focus = /Files to reassess[^]*?\n\n/.exec(agenticCtx.userPrompt)![0];
    expect(focus).toContain("- svc/b.ts");
    expect(focus).not.toContain("- svc/a.ts");
    expect(agenticCtx.userPrompt).toContain("- svc/a.ts (+1 −0)");
    expect(agenticCtx.userPrompt).toContain("Your working directory is `svc/`");
    // Callers of the changed export were located mechanically and rendered
    // with repo-relative paths.
    expect(agenticCtx.userPrompt).toContain("Call sites of changed exports");
    expect(agenticCtx.userPrompt).toContain(
      "- svc/cmd/run.ts:1  await withProgress(() => selectThing());",
    );
    expect(agenticCtx.userPrompt).toContain(
      "`selectThing` (changed in this diff) is called from:",
    );
    expect(agenticCtx.systemPrompt).toContain("Procedure — do these before");

    // The verify pass ran headless over the one in-scope finding.
    expect(contexts[1]!.agentic).toBe(false);
    expect(contexts[1]!.userPrompt).toContain("#0 [warning] svc/b.ts:11");
    expect(contexts[1]!.userPrompt).not.toContain("A is wrong");

    // Only B's finding posted; A's was dropped as out of scope.
    expect(result.inline.map((f) => `${f.path}:${f.line}`)).toEqual([
      "svc/b.ts:11",
    ]);
    expect(result.diagnostics).toEqual({
      mode: "agentic",
      verify: "passed",
      incremental: "delta",
      malformedDropped: { findings: 0, concerns: 0 },
      outOfScopeDropped: 1,
      profileDropped: 0,
      verifyDropped: 0,
      offDiff: 0,
    });

    // Only B's prior thread resolved, and only after review + summary posted.
    expect(api.calls).toEqual([
      "createReview",
      "updateComment",
      "resolve:thread:svc/b.ts",
    ]);
    expect(api.pulls.deleteReviewComment).not.toHaveBeenCalled();
    const summary = api.issues.updateComment.mock.calls[0]![0]!.body;
    expect(summary).toContain(`<!-- loupe:summary:code sha=${SHA_B} -->`);
    expect(summary).toContain("<summary>Run details</summary>");
    expect(summary).not.toContain("⚠️ degraded run");
  });

  it("history lookup failure: full review, prior threads untouched, run marked degraded", async () => {
    const api = fakeOctokit({
      listCommentsError: new Error("rate limited"),
      threads: ["svc/a.ts"],
    });
    const { harness, contexts } = fakeHarness({ agentic: reviewJson([]) });

    const result = await runReview(request(api, harness, checkout()));

    expect(contexts[0]!.userPrompt).not.toContain("Files to reassess");
    expect(result.diagnostics.incremental).toBe("unknown");
    expect(api.graphql).not.toHaveBeenCalled();
    expect(api.calls).toEqual(["createComment"]);
    expect(api.issues.createComment.mock.calls[0]![0]!.body).toContain(
      "⚠️ degraded run",
    );
  });

  it("agentic output that is not a review falls back to one headless retry", async () => {
    const api = fakeOctokit({});
    const { harness, contexts } = fakeHarness({
      agentic: "I looked around but here is prose, no JSON.",
      headless: reviewJson([
        { path: "svc/a.ts", line: 2, severity: "blocker", body: "boom" },
      ]),
      verify: verifyAll(1),
    });

    const result = await runReview(request(api, harness, checkout()));

    expect(contexts.map((c) => c.agentic)).toEqual([true, false, false]);
    expect(contexts[1]!.userPrompt).toContain("Diff under review:");
    expect(contexts[1]!.userPrompt).toContain(
      "+export async function selectThing",
    );
    expect(result.diagnostics.mode).toBe("fallback");
    expect(result.requestedChanges).toBe(true);
    expect(api.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "REQUEST_CHANGES" }),
    );
    expect(api.issues.createComment.mock.calls[0]![0]!.body).toContain(
      "headless fallback",
    );
  });

  it("compare at GitHub's 300-file cap is treated as unknown history", async () => {
    const api = fakeOctokit({
      priorSummarySha: SHA_A,
      compare: Array.from({ length: 300 }, (_, i) => `x/${i}.ts`),
      threads: ["svc/a.ts"],
    });
    const { harness } = fakeHarness({ agentic: reviewJson([]) });
    const result = await runReview(request(api, harness, checkout()));
    expect(result.diagnostics.incremental).toBe("unknown");
    expect(api.graphql).not.toHaveBeenCalled();
    expect(api.calls).toEqual(["updateComment"]);
  });

  it("dry run computes everything and writes nothing", async () => {
    const api = fakeOctokit({ threads: ["svc/a.ts"] });
    const { harness } = fakeHarness({
      agentic: reviewJson([
        { path: "svc/a.ts", line: 2, severity: "warning", body: "x" },
      ]),
      verify: verifyAll(1),
    });
    const result = await runReview(
      request(api, harness, checkout(), { dryRun: true }),
    );
    expect(result.inlineCount).toBe(1);
    expect(api.calls).toEqual([]);
    expect(api.graphql).not.toHaveBeenCalled();
  });
});
