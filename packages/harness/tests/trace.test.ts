import { describe, expect, it } from "vitest";

import type { TurnEvent } from "@whip/sdk";

import {
  envSecretValues,
  redactSecrets,
  REDACTION_MARK,
  turnEventToTrace,
} from "../src/index";

const event = (fields: Record<string, unknown>): TurnEvent =>
  ({
    seq: "1",
    agentId: "root",
    turnId: "t1",
    ...fields,
  }) as unknown as TurnEvent;

describe("turnEventToTrace (nondestructive normalization)", () => {
  it("translates reasoning and text deltas", () => {
    expect(
      turnEventToTrace(event({ type: "reasoning", delta: "think " })),
    ).toEqual([{ type: "reasoning", delta: "think " }]);
    expect(turnEventToTrace(event({ type: "text", delta: "hi" }))).toEqual([
      { type: "text", delta: "hi" },
    ]);
  });

  it("maps a host call to tool_start/tool_end with truncated blobs", () => {
    const long = "x".repeat(5000);
    expect(
      turnEventToTrace(
        event({
          type: "host",
          id: "h1",
          invocationId: "i",
          operation: "files.read",
          summary: long,
          status: "running",
        }),
      ),
    ).toEqual([
      {
        type: "tool_start",
        name: "files.read",
        args: `${long.slice(0, 2000)}…`,
      },
    ]);
    expect(
      turnEventToTrace(
        event({
          type: "host",
          id: "h1",
          invocationId: "i",
          operation: "files.read",
          summary: "",
          status: "failed",
          error: "denied",
        }),
      ),
    ).toEqual([{ type: "tool_end", name: "files.read", result: "denied" }]);
  });

  it("maps a cell's code and result to a tool", () => {
    expect(
      turnEventToTrace(
        event({ type: "cell", id: "c1", status: "running", code: "x = 1" }),
      ),
    ).toEqual([{ type: "tool_start", name: "cell", args: "x = 1" }]);
    expect(
      turnEventToTrace(
        event({ type: "cell", id: "c1", status: "completed", result: "1" }),
      ),
    ).toEqual([{ type: "tool_end", name: "cell", result: "1" }]);
    expect(
      turnEventToTrace(event({ type: "cell", id: "c1", status: "called" })),
    ).toEqual([]);
  });

  it("ignores events the trace has no shape for", () => {
    expect(turnEventToTrace(event({ type: "notice", text: "n" }))).toEqual([]);
    expect(
      turnEventToTrace(event({ type: "end", status: "succeeded" })),
    ).toEqual([]);
    expect(
      turnEventToTrace(event({ type: "raw", event: { kind: "x" } })),
    ).toEqual([]);
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
