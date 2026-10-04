import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Harness,
  HarnessContext,
  HarnessTraceEvent,
} from "@loupe/harness";
import type { Finding } from "../src/types";
import { describe, expect, it, vi } from "vitest";

import {
  isDegraded,
  reviewResultFromProduced,
  runReview,
  type ProducedReview,
  type ReviewDiagnostics,
  type ReviewRequest,
} from "../src/index";

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
  /**
   * State the PR is in by publish time, simulated by the SECOND `pulls.get`
   * (the pre-publish freshness check). The first call — fetching context at
   * run start — still returns the open PR at SHA_B. `"open"` keeps it
   * publishable; `"merged"` / `"closed"` skip publishing; `"moved"` reports a
   * head different from SHA_B so the review is anchored to a stale commit.
   */
  closedAs?: "merged" | "closed" | "moved" | "open";
  /** Makes the SECOND `pulls.get` (the publish check) throw, to exercise the
   * per-reviewer fail-open path: a transient error posts rather than dropping
   * a completed review. */
  failPublishCheck?: boolean;
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
  // The first `pulls.get` (fetchPullContext) sees the open PR; the second
  // (the pre-publish freshness check) returns whatever closedAs is set to, so
  // a run can simulate a merge/close/head-move that lands mid-run.
  let pullsGetCalls = 0;
  const api = {
    graphql,
    users: {
      getAuthenticated: vi.fn(async () => ({ data: { login: "bot" } })),
    },
    pulls: {
      get: vi.fn(async () => {
        pullsGetCalls += 1;
        // pulls.get is called three times per non-dry run: fetchPullContext
        // and fetchConventions run concurrently (calls 1-2, order races but
        // both resolve before publish), then checkPublishable at publish time
        // (call 3). Throw only on that third call so the fetches still succeed.
        if (pullsGetCalls === 3 && gh.failPublishCheck) {
          throw new Error("transient publish-check failure");
        }
        if (pullsGetCalls > 1 && gh.closedAs) {
          // A moved head is an open PR whose head differs from the reviewed
          // SHA; closed/merged are closed. checkPublishable checks merged,
          // then closed, then head — so "moved" must stay open to reach that.
          if (gh.closedAs === "moved") {
            return {
              data: {
                merged: false,
                state: "open",
                head: { sha: "c".repeat(40) },
              },
            };
          }
          return {
            data: {
              merged: gh.closedAs === "merged",
              state: gh.closedAs === "open" ? "open" : "closed",
              head: { sha: SHA_B },
            },
          };
        }
        return {
          data: { title: "Change A and B", body: "desc", head: { sha: SHA_B } },
        };
      }),
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
    review: async (ctx) => {
      contexts.push(ctx);
      const verifying = ctx.systemPrompt.startsWith(
        "You are a strict reviewer verifying",
      );
      ctx.trace?.({
        type: "reasoning",
        delta: verifying ? "verify evidence" : "inspect change",
        model: ctx.model,
        phase: ctx.phase,
      });
      if (verifying) {
        const output = script.verify ?? "";
        ctx.trace?.({
          type: "done",
          text: output,
          model: ctx.model,
          phase: ctx.phase,
        });
        return { text: output, output: undefined };
      }
      if (ctx.agentic && script.agentic instanceof Error) {
        ctx.trace?.({
          type: "error",
          error: script.agentic.message,
          model: ctx.model,
          phase: ctx.phase,
        });
        throw script.agentic;
      }
      const output = ctx.agentic
        ? (script.agentic as string)
        : (script.headless ?? "");
      ctx.trace?.({
        type: "done",
        text: output,
        model: ctx.model,
        phase: ctx.phase,
      });
      return { text: output, output: undefined };
    },
  };
  return { harness, contexts };
}

/**
 * A harness that scripts each model independently, so an ensemble can have one
 * leg throw and another succeed. A model whose script is an Error throws on
 * EVERY call (agentic and the headless fallback alike) so produceOne's own
 * agentic→one-shot retry also fails and the throw propagates to the ensemble
 * loop — the shape of a real timeout/quota death. A string script answers that
 * model's agentic review. The verify pass is detected by its system-prompt prefix
 * and answered from the optional `verify` script (defaulting to "" → invalid).
 */
