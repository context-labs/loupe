import { spawn } from "node:child_process";

import type { Logger } from "@loupe/logger";

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
  readonly workdir: string;
  readonly env: Record<string, string>;
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
 * whip (context-labs custom harness): runs `whip run --format json` and streams
 * the event log live. `-system` sets the reviewer/output/headless instructions.
 * It self-authenticates from its own local login (~/.whip/), so loupe injects no
 * credentials. `-max-turns` caps the tool loop as a safety net in case the model
 * ignores the headless (no-tools) directive in the system prompt.
 */
export function whipHarness(): Harness {
  return {
    name: "whip",
    credentialKeys: [],
    available: () => commandExists("whip"),
    review: (ctx) => {
      const args = [
        "run",
        "--format",
        "json",
        "-quiet",
        "-no-session",
        "-max-turns",
        "10",
        "-system",
        ctx.systemPrompt,
      ];
      if (ctx.model) args.push("-m", ctx.model);
      return runWhipStreaming(args, ctx);
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
