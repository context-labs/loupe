import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  chatAgent,
  contentId,
  definitionId,
  fixerAgent,
  reviewerAgent,
  verifierAgent,
} from "../src/agents";

const output = z.object({ summary: z.string() });

describe("definitionId", () => {
  it("fits reviewer names to whip's id rules", () => {
    expect(definitionId("code")).toBe("loupe-code");
    expect(definitionId("Migrations Risk")).toBe("loupe-migrations-risk");
    expect(definitionId("")).toBe("loupe-review");
    expect(definitionId("x".repeat(80))).toMatch(/^loupe-x{58}$/);
  });
});

describe("contentId", () => {
  it("changes with the content and stays within whip's id rules", () => {
    const a = contentId("bugs", "prompt A", ["context"]);
    const b = contentId("bugs", "prompt B", ["context"]);
    expect(a).toMatch(/^loupe-bugs-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(contentId("bugs", "prompt A", ["context"])).toBe(a);
    expect(contentId("x".repeat(80), "p")).toMatch(/^loupe-x{49}-[0-9a-f]{8}$/);
  });
});

describe("agent definitions", () => {
  it("gives an agentic reviewer read-only file access, a write-attempt hook, and its output contract", () => {
    const agent = reviewerAgent({
      name: "bugs",
      systemPrompt: "Find bugs.",
      agentic: true,
      output,
    });
    expect(agent.document.id).toMatch(/^loupe-bugs-[0-9a-f]{8}$/);
    expect(agent.document.instructions.persona).toBe("Find bugs.");
    expect(agent.document.modules).toEqual(["context", "files"]);
    expect(agent.document.capabilities).toEqual(["read"]);
    expect(agent.document.children).toEqual({});
    expect(agent.document.hooks?.before_tool?.operations).toEqual([
      "files.write",
      "files.patch",
    ]);
    expect(agent.document.hooks?.before_spawn).toBeNull();
    expect(typeof agent.hooks.before_tool).toBe("function");
    expect(agent.document.output).toMatchObject({
      type: "object",
      required: ["summary"],
    });
  });

  it("derives the id from the whole document, so a different prompt or mode is a different agent", () => {
    const a = reviewerAgent({ systemPrompt: "p", agentic: false, output });
    expect(a.document.id).toMatch(/^loupe-review-[0-9a-f]{8}$/);
    expect(a.document.modules).toEqual(["context"]);
    expect(a.document.hooks).toBeNull();
    expect(a.document.id).not.toBe(
      reviewerAgent({ systemPrompt: "p", agentic: true, output }).document.id,
    );
    expect(a.document.id).not.toBe(
      reviewerAgent({ systemPrompt: "q", agentic: false, output }).document.id,
    );
    expect(a.document.id).toBe(
      reviewerAgent({ systemPrompt: "p", agentic: false, output }).document.id,
    );
  });

  it("gives the verifier the checkout only when the review was agentic, keeps chat diff-only, and lets only the fixer write", () => {
    const headless = verifierAgent({
      systemPrompt: "v",
      agentic: false,
      output,
    });
    expect(headless.document.modules).toEqual(["context"]);
    expect(headless.document.output).toMatchObject({ type: "object" });
    expect(headless.document.hooks).toBeNull();
    const agentic = verifierAgent({ systemPrompt: "v", agentic: true, output });
    expect(agentic.document.modules).toEqual(["context", "files"]);
    expect(agentic.document.capabilities).toEqual(["read"]);
    expect(typeof agentic.hooks.before_tool).toBe("function");
    expect(chatAgent("c").document.modules).toEqual(["context"]);
    expect(chatAgent("c").document.output).toBeNull();
    const fixer = fixerAgent("f", "/work/repo");
    expect(fixer.document.modules).toEqual(["context", "files", "shell"]);
    expect(fixer.document.capabilities).toEqual(["read", "write", "shell"]);
    expect(fixer.document.hooks?.before_tool?.operations).toContain(
      "shell.run",
    );
    expect(
      fixer.hooks.before_tool?.({
        operation: "shell.run",
        arguments: { command: "git push" },
      } as never),
    ).toMatchObject({ decision: "deny" });
  });
});
