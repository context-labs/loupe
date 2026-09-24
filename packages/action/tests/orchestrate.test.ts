import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Finding, ProducedReview, ReviewDiagnostics } from "@loupe/core";
import { describe, expect, it, vi } from "vitest";

import type { Config } from "../src/config";
import type { RunInput } from "../src/run";

// Capture every produce and publish so we can assert the dedupe wired the
// survivors to the right reviewer and posted only those.
const producedCalls: { label: string; input: RunInput }[] = [];
const publishCalls: {
  reviewer: string;
  inline: readonly Finding[];
  diagnostics: ReviewDiagnostics;
}[] = [];

const mockProduce = vi.fn(async (input: RunInput): Promise<ProducedReview> => {
  const name = input.reviewerName ?? "default";
  producedCalls.push({ label: name, input });
  const inline = findingsScript[name] ?? [];
  const clean: ReviewDiagnostics = {
    mode: "agentic",
    verify: "skipped",
    incremental: "full",
    malformedDropped: { findings: 0, concerns: 0 },
    outOfScopeDropped: 0,
    profileDropped: 0,
    verifyDropped: 0,
    crossReviewerDropped: 0,
    offDiff: 0,
    salvagedFindings: 0,
  };
  return {
    reviewerName: name,
    review: {
      summary: `summary ${name}`,
      findings: inline,
      concerns: [],
      highlights: [],
    },
    inline,
    uncertain: [],
    dropped: [],
    diagnostics: clean,
    headSha: "b".repeat(40),
    refreshPaths: new Set(["svc/billing.ts"]),
    headPaths: new Set(["svc/billing.ts"]),
    fileCount: 1,
  };
});
const mockPublish = vi.fn(
  async (
    input: RunInput,
    _p: ProducedReview,
    inline: readonly Finding[],
    diagnostics: ReviewDiagnostics,
  ): Promise<string> => {
    publishCalls.push({
      reviewer: input.reviewerName ?? "default",
      inline,
      diagnostics,
    });
    return `summary body ${input.reviewerName}`;
  },
);

// Mock ./run with our produce/publish stubs; resultFromProduced mirrors core.
vi.mock("../src/run", () => ({
  produceReviewPullRequest: mockProduce,
  publishReviewPullRequest: mockPublish,
  resultFromProduced: (
    p: ProducedReview,
    inline: readonly Finding[] = p.inline,
    d: ReviewDiagnostics = p.diagnostics,
  ) => ({
    inlineCount: inline.length,
    droppedCount: p.dropped.length,
    requestedChanges: [...inline].some((f) => f.severity === "blocker"),
    summary: p.review.summary,
    inline,
    dropped: p.dropped,
    diagnostics: d,
  }),
  formatResult: () => "formatted",
}));

// Mock @loupe/core: keep the real dedupeFindings (used for the union), stub the
// GitHub-posting helpers so no network call escapes.
const core = (await vi.importActual("@loupe/core")) as Record<string, unknown>;
vi.mock("@loupe/core", () => ({
  ...core,
  makeOctokit: () => ({}),
  postIssueComment: vi.fn(async () => {}),
  upsertCombinedSummary: vi.fn(async () => {}),
}));

// Imported after the mocks so runReviews calls our stubs.
const { runReviews } = await import("../src/orchestrate");

const f = (
  path: string,
  line: number,
  severity: Finding["severity"],
  body: string,
): Finding => ({ path, line, severity, body });

// Findings each reviewer produces. backend-critical and tests raise the same
// claim (same file, within 3 lines, different wording) — the issue's pattern.
let findingsScript: Record<string, Finding[]> = {};

function baseConfig(
  configPath: string | undefined,
  crossReviewerDedup: boolean,
): Config {
  return {
    token: "t",
    owner: "acme",
    repo: "app",
    pullNumber: 7,
    harnessName: "fake",
    workdir: "/tmp",
    conventionPaths: [],
    providers: [],
    model: "kimi-k3",
    verify: true,
    full: false,
    ensembleModels: [],
    skills: [],
    timezone: "UTC",
    priorComments: "resolve",
    crossReviewerDedup,
    configPath,
  } as unknown as Config;
}

function writeConfig(reviewers: { name: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "loupe-orch-"));
  writeFileSync(join(dir, ".loupe.json"), JSON.stringify({ reviewers }));
  return join(dir, ".loupe.json");
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
};
logger.child.mockReturnValue(logger);

function reset() {
  producedCalls.length = 0;
  publishCalls.length = 0;
  mockProduce.mockClear();
  mockPublish.mockClear();
}

describe("runReviews cross-reviewer dedupe", () => {
  it("suppresses a duplicate claim raised by two reviewers before posting", async () => {
    reset();
    findingsScript = {
      "backend-critical": [
        f(
          "svc/billing.ts",
          42,
          "blocker",
          "concurrent index build will fail on existing duplicates",
        ),
      ],
      tests: [
        f(
          "svc/billing.ts",
          43,
          "warning",
          "the unique index will error if rows already exist",
        ),
      ],
    };
    const path = writeConfig([{ name: "backend-critical" }, { name: "tests" }]);
    const outcomes = await runReviews(baseConfig(path, true), logger as any);

    expect(producedCalls.map((c) => c.label)).toEqual([
      "backend-critical",
      "tests",
    ]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);

    const backend = publishCalls.find(
      (c) => c.reviewer === "backend-critical",
    )!;
    const testsPublish = publishCalls.find((c) => c.reviewer === "tests")!;
    // backend-critical raised the blocker → keeps it; tests' copy is suppressed.
    expect(backend.inline).toHaveLength(1);
    expect(backend.inline[0]!.severity).toBe("blocker");
    expect(backend.diagnostics.crossReviewerDropped).toBe(0);
    expect(testsPublish.inline).toHaveLength(0);
    expect(testsPublish.diagnostics.crossReviewerDropped).toBe(1);
  });

  it("posts both findings unchanged when dedup is disabled", async () => {
    reset();
    findingsScript = {
      "backend-critical": [f("svc/billing.ts", 42, "blocker", "dupe one")],
      tests: [f("svc/billing.ts", 43, "warning", "dupe two")],
    };
    const path = writeConfig([{ name: "backend-critical" }, { name: "tests" }]);
    const outcomes = await runReviews(baseConfig(path, false), logger as any);

    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
    const backend = publishCalls.find(
      (c) => c.reviewer === "backend-critical",
    )!;
    const testsPublish = publishCalls.find((c) => c.reviewer === "tests")!;
    // No dedup → both post their own copy.
    expect(backend.inline).toHaveLength(1);
    expect(backend.diagnostics.crossReviewerDropped).toBe(0);
    expect(testsPublish.inline).toHaveLength(1);
    expect(testsPublish.diagnostics.crossReviewerDropped).toBe(0);
  });

  it("skips dedup for a single reviewer (no duplicates possible)", async () => {
    reset();
    findingsScript = {
      code: [f("x.ts", 10, "warning", "only one")],
    };
    const path = writeConfig([{ name: "code" }]);
    const outcomes = await runReviews(baseConfig(path, true), logger as any);

    expect(outcomes.map((o) => o.ok)).toEqual([true]);
    const code = publishCalls.find((c) => c.reviewer === "code")!;
    expect(code.inline).toHaveLength(1);
    expect(code.diagnostics.crossReviewerDropped).toBe(0);
  });
});
