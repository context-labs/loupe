import { describe, expect, it } from "vitest";

import { parseReviewOutput } from "../src/parse";

describe("parseReviewOutput — recognizable review", () => {
  it("accepts a minimal object with no summary as an empty clean review", () => {
    // The exact shape glm-5.3 emitted on monorepo PR #7104 when it had nothing
    // to report — it must be a clean review, not a reviewer failure.
    const r = parseReviewOutput('{"highlights":[],"diagram":""}');
    expect(r.review.summary).toBe("");
    expect(r.review.findings).toEqual([]);
    expect(r.review.concerns).toEqual([]);
  });

  it("accepts findings with no summary", () => {
    const r = parseReviewOutput(
      '{"findings":[{"path":"a.ts","line":1,"severity":"warning","body":"x"}]}',
    );
    expect(r.review.summary).toBe("");
    expect(r.review.findings).toHaveLength(1);
  });

  it("still rejects unrelated JSON with no review key", () => {
    expect(() => parseReviewOutput('{"status":"done"}')).toThrow(
      /not a review/,
    );
  });

  it("rejects a non-string summary", () => {
    expect(() => parseReviewOutput('{"summary":123}')).toThrow(/not a review/);
  });

  it("throws on empty output", () => {
    expect(() => parseReviewOutput("   ")).toThrow(/no output/i);
  });
});
