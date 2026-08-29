import { spawn } from "node:child_process";

/**
 * What a harness needs to run a review: the fully-assembled prompt, a working
 * directory it may read from (the checked-out target repo), and the resolved
 * secrets to inject into its subprocess env (e.g. ANTHROPIC_API_KEY).
 */
export type HarnessContext = {
  readonly prompt: string;
  readonly workdir: string;
  readonly env: Record<string, string>;
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

/** Run a command, feed the prompt on stdin, resolve with stdout. */
function runCli(
  cmd: string,
  args: readonly string[],
  ctx: HarnessContext,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ctx.workdir,
      env: { ...process.env, ...ctx.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
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

export function registry(): Map<string, Harness> {
  const harnesses = [claudeHarness(), codexHarness()];
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
