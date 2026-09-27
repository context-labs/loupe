import type { Logger } from "@loupe/logger";
import type { TurnEvent, TurnUsage } from "@whip/sdk";

import type { HarnessTraceEvent } from "./trace";

const clip = (s: string | undefined, n = 200): string | undefined =>
  s === undefined ? undefined : s.length > n ? `${s.slice(0, n)}…` : s;

type Accounting = {
  reported_cost_micros: string;
  estimated_cost_micros: string;
};

/**
 * Normalize one typed turn event into the trace events it represents, so the
 * Actions step summary keeps rendering reasoning, visible text, tool calls
 * and results without knowing the SDK. Cells (the model's Starlark) and host
 * calls (module operations) are both "tools" to the trace. `done` and `error`
 * are the harness's to emit: the turn's end event carries no text, and its
 * failure is what the harness throws. Tool payloads are truncated here so a
 * trace consumer never sees an unbounded blob.
 */
export function turnEventToTrace(event: TurnEvent): HarnessTraceEvent[] {
  switch (event.type) {
    case "reasoning":
      return [{ type: "reasoning", delta: event.delta }];
    case "text":
      return [{ type: "text", delta: event.delta }];
    case "cell":
      if (event.status === "running" && event.code !== undefined) {
        return [
          { type: "tool_start", name: "cell", args: clip(event.code, 2000) },
        ];
      }
      if (event.status === "completed") {
        return [
          {
            type: "tool_end",
            name: "cell",
            result: clip(event.result ?? event.output, 2000),
          },
        ];
      }
      return [];
    case "host":
      if (event.status === "running") {
        return [
          {
            type: "tool_start",
            name: event.operation,
            args: clip(event.summary, 2000),
          },
        ];
      }
      return [
        {
          type: "tool_end",
          name: event.operation,
          result: clip(event.error ?? event.status, 2000),
        },
      ];
    default:
      return [];
  }
}

/**
 * Turn a run's typed turn events into the live log a `whip run` gave:
 * throttled `thinking` / `streaming reply` counters, one line per cell and
 * host call, hook decisions, child lifecycle, and a `run finished` line with
 * cost. Events from a child agent carry its id. Pure over events, so it is
 * unit-testable with scripted ones.
 */
export class RunProgress {
  private text = 0;
  private textLogged = 0;
  private thinking = 0;
  private thinkingLogged = 0;
  private costMicros: bigint | undefined;
  /** Sum of the per-call cost carried on usage events, in dollars. */
  private usageCost = 0;

  constructor(
    private readonly log: Logger,
    private readonly rootId: string,
  ) {}

  observe(event: TurnEvent): void {
    const who =
      event.agentId && event.agentId !== this.rootId
        ? { agent: event.agentId }
        : {};
    switch (event.type) {
      case "reasoning":
        if (who.agent) return;
        this.thinking += event.delta.length;
        if (this.thinking - this.thinkingLogged >= 200) {
          this.log.info("thinking", { chars: this.thinking });
          this.thinkingLogged = this.thinking;
        }
        return;
      case "text":
        if (who.agent) return;
        this.text += event.delta.length;
        if (this.text - this.textLogged >= 120) {
          this.log.info("streaming reply", { chars: this.text });
          this.textLogged = this.text;
        }
        return;
      case "cell":
        if (event.status === "running" && event.code !== undefined) {
          this.log.info("cell", { ...who, code: clip(event.code) });
        } else if (event.status === "completed") {
          this.log.debug("cell result", {
            ...who,
            result: clip(event.result, 600),
          });
        } else if (event.output !== undefined) {
          this.log.debug("cell output", {
            ...who,
            text: clip(event.output, 600),
          });
        }
        return;
      case "host":
        if (event.status === "running") {
          this.log.info("host call", {
            ...who,
            operation: event.operation,
            args: clip(event.summary),
          });
        } else if (event.status === "failed") {
          this.log.warn("host call failed", {
            ...who,
            operation: event.operation,
            error: clip(event.error, 300),
          });
        } else {
          this.log.debug("host result", {
            ...who,
            operation: event.operation,
            status: event.status,
          });
        }
        return;
      case "progress":
        this.log.info("tool progress", {
          ...who,
          operation: event.operation,
          text: clip(event.text),
        });
        return;
      case "hook":
        this.log.info("hook decision", {
          ...who,
          hook: event.hook,
          decision: event.decision,
          operation: event.operation,
          reason: clip(event.reason),
        });
        return;
      case "child":
        if (event.kind === "agent.admitted") {
          this.log.info("child agent spawned", { agent: event.childId });
        } else if (event.kind === "agent.turn.failed") {
          this.log.warn("child turn failed", {
            agent: event.childId,
            status: event.status,
          });
        } else {
          this.log.debug("child", {
            agent: event.childId,
            kind: event.kind,
            status: event.status,
          });
        }
        return;
      case "usage":
        this.usageCost += event.usage.usage.cost ?? 0;
        return;
      case "end":
        if (event.error) {
          this.log.warn(who.agent ? "child turn failed" : "turn failed", {
            ...who,
            error: clip(event.error, 300),
          });
        }
        return;
      case "raw": {
        const payload = event.event.payload as
          | { accounting?: Accounting | null }
          | undefined;
        if (event.event.kind === "stream.accounting" && payload?.accounting) {
          // Providers without a price list report 0; the estimate still counts.
          const reported = BigInt(payload.accounting.reported_cost_micros);
          this.costMicros =
            reported > 0n
              ? reported
              : BigInt(payload.accounting.estimated_cost_micros);
        } else {
          this.log.debug("event", { ...who, kind: event.event.kind });
        }
        return;
      }
      default:
        this.log.debug("event", { ...who, kind: event.type });
    }
  }

  /** Log the run's totals once the turn has settled. */
  finish(usage?: TurnUsage): void {
    const props: Record<string, unknown> = { replyChars: this.text };
    if (this.thinking > 0) props["thinkingChars"] = this.thinking;
    if (usage) {
      props["promptTokens"] = usage.usage.prompt_tokens;
      props["completionTokens"] = usage.usage.completion_tokens;
    }
    // Accounting events, when they fall inside the turn window, are authoritative;
    // otherwise the per-call cost on usage events adds up to the same number.
    if (this.costMicros !== undefined) {
      props["costUsd"] = Number(this.costMicros) / 1_000_000;
    } else if (this.usageCost > 0) {
      props["costUsd"] = this.usageCost;
    }
    this.log.info("run finished", props);
  }
}
