import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Logger } from "@loupe/logger";

// Mutable PR state the tests set before calling handleComment.
const {
  postIssueComment,
  updateIssueComment,
  pullsGet,
  runReviews,
  state,
  cleanResult,
} = vi.hoisted(() => ({
  postIssueComment: vi.fn(async () => ({ data: { id: 42 } })),
  updateIssueComment: vi.fn(
    async (_o: unknown, _r: unknown, _id: number, _body: string) => undefined,
  ),
  pullsGet: vi.fn(async () => ({
    data: { merged: false, state: "open", head: { sha: "h".repeat(40) } },
  })),
  // A full ReviewResult so renderReviewCompletion's outcomeLine can read
  // inline/diagnostics without crashing.
  cleanResult: {
    inlineCount: 0,
    droppedCount: 0,
    requestedChanges: false,
    summary: "ok",
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
  },
  // runReviews returns one clean reviewer outcome by default.
  runReviews: vi.fn(async () => [
    { name: "code", ok: true, result: cleanResult },
  ]),
  state: { merged: false, closed: false },
}));

pullsGet.mockImplementation(async () => ({
  data: {
    merged: state.merged,
    state: state.closed ? "closed" : "open",
    head: { sha: "h".repeat(40) },
  },
}));

vi.mock("@loupe/core", () => ({
  makeOctokit: () => ({ pulls: { get: pullsGet } }),
  postIssueComment,
  updateIssueComment,
  fetchPullContext: vi.fn(async () => ({
    title: "t",
    description: "",
    files: [],
    headSha: "h".repeat(40),
    headPaths: new Set<string>(),
  })),
  buildChatSystemPrompt: vi.fn(() => ""),
  buildChatUserPrompt: vi.fn(() => ""),
  listOpenLoupeFindings: vi.fn(async () => []),
}));
vi.mock("@loupe/credentials", () => ({
  resolveCredentials: vi.fn(async () => ({})),
}));
vi.mock("@loupe/harness", () => ({
  getHarness: vi.fn(() => ({
    name: "fake",
    credentialKeys: [],
    available: async () => true,
    review: vi.fn(),
  })),
}));
vi.mock("../src/orchestrate", () => ({
  runReviews,
  CombinedSummaryPublicationError: class extends Error {},
  skipReasonText: (r: string) => r,
}));
vi.mock("../src/reviewers", () => ({ loadReviewers: vi.fn(() => []) }));

import { handleComment } from "../src/respond";
import type { Config } from "../src/config";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

function eventConfig(body: string): Config {
  const path = join(tmpdir(), `loupe-event-${Math.random()}.json`);
  writeFileSync(path, JSON.stringify({ comment: { body } }));
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
    eventPath: path,
    eventName: "issue_comment",
  } as Config;
}

describe("handleComment re-review completion gate", () => {
  it("posts the verdict summary when the PR is still open", async () => {
    state.merged = false;
    state.closed = false;
    postIssueComment.mockClear();
    updateIssueComment.mockClear();
    runReviews.mockResolvedValueOnce([
      { name: "code", ok: true, result: cleanResult },
    ]);

    await handleComment(eventConfig("@loupe review"), logger);

    // The ack is posted, then the completion verdict replaces it.
    expect(postIssueComment).toHaveBeenCalledTimes(1);
    expect(updateIssueComment).toHaveBeenCalledTimes(1);
    const body = updateIssueComment.mock.calls[0]![3] as string;
    expect(body).toContain("Re-review of");
    expect(body).not.toContain("merged before loupe could publish");
  });

  it("posts the closure ack instead of the verdict when the PR merged mid-run", async () => {
    state.merged = true;
    state.closed = true;
    postIssueComment.mockClear();
    updateIssueComment.mockClear();
    runReviews.mockResolvedValueOnce([
      { name: "code", ok: true, result: cleanResult },
    ]);

    await handleComment(eventConfig("@loupe review"), logger);

    expect(postIssueComment).toHaveBeenCalledTimes(1);
    expect(updateIssueComment).toHaveBeenCalledTimes(1);
    const body = updateIssueComment.mock.calls[0]![3] as string;
    expect(body).toContain("merged before loupe could publish");
    expect(body).toContain("nothing was posted");
    expect(body).not.toContain("Re-review of");
  });

  it("posts the closure ack when the PR was closed but not merged", async () => {
    state.merged = false;
    state.closed = true;
    postIssueComment.mockClear();
    updateIssueComment.mockClear();
    runReviews.mockResolvedValueOnce([
      { name: "code", ok: true, result: cleanResult },
    ]);

    await handleComment(eventConfig("@loupe review"), logger);

    const body = updateIssueComment.mock.calls[0]![3] as string;
    expect(body).toContain("closed before loupe could publish");
    expect(body).not.toContain("Re-review of");
  });
});
