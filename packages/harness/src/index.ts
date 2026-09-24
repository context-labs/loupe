import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "@loupe/logger";

import { HarnessError, classifyHarnessError } from "./errors";
import type { HarnessTraceEvent } from "./trace";
import { envSecretValues, redactSecrets } from "./trace";

export {
  HarnessError,
  classifyHarnessError,
  isNonRetryableHarnessError,
  type HarnessErrorKind,
} from "./errors";
export * from "./trace";

/**
 * A whip provider + model catalog, declared in loupe's config so the review
 * workflow doesn't have to hand-write `~/.whip/config.json` in a CI step. When
 * present, the whip harness materializes it into a throwaway config dir and
 * points `WHIP_HOME` at it — never touching a developer's real `~/.whip`.
 */
export type WhipConfig = {
  /** OpenAI-compatible provider whip routes through. */
  readonly provider: {
    /** Provider key (e.g. "inference-net"). */
    readonly name: string;
    readonly baseUrl: string;
    /** Env var whip reads the API key from at runtime (e.g. "INFERENCE_API_KEY"). */
    readonly apiKeyEnv: string;
    /** Display label; defaults to `name`. */
    readonly label?: string;
  };
  /** Models whip may route to (the panel). The first is the default if unset. */
  readonly models: readonly string[];
  /** Default model; defaults to the review's model, else the first in `models`. */
  readonly defaultModel?: string;
};

/**
 * What a harness needs to run a review: the system prompt (reviewer persona +
 * output contract) and the user prompt (the diff), the model to use, a working
 * directory it may read from, the resolved secrets to inject into its subprocess
 * env (e.g. ANTHROPIC_API_KEY), and a logger so subprocess output is observable.
 */
/** Reasoning effort passed to the harness natively (whip defaultEffort, claude --effort, codex model_reasoning_effort). */
export type ReasoningEffort = "low" | "medium" | "high";

