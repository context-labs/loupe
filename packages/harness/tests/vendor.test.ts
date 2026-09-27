import { describe, expect, it } from "vitest";

import { defineAgent, tool } from "@whip/sdk/agents";
import { createWhipClient, unixSocket } from "@whip/sdk/node";

// The vendored SDK resolves under Bun and exposes the entry points loupe uses.
describe("vendored @whip/sdk", () => {
  it("exposes the node transport and the agents API", () => {
    expect(typeof unixSocket("/tmp/x.sock")).toBe("function");
    expect(typeof createWhipClient).toBe("function");
    const ping = tool({
      name: "ping",
      description: "Ping",
      input: { type: "object" },
      execute: () => "pong",
    });
    const agent = defineAgent({
      id: "loupe-vendor-test",
      modules: ["context"],
      tools: [ping],
    });
    expect(agent.document.id).toBe("loupe-vendor-test");
    expect(agent.document.tools?.[0]?.name).toBe("ping");
  });
});
