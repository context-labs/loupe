import { describe, expect, it } from "vitest";

import type { ReviewResult } from "@loupe/core";

import type { ReviewerOutcome } from "../src/orchestrate";
import {
  closureMessageIfPrNotOpen,
  renderReviewCompletion,
} from "../src/respond";

const diagnostics = {
  mode: "agentic" as const,
  verify: "skipped" as const,
  incremental: "full" as const,
  malformedDropped: { findings: 0, concerns: 0 },
  outOfScopeDropped: 0,
  profileDropped: 0,
  verifyDropped: 0,
  offDiff: 0,
  salvagedFindings: 0,
};
type OkOutcome = { name: string; ok: true; result: ReviewResult };
const clean = (name: string): OkOutcome => ({
  name,
  ok: true,
  result: {
    inlineCount: 0,
    droppedCount: 0,
    requestedChanges: false,
    summary: "Looks fine.",
    inline: [],
    dropped: [],
    diagnostics,
  },
});
const outOfScope = (name: string): OkOutcome => ({
  ...clean(name),
  result: { ...clean(name).result, summary: "No changed files in scope." },
});
const skipped = (
  name: string,
  reason: "merged" | "closed" | "head-moved",
): OkOutcome => ({
  ...clean(name),
  result: { ...clean(name).result, skipped: { reason } },
});

describe("renderReviewCompletion", () => {
  it("lists each reviewer's verdict and points at the updated summaries", () => {
    const warned: ReviewerOutcome = {
      name: "zdr",
      ok: true,
      result: {
        ...clean("zdr").result,
        inlineCount: 1,
        inline: [{ path: "a.ts", line: 1, severity: "warning", body: "x" }],
      },
    };
    const body = renderReviewCompletion(
      [clean("code"), warned, { name: "docs", ok: false, error: "boom" }],
      "c61996e".padEnd(40, "0"),
      ["inference"],
    );
    expect(body).toContain("✅ Re-review of `c61996e` done.");
    expect(body).toContain("- code: ✅ no issues");
    expect(body).toContain("- zdr: 🟡 1");
    expect(body).toContain("- docs: ⚠️ failed");
    expect(body).toContain("updated in place");
  });

  it("says plainly when the config covers none of the changed files", () => {
    const body = renderReviewCompletion(
      [outOfScope("code"), outOfScope("zdr")],
      "7".repeat(40),
      ["inference", "elixir_engine"],
    );
    expect(body).toContain("- code: no changed files in scope");
    expect(body).toContain(
      "covers `inference/`, `elixir_engine/` and no changed file is under it",
    );
    expect(body).not.toContain("updated in place");
  });

  it("marks a skipped reviewer in the per-reviewer lines", () => {
    const body = renderReviewCompletion(
      [skipped("code", "merged"), clean("zdr")],
      "7".repeat(40),
      undefined,
    );
    expect(body).toContain("- code: ⏸️ skipped (PR merged)");
    expect(body).toContain("- zdr: ✅ no issues");
  });

  it("notes nothing was posted when every reviewer was skipped", () => {
    const body = renderReviewCompletion(
      [skipped("code", "merged"), skipped("zdr", "head-moved")],
      "7".repeat(40),
      ["inference"],
    );
    expect(body).toContain("- code: ⏸️ skipped (PR merged)");
    expect(body).toContain("- zdr: ⏸️ skipped (PR head moved)");
    expect(body).toContain("The PR changed before loupe could publish");
    expect(body).not.toContain("updated in place");
  });
});

describe("closureMessageIfPrNotOpen", () => {
  it("returns a merged closure message when the PR merged", () => {
    expect(closureMessageIfPrNotOpen({ merged: true, state: "closed" })).toBe(
      "⏸️ Re-review ran, but the PR merged before loupe could publish — nothing was posted.",
    );
  });

  it("returns a closed closure message when the PR was closed but not merged", () => {
    expect(closureMessageIfPrNotOpen({ merged: false, state: "closed" })).toBe(
      "⏸️ Re-review ran, but the PR closed before loupe could publish — nothing was posted.",
    );
  });

  it("returns undefined for an open PR, so the verdict summary posts", () => {
    expect(
      closureMessageIfPrNotOpen({ merged: false, state: "open" }),
    ).toBeUndefined();
  });

  it("reports merged even when state is also closed", () => {
    // GitHub sets state=closed and merged=true once merged; merged wins.
    expect(
      closureMessageIfPrNotOpen({ merged: true, state: "closed" }),
    ).toContain("merged");
  });
});