export type HarnessContext = {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** Model id, harness-specific (e.g. "kimi-k3", "claude-opus-4-8"). */
  readonly model?: string;
  /** Allow the agent to use tools and explore the checkout (vs diff-only). */
  readonly agentic?: boolean;
  readonly workdir: string;
  readonly env: Record<string, string>;
  /** whip provider/model catalog to materialize into a throwaway WHIP_HOME. */
  readonly whipConfig?: WhipConfig;
  /** Cap on the agentic tool loop; harness default (10) when unset. */
  readonly maxTurns?: number;
  /**
   * Native reasoning effort. Unset leaves the harness's own default in place
   * (whip picks a model-aware default; claude/codex use their config).
   */
  readonly reasoning?: ReasoningEffort;
  /** Stable prompt-cache key (e.g. repo/reviewer) so the provider reuses the
   * cached system prefix across runs. Passed to whip as -cache-key. */
  readonly cacheKey?: string;
  /**
   * Optional trace sink. When supplied, every harness event (reasoning deltas,
   * text, tool_start/tool_end, done/error) is normalized and emitted here so a
   * caller can observe/record the run's progress and outcome without parsing
   * raw subprocess output. No-op when unset.
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
 * A coding-agent CLI wrapped as a reviewer. `review` runs the CLI to completion
 * and returns its raw stdout; parsing findings out of that text is the core's
 * job, not the harness's — keeps adapters dumb and swappable.
 */
export type Harness = {
  readonly name: string;
  /** Which secret keys this harness expects to find in `ctx.env`. */
  readonly credentialKeys: readonly string[];
  /** Is the CLI actually installed and runnable? */
  available(): Promise<boolean>;
  review(ctx: HarnessContext): Promise<string>;
};

function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("which", [cmd], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Run a command, feed `stdin` in, resolve with stdout. stderr is streamed to the
 * logger at debug (live visibility into what the agent is doing), and the full
 * stdout is logged at debug on completion so an empty or non-JSON response is
 * diagnosable. A non-zero exit rejects with stderr.
 */
function runCli(
  cmd: string,
  args: readonly string[],
  stdin: string,
  ctx: HarnessContext,
): Promise<string> {
  const log = ctx.logger.child(cmd);
  const secrets = envSecretValues({ ...process.env, ...ctx.env });
  const emit = (event: HarnessTraceEvent): void =>
    ctx.trace?.({
      ...event,
      ...(event.type === "done"
        ? { text: redactSecrets(event.text, secrets) }
        : event.type === "error"
          ? { error: redactSecrets(event.error, secrets) }
          : {}),
      model: event.model ?? ctx.model,
      phase: event.phase ?? ctx.phase,
    });
  log.debug("Spawning harness", { args, cwd: ctx.workdir, model: ctx.model });
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ctx.workdir,
      env: { ...process.env, ...ctx.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      log.debug(chunk.trimEnd());
    });
    child.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;
      log.debug(chunk.trimEnd());
    });
    child.on("error", (err) => {
      emit({ type: "error", error: err.message });
      reject(
        new HarnessError(err instanceof Error ? err.message : String(err)),
      );
    });
    child.on("close", (code) => {
      log.debug("Harness exited", { code, stdoutChars: stdout.length });
      log.debug("Harness stdout", { stdout });
      if (code === 0) {
        emit({ type: "done", text: stdout });
        resolve(stdout);
      } else {
        const message = `${cmd} exited ${code}: ${stderr.slice(0, 2000)}`;
        emit({ type: "error", error: message });
        reject(new HarnessError(message, classifyHarnessError(message)));
      }
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** Argument list for `claude -p`; exported so the flag mapping is testable. */
export function buildClaudeArgs(
  ctx: Pick<HarnessContext, "systemPrompt" | "model" | "reasoning">,
): string[] {
  const args = [
    "-p",
    "--permission-mode",
    "plan",
    "--append-system-prompt",
    ctx.systemPrompt,
  ];
  if (ctx.model) args.push("--model", ctx.model);
  if (ctx.reasoning) args.push("--effort", ctx.reasoning);
  return args;
}

/** Claude Code CLI: `claude -p` reads the user prompt from stdin. */
export function claudeHarness(): Harness {
  return {
    name: "claude",
    credentialKeys: ["ANTHROPIC_API_KEY"],
    available: () => commandExists("claude"),
    review: (ctx) =>
      runCli("claude", buildClaudeArgs(ctx), ctx.userPrompt, ctx),
  };
}

/** Argument list for `codex exec`; exported so the flag mapping is testable. */
export function buildCodexArgs(
  ctx: Pick<HarnessContext, "model" | "reasoning">,
): string[] {
  const args = ["exec"];
  if (ctx.model) args.push("--model", ctx.model);
  if (ctx.reasoning) args.push("-c", `model_reasoning_effort=${ctx.reasoning}`);
  args.push("-");
  return args;
}

/** OpenAI Codex CLI: `codex exec` runs a one-shot prompt from stdin. */
export function codexHarness(): Harness {
  return {
    name: "codex",
    credentialKeys: ["OPENAI_API_KEY"],
    available: () => commandExists("codex"),
    review: (ctx) => {
      // Codex has no system-prompt flag; prepend it to the piped input.
      const stdin = `${ctx.systemPrompt}\n\n---\n\n${ctx.userPrompt}`;
      return runCli("codex", buildCodexArgs(ctx), stdin, ctx);
    },
  };
}

/**
 * Stream whip's `--format json` NDJSON event stream, logging activity live
 * (tool calls at info, reply text as it arrives at debug) so a long run is
 * observable instead of silent. Resolves with the assembled assistant text
 * (the review JSON), so the core parses it the same as any other harness.
 */
function runWhipStreaming(
  args: readonly string[],
  ctx: HarnessContext,
): Promise<string> {
  const log = ctx.logger.child("whip");
  // Known secrets (resolved credential values handed to the subprocess via env)
  // are scrubbed from every trace payload downstream so an API key that happens
  // to surface in a tool result or reasoning chunk never lands in the summary.
  const secrets = envSecretValues({ ...process.env, ...ctx.env });
  const scrub = (s: string | undefined): string | undefined =>
    s === undefined ? undefined : redactSecrets(s, secrets);
  // Scrub every string field on an event (delta/args/result/text/error).
  const scrubEvent = (event: HarnessTraceEvent): HarnessTraceEvent =>
    ({
      ...event,
      ...("delta" in event ? { delta: scrub(event.delta) } : {}),
      ...("args" in event ? { args: scrub(event.args) } : {}),
      ...("result" in event ? { result: scrub(event.result) } : {}),
      ...("text" in event ? { text: scrub(event.text) } : {}),
      ...("error" in event ? { error: scrub(event.error) } : {}),
    }) as HarnessTraceEvent;
  // Normalize and forward a raw NDJSON event to the optional trace sink,
  // tagging it with the run's model/phase so renderers can label provenance.
  const emit = (event: HarnessTraceEvent): void =>
    ctx.trace?.({
      ...scrubEvent(event),
      model: event.model ?? ctx.model,
      phase: event.phase ?? ctx.phase,
    });
  log.debug("Spawning harness", { args, cwd: ctx.workdir, model: ctx.model });
  return new Promise((resolve, reject) => {
    const child = spawn("whip", args, {
      cwd: ctx.workdir,
      env: { ...process.env, ...ctx.env },
    });
    let buffer = ""; // partial NDJSON line
    let text = ""; // accumulated assistant reply
    let logged = 0; // chars already flushed to the log
    let thinking = 0; // reasoning chars seen
    let thinkingLogged = 0; // reasoning chars already flushed to the log
    let stderr = "";
    let final: string | undefined;

    const handle = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        log.debug(trimmed); // non-JSON note — surface it raw
        return;
      }
      for (const t of whipEventToTrace(event)) emit(t);
      switch (event["type"]) {
        case "reasoning":
          if (typeof event["delta"] === "string") {
            thinking += event["delta"].length;
          }
          if (thinking - thinkingLogged >= 200) {
            log.info("thinking", { chars: thinking });
            thinkingLogged = thinking;
          }
          break;
        case "text":
          if (typeof event["delta"] === "string") text += event["delta"];
          if (text.length - logged >= 120) {
            log.info("streaming reply", { chars: text.length });
            logged = text.length;
          }
          break;
        case "tool_start":
          log.info("tool call", { name: event["name"], args: event["args"] });
          break;
        case "tool_end":
          log.info("tool result", {
            name: event["name"],
            result:
              typeof event["result"] === "string"
                ? event["result"].slice(0, 300)
                : undefined,
          });
          break;
        case "done":
          final = typeof event["text"] === "string" ? event["text"] : text;
          break;
        case "error": {
          const message = `whip error: ${JSON.stringify(event["error"])}`;
          reject(new HarnessError(message, classifyHarnessError(message)));
          break;
        }
        default:
          log.debug("event", event);
      }
    };

    child.stdout.on("data", (d: Buffer) => {
      buffer += d.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handle(line);
    });
    child.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;
      log.debug(chunk.trimEnd());
    });
    child.on("error", (e) =>
      reject(new HarnessError(e instanceof Error ? e.message : String(e))),
    );
    child.on("close", (code) => {
      if (buffer.trim()) handle(buffer);
      const out = final ?? text;
      log.debug("Harness exited", { code, replyChars: out.length });
      if (code === 0) resolve(out);
      else {
        const message = `whip exited ${code}: ${stderr.slice(0, 2000)}`;
        reject(new HarnessError(message, classifyHarnessError(message)));
      }
    });
    child.stdin.write(ctx.userPrompt);
    child.stdin.end();
  });
}

