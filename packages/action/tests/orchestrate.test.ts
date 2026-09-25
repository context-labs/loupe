import { describe, expect, it } from "vitest";

import type { ReviewResult } from "@loupe/core";

import { renderCombinedSummary } from "../src/orchestrate";

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
  degradedLegs: [],
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
const skipped = (
  name: string,
  reason: "merged" | "closed" | "head-moved",
): OkOutcome => ({
  ...clean(name),
  result: { ...clean(name).result, skipped: { reason } },
});

describe("renderCombinedSummary", () => {
  it("renders a skipped reviewer as a skipped section, not _Not run_", () => {
    const body = renderCombinedSummary([skipped("code", "merged")]);
    expect(body).toContain("<!-- loupe:section:code:start -->");
    expect(body).toContain("## code");
    expect(body).toContain(
      "⏸️ Skipped: the PR merged before loupe could publish",
    );
    expect(body).toContain("Findings were computed but not posted");
    expect(body).not.toContain("_Not run_");
  });

  it("phrases a closed PR and a moved head distinctly", () => {
    expect(renderCombinedSummary([skipped("a", "closed")])).toContain(
      "the PR closed before loupe could publish",
    );
    expect(renderCombinedSummary([skipped("b", "head-moved")])).toContain(
      "the PR head moved before loupe could publish",
    );
  });

  it("keeps the section markers so a skipped reviewer still has boundaries", () => {
    const body = renderCombinedSummary([
      clean("zdr"),
      skipped("code", "head-moved"),
    ]);
    expect(body).toContain("<!-- loupe:section:zdr:start -->");
    expect(body).toContain("<!-- loupe:section:code:start -->");
    expect(body).toContain("<!-- loupe:section:code:end -->");
    expect(body).toContain("⏸️ Skipped: the PR head moved");
  });
});
