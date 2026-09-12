import { describe, expect, it } from "vitest";

import { commentableLines } from "../src/diff";
import { parseReviewOutput, parseVerification } from "../src/parse";
import { severitiesForProfile } from "../src/types";
import { majority, mergeEnsemble } from "../src/ensemble";
import { validateFindings } from "../src/validate";

const patch = [
  "@@ -1,3 +1,4 @@",
  " const a = 1;", // context -> new line 1
  "-const b = 2;", // deleted -> not commentable
  "+const b = 3;", // added   -> new line 2
  "+const c = 4;", // added   -> new line 3
  " const d = 5;", // context -> new line 4
].join("\n");

const files = [{ path: "src/x.ts", patch }];

describe("commentableLines", () => {
  it("tracks RIGHT-side line numbers for added and context lines only", () => {
    const map = commentableLines(files);
    expect([...(map.get("src/x.ts") ?? [])].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4,
    ]);
  });
});

describe("validateFindings", () => {
  it("keeps on-diff findings inline and drops off-diff ones", () => {
    const { inline, dropped } = validateFindings(
      [
        { path: "src/x.ts", line: 3, severity: "warning", body: "on diff" },
        { path: "src/x.ts", line: 99, severity: "blocker", body: "off diff" },
        { path: "other.ts", line: 1, severity: "nit", body: "unknown file" },
      ],
      files,
    );
    expect(inline.map((f) => f.line)).toEqual([3]);
    expect(dropped.map((f) => f.line)).toEqual([99, 1]);
  });
});

describe("parseReviewOutput", () => {
  it("extracts the JSON object from noisy CLI output", () => {
    const stdout =
      'Here is my review:\n```json\n{"summary":"looks ok","findings":[]}\n```\nDone.';
    const { review } = parseReviewOutput(stdout);
    expect(review.summary).toBe("looks ok");
    expect(review.findings).toEqual([]);
  });

  it("throws on missing JSON", () => {
    expect(() => parseReviewOutput("no json here")).toThrow();
  });

  it("rejects an object that is not a review instead of treating it as clean", () => {
    expect(() => parseReviewOutput("{}")).toThrow(/not a review/);
    expect(() => parseReviewOutput('{"status":"done"}')).toThrow(
      /not a review/,
    );
  });

  it("counts malformed findings it had to drop", () => {
    const { review, malformedFindings } = parseReviewOutput(
      '{"summary":"s","findings":[{"path":"a","line":1,"severity":"nit","body":"ok"},{"path":"b"}]}',
    );
    expect(review.findings).toHaveLength(1);
    expect(malformedFindings).toBe(1);
  });

  it("keeps multi-paragraph Markdown bodies with code fences intact", () => {
    const body =
      "First paragraph.\n\n```ts\nawait x();\n```\n\nSecond paragraph.";
    const { review } = parseReviewOutput(
      JSON.stringify({
        summary: "s",
        findings: [{ path: "a", line: 1, severity: "warning", body }],
      }),
    );
    expect(review.findings[0]!.body).toBe(body);
  });

  it("throws a clear error on empty output", () => {
    expect(() => parseReviewOutput("   \n ")).toThrow(/no output/i);
  });

  it("normalizes off-scale severities onto blocker/warning/nit", () => {
    const { review: out, malformedFindings } = parseReviewOutput(
      '{"summary":"s","findings":[' +
        '{"path":"a","line":1,"severity":"critical","body":"x"},' +
        '{"path":"b","line":2,"severity":"major","body":"y"},' +
        '{"path":"c","line":3,"severity":"MINOR","body":"z"},' +
        '{"path":"d","line":4,"severity":"whoknows","body":"w"}]}',
    );
    expect(malformedFindings).toBe(0); // normalized aliases are not malformed
    expect(out.findings.map((f) => f.severity)).toEqual([
      "blocker",
      "warning",
      "nit",
      "warning",
    ]);
  });
});

describe("parseReviewOutput concerns/diagram", () => {
  it("parses concerns and a diagram, dropping and counting malformed concerns", () => {
    const { review: out, malformedConcerns } = parseReviewOutput(
      JSON.stringify({
        summary: "s",
        findings: [],
        concerns: [
          { title: "risk", detail: "watch out", severity: "warning" },
          { title: "bad" }, // malformed (no detail) → dropped
        ],
        diagram: "sequenceDiagram\n A->>B: hi",
      }),
    );
    expect(out.concerns).toEqual([
      { title: "risk", detail: "watch out", severity: "warning" },
    ]);
    expect(malformedConcerns).toBe(1);
    expect(out.diagram).toContain("sequenceDiagram");
  });
});

