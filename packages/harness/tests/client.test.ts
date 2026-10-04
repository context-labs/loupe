import { createWhipClient } from "@whip/sdk";
import { defineAgent } from "@whip/sdk/agents";
import { scriptedDaemon, type ScriptedDaemon } from "@whip/sdk/testing";
import { describe, expect, it } from "vitest";

import { reviewerAgent } from "../src/agents";
import { discoverModels, runAgent, serveAgent } from "../src/client";
import { z } from "zod";

const output = z.object({ ok: z.boolean() });
import { recorder } from "./recorder";

/** The command.submit requests the runner sent, in order. */
function commands(daemon: ScriptedDaemon) {
  return daemon.current.requests
    .filter((r) => r.method === "command.submit")
    .map((r) => ({
      operation: String(r.params["operation"]),
      payload: r.params["payload"] as Record<string, unknown>,
    }));
}

/** The scripted daemon answers every non-submit command with `{}`; the effort
 * result must carry the effort back, so script that one reply. */
function answerEffort(daemon: ScriptedDaemon): ScriptedDaemon {
  return daemon.reply("command.submit", (request) => {
    if (request.params["operation"] !== "session.effort") return undefined;
    const payload = request.params["payload"] as { effort: string };
    return {
      operation: "session.effort",
      command_id: String(request.params["command_id"]),
      ingress_seq: "900",
      status: "succeeded",
      result: { effort: payload.effort },
    };
  });
}

async function connected(daemon: ScriptedDaemon) {
  const client = createWhipClient({
    endpoint: daemon.factory,
    clientId: "loupe-runner-test",
    commandPollMs: 5,
  });
  await client.connect();
  return client;
}

describe("runAgent", () => {
  it("serves an agent with hooks, creates a pinned session, configures it, runs the turn, and cleans up", async () => {
    const daemon = answerEffort(scriptedDaemon().serveSessions());
    const client = await connected(daemon);
    const { log, lines } = recorder();
    const agent = reviewerAgent({
      name: "t",
      systemPrompt: "p",
      agentic: true,
      output,
    });
    const played = daemon.turn("root-1", {
      steps: [
        { text: "Looking. " },
        { host: { id: "i1", operation: "tools.pr_hunks", summary: "path=x" } },
        { text: "Done." },
      ],
      text: "Looking. Done.",
      output: { ok: true },
    });
    const seen: string[] = [];
    const outcome = await runAgent(client, {
      agent,
      cwd: "/repo",
      prompt: "review",
      model: "glm-5.3",
      provider: "inference-net",
      effort: "high",
      maxTurns: 3,
      cacheKey: "loupe/o/r/t",
      onEvent: (event) => seen.push(event.type),
      logger: log,
    });
    await played;
    client.close();

    expect(outcome.text).toBe("Looking. Done.");
    expect(outcome.output).toEqual({ ok: true });
    const sent = commands(daemon);
    expect(sent.map((c) => c.operation)).toEqual([
      "session.create",
      "run.configure",
      "session.effort",
      "submit",
      "session.delete",
    ]);
    expect(sent[2]?.payload).toEqual({
      effort: "high",
      persist_default: false,
    });
    expect(seen).toContain("host");
    expect(sent[0]?.payload).toMatchObject({
      definition: agent.document.id,
      model: "glm-5.3",
      provider: "inference-net",
      permission_mode: "automatic",
      cwd: "/repo",
    });
    expect(sent[1]?.payload).toEqual({
      headless: true,
      max_turns: 3,
      cache_key: "loupe/o/r/t",
    });
    expect(
      daemon.current.requests.some((r) => r.method === "executor.bind"),
    ).toBe(true);
    expect(lines.map((l) => l.message)).toContain("host call");
    expect(lines.at(-1)?.message).toBe("run finished");
  });

  it("keeps going when the model has no such effort level, and says so", async () => {
    const daemon = scriptedDaemon()
      .serveSessions()
      .reply("command.submit", (request) =>
        request.params["operation"] === "session.effort"
          ? {
              operation: "session.effort",
              command_id: String(request.params["command_id"]),
              ingress_seq: "901",
              status: "failed",
              failure: {
                code: -32000,
                message: 'glm-5.3 does not support effort "medium"',
              },
            }
          : undefined,
      );
    const client = await connected(daemon);
    const { log, lines } = recorder();
    const played = daemon.turn("root-1", { text: "ok", output: { ok: true } });
    const outcome = await runAgent(client, {
      agent: reviewerAgent({
        name: "t",
        systemPrompt: "p",
        agentic: true,
        output,
      }),
      cwd: "/repo",
      prompt: "review",
      effort: "medium",
      logger: log,
    });
    await played;
    client.close();
    expect(outcome.output).toEqual({ ok: true });
    const warning = lines.find((l) => l.level === "warn");
    expect(warning?.message).toBe(
      "reasoning effort not applied; the model's default applies",
    );
    expect(warning?.props?.["error"]).toMatch(/does not support effort/);
  });

  it("only registers an agent without tools or hooks and still runs it", async () => {
    const daemon = scriptedDaemon().serveSessions();
    const client = await connected(daemon);
    const { log } = recorder();
    const plain = defineAgent({
      id: "loupe-plain",
      modules: ["context"],
      instructions: { persona: "p" },
    });
    const played = daemon.turn("root-1", { text: "answer" });
    const outcome = await runAgent(client, {
      agent: plain,
      cwd: "/repo",
      prompt: "q",
      logger: log,
    });
    await played;
    client.close();
    expect(outcome.text).toBe("answer");
    expect(
      daemon.current.requests.some((r) => r.method === "definitions.register"),
    ).toBe(true);
    expect(
      daemon.current.requests.some((r) => r.method === "executor.bind"),
    ).toBe(false);
  });

  it("runs several turns and sessions on one served agent, then stops serving", async () => {
    const daemon = scriptedDaemon().serveSessions();
    const client = await connected(daemon);
    const { log } = recorder();
    const served = await serveAgent(
      client,
      reviewerAgent({ name: "t", systemPrompt: "p", agentic: true, output }),
      log,
    );
    const first = daemon.turn("root-1", { text: "one", output: { ok: true } });
    const second = daemon.turn("root-1", {
      text: "two",
      output: { ok: false },
    });
    const other = daemon.turn("root-2", {
      text: "other",
      output: { ok: true },
    });
    const a = await served.session({
      cwd: "/repo",
      maxTurns: 4,
      cacheKey: "k",
    });
    const b = await served.session({ cwd: "/repo" });
    const [r1, r2, r3] = await Promise.all([
      a.run("first"),
      a.run("second").catch(() => undefined),
      b.run("third"),
    ]);
    await Promise.all([first, other]);
    // A second turn on the same session queues behind the first in the daemon; here it plays next.
    const r2b = r2 ?? (await a.run("second"));
    await second;
    await Promise.all([a.close(), b.close()]);
    served.close();
    client.close();
    expect(r1.output).toEqual({ ok: true });
    expect(r2b.output).toEqual({ ok: false });
    expect(r3.text).toBe("other");
    const sent = commands(daemon);
    expect(sent.filter((c) => c.operation === "session.create")).toHaveLength(
      2,
    );
    expect(sent.filter((c) => c.operation === "session.delete")).toHaveLength(
      2,
    );
    expect(
      daemon.current.requests.filter((r) => r.method === "executor.bind"),
    ).toHaveLength(1);
  });

  it("surfaces a failed turn as an error and still deletes the session", async () => {
    const daemon = scriptedDaemon().serveSessions();
    const client = await connected(daemon);
    const { log } = recorder();
    const agent = reviewerAgent({
      name: "t",
      systemPrompt: "p",
      agentic: true,
      output,
    });
    const played = daemon.turn("root-1", {
      status: "failed",
      failure: { code: -32000, message: "model unavailable" },
    });
    await expect(
      runAgent(client, { agent, cwd: "/repo", prompt: "review", logger: log }),
    ).rejects.toThrow(/whip turn failed: model unavailable/);
    await played;
    client.close();
    expect(commands(daemon).at(-1)?.operation).toBe("session.delete");
  });
});

