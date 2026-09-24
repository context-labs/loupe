import { describe, expect, it, vi } from "vitest";

import type { ReviewResult } from "@loupe/core";
import type { Logger } from "@loupe/logger";

// vi.mock factories are hoisted above all top-level code, so any values they
// close over must be created with vi.hoisted (which runs at hoist time). These
// are the levers the tests flip, plus the spy for the write we gate.
const { upsertCombinedSummary, postIssueComment, pullsGet, state } = vi.hoisted(
  () => ({
    upsertCombinedSummary: vi.fn(async () => undefined),
    postIssueComment: vi.fn(async () => undefined),
    pullsGet: vi.fn(async () => ({
      data: { merged: false, state: "open", head: { sha: "h".repeat(40) } },
    })),
    // Mutable PR state the tests set before each call; the mock reads it live.
    state: {
      open: true,
      reason: "merged" as "merged" | "closed",
      throws: false,
    },
  }),
);

// pullsGet returns whatever `state` says right now, so each test drives the gate
// by mutating state before calling runReviews.
pullsGet.mockImplementation(async () => {
  if (state.throws) throw new Error("boom");
  return {
    data: {
      merged: !state.open && state.reason === "merged",
      state: state.open ? "open" : "closed",
      head: { sha: "h".repeat(40) },
    },
  };
});

vi.mock("@loupe/core", () => ({
  makeOctokit: () => ({ pulls: { get: pullsGet } }),
  // Mirror checkPrOpen's real merged-then-closed ordering via the shared pullsGet.
  checkPrOpen: async () => {
    const pr = await pullsGet();
    if (pr.data.merged) return { open: false, reason: "merged" as const };
    if (pr.data.state === "closed")
      return { open: false, reason: "closed" as const };
    return { open: true };
  },
  upsertCombinedSummary,
  postIssueComment,
}));

const result: ReviewResult = {
  inlineCount: 0,
  droppedCount: 0,
  requestedChanges: false,
  summary: "Looks fine.",
  inline: [],
  dropped: [],
  diagnostics: {
    mode: "agentic",
    verify: "skipped",
    incremental: "full",
    malformedDropped: { findings: 0, concerns: 0 },
    outOfScopeDropped: 0,
    profileDropped: 0,
    verifyDropped: 0,
    offDiff: 0,
    salvagedFindings: 0,
  },
};
vi.mock("../src/run", () => ({
  reviewPullRequest: vi.fn(async () => result),
  formatResult: () => "loupe: 0 inline comment(s)",
}));

import { runReviews } from "../src/orchestrate";
import type { Config } from "../src/config";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    token: "t",
    owner: "acme",
    repo: "app",
    pullNumber: 7,
    harnessName: "fake",
    workdir: ".",
    conventionPaths: ["AGENTS.md"],
    providers: [],
    model: "m",
    profile: "chill",
    verify: false,
    full: false,
    ensembleModels: [],
    skills: [],
    timezone: "UTC",
    ...overrides,
  } as Config;
}

describe("runReviews combined-summary freshness gate", () => {
  it("writes the combined summary when the PR is still open", async () => {
    state.open = true;
    state.throws = false;
    upsertCombinedSummary.mockClear();
    await runReviews(baseConfig(), logger);
    expect(upsertCombinedSummary).toHaveBeenCalledTimes(1);
  });

  it("skips the combined summary when the PR merged mid-run", async () => {
    state.open = false;
    state.reason = "merged";
    state.throws = false;
    upsertCombinedSummary.mockClear();
    const outcomes = await runReviews(baseConfig(), logger);
    expect(upsertCombinedSummary).not.toHaveBeenCalled();
    // The reviewer outcome still surfaces (ok: true) — only the summary post was skipped.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(true);
  });

  it("skips the combined summary when the PR was closed mid-run", async () => {
    state.open = false;
    state.reason = "closed";
    state.throws = false;
    upsertCombinedSummary.mockClear();
    await runReviews(baseConfig(), logger);
    expect(upsertCombinedSummary).not.toHaveBeenCalled();
  });

  it("fails open: a transient checkPrOpen error still writes the summary", async () => {
    state.open = true;
    state.throws = true;
    upsertCombinedSummary.mockClear();
    await runReviews(baseConfig(), logger);
    expect(upsertCombinedSummary).toHaveBeenCalledTimes(1);
    state.throws = false;
  });
});