/**
 * Normalize one raw whip NDJSON event into the normalized trace events it
 * represents. Exported so the mapping is unit-testable without spawning a whip
 * process. Unknown event types and malformed payloads map to an empty list.
 * Tool args/results are truncated here so a trace consumer never sees an
 * unbounded blob.
 */
export function whipEventToTrace(raw: unknown): HarnessTraceEvent[] {
  if (!raw || typeof raw !== "object") return [];
  const event = raw as Record<string, unknown>;
  const name =
    typeof event["name"] === "string" ? (event["name"] as string) : "tool";
  const serialize = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === "string") return value.slice(0, 2000);
    try {
      return JSON.stringify(value).slice(0, 2000);
    } catch {
      return "[unserializable tool payload]";
    }
  };
  switch (event["type"]) {
    case "reasoning":
      return typeof event["delta"] === "string"
        ? [{ type: "reasoning", delta: event["delta"] as string }]
        : [];
    case "text":
      return typeof event["delta"] === "string"
        ? [{ type: "text", delta: event["delta"] as string }]
        : [];
    case "tool_start":
      return [
        {
          type: "tool_start",
          name,
          args: serialize(event["args"]),
        },
      ];
    case "tool_end":
      return [
        {
          type: "tool_end",
          name,
          result: serialize(event["result"]),
        },
      ];
    case "done":
      return [
        {
          type: "done",
          text:
            typeof event["text"] === "string" ? (event["text"] as string) : "",
        },
      ];
    case "error":
      return [
        { type: "error", error: JSON.stringify(event["error"] ?? event) },
      ];
    default:
      return [];
  }
}

/**
 * Materialize a WhipConfig into a throwaway config dir and return the env
 * (WHIP_HOME) that points whip at it. Keeps loupe's `whip` block out of a
 * developer's real ~/.whip and removes the hand-written config step from CI.
 */
