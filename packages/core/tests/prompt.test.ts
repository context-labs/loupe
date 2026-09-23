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
  it("headless mode fails closed: rejects findings that depend on code outside the diff", () => {
    const p = buildVerifySystemPrompt();
    expect(p).toContain("headless with NO repository access");
    expect(p).toContain("speculative from the diff alone: reject it");
    // The old fail-open "outside-diff" acquittal is gone.
    expect(p).not.toContain("outside-diff");
  });
  it("agentic mode instructs the verifier to read surrounding code and refute false claims", () => {
    const p = buildVerifySystemPrompt({ agentic: true });
    expect(p).toContain("repository access");
    expect(p).toContain("READ the surrounding code");
    expect(p).toContain("If the surrounding code REFUTES the claim");
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

  it("puts the evidence bar in the default guidance, not the output contract", () => {
    const def = buildSystemPrompt({});
    expect(def).toContain("The bar for a finding (precision over recall)");
    expect(def).toContain("this input / this path → this wrong result");
    expect(def).toContain("Hedge the claim, not the report.");
    // A custom prompt replaces the guidance, so the bar goes with it: a docs
    // reviewer has no runtime failure to name.
    expect(buildSystemPrompt({ guidance: "Only hunt bugs." })).not.toContain(
      "The bar for a finding",
    );
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
