import { spawn } from "node:child_process";

import type { Logger } from "@loupe/logger";

/**
 * What a harness needs to run a review: the fully-assembled prompt, a working
 * directory it may read from (the checked-out target repo), the resolved
 * secrets to inject into its subprocess env (e.g. ANTHROPIC_API_KEY), and a
 * logger so subprocess output is observable.
 */
export type HarnessContext = {
  readonly prompt: string;
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
 * Run a command, feed the prompt on stdin, resolve with stdout. stderr is
 * streamed to the logger at debug (live visibility into what the agent is
 * doing), and the full stdout is logged at debug on completion so an empty or
 * non-JSON response is diagnosable. A non-zero exit rejects with stderr.
 */
function runCli(
  cmd: string,
  args: readonly string[],
  ctx: HarnessContext,
): Promise<string> {
  const log = ctx.logger.child(cmd);
  log.debug("Spawning harness", { args, cwd: ctx.workdir });
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ctx.workdir,
      env: { ...process.env, ...ctx.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
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
    child.stdin.write(ctx.prompt);
    child.stdin.end();
  });
}

/** Claude Code CLI: `claude -p` reads the prompt from stdin, prints to stdout. */
export function claudeHarness(): Harness {
  return {
    name: "claude",
    credentialKeys: ["ANTHROPIC_API_KEY"],
    available: () => commandExists("claude"),
    review: (ctx) => runCli("claude", ["-p", "--permission-mode", "plan"], ctx),
  };
}

/** OpenAI Codex CLI: `codex exec` runs a one-shot prompt. */
export function codexHarness(): Harness {
  return {
    name: "codex",
    credentialKeys: ["OPENAI_API_KEY"],
    available: () => commandExists("codex"),
    review: (ctx) => runCli("codex", ["exec", "-"], ctx),
  };
}

/**
 * whip is agentic — by default the model tries to explore the repo with tools.
 * In a headless review there's no checkout, so a tool-use loop either exits with
 * no final text (uncapped) or hard-fails (capped). This system prompt tells the
 * model to answer straight from the diff, which keeps it to a single completion.
 */
const WHIP_SYSTEM =
  "You are a non-interactive code reviewer in headless mode with NO repository " +
  "access. Do NOT call any tools or try to read files — you cannot, and any " +
  "tool call wastes the run. Review strictly from the diff in the user message " +
  "and reply with ONLY the JSON object it asks for.";

/**
 * whip (context-labs custom harness): `whip run` reads the prompt from stdin
 * and streams the reply to stdout. It self-authenticates from its own local
 * login (~/.whip/), so loupe injects no credentials — being logged in via
 * `whip auth inference-net login` is the only requirement. `-max-turns` caps
 * the loop as a safety net in case the model ignores the no-tools directive.
 */
export function whipHarness(): Harness {
  return {
    name: "whip",
    credentialKeys: [],
    available: () => commandExists("whip"),
    review: (ctx) =>
      runCli(
        "whip",
        [
          "run",
          "-quiet",
          "-no-session",
          "-max-turns",
          "10",
          "-system",
          WHIP_SYSTEM,
        ],
        ctx,
      ),
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
