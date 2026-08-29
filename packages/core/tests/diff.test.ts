import { describe, expect, it } from "vitest";

import { commentableLines } from "../src/diff";
import { parseReviewOutput } from "../src/parse";
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