function fakePerModelHarness(
  byModel: Record<string, string | Error>,
  verify?: string,
): {
  harness: Harness;
  contexts: HarnessContext[];
} {
  const contexts: HarnessContext[] = [];
  const harness: Harness = {
    name: "fake",
    review: async (ctx) => {
      contexts.push(ctx);
      const verifying = ctx.systemPrompt.startsWith(
        "You are a strict reviewer verifying",
      );
      if (verifying) {
        const output = verify ?? "";
        ctx.trace?.({
          type: "done",
          text: output,
          model: ctx.model,
          phase: ctx.phase,
        });
        return { text: output, output: undefined };
      }
      const script = ctx.model ? byModel[ctx.model] : undefined;
      if (script instanceof Error) {
        ctx.trace?.({
          type: "error",
          error: script.message,
          model: ctx.model,
          phase: ctx.phase,
        });
        throw script;
      }
      const output = ctx.agentic ? String(script ?? reviewJson([])) : "";
      ctx.trace?.({
        type: "done",
        text: output,
        model: ctx.model,
        phase: ctx.phase,
      });
      return { text: output, output: undefined };
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
    conventionPaths: ["AGENTS.md"],
    dirs: ["svc"],
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

/** A minimal non-empty ProducedReview for unit-testing result assembly. */
const producedWith = (
  inline: readonly Finding[],
  commentCap = 10,
  concerns: readonly Finding[] = [],
): ProducedReview => ({
  reviewerName: "code",
  review: {
    summary: "s",
    findings: [],
    concerns: concerns as never,
    highlights: [],
  },
  inline,
  uncertain: [],
  // The produce phase emits no overflow; the cap applies at result/publish
  // time over the (possibly deduped) inline set.
  overflow: [],
  commentCap,
  dropped: [],
  diagnostics: {} as ReviewDiagnostics,
  headSha: "d".repeat(40),
  refreshPaths: new Set<string>(),
  headPaths: new Set<string>(),
  fileCount: 1,
});

describe("reviewResultFromProduced: cap × dedup verdict", () => {
  const blocker: Finding = {
    path: "a.ts",
    line: 1,
    severity: "blocker",
    body: "b",
  };
  const warning: Finding = {
    path: "a.ts",
    line: 2,
    severity: "warning",
    body: "w",
  };

  it("a blocker demoted by the cap still requests changes", () => {
    // Two blockers at a cap of one: one posts inline, one overflows, and the
    // verdict must reflect the whole run, not just what posted.
    const produced = producedWith([blocker, { ...blocker, line: 3 }], 1);
    const r = reviewResultFromProduced(produced);
    expect(r.inlineCount).toBe(1);
    expect(r.overflow).toHaveLength(1);
    expect(r.requestedChanges).toBe(true);
    expect(r.diagnostics.cappedDropped).toBe(1);
  });

  it("a blocker removed by the dedup override no longer requests changes", () => {
    // Upstream's contract: the verdict is recomputed from the deduped inline
    // set, so a blocker that was a duplicate doesn't request changes.
    const produced = producedWith([blocker, warning]);
    const original = reviewResultFromProduced(produced);
    expect(original.requestedChanges).toBe(true);
    const deduped = reviewResultFromProduced(produced, []);
    expect(deduped.requestedChanges).toBe(false);
  });

  it("the cap never resurrects a blocker that dedup removed", () => {
    // Dedup leaves only a warning; capping that set cannot put the removed
    // blocker back — inline or overflow — so the verdict stays off.
    const produced = producedWith([blocker, warning], 1);
    const deduped = reviewResultFromProduced(produced, [warning]);
    expect(deduped.requestedChanges).toBe(false);
    expect(deduped.overflow).toHaveLength(0);
  });

  it("no requirements when neither inline nor overflow holds a blocker", () => {
    const produced = producedWith([warning, { ...warning, line: 3 }], 1);
    const r = reviewResultFromProduced(produced);
    expect(r.inlineCount).toBe(1);
    expect(r.overflow).toHaveLength(1);
    expect(r.requestedChanges).toBe(false);
  });
});

describe("comment cap", () => {
  // 12 findings: emit nits first, blockers last, to prove ranking, not
  // emission order, decides what stays inline.
  const manyFindings = [
    ...Array.from({ length: 6 }, (_, i) => ({
      path: i % 2 === 0 ? "svc/a.ts" : "svc/b.ts",
      line: i % 2 === 0 ? 2 : 11,
      severity: "nit",
      body: `nit ${i}`,
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      path: i % 2 === 0 ? "svc/a.ts" : "svc/b.ts",
      line: i % 2 === 0 ? 2 : 11,
      severity: "blocker",
      body: `blocker ${i}`,
    })),
  ];

  it("ranks by severity and spills extras into a collapsed summary section", async () => {
    const api = fakeOctokit({});
    const { harness } = fakeHarness({
      agentic: reviewJson(manyFindings),
    });
    const result = await runReview(
      request(api, harness, checkout(), {
        maxComments: 5,
        verify: false,
        profile: "assertive",
      }),
    );

    // All five inline comments are blockers, despite the nits being emitted first.
    expect(result.inlineCount).toBe(5);
    expect(result.inline.every((f) => f.severity === "blocker")).toBe(true);
    expect(result.diagnostics.cappedDropped).toBe(7);
    const body = (
      api.issues.createComment.mock.calls[0]![0] as {
        body: string;
      }
    ).body;
    expect(body).toContain(
      "Additional findings (ranked below the 5-comment cap)",
    );
    expect(body).toContain("`svc/a.ts:2` [nit] nit 0");
  });

  it("a blocker demoted by the cap still requests changes", async () => {
    const api = fakeOctokit({});
    const sixBlockers = Array.from({ length: 6 }, (_, i) => ({
      path: i % 2 === 0 ? "svc/a.ts" : "svc/b.ts",
      line: i % 2 === 0 ? 2 : 11,
      severity: "blocker",
      body: `blocker ${i}`,
    }));
    const { harness } = fakeHarness({ agentic: reviewJson(sixBlockers) });
    const result = await runReview(
      request(api, harness, checkout(), {
        maxComments: 5,
        verify: false,
      }),
    );

    expect(result.inlineCount).toBe(5);
    expect(result.requestedChanges).toBe(true);
    // The posted review event must carry the verdict even though every
    // blocker's copy beyond the cap was demoted to the summary.
    const reviewCall = (
      api.pulls.createReview as unknown as {
        mock: { calls: { event: string }[][] };
      }
    ).mock.calls[0]![0]!;
    expect(reviewCall.event).toBe("REQUEST_CHANGES");
  });

  it("defaults to 10 when maxComments is omitted", async () => {
    const api = fakeOctokit({});
    const { harness } = fakeHarness({ agentic: reviewJson(manyFindings) });
    const result = await runReview(
      request(api, harness, checkout(), {
        verify: false,
        profile: "assertive",
      }),
    );

    expect(result.inlineCount).toBe(10);
    expect(result.diagnostics.cappedDropped).toBe(2);
  });

  it("does nothing when findings are under the cap", async () => {
    const api = fakeOctokit({});
    const { harness } = fakeHarness({
      agentic: reviewJson([
        {
          path: "svc/a.ts",
          line: 2,
          severity: "warning",
          body: "w1",
        },
      ]),
    });
    const result = await runReview(
      request(api, harness, checkout(), {
        maxComments: 5,
        verify: false,
      }),
    );

    expect(result.inlineCount).toBe(1);
    expect(result.diagnostics.cappedDropped).toBe(0);
    const body = (
      api.issues.createComment.mock.calls[0]![0] as {
        body: string;
      }
    ).body;
    expect(body).not.toContain("Additional findings");
  });

  it("exactly at the cap: everything posts inline, no overflow section", async () => {
    const api = fakeOctokit({});
    const five = Array.from({ length: 5 }, (_, i) => ({
      path: i % 2 === 0 ? "svc/a.ts" : "svc/b.ts",
      line: i % 2 === 0 ? 2 : 11,
      severity: "warning",
      body: `w${i}`,
    }));
    const { harness } = fakeHarness({ agentic: reviewJson(five) });
    const result = await runReview(
      request(api, harness, checkout(), {
        maxComments: 5,
        verify: false,
      }),
    );

    // Boundary must be inclusive: five findings at a cap of five post as-is.
    expect(result.inlineCount).toBe(5);
    expect(result.diagnostics.cappedDropped).toBe(0);
    const body = (
      api.issues.createComment.mock.calls[0]![0] as {
        body: string;
      }
    ).body;
    expect(body).not.toContain("Additional findings");
  });

  it("caps after the verification pass: findings rejected by verify never reach the cap", async () => {
    const api = fakeOctokit({});
    const six = Array.from({ length: 6 }, (_, i) => ({
      path: i % 2 === 0 ? "svc/a.ts" : "svc/b.ts",
      line: i % 2 === 0 ? 2 : 11,
      severity: "warning",
      body: `w${i}`,
    }));
    const { harness } = fakeHarness({
      agentic: reviewJson(six),
      // Verify keeps only findings #0 and #2; the other four are rejected.
      verify: JSON.stringify({
        verdicts: six.map((_, i) => ({ index: i, real: i === 0 || i === 2 })),
      }),
    });
    const result = await runReview(
      request(api, harness, checkout(), {
        maxComments: 5,
      }),
    );

    // If the cap ran before verify, six findings would first be demoted to
    // five and one would spill; running after verify, two survive and the
    // cap never engages.
    expect(result.diagnostics.verify).toBe("passed");
    expect(result.diagnostics.verifyDropped).toBe(4);
    expect(result.inlineCount).toBe(2);
    expect(result.diagnostics.cappedDropped).toBe(0);
    const body = (
      api.issues.createComment.mock.calls[0]![0] as {
        body: string;
      }
    ).body;
    expect(body).not.toContain("Additional findings");
  });

  it("caps ensemble-merged findings: severity ranks a blocker over a demoted nit", async () => {
    const api = fakeOctokit({});
    // Both models emit the same two findings (one per diff anchor), so the
    // majority merge confirms both. The nit is emitted first to prove the
    // cap ranks by severity on the *merged* result, not emission order.
    const merged = [
      { path: "svc/a.ts", line: 2, severity: "nit", body: "nit" },
      { path: "svc/b.ts", line: 11, severity: "blocker", body: "blocker" },
    ];
    const script = reviewJson(merged);
    const { harness } = fakePerModelHarness({
      "model-a": script,
      "model-b": script,
    });
    const result = await runReview(
      request(api, harness, checkout(), {
        ensembleModels: ["model-a", "model-b"],
        maxComments: 1,
        profile: "assertive",
      }),
    );

    // Ensemble merge confirmed exactly the two findings the models agreed on.
    expect(result.inlineCount).toBe(1);
    expect(result.inline[0]!.severity).toBe("blocker");
    expect(result.diagnostics.cappedDropped).toBe(1);
    expect(result.requestedChanges).toBe(true);
    const body = (
      api.issues.createComment.mock.calls[0]![0] as {
        body: string;
      }
    ).body;
    expect(body).toContain(
      "Additional findings (ranked below the 1-comment cap)",
    );
    expect(body).toContain("`svc/a.ts:2` [nit] nit");
  });

  it("tallies demoted findings in the summary header, not only the inline review", async () => {
    const api = fakeOctokit({});
    const findings = [
      ...Array.from({ length: 6 }, (_, i) => ({
        path: i % 2 === 0 ? "svc/a.ts" : "svc/b.ts",
        line: i % 2 === 0 ? 2 : 11,
        severity: "nit",
        body: `nit ${i}`,
      })),
    ];
    const { harness } = fakeHarness({ agentic: reviewJson(findings) });
    await runReview(
      request(api, harness, checkout(), {
        maxComments: 2,
        verify: false,
        profile: "assertive",
      }),
    );
    const body = (
      api.issues.createComment.mock.calls[0]![0] as { body: string }
    ).body;
    // The stat line must count all six findings, not just the two that
    // posted inline (Bugbot: capped findings were omitted from tallies).
    expect(body).toContain("🔵 6");
  });

  it("deferSummary: the overflow section lands in the returned summaryBody for the orchestrator", async () => {
    const api = fakeOctokit({});
    const { harness } = fakeHarness({
      agentic: reviewJson(manyFindings),
    });
    const result = await runReview(
      request(api, harness, checkout(), {
        maxComments: 4,
        verify: false,
        profile: "assertive",
        deferSummary: true,
      }),
    );

    expect(result.inlineCount).toBe(4);
    expect(result.diagnostics.cappedDropped).toBe(8);
    // The orchestrator (not runReview) posts the combined summary, so the
    // overflow note must travel on summaryBody.
    expect(result.summaryBody).toContain(
      "Additional findings (ranked below the 4-comment cap)",
    );
    // Nothing was posted as an issue comment; only the inline review exists.
    expect(api.issues.createComment).not.toHaveBeenCalled();
  });
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

    // The verify pass ran agentic over the one in-scope finding — it has the
    // same checkout the primary pass did, so it can read surrounding code.
    expect(contexts[1]!.agentic).toBe(true);
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
      crossReviewerDropped: 0,
      offDiff: 0,
      cappedDropped: 0,
      salvagedFindings: 0,
      degradedLegs: [],
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

    // [0] agentic primary, [1] headless fallback, [2] agentic verify (the
    // checkout exists, so the verifier reads surrounding code too).
    expect(contexts.map((c) => c.agentic)).toEqual([true, false, true]);
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

  it("tags primary and verification trace events", async () => {
    const api = fakeOctokit({});
    const { harness } = fakeHarness({
      agentic: reviewJson([
        { path: "svc/a.ts", line: 2, severity: "warning", body: "check me" },
      ]),
      verify: verifyAll(1),
    });
    const events: HarnessTraceEvent[] = [];

    await runReview(
      request(api, harness, checkout(), {
        model: "trace-model",
        trace: (event) => events.push(event),
      }),
    );

    expect(events.map((event) => `${event.phase}:${event.type}`)).toEqual([
      "primary:trace-model:reasoning",
      "primary:trace-model:done",
      "verify:trace-model:reasoning",
      "verify:trace-model:done",
    ]);
  });

  it("retains the failed primary trace before a successful fallback", async () => {
    const api = fakeOctokit({});
    const { harness } = fakeHarness({
      agentic: new Error("primary exploded"),
      headless: reviewJson([]),
    });
    const events: HarnessTraceEvent[] = [];

    const result = await runReview(
      request(api, harness, checkout(), {
        model: "trace-model",
        trace: (event) => events.push(event),
      }),
    );

    expect(result.diagnostics.mode).toBe("fallback");
    expect(events.map((event) => `${event.phase}:${event.type}`)).toEqual([
      "primary:trace-model:reasoning",
      "primary:trace-model:error",
      "fallback:trace-model:reasoning",
      "fallback:trace-model:done",
    ]);
    expect(
      events.find(
        (event) => event.type === "error" && event.phase?.startsWith("primary"),
      ),
    ).toEqual(expect.objectContaining({ error: "primary exploded" }));
  });

  it("tags every ensemble model independently (no findings → no verify)", async () => {
    const api = fakeOctokit({});
    const { harness } = fakeHarness({ agentic: reviewJson([]) });
    const events: HarnessTraceEvent[] = [];

    await runReview(
      request(api, harness, checkout(), {
        ensembleModels: ["model-a", "model-b"],
        trace: (event) => events.push(event),
      }),
    );

    expect(events.map((event) => `${event.phase}:${event.type}`)).toEqual([
      "ensemble:model-a:reasoning",
      "ensemble:model-a:done",
      "ensemble:model-b:reasoning",
      "ensemble:model-b:done",
    ]);
    // No findings survived the merge, so the verify pass has nothing to judge.
    expect(events.some((event) => event.phase?.startsWith("verify"))).toBe(
      false,
    );
  });

  it("ensemble with one failing leg degrades to the survivors and flags degraded", async () => {
    // Three models, one fails: the two survivors both flag the same finding, so
    // it clears the 2-of-3 majority and posts inline; the run is flagged
    // degraded because a leg was lost.
    const api = fakeOctokit({});
    const { harness, contexts } = fakePerModelHarness(
      {
        "model-a": reviewJson([
          {
            path: "svc/a.ts",
            line: 2,
            severity: "warning",
            body: "A is wrong",
          },
        ]),
        "model-b": reviewJson([
          {
            path: "svc/a.ts",
            line: 2,
            severity: "warning",
            body: "A is wrong",
          },
        ]),
        "model-c": new Error("whip error: context deadline exceeded"),
      },
      verifyAll(1),
    );
    const events: HarnessTraceEvent[] = [];

    const result = await runReview(
      request(api, harness, checkout(), {
        ensembleModels: ["model-a", "model-b", "model-c"],
        trace: (event) => events.push(event),
      }),
    );

    // Every leg was attempted; the failed one emitted an error on its agentic
    // pass and again on produceOne's headless fallback (a plain Error isn't a
    // non-retryable HarnessError, so the fallback fires and also dies) before the
    // ensemble loop caught it. Only the survivors' majority-confirmed finding
    // posts inline, and the verify pass still runs on it (an agentic review with
    // a checkout keeps the verifier agentic).
    expect(events.map((e) => `${e.phase}:${e.type}`)).toEqual([
      "ensemble:model-a:done",
      "ensemble:model-b:done",
      "ensemble:model-c:error",
      "fallback:model-c:error",
      "verify:done",
    ]);
    expect(result.inline.map((f) => `${f.path}:${f.line}`)).toEqual([
      "svc/a.ts:2",
    ]);
    expect(result.diagnostics.degradedLegs).toEqual(["model-c"]);
    expect(isDegraded(result.diagnostics)).toBe(true);
    // Exactly five harness calls: one agentic per leg (3), plus produceOne's
    // headless fallback for the dead leg (a plain Error isn't non-retryable, so
    // the fallback fires and also dies), plus the agentic verify pass on the one
    // majority-confirmed finding.
    expect(contexts.length).toBe(5);
  });

  it("a lone surviving ensemble leg lands in lower-confidence, not inline-confirmed", async () => {
    // Two models, one fails: the single survivor is below the 2-of-2 majority,
    // so its finding flows into the lower-confidence section rather than being
    // falsely labeled majority-confirmed. That is the honest claim for a
    // degraded ensemble, and the run is still flagged degraded.
    const api = fakeOctokit({});
    const { harness } = fakePerModelHarness({
      "model-a": reviewJson([
        { path: "svc/a.ts", line: 2, severity: "warning", body: "A is wrong" },
      ]),
      "model-b": new Error("whip error: context deadline exceeded"),
    });

    const result = await runReview(
      request(api, harness, checkout(), {
        ensembleModels: ["model-a", "model-b"],
      }),
    );

    expect(result.inline).toEqual([]);
    expect(result.droppedCount).toBe(0);
    expect(result.diagnostics.degradedLegs).toEqual(["model-b"]);
    expect(isDegraded(result.diagnostics)).toBe(true);
    // The survivor's finding lands in the lower-confidence section of the posted
    // summary (the honest claim for a single-model "majority"), not inline.
    expect(result.summaryBody).toContain(
      "Lower-confidence findings (raised by a minority of models)",
    );
    expect(result.summaryBody).toContain("svc/a.ts:2");
  });

  it("unions concerns, highlights, and off-diff notes across surviving ensemble legs (issue #40)", async () => {
    // Two models both survive. Model A raises an off-diff finding (unusable line)
    // and a highlight; model B raises the same off-diff finding reworded, plus a
    // concern and a highlight A didn't have. Before #40's fix, only the first
    // survivor's review body was kept — B's concern and the union of dropped
    // notes were silently discarded.
    const api = fakeOctokit({});
    const fullReview = JSON.stringify({
      summary: "reviewed",
      findings: [
        // In-scope file, unusable line (far past the 3-line hunk) → salvages
        // into the off-diff notes.
        {
          path: "svc/a.ts",
          line: 999,
          severity: "warning",
          body: "config value is read before initialization",
        },
      ],
      concerns: [],
      highlights: ["cleanup of the retry loop"],
    });
    const { harness } = fakePerModelHarness({
      "model-a": fullReview,
      "model-b": JSON.stringify({
        summary: "reviewed",
        findings: [
          // Same off-diff claim reworded by B — unions to one note.
          {
            path: "svc/a.ts",
            line: 999,
            severity: "warning",
            body: "config value is read before it is initialized here",
          },
        ],
        concerns: [
          {
            title: "Retry budget is shared across request paths",
            detail:
              "The retry budget counter is global, so one hot path can starve the others.",
            severity: "warning",
          },
        ],
        highlights: [
          "cleanup of the retry loop",
          "nice test coverage on parse",
        ],
      }),
    });

    const result = await runReview(
      request(api, harness, checkout(), {
        ensembleModels: ["model-a", "model-b"],
      }),
    );

    // The off-diff notes union: both legs' notes survive the union, and the
    // reworded duplicate collapses to one entry (was: only the first
    // survivor's single note).
    expect(result.diagnostics.offDiff).toBe(1);
    // B's concern survives into the posted review even though A came first.
    expect(result.summaryBody).toContain("Retry budget is shared");
    // Highlights union: A's plus B's unique one, deduped overlap.
    expect(result.summaryBody).toContain("nice test coverage on parse");
  });

  it("concern merge never downgrades severity, and loose title matches don't merge (Bugbot)", async () => {
    // Bugbot 1: a later leg's lower-severity concern with a longer writeup
    // used to replace the first raiser's blocker. Bugbot 2: titles sharing a
    // prefix used to merge at the 0.1 body threshold, dropping a leg's unique
    // concern.
    const api = fakeOctokit({});
    const { harness } = fakePerModelHarness({
      "model-a": JSON.stringify({
        summary: "reviewed",
        findings: [],
        concerns: [
          {
            title: "Database migration has no rollback path",
            detail:
              "The migration adds a column with a default but never documents how to roll it back if deployment aborts halfway.",
            severity: "blocker",
          },
        ],
        highlights: [],
      }),
      "model-b": JSON.stringify({
        summary: "reviewed",
        findings: [],
        concerns: [
          // Longer detail, lower severity: must NOT replace the blocker.
          {
            title: "Database migration lacks a documented rollback procedure",
            detail:
              "There is no written procedure describing what an operator should do to roll this migration back if the deployment fails partway through, " +
              "which would leave the schema in a mixed state with the new column present and the backfill incomplete. " +
              "Operators would need to reconstruct recovery steps from the migration source by hand under pressure during an incident.",
            severity: "nit",
          },
          // Shares headword, describes a distinct issue: must stay separate.
          {
            title: "Database pool sizing is hardcoded",
            detail:
              "The connection pool is sized for local development; production traffic would exhaust it before the migration even runs.",
            severity: "warning",
          },
        ],
        highlights: [],
      }),
    });

    const result = await runReview(
      request(api, harness, checkout(), {
        ensembleModels: ["model-a", "model-b"],
      }),
    );

    // The blocker was reworded by model-b and merged in (same claim, its nit
    // copy is the longer detail): the posted representative must still be a
    // blocker — never the reworded nit.
    const body = result.summaryBody ?? "";
    const lines = body
      .split("\n")
      .filter((l) => l.includes("rollback") || l.includes("hardcoded"));
    expect(lines.length).toBeGreaterThanOrEqual(2); // both concerns posted
    const rollbackLine = lines.find((l) => l.includes("rollback"));
    expect(rollbackLine).toContain("🔴"); // blocker marker preserved
    expect(body).toContain("Database pool sizing is hardcoded");
  });

  it("a leg that dies on the headless fallback does not taint the survivors' mode", async () => {
    // Bugbot: a dead leg sets counts.mode = "fallback" before its headless
    // retry, then the retry throws too — leaving "fallback" on shared counts.
    // The surviving leg ran agentic and should report mode "agentic", not the
    // dead leg's "fallback". The error script throws on every call, so the
    // dead leg's own headless fallback also fails before the loop catches it.
    const api = fakeOctokit({});
    const { harness } = fakePerModelHarness({
      "model-a": reviewJson([
        { path: "svc/a.ts", line: 2, severity: "warning", body: "A is wrong" },
      ]),
      "model-b": reviewJson([
        { path: "svc/a.ts", line: 2, severity: "warning", body: "A is wrong" },
      ]),
      "model-c": new Error("model-c died"),
    });

    const result = await runReview(
      request(api, harness, checkout(), {
        ensembleModels: ["model-a", "model-b", "model-c"],
      }),
    );

    expect(result.diagnostics.mode).toBe("agentic");
    expect(result.diagnostics.degradedLegs).toEqual(["model-c"]);
  });

  it("ensemble where the first leg fails still posts a surviving leg's review", async () => {
    const api = fakeOctokit({});
    const { harness } = fakePerModelHarness({
      "model-a": new Error("400 Bad Request: prompt_cache_key"),
      "model-b": reviewJson([
        { path: "svc/a.ts", line: 2, severity: "warning", body: "A is wrong" },
      ]),
      "model-c": reviewJson([
        { path: "svc/a.ts", line: 2, severity: "warning", body: "A is wrong" },
      ]),
    });

    const result = await runReview(
      request(api, harness, checkout(), {
        ensembleModels: ["model-a", "model-b", "model-c"],
      }),
    );

    // The summary/concerns come from the first SURVIVING leg (model-b), not the
    // first configured leg (model-a) which failed.
    expect(result.summary).toBe("reviewed");
    expect(result.inline.map((f) => `${f.path}:${f.line}`)).toEqual([
      "svc/a.ts:2",
    ]);
    expect(result.diagnostics.degradedLegs).toEqual(["model-a"]);
  });

  it("ensemble where every leg fails throws (no vacuous clean review)", async () => {
    const api = fakeOctokit({});
    const { harness } = fakePerModelHarness({
      "model-a": new Error("model-a died"),
      "model-b": new Error("model-b died"),
    });

    await expect(
      runReview(
        request(api, harness, checkout(), {
          ensembleModels: ["model-a", "model-b"],
        }),
      ),
    ).rejects.toThrow("all ensemble models failed");
    // Nothing posted — the reviewer-level failure path handles visibility.
    expect(api.calls).toEqual([]);
  });

  it("ensemble + verify coexist: the verify pass drops a majority-confirmed false positive", async () => {
    // sebi75 (#46): turning on an ensemble used to drop the verification pass
    // entirely. Majority agreement filters cross-model noise but not the
    // outside-diff class — both models can agree on a claim the surrounding
    // code refutes. The verify pass now runs on the merged inline findings too.
    const api = fakeOctokit({});
    const { harness, contexts } = fakePerModelHarness(
      {
        "model-a": reviewJson([
          {
            path: "svc/a.ts",
            line: 2,
            severity: "warning",
            body: "A is wrong",
          },
        ]),
        "model-b": reviewJson([
          {
            path: "svc/a.ts",
            line: 2,
            severity: "warning",
            body: "A is wrong",
          },
        ]),
      },
      // The verifier reads the checkout and refutes the majority-confirmed
      // finding: real:false drops it, so nothing posts inline.
      JSON.stringify({
        verdicts: [
          {
            index: 0,
            real: false,
            reason: "early return makes this unreachable",
          },
        ],
      }),
    );
    const events: HarnessTraceEvent[] = [];

    const result = await runReview(
      request(api, harness, checkout(), {
        ensembleModels: ["model-a", "model-b"],
        trace: (event) => events.push(event),
      }),
    );

    // Both legs ran, then the verify pass ran over the one merged finding.
    expect(events.map((e) => `${e.phase}:${e.type}`)).toEqual([
      "ensemble:model-a:done",
      "ensemble:model-b:done",
      "verify:done",
    ]);
    // The majority-confirmed finding was rejected by verification.
    expect(result.inline).toEqual([]);
    expect(result.diagnostics.verify).toBe("passed");
    expect(result.diagnostics.verifyDropped).toBe(1);
    // Three harness calls: two agentic legs + one agentic verify.
    expect(contexts.length).toBe(3);
    expect(contexts[2]!.agentic).toBe(true);
    expect(contexts[2]!.userPrompt).toContain("#0 [warning] svc/a.ts:2");
  });

  it("promptCache:true (default) stamps a stable cache key on every call", async () => {
    const api = fakeOctokit({});
    const { harness, contexts } = fakeHarness({ agentic: reviewJson([]) });
    await runReview(request(api, harness, checkout()));
    // One agentic call; the key is repo/reviewer-scoped.
    expect(contexts.length).toBeGreaterThanOrEqual(1);
    for (const ctx of contexts) {
      expect(ctx.cacheKey).toBe("loupe/acme/app/code");
    }
  });

  it("promptCache:false omits the cache key so an incompatible model isn't 400'd", async () => {
    const api = fakeOctokit({});
    const { harness, contexts } = fakeHarness({ agentic: reviewJson([]) });
    await runReview(request(api, harness, checkout(), { promptCache: false }));
    // No call carries a cache key — whip never sends -cache-key, so a model
    // that rejects prompt_cache_key runs instead of 400ing.
    expect(contexts.length).toBeGreaterThanOrEqual(1);
    for (const ctx of contexts) {
      expect(ctx.cacheKey).toBeUndefined();
    }
  });

  it("promptCache:false also suppresses the verify-pass cache key", async () => {
    const api = fakeOctokit({});
    const { harness, contexts } = fakeHarness({
      agentic: reviewJson([
        { path: "svc/a.ts", line: 2, severity: "warning", body: "wrong" },
      ]),
      verify: verifyAll(1),
    });
    await runReview(request(api, harness, checkout(), { promptCache: false }));
    // The agentic run and the verify pass both run; neither carries a key.
    expect(contexts.length).toBe(2);
    for (const ctx of contexts) {
      expect(ctx.cacheKey).toBeUndefined();
    }
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

  it("skips publishing when the PR merged before postReview, keeping the findings on the result", async () => {
    const api = fakeOctokit({ threads: ["svc/a.ts"], closedAs: "merged" });
    const { harness } = fakeHarness({
      agentic: reviewJson([
        { path: "svc/a.ts", line: 2, severity: "warning", body: "x" },
      ]),
      verify: verifyAll(1),
    });
    const result = await runReview(request(api, harness, checkout()));

    // The review ran: the finding survived parsing and verification.
    expect(result.inlineCount).toBe(1);
    // But nothing was published onto the merged PR.
    expect(api.calls).toEqual([]);
    expect(api.pulls.createReview).not.toHaveBeenCalled();
    expect(api.issues.createComment).not.toHaveBeenCalled();
    expect(api.issues.updateComment).not.toHaveBeenCalled();
    expect(api.graphql).not.toHaveBeenCalled();
    // The skip is reported with the reason, and no head was stamped.
    expect(result.skipped).toEqual({ reason: "merged" });
    expect(result.summaryBody).toBeUndefined();
    expect(result.reviewedHeadSha).toBeUndefined();
  });

  it("skips publishing when the PR was closed before postReview", async () => {
    const api = fakeOctokit({ threads: ["svc/a.ts"], closedAs: "closed" });
    const { harness } = fakeHarness({
      agentic: reviewJson([
        { path: "svc/a.ts", line: 2, severity: "blocker", body: "boom" },
      ]),
      verify: verifyAll(1),
    });
    const result = await runReview(request(api, harness, checkout()));

    expect(result.inlineCount).toBe(1);
    expect(api.pulls.createReview).not.toHaveBeenCalled();
    expect(result.skipped).toEqual({ reason: "closed" });
  });

  it("skips publishing when the head moved since the review started", async () => {
    const api = fakeOctokit({ threads: ["svc/a.ts"], closedAs: "moved" });
    const { harness } = fakeHarness({
      agentic: reviewJson([
        { path: "svc/a.ts", line: 2, severity: "warning", body: "x" },
      ]),
      verify: verifyAll(1),
    });
    const result = await runReview(request(api, harness, checkout()));

    expect(result.inlineCount).toBe(1);
    expect(api.pulls.createReview).not.toHaveBeenCalled();
    expect(result.skipped).toEqual({ reason: "head-moved" });
  });

  it("publishes normally when the PR is still open at postReview", async () => {
    const api = fakeOctokit({ closedAs: "open" });
    const { harness } = fakeHarness({
      agentic: reviewJson([
        { path: "svc/a.ts", line: 2, severity: "warning", body: "x" },
      ]),
      verify: verifyAll(1),
    });
    const result = await runReview(request(api, harness, checkout()));

    expect(result.inlineCount).toBe(1);
    expect(api.calls).toEqual(["createReview", "createComment"]);
    expect(result.skipped).toBeUndefined();
    expect(result.reviewedHeadSha).toBe(SHA_B);
  });

  it("dry run is unaffected by the publish gate", async () => {
    const api = fakeOctokit({ threads: ["svc/a.ts"], closedAs: "merged" });
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
    expect(result.skipped).toBeUndefined();
  });

  it("fails open: a transient publish-check error still posts the review", async () => {
    const api = fakeOctokit({ failPublishCheck: true });
    const { harness } = fakeHarness({
      agentic: reviewJson([
        { path: "svc/a.ts", line: 2, severity: "warning", body: "x" },
      ]),
      verify: verifyAll(1),
    });
    const result = await runReview(request(api, harness, checkout()));

    // The publish check threw, so the run posts anyway rather than dropping a
    // completed review. The skip flag is not set — this is a real publish.
    expect(result.inlineCount).toBe(1);
    expect(api.calls).toEqual(["createReview", "createComment"]);
    expect(result.skipped).toBeUndefined();
    expect(result.reviewedHeadSha).toBe(SHA_B);
  });
});
