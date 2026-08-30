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
    const parsed = parseReviewOutput(stdout);
    expect(parsed.summary).toBe("looks ok");
    expect(parsed.findings).toEqual([]);
  });

  it("throws on missing JSON", () => {
    expect(() => parseReviewOutput("no json here")).toThrow();
  });

  it("throws a clear error on empty output", () => {
    expect(() => parseReviewOutput("   \n ")).toThrow(/no output/i);
  });

  it("normalizes off-scale severities onto blocker/warning/nit", () => {
    const out = parseReviewOutput(
      '{"summary":"s","findings":[' +
        '{"path":"a","line":1,"severity":"critical","body":"x"},' +
        '{"path":"b","line":2,"severity":"major","body":"y"},' +
        '{"path":"c","line":3,"severity":"MINOR","body":"z"},' +
        '{"path":"d","line":4,"severity":"whoknows","body":"w"}]}',
    );
    expect(out.findings.map((f) => f.severity)).toEqual([
      "blocker",
      "warning",
      "nit",
      "warning",
    ]);
  });
});

describe("parseReviewOutput walkthrough/diagram", () => {
  it("parses walkthrough items and a diagram, dropping malformed items", () => {
    const out = parseReviewOutput(
      JSON.stringify({
        summary: "s",
        findings: [],
        walkthrough: [
          { path: "a.ts", summary: "did a" },
          { path: "b.ts" }, // malformed → dropped
        ],
        diagram: "sequenceDiagram\n A->>B: hi",
      }),
    );
    expect(out.walkthrough).toEqual([{ path: "a.ts", summary: "did a" }]);
    expect(out.diagram).toContain("sequenceDiagram");
  });
});

describe("parseVerification", () => {
  it("maps finding index to real verdict", () => {
    const m = parseVerification(
      'ok: {"verdicts":[{"index":0,"real":true},{"index":1,"real":false}]}',
    );
    expect(m.get(0)).toBe(true);
    expect(m.get(1)).toBe(false);
    expect(m.get(2)).toBeUndefined();
  });
  it("returns empty map on junk", () => {
    expect(parseVerification("no json").size).toBe(0);
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
