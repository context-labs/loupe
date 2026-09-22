import { describe, expect, it, vi } from "vitest";

import { HarnessError, type Harness } from "@loupe/harness";
import type { Logger } from "@loupe/logger";

// Stub the network layer so runReview never calls Octokit. fetchConventions
// returns nothing so the reviewer runs with defaults.
vi.mock("../src/github", () => ({
  makeOctokit: () => ({}),
  fetchPullContext: vi.fn().mockResolvedValue({
    title: "test",
    description: "",
    files: [{ path: "src/x.ts", patch: "@@ -1 +1,2 @@\n+const a = 1;\n" }],
    headSha: "abc123",
  }),
  fetchConventions: vi.fn().mockResolvedValue({ text: "", found: [] }),
  postReview: vi.fn().mockResolvedValue(undefined),
}));

// Silence the logger.
const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => stubLogger,
} as unknown as Logger;

/**
 * Build a fake agentic harness whose `review` records every call's `agentic`
 * flag and throws `throwOnFirst` on the first (agentic) call. Subsequent calls
 * (the one-shot fallback) return valid empty review JSON.
 */
function fakeHarness(throwOnFirst: unknown): {
  harness: Harness;
  calls: { agentic?: boolean }[];
} {
  const calls: { agentic?: boolean }[] = [];
  const harness: Harness = {
    name: "fake",
    credentialKeys: [],
    available: () => Promise.resolve(true),
    review: async (ctx) => {
      calls.push({ agentic: ctx.agentic });
      if (calls.length === 1) throw throwOnFirst;
      return JSON.stringify({ summary: "", findings: [], concerns: [] });
    },
  };
  return { harness, calls };
}

async function runReviewWith(harness: Harness): Promise<unknown> {
  const { runReview } = await import("../src/index");
  return runReview({
    token: "t",
    ref: { owner: "o", repo: "r", pull_number: 1 },
    harness,
    workdir: ".",
    harnessEnv: {},
    conventionPaths: [],
    reasoning: "low",
    dryRun: true, // don't post
    full: true, // skip the incremental path (getLastReviewedSha/changedFilesBetween)
    logger: stubLogger,
  });
}

describe("agentic→one-shot retry guard", () => {
  it("re-throws a quota HarnessError without the one-shot fallback", async () => {
    const { harness, calls } = fakeHarness(
      new HarnessError("402 Payment Required", "quota"),
    );
    await expect(runReviewWith(harness)).rejects.toBeInstanceOf(HarnessError);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.agentic).toBe(true);
  });

  it("re-throws a rate-limit HarnessError without the one-shot fallback", async () => {
    const { harness, calls } = fakeHarness(
      new HarnessError("429 Too Many Requests", "rate-limit"),
    );
    await expect(runReviewWith(harness)).rejects.toBeInstanceOf(HarnessError);
    expect(calls).toHaveLength(1);
  });

  it("still falls back to one-shot for an unknown HarnessError", async () => {
    const { harness, calls } = fakeHarness(
      new HarnessError("exited 1: boom", "unknown"),
    );
    const result = await runReviewWith(harness);
    expect(result).toBeDefined();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.agentic).toBe(false);
  });

  it("still falls back to one-shot for a bare Error", async () => {
    const { harness, calls } = fakeHarness(new Error("transient blip"));
    const result = await runReviewWith(harness);
    expect(result).toBeDefined();
    expect(calls).toHaveLength(2);
  });
});
