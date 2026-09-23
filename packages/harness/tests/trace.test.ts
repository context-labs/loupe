import { describe, expect, it } from "vitest";

import {
  envSecretValues,
  redactSecrets,
  REDACTION_MARK,
  whipEventToTrace,
  type HarnessTraceEvent,
} from "../src/index";

describe("whipEventToTrace (nondestructive normalization)", () => {
  it("translates reasoning and text deltas", () => {
    expect(whipEventToTrace({ type: "reasoning", delta: "think " })).toEqual([
      { type: "reasoning", delta: "think " },
    ]);
    expect(whipEventToTrace({ type: "text", delta: "hi" })).toEqual([
      { type: "text", delta: "hi" },
    ]);
  });

  it("normalizes tool_start/tool_end with truncated blobs", () => {
    const long = "x".repeat(5000);
    const start = whipEventToTrace({
      type: "tool_start",
      name: "read",
      args: long,
    });
    expect(start).toEqual([
      { type: "tool_start", name: "read", args: long.slice(0, 2000) },
    ]);
    const end = whipEventToTrace({
      type: "tool_end",
      name: "read",
      result: long,
    });
    expect(end).toEqual([
      { type: "tool_end", name: "read", result: long.slice(0, 2000) },
    ]);
  });

  it("serializes structured tool results", () => {
    expect(
      whipEventToTrace({
        type: "tool_end",
        name: "read",
        result: { lines: ["one", "two"], truncated: false },
      }),
    ).toEqual([
      {
        type: "tool_end",
        name: "read",
        result: '{"lines":["one","two"],"truncated":false}',
      },
    ]);
  });

  it("handles circular tool payloads without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(
      whipEventToTrace({ type: "tool_start", name: "custom", args: circular }),
    ).toEqual([
      {
        type: "tool_start",
        name: "custom",
        args: "[unserializable tool payload]",
      },
    ]);
  });

  it("defaults a missing tool name and serializes structured args", () => {
    expect(whipEventToTrace({ type: "tool_start" })).toEqual([
      { type: "tool_start", name: "tool", args: undefined },
    ]);
    expect(
      whipEventToTrace({ type: "tool_start", name: "grep", args: { x: 1 } }),
    ).toEqual([{ type: "tool_start", name: "grep", args: '{"x":1}' }]);
  });

  it("ignores non-object raw events", () => {
    expect(whipEventToTrace(null)).toEqual([]);
    expect(whipEventToTrace("reasoning")).toEqual([]);
  });

  it("normalizes done and error", () => {
    expect(whipEventToTrace({ type: "done", text: "{}" })).toEqual([
      { type: "done", text: "{}" },
    ]);
    const err = whipEventToTrace({
      type: "error",
      error: { message: "boom" },
    })[0] as HarnessTraceEvent & { type: "error" };
    expect(err.type).toBe("error");
    expect(err.error).toContain("boom");
  });

  it("ignores unknown event types and malformed payloads", () => {
    expect(whipEventToTrace({ type: "ping" })).toEqual([]);
    expect(whipEventToTrace({ type: "reasoning" })).toEqual([]);
    expect(whipEventToTrace({ type: "text", delta: 42 })).toEqual([]);
  });
});

describe("redactSecrets", () => {
  it("redacts known secret values wherever they appear", () => {
    expect(
      redactSecrets("got key sk-abcdef-super-secret here", [
        "sk-abcdef-super-secret",
      ]),
    ).toBe(`got key ${REDACTION_MARK} here`);
  });

  it("redacts multiple secrets and repeated occurrences", () => {
    const out = redactSecrets(
      "the-first-secret-key-1 and again the-first-secret-key-1, then second-secret-key-2",
      ["the-first-secret-key-1", "second-secret-key-2"],
    );
    expect(out).not.toContain("the-first-secret-key-1");
    expect(out).not.toContain("second-secret-key-2");
    expect(out.split(REDACTION_MARK).length - 1).toBe(3);
  });

  it("treats short secrets as noise and leaves them alone", () => {
    expect(redactSecrets("value is 'on'", ["on"])).toBe("value is 'on'");
    expect(redactSecrets("path a", ["a"])).toBe("path a");
  });

  it("no-ops with no secrets or a secret longer than the text", () => {
    expect(redactSecrets("hello", [])).toBe("hello");
    expect(
      redactSecrets("short", ["this-secret-is-much-longer-than-the-text"]),
    ).toBe("short");
  });
});

describe("envSecretValues", () => {
  it("collects regenerable non-empty env values above the min length", () => {
    expect(
      envSecretValues({
        INFERENCE_API_KEY: "sk-long-enough-to-matter",
        OPENAI_API_KEY: "x",
        PATH: "/usr/bin:/bin",
        EMPTY: "",
      }),
    ).toEqual(["sk-long-enough-to-matter"]);
  });
});
