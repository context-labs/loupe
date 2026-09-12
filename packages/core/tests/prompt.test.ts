import { describe, expect, it } from "vitest";

import { renderFileTree, type DiffFile } from "../src/diff";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildVerifySystemPrompt,
} from "../src/prompt";

const files: DiffFile[] = [
  { path: "src/a.ts", patch: "@@ -1,1 +1,2 @@\n line\n+added line\n-removed" },
  { path: "img.png", patch: undefined },
];

describe("renderFileTree", () => {
  it("lists paths with +/- counts, and marks binaries", () => {
    const tree = renderFileTree(files);
    expect(tree).toContain("- src/a.ts (+1 −1)");
    expect(tree).toContain("- img.png (binary/too large)");
    // it must NOT contain the actual patch body
    expect(tree).not.toContain("added line");
  });
});

describe("buildUserPrompt", () => {
  const base = { title: "t", description: "", files };

  it("headless mode inlines the full diff", () => {
    const p = buildUserPrompt(base);
    expect(p).toContain("Diff under review:");
    expect(p).toContain("+added line"); // the patch body is present
    expect(p).not.toContain("is written to");
  });

  it("agentic mode (diffPath) sends the tree + a pointer, not the diff body", () => {
    const p = buildUserPrompt({ ...base, diffPath: "/tmp/x/pr.diff" });
    expect(p).toContain("Changed files");
    expect(p).toContain("- src/a.ts (+1 −1)");
    expect(p).toContain("/tmp/x/pr.diff");
    expect(p).not.toContain("+added line"); // the diff body is NOT inlined
  });
});

describe("buildUserPrompt scope notes", () => {
  const base = {
    title: "t",
    description: "",
    files,
    diffPath: "/tmp/x/pr.diff",
  };

  it("explains the cwd/path mapping only when running inside a subdir", () => {
    expect(buildUserPrompt({ ...base, cwdSubdir: "inference" })).toContain(
      "Your working directory is `inference/`",
    );
    expect(buildUserPrompt(base)).not.toContain("Your working directory");
  });

  it("lists focus files before the tree on an incremental run", () => {
    const p = buildUserPrompt({ ...base, focusPaths: ["src/a.ts"] });
    expect(p.indexOf("Files to reassess")).toBeLessThan(
      p.indexOf("Changed files"),
    );
    expect(p).toContain("- src/a.ts\n");
    expect(p).toContain("The other listed files are context");
  });
});

describe("buildSystemPrompt reasoning", () => {
  it("omits the reasoning note when no effort is configured", () => {
    expect(buildSystemPrompt({})).not.toContain("Reasoning effort:");
    expect(buildSystemPrompt({ reasoning: "high" })).toContain(
      "Reasoning effort: high",
    );
  });
});

describe("buildVerifySystemPrompt", () => {
  it("fails open on evidence outside the diff instead of rejecting it", () => {
    const p = buildVerifySystemPrompt();
    expect(p).toContain("outside-diff");
    expect(p).not.toContain("based on code not shown");
  });
});

describe("review procedure and call sites", () => {
  it("appends the procedure even when custom guidance replaces the default, unless disabled", () => {
    const custom = buildSystemPrompt({ guidance: "Only hunt bugs." });
    expect(custom).toContain("Only hunt bugs.");
    expect(custom).toContain("Procedure — do these before writing any finding");
    expect(
      buildSystemPrompt({ guidance: "x", procedure: false }),
    ).not.toContain("Procedure —");
  });

  it("renders pre-computed call sites in the user message", () => {
    const p = buildUserPrompt({
      title: "t",
      description: "",
      files,
      diffPath: "/tmp/x/pr.diff",
      callSites: "`login`:\n- svc/commands/harness.ts:41  await login();",
    });
    expect(p).toContain("Call sites of changed exports");
    expect(p).toContain("svc/commands/harness.ts:41");
  });
});
