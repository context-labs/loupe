import type { TurnEvent } from "@whip/sdk";
import { describe, expect, it } from "vitest";

import { RunProgress } from "../src/progress";
import { recorder } from "./recorder";

const ROOT = "root-1";
const event = (fields: Record<string, unknown>, agentId = ROOT): TurnEvent =>
  ({ seq: "1", agentId, turnId: "t1", ...fields }) as unknown as TurnEvent;

describe("RunProgress", () => {
  it("throttles reply and reasoning deltas into counters, ignoring children's text", () => {
    const { log, lines } = recorder();
    const progress = new RunProgress(log, ROOT);
    for (let i = 0; i < 6; i++) {
      progress.observe(event({ type: "text", delta: "x".repeat(50) }));
    }
    progress.observe(
      event({ type: "text", delta: "y".repeat(500) }, "child-1"),
    );
    progress.observe(event({ type: "reasoning", delta: "y".repeat(250) }));
    const info = lines.filter((l) => l.level === "info");
    expect(info.map((l) => l.message)).toEqual([
      "streaming reply",
      "streaming reply",
      "thinking",
    ]);
    expect(info[0]?.props).toEqual({ chars: 150 });
    expect(info[1]?.props).toEqual({ chars: 300 });
    expect(info[2]?.props).toEqual({ chars: 250 });
  });

  it("logs cells, host calls, hooks, and failures one line each and clips arguments", () => {
    const { log, lines } = recorder();
    const progress = new RunProgress(log, ROOT);
    progress.observe(
      event({
        type: "cell",
        id: "c1",
        status: "running",
        code: "a".repeat(300),
      }),
    );
    progress.observe(
      event({
        type: "host",
        id: "h1",
        invocationId: "i",
        operation: "files.read",
        summary: "path=x",
        status: "running",
      }),
    );
    progress.observe(
      event({
        type: "host",
        id: "h1",
        invocationId: "i",
        operation: "files.read",
        summary: "path=x",
        status: "failed",
        error: "denied",
      }),
    );
    progress.observe(
      event({
        type: "hook",
        hook: "before_tool",
        operation: "shell.run",
        decision: "deny",
        reason: "reviewers are read-only",
      }),
    );
    progress.observe(event({ type: "end", status: "failed", error: "boom" }));
    expect(lines.map((l) => [l.level, l.message])).toEqual([
      ["info", "cell"],
      ["info", "host call"],
      ["warn", "host call failed"],
      ["info", "hook decision"],
      ["warn", "turn failed"],
    ]);
    expect(String(lines[0]?.props?.["code"]).length).toBe(201);
    expect(lines[3]?.props).toEqual({
      hook: "before_tool",
      decision: "deny",
      operation: "shell.run",
      reason: "reviewers are read-only",
    });
  });

  it("reports children by id: spawn, their host calls, and their failures", () => {
    const { log, lines } = recorder();
    const progress = new RunProgress(log, ROOT);
    progress.observe(
      event(
        {
          type: "child",
          childId: "c1",
          kind: "agent.admitted",
          status: "running",
        },
        "c1",
      ),
    );
    progress.observe(
      event(
        {
          type: "host",
          id: "h",
          invocationId: "i",
          operation: "tools.pr_hunks",
          summary: "",
          status: "running",
        },
        "c1",
      ),
    );
    progress.observe(
      event({ type: "end", status: "failed", error: "budget exhausted" }, "c1"),
    );
    expect(lines.map((l) => [l.level, l.message, l.props?.["agent"]])).toEqual([
      ["info", "child agent spawned", "c1"],
      ["info", "host call", "c1"],
      ["warn", "child turn failed", "c1"],
    ]);
    expect(lines[2]?.props?.["error"]).toBe("budget exhausted");
  });

  it("reports cost from accounting events and tokens from the result's usage", () => {
    const { log, lines } = recorder();
    const progress = new RunProgress(log, ROOT);
    const accounting = (reported: string, estimated: string) =>
      event({
        type: "raw",
        event: {
          kind: "stream.accounting",
          payload: {
            accounting: {
              reported_cost_micros: reported,
              estimated_cost_micros: estimated,
            },
          },
        },
      });
    progress.observe(accounting("1500", "9"));
    progress.observe(accounting("0", "4200"));
    progress.finish({
      used: 1,
      size: 2,
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    });
    expect(lines.at(-1)).toEqual({
      level: "info",
      message: "run finished",
      props: {
        replyChars: 0,
        promptTokens: 120,
        completionTokens: 30,
        costUsd: 0.0042,
      },
    });
  });

  it("sums per-call usage cost when no accounting event reaches the turn", () => {
    const { log, lines } = recorder();
    const progress = new RunProgress(log, ROOT);
    const usage = (cost: number) =>
      event({
        type: "usage",
        usage: {
          used: 1,
          size: 1,
          usage: { prompt_tokens: 1, completion_tokens: 1, cost },
        },
      });
    progress.observe(usage(0.01));
    progress.observe(usage(0.02));
    progress.finish();
    expect(lines.at(-1)?.props?.["costUsd"]).toBeCloseTo(0.03);
  });
});