export function materializeWhipHome(
  cfg: WhipConfig,
  reasoning?: ReasoningEffort,
): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "loupe-whip-"));
  const providerKey = cfg.provider.name;
  const defaultModel = cfg.defaultModel ?? cfg.models[0];
  const config = {
    defaultModel,
    defaultProvider: providerKey,
    // An explicit effort pins whip's reasoning_effort for every request. Left
    // out, whip picks its model-aware default.
    ...(reasoning ? { defaultEffort: reasoning } : {}),
    providers: {
      [providerKey]: {
        name: cfg.provider.label ?? providerKey,
        baseUrl: cfg.provider.baseUrl,
        api: "openai-completions",
        apiKeyEnv: cfg.provider.apiKeyEnv,
      },
    },
    models: Object.fromEntries(
      cfg.models.map((m) => [m, { providers: [providerKey] }]),
    ),
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  return { WHIP_HOME: dir };
}

/**
 * Decide whether a whip failure is a prompt-cache-key incompatibility worth one
 * retry without the key. Two cases, both requiring a key was actually sent:
 *   1. an older whip that predates the `-cache-key` flag ("flag provided but
 *      not defined: -cache-key"); and
 *   2. a provider that accepts the flag but rejects the resulting
 *      `prompt_cache_key` argument as unrecognized — some OpenAI-compatible
 *      endpoints strict-validate unknown fields. Those providers cache the
 *      stable system prefix automatically by prefix match, so dropping the key
 *      costs nothing and unblocks the model.
 * Exported so the retry condition is unit-testable without spawning whip.
 */
export function shouldRetryWithoutCacheKey(
  err: unknown,
  cacheKey?: string,
): boolean {
  if (!cacheKey) return false;
  const msg = String(err);
  return (
    /flag provided but not defined: -cache-key/.test(msg) ||
    /prompt_cache_key/i.test(msg)
  );
}

/**
 * whip (context-labs custom harness): runs `whip run --format json` and streams
 * the event log live. `-system` sets the reviewer/output/headless instructions.
 * By default it self-authenticates from its own local login (~/.whip/); when a
 * `whipConfig` is supplied, loupe writes a throwaway WHIP_HOME config declaring
 * the provider + model panel instead. `-max-turns` caps the tool loop as a
 * safety net in case the model ignores the headless directive.
 */
export function whipHarness(): Harness {
  return {
    name: "whip",
    credentialKeys: [],
    available: () => commandExists("whip"),
    review: (ctx) => {
      // Agentic reviews need room to explore the checkout with tools; headless
      // diff-only reviews should answer in one turn, capped as a safety net.
      // The agentic cap is configurable (config.json maxTurns / --max-turns).
      const maxTurns = ctx.agentic ? String(ctx.maxTurns ?? 10) : "10";
      const args = [
        "run",
        "--format",
        "json",
        "-quiet",
        "-no-session",
        "-max-turns",
        maxTurns,
        "-system",
        ctx.systemPrompt,
      ];
      if (ctx.model) args.push("-m", ctx.model);
      const whipEnv = ctx.whipConfig
        ? materializeWhipHome(ctx.whipConfig, ctx.reasoning)
        : {};
      if (ctx.reasoning && !ctx.whipConfig) {
        ctx.logger
          .child("whip")
          .warn(
            "reasoning is set but no whip config block is materialized; whip's own default effort applies",
          );
      }
      const runCtx = { ...ctx, env: { ...ctx.env, ...whipEnv } };
      // Stable cache key → the provider reuses the cached prefix across runs.
      // Tolerate an older whip that predates the flag: on "flag not defined:
      // -cache-key", retry without it (caching off, but the review still runs).
      const withKey = ctx.cacheKey
        ? [...args, "-cache-key", ctx.cacheKey]
        : args;
      return runWhipStreaming(withKey, runCtx).catch((err: unknown) => {
        // A reviewer that opted out via promptCache:false has cacheKey
        // undefined, so this never fires for it — no wasted retry.
        if (shouldRetryWithoutCacheKey(err, ctx.cacheKey)) {
          ctx.logger
            .child("whip")
            .warn(
              "prompt cache key rejected; retrying without it. " +
                "Set promptCache:false to skip this retry.",
            );
          return runWhipStreaming(args, runCtx);
        }
        throw err;
      });
    },
  };
}

export function registry(): Map<string, Harness> {
  const harnesses = [claudeHarness(), codexHarness(), whipHarness()];
  return new Map(harnesses.map((h) => [h.name, h]));
}

export function getHarness(name: string): Harness {
  const h = registry().get(name);
  if (!h) {
    const known = [...registry().keys()].join(", ");
    throw new Error(`Unknown harness "${name}". Known: ${known}`);
  }
  return h;
}