describe("parseVerification", () => {
  it("maps finding index to a verdict when every index is covered once", () => {
    const r = parseVerification(
      'ok: {"verdicts":[{"index":0,"real":true},{"index":1,"real":false,"reason":"dup"}]}',
      2,
    );
    expect(r.valid).toBe(true);
    if (!r.valid) return;
    expect(r.verdicts.get(0)).toEqual({ real: true, reason: undefined });
    expect(r.verdicts.get(1)).toEqual({ real: false, reason: "dup" });
  });
  it("is invalid on junk, a bare object, or an empty verdict list", () => {
    expect(parseVerification("no json", 1).valid).toBe(false);
    expect(parseVerification("{}", 1).valid).toBe(false);
    expect(parseVerification('{"verdicts":[]}', 1).valid).toBe(false);
  });
  it("is invalid on missing, duplicate, or out-of-range indices", () => {
    const missing = parseVerification(
      '{"verdicts":[{"index":0,"real":true}]}',
      2,
    );
    expect(missing).toEqual({
      valid: false,
      reasons: ["missing verdict for #1"],
    });
    const dup = parseVerification(
      '{"verdicts":[{"index":0,"real":true},{"index":0,"real":false}]}',
      1,
    );
    expect(dup.valid).toBe(false);
    const range = parseVerification(
      '{"verdicts":[{"index":3,"real":true}]}',
      1,
    );
    expect(range.valid).toBe(false);
  });
});

describe("severitiesForProfile", () => {
  it("scopes severities by profile", () => {
    expect(severitiesForProfile("quiet")).toEqual(["blocker"]);
    expect(severitiesForProfile("chill")).toEqual(["blocker", "warning"]);
    expect(severitiesForProfile("assertive")).toEqual([
      "blocker",
      "warning",
      "nit",
    ]);
  });
});

describe("mergeEnsemble", () => {
  const f = (path: string, line: number, severity: any = "warning") => ({
    path,
    line,
    severity,
    body: `${path}:${line}`,
  });
  it("confirms findings a majority of models agree on, others uncertain", () => {
    const a = [f("x.ts", 10, "blocker"), f("y.ts", 5)];
    const b = [f("x.ts", 11), f("z.ts", 1)]; // x.ts within 3 lines => agrees
    const { confirmed, uncertain } = mergeEnsemble([a, b], majority(2));
    expect(confirmed.map((c) => c.path)).toEqual(["x.ts"]);
    expect(confirmed[0]!.severity).toBe("blocker"); // stronger rep kept
    expect(uncertain.map((c) => c.path).sort()).toEqual(["y.ts", "z.ts"]);
  });
  it("majority is 2 of 2 and 2 of 3", () => {
    expect(majority(2)).toBe(2);
    expect(majority(3)).toBe(2);
    expect(majority(4)).toBe(3);
  });
});

describe("parseReviewOutput resilience (jsonrepair)", () => {
  it("recovers a truncated review instead of throwing", () => {
    // Missing closing braces/brackets (model hit a token limit).
    const truncated =
      '{"summary":"looks ok","findings":[{"path":"a.ts","line":1,"severity":"blocker","body":"boom"}';
    const { review: out } = parseReviewOutput(truncated);
    expect(out.summary).toBe("looks ok");
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.path).toBe("a.ts");
  });
  it("recovers JSON with a trailing comma", () => {
    const { review: out } = parseReviewOutput(
      '{"summary":"s","findings":[],"walkthrough":[],}',
    );
    expect(out.summary).toBe("s");
  });
});

describe("validateFindings snapping", () => {
  const files = [{ path: "src/x.ts", patch }]; // commentable RIGHT lines: 1..4
  it("snaps an off-by-a-few finding to the nearest commentable line", () => {
    const { inline, dropped } = validateFindings(
      [{ path: "src/x.ts", line: 7, severity: "warning", body: "near" }],
      files,
    );
    expect(dropped).toHaveLength(0);
    expect(inline).toHaveLength(1);
    expect(inline[0]!.line).toBe(4); // snapped from 7 to nearest (4)
  });
  it("drops a finding with no commentable line within the window", () => {
    const { inline, dropped } = validateFindings(
      [{ path: "src/x.ts", line: 500, severity: "nit", body: "far" }],
      files,
    );
    expect(inline).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });
  it("drops a finding on a file not in the diff", () => {
    const { inline, dropped } = validateFindings(
      [{ path: "other.ts", line: 1, severity: "nit", body: "x" }],
      files,
    );
    expect(inline).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });
});
