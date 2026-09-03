import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "@loupe/logger";

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
  /** Stable prompt-cache key (e.g. repo/reviewer) so the provider reuses the
   * cached system prefix across runs. Passed to whip as -cache-key. */
  readonly cacheKey?: string;
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
    child.on("error", reject);
    child.on("close", (code) => {
      log.debug("Harness exited", { code, stdoutChars: stdout.length });
      log.debug("Harness stdout", { stdout });
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 2000)}`));
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** Claude Code CLI: `claude -p` reads the user prompt from stdin. */
export function claudeHarness(): Harness {
  return {
    name: "claude",
    credentialKeys: ["ANTHROPIC_API_KEY"],
    available: () => commandExists("claude"),
    review: (ctx) => {
      const args = [
        "-p",
        "--permission-mode",
        "plan",
        "--append-system-prompt",
        ctx.systemPrompt,
      ];
      if (ctx.model) args.push("--model", ctx.model);
      return runCli("claude", args, ctx.userPrompt, ctx);
    },
  };
}

/** OpenAI Codex CLI: `codex exec` runs a one-shot prompt from stdin. */
export function codexHarness(): Harness {
  return {
    name: "codex",
    credentialKeys: ["OPENAI_API_KEY"],
    available: () => commandExists("codex"),
    review: (ctx) => {
      const args = ["exec"];
      if (ctx.model) args.push("--model", ctx.model);
      // Codex has no system-prompt flag; prepend it to the piped input.
      const stdin = `${ctx.systemPrompt}\n\n---\n\n${ctx.userPrompt}`;
      args.push("-");
      return runCli("codex", args, stdin, ctx);
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
          log.info("tool result", { name: event["name"] });
          break;
        case "done":
          final = typeof event["text"] === "string" ? event["text"] : text;
          break;
        case "error":
          reject(new Error(`whip error: ${JSON.stringify(event["error"])}`));
          break;
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
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffer.trim()) handle(buffer);
      const out = final ?? text;
      log.debug("Harness exited", { code, replyChars: out.length });
      if (code === 0) resolve(out);
      else reject(new Error(`whip exited ${code}: ${stderr.slice(0, 2000)}`));
    });
    child.stdin.write(ctx.userPrompt);
    child.stdin.end();
  });
}

/**
 * Materialize a WhipConfig into a throwaway config dir and return the env
 * (WHIP_HOME) that points whip at it. Keeps loupe's `whip` block out of a
 * developer's real ~/.whip and removes the hand-written config step from CI.
 */
export function materializeWhipHome(cfg: WhipConfig): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "loupe-whip-"));
  const providerKey = cfg.provider.name;
  const defaultModel = cfg.defaultModel ?? cfg.models[0];
  const config = {
    defaultModel,
    defaultProvider: providerKey,
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
      const whipEnv = ctx.whipConfig ? materializeWhipHome(ctx.whipConfig) : {};
      const runCtx = { ...ctx, env: { ...ctx.env, ...whipEnv } };
      // Stable cache key → the provider reuses the cached prefix across runs.
      // Tolerate an older whip that predates the flag: on "flag not defined:
      // -cache-key", retry without it (caching off, but the review still runs).
      const withKey = ctx.cacheKey
        ? [...args, "-cache-key", ctx.cacheKey]
        : args;
      return runWhipStreaming(withKey, runCtx).catch((err: unknown) => {
        if (
          ctx.cacheKey &&
          /flag provided but not defined: -cache-key/.test(String(err))
        ) {
          ctx.logger
            .child("whip")
            .warn(
              "whip does not support -cache-key; retrying without it. Upgrade whip to enable prompt caching.",
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
