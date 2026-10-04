import type { Logger } from "@loupe/logger";
import type { Schema } from "@whip/sdk";
import type { AgentDefinition } from "@whip/sdk/agents";
import type { WhipClient } from "@whip/sdk/node";

import { chatAgent, fixerAgent, reviewerAgent, verifierAgent } from "./agents";
import { runAgent, type RunOutcome } from "./client";
import { HarnessError, classifyHarnessError } from "./errors";
import { turnEventToTrace } from "./progress";
import {
  envSecretValues,
  redactSecrets,
  type HarnessTraceEvent,
} from "./trace";

export {
  HarnessError,
  classifyHarnessError,
  isNonRetryableHarnessError,
  type HarnessErrorKind,
} from "./errors";
export * from "./trace";
export {
  PINNED_WHIP_TAG,
  ensureDaemon,
  homeEnvName,
  installPinnedWhip,
  materializeWhipHome,
  pinnedWhipAsset,
  pinnedWhipPath,
  planDaemonEnv,
  resolveWhipBinary,
} from "./daemon";
export type { DaemonHandle, WhipConfig } from "./daemon";
export { connect, discoverModels, runAgent, serveAgent } from "./client";
export type {
  AgentRun,
  RunOutcome,
  RunSpec,
  ServedAgent,
  SessionParams,
} from "./client";
export { RunProgress, turnEventToTrace } from "./progress";
export {
  FIXER_HOOK_OPERATIONS,
  REVIEWER_HOOK_OPERATIONS,
  fixerBeforeTool,
  inside,
  reviewerBeforeTool,
} from "./hooks";
export {
  chatAgent,
  contentId,
  definitionId,
  fixerAgent,
  reviewerAgent,
  verifierAgent,
} from "./agents";
export type { WhipClient } from "@whip/sdk/node";
export type { AgentDefinition } from "@whip/sdk/agents";

/** Reasoning effort set on each session natively (whip's `session.effort`). */
export type ReasoningEffort = "low" | "medium" | "high";

/** The loupe agents: which definition a context runs under. */
export type AgentKind = "reviewer" | "verifier" | "chat" | "fixer";

/**
 * What a harness needs to run one turn: which loupe agent, the system prompt
 * that becomes its persona, the user prompt for the turn, the output contract
 * its final message must match (none for prose), the model and provider,
 * a working directory its file tools operate in, and a logger so the run is
 * observable. The daemon is process-wide; nothing here chooses it.
 */
export type HarnessContext = {
  readonly agent: AgentKind;
  /** Output contract the daemon validates the final message against; the
   * validated value comes back as `RunOutcome.output`. Absent for prose. */
  readonly output?: Schema;
  /** Label folded into the definition id (e.g. the reviewer name). */
  readonly name?: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** Model id (e.g. "kimi-k3"); empty uses the daemon's default. */
  readonly model?: string;
  /** Provider the model is routed through (the whip block's); empty uses the
   * daemon's default, which on a desktop daemon may not carry the model. */
  readonly provider?: string;
  /** Allow the agent to use tools and explore the checkout (vs diff-only). */
  readonly agentic?: boolean;
  readonly workdir: string;
  /** Cap on the agentic tool loop; harness default (10) when unset. */
  readonly maxTurns?: number;
  /** Native reasoning effort. Unset leaves the daemon's own default in place. */
  readonly reasoning?: ReasoningEffort;
  /** Stable prompt-cache key (e.g. repo/reviewer) so the provider reuses the
   * cached system prefix across runs. Passed to whip as `cache_key`. */
  readonly cacheKey?: string;
  /**
   * Optional trace sink. When supplied, every harness event (reasoning deltas,
   * text, tool_start/tool_end, done/error) is normalized and emitted here so a
   * caller can observe/record the run's progress and outcome. No-op when unset.
   */
  readonly trace?: (event: HarnessTraceEvent) => void;
  /**
   * Optional label for which pass or phase this context belongs to (e.g.
   * "primary", "fallback", "ensemble:model", "verify"). Carried onto emitted
   * trace events so downstream renderers can group them; purely informational.
   */
  readonly phase?: string;
  readonly logger: Logger;
};

/**
 * The seam the review pipeline drives. `review` runs one turn to completion
 * and returns its final text and, under an output contract, the validated
 * value; turning that into findings is the core's job, not the harness's.
 */
export type Harness = {
  readonly name: string;
  review(ctx: HarnessContext): Promise<RunOutcome>;
};

/** The definition a context runs under: the prompt as persona, the contract
 * on the final message, and the modules and hooks its kind calls for. */
export function agentFor(ctx: HarnessContext): AgentDefinition {
  switch (ctx.agent) {
    case "reviewer":
      return reviewerAgent({
        name: ctx.name,
        systemPrompt: ctx.systemPrompt,
        agentic: ctx.agentic ?? false,
        output: ctx.output,
      });
    case "verifier":
      return verifierAgent({
        systemPrompt: ctx.systemPrompt,
        agentic: ctx.agentic ?? false,
        output: ctx.output,
      });
    case "chat":
      return chatAgent(ctx.systemPrompt);
    case "fixer":
      return fixerAgent(ctx.systemPrompt, ctx.workdir);
  }
}

/**
 * whip through its SDK: each `review` serves the context's definition from
 * this process, opens one session pinned to it on the shared daemon, runs the
 * turn, and lets both go. The daemon validates the final message against the
 * definition's output contract and corrects it once; the turn's typed events
 * feed the log and the trace sink. Known secrets are scrubbed from every
 * trace payload so an API key surfacing in a tool result never lands in a
 * step summary.
 */
export function whipHarness(
  client: WhipClient,
  secrets: readonly string[] = envSecretValues(process.env),
): Harness {
  return {
    name: "whip",
    review: async (ctx) => {
      const scrub = (s: string | undefined): string | undefined =>
        s === undefined ? undefined : redactSecrets(s, secrets);
      const emit = (event: HarnessTraceEvent): void =>
        ctx.trace?.({
          ...event,
          ...("delta" in event ? { delta: scrub(event.delta) } : {}),
          ...("args" in event ? { args: scrub(event.args) } : {}),
          ...("result" in event ? { result: scrub(event.result) } : {}),
          ...("text" in event ? { text: scrub(event.text) } : {}),
          ...("error" in event ? { error: scrub(event.error) } : {}),
          model: event.model ?? ctx.model,
          phase: event.phase ?? ctx.phase,
        } as HarnessTraceEvent);
      // Agentic reviews need room to explore the checkout with tools; headless
      // diff-only reviews should answer in one turn, capped as a safety net.
      // The agentic cap is configurable (config.json maxTurns / --max-turns).
      const maxTurns = ctx.agentic ? (ctx.maxTurns ?? 10) : 10;
      try {
        const outcome = await runAgent(client, {
          agent: agentFor(ctx),
          cwd: ctx.workdir,
          prompt: ctx.userPrompt,
          model: ctx.model,
          provider: ctx.provider,
          effort: ctx.reasoning,
          maxTurns,
          cacheKey: ctx.cacheKey,
          onEvent: (event) => {
            for (const t of turnEventToTrace(event)) emit(t);
          },
          logger: ctx.logger,
        });
        emit({ type: "done", text: outcome.text });
        return outcome;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: "error", error: message });
        throw new HarnessError(message, classifyHarnessError(message));
      }
    },
  };
}
