import { describe, expect, it } from "vitest";

import type { Logger } from "@loupe/logger";

import {
  HarnessError,
  REDACTION_MARK,
  runCli,
  runWhipStreaming,
  type HarnessContext,
} from "../src/index";

/**
 * These tests pin the F-93 fix: known secrets must be scrubbed from the value
 * the harness RETURNS (what every publisher posts to GitHub), not only from the
 * trace copy. We drive the real adapters against a throwaway `node` subprocess
 * so the resolved reply / thrown error is exercised end to end, no spawn mock.
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

describe("runWhipStreaming redacts secrets from the returned reply", () => {
  it("scrubs the secret out of a done event's final text", async () => {
    const script = node(
      `process.stdout.write(JSON.stringify({type:"done",text:"final has ${SECRET} inside"})+"\\n");process.exit(0);`,
    );
    const out = await runWhipStreaming(script.args, ctx(), script.bin);
    expect(out).not.toContain(SECRET);
    expect(out).toContain(REDACTION_MARK);
  });

  it("scrubs the secret out of accumulated text deltas (no done event)", async () => {
    const script = node(
      `process.stdout.write(JSON.stringify({type:"text",delta:"key is ${SECRET} ok"})+"\\n");process.exit(0);`,
    );
    const out = await runWhipStreaming(script.args, ctx(), script.bin);
    expect(out).not.toContain(SECRET);
    expect(out).toContain(REDACTION_MARK);
  });

  it("scrubs the secret out of stderr embedded in the thrown error", async () => {
    const script = node(
      `process.stderr.write("boom ${SECRET} boom");process.exit(2);`,
    );
    await expect(
      runWhipStreaming(script.args, ctx(), script.bin),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof HarnessError &&
        !e.message.includes(SECRET) &&
        e.message.includes(REDACTION_MARK),
    );
  });
});

describe("runCli redacts secrets from the resolved reply", () => {
  it("scrubs the secret out of stdout", async () => {
    const script = node(
      `process.stdout.write("reply with ${SECRET} inside");process.exit(0);`,
    );
    const out = await runCli(script.bin, script.args, "stdin", ctx());
    expect(out).not.toContain(SECRET);
    expect(out).toContain(REDACTION_MARK);
  });

  it("scrubs the secret out of stderr embedded in the thrown error", async () => {
    const script = node(
      `process.stderr.write("fatal ${SECRET} fatal");process.exit(3);`,
    );
    await expect(
      runCli(script.bin, script.args, "stdin", ctx()),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof HarnessError &&
        !e.message.includes(SECRET) &&
        e.message.includes(REDACTION_MARK),
    );
  });
});
