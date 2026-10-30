import { afterEach, describe, expect, it } from "vitest";

import type { Logger, LogProps } from "@loupe/logger";

import {
  REDACTION_MARK,
  runCli,
  runWhipStreaming,
  type HarnessContext,
} from "../src/index";

/**
 * N4 (INF-7471): the child env must be an explicit non-secret safelist merged
 * with only `ctx.env`, never `...process.env`. In the Action every secret lives
 * in process.env, so inheriting it would leak the whole secret set to every
 * harness regardless of its credentialKeys. N5 (INF-7472): tool_start/tool_end
 * log lines must go through the same scrub() as every other egress path. Both
 * are exercised against a throwaway node subprocess, no spawn mock.
 */

const SECRET = "sk-planted-secret-abc123def456";

function silentLogger(): Logger {
  const log: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => log,
  };
  return log;
}

/** A logger that records every info() call so a test can assert on its props. */
function capturingLogger(): {
  logger: Logger;
  infos: { message: string; props?: LogProps }[];
} {
  const infos: { message: string; props?: LogProps }[] = [];
  const log: Logger = {
    debug() {},
    info(message, props) {
      infos.push({ message, props });
    },
    warn() {},
    error() {},
    child: () => log,
  };
  return { logger: log, infos };
}

function ctx(overrides: Partial<HarnessContext> = {}): HarnessContext {
  return {
    systemPrompt: "",
    userPrompt: "prompt",
    workdir: process.cwd(),
    env: { TEST_API_KEY: SECRET },
    logger: silentLogger(),
    ...overrides,
  };
}

/** A node script that drains stdin (so the parent's write never EPIPEs). */
function node(body: string): { bin: string; args: string[] } {
  return {
    bin: process.execPath,
    args: [
      "-e",
      `let _="";process.stdin.on("data",d=>_+=d);process.stdin.on("end",()=>{${body}});`,
    ],
  };
}

describe("child env is scoped to a safelist + ctx.env (N4)", () => {
  afterEach(() => {
    delete process.env.PLANTED_SECRET;
    delete process.env.GITHUB_TOKEN;
  });

  it("hides unrelated process.env secrets from the child but passes ctx.env + PATH", async () => {
    process.env.PLANTED_SECRET = "planted-value-not-a-credential";
    process.env.GITHUB_TOKEN = "ghp-fake-token-value-1234567890";
    // Print presence as yes/no so scrubbing of values can't obscure the result.
    const script = node(
      `const has=k=>process.env[k]===undefined?"no":"yes";` +
        `process.stdout.write("PLANTED="+has("PLANTED_SECRET")+" GHTOKEN="+has("GITHUB_TOKEN")+" CRED="+has("TEST_API_KEY")+" PATH="+has("PATH"));` +
        `process.exit(0);`,
    );
    const out = await runCli(script.bin, script.args, "stdin", ctx());
    expect(out).toContain("PLANTED=no");
    expect(out).toContain("GHTOKEN=no");
    expect(out).toContain("CRED=yes");
    expect(out).toContain("PATH=yes");
  });

  it("applies the same scoping to the whip spawn", async () => {
    process.env.PLANTED_SECRET = "planted-value-not-a-credential";
    const script = node(
      `const has=k=>process.env[k]===undefined?"no":"yes";` +
        `process.stdout.write(JSON.stringify({type:"done",text:"PLANTED="+has("PLANTED_SECRET")+" CRED="+has("TEST_API_KEY")})+"\\n");` +
        `process.exit(0);`,
    );
    const out = await runWhipStreaming(script.args, ctx(), script.bin);
    expect(out).toContain("PLANTED=no");
    expect(out).toContain("CRED=yes");
  });
});

describe("tool_start/tool_end log lines are scrubbed (N5)", () => {
  it("scrubs a secret echoed in tool call args and tool result", async () => {
    const { logger, infos } = capturingLogger();
    const script = node(
      `process.stdout.write(JSON.stringify({type:"tool_start",name:"read",args:"token=${SECRET}"})+"\\n");` +
        `process.stdout.write(JSON.stringify({type:"tool_end",name:"read",result:"result ${SECRET} tail"})+"\\n");` +
        `process.exit(0);`,
    );
    await runWhipStreaming(script.args, ctx({ logger }), script.bin);

    const toolCall = infos.find((i) => i.message === "tool call");
    const toolResult = infos.find((i) => i.message === "tool result");
    expect(toolCall?.props?.["args"]).toBe(`token=${REDACTION_MARK}`);
    expect(toolResult?.props?.["result"]).toContain(REDACTION_MARK);
    expect(JSON.stringify(infos)).not.toContain(SECRET);
  });
});