describe("discoverModels", () => {
  const catalogs = (models: { id: string }[], error?: string) => ({
    models: {},
    providers: {
      "inference-net": { base_url: "https://api.inference.net/v1" },
    },
    catalogs: {
      "inference-net": {
        fetched_at: "2026-09-26T00:00:00Z",
        base_url: "https://api.inference.net/v1",
        models,
      },
    },
    errors: error ? { "inference-net": error } : {},
  });
  /** Queries ride the `query` method with the operation inside. */
  const answering = (models: { id: string }[], error?: string) =>
    scriptedDaemon().reply("query", (request) =>
      request.params["operation"] === "provider.catalogs"
        ? { result: catalogs(models, error) }
        : undefined,
    );

  it("asks the daemon for the provider's catalog and logs what it found", async () => {
    const daemon = answering([{ id: "glm-5.3" }, { id: "kimi-k3" }]);
    const client = await connected(daemon);
    const { log, lines } = recorder();
    await discoverModels(client, "inference-net", log);
    client.close();
    const request = daemon.current.requests.find(
      (r) => r.params["operation"] === "provider.catalogs",
    );
    expect(request?.params).toMatchObject({
      operation: "provider.catalogs",
      payload: { provider: "inference-net" },
    });
    expect(lines.at(-1)).toMatchObject({
      level: "debug",
      message: "provider models discovered",
      props: { provider: "inference-net", models: ["glm-5.3", "kimi-k3"] },
    });
  });

  it("warns, and goes on, when discovery fails or finds nothing", async () => {
    const daemon = answering(
      [],
      "Model discovery failed; check the provider connection and retry.",
    );
    const client = await connected(daemon);
    const { log, lines } = recorder();
    await discoverModels(client, "inference-net", log);
    client.close();
    expect(lines.at(-1)?.level).toBe("warn");
    expect(lines.at(-1)?.props?.["error"]).toMatch(/Model discovery failed/);
  });
});
