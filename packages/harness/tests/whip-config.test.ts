import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { materializeWhipHome, type WhipConfig } from "../src/index";

const base: WhipConfig = {
  provider: {
    name: "inference-net",
    baseUrl: "https://api.inference.net/v1",
    apiKeyEnv: "INFERENCE_API_KEY",
    label: "Inference.net",
  },
  models: ["kimi-k3", "glm-5.3-flash", "gpt-5.6-luna"],
  defaultModel: "kimi-k3",
};

function writtenConfig(cfg: WhipConfig): {
  env: Record<string, string>;
  config: Record<string, unknown>;
} {
  const env = materializeWhipHome(cfg);
  const config = JSON.parse(
    readFileSync(join(env["WHIP_HOME"]!, "config.json"), "utf8"),
  ) as Record<string, unknown>;
  return { env, config };
}

describe("materializeWhipHome", () => {
  it("writes a WHIP_HOME config with the provider and full model panel", () => {
    const { env, config } = writtenConfig(base);
    expect(env["WHIP_HOME"]).toBeTruthy();
    expect(config["defaultModel"]).toBe("kimi-k3");
    expect(config["defaultProvider"]).toBe("inference-net");
    expect(config["providers"]).toEqual({
      "inference-net": {
        name: "Inference.net",
        baseUrl: "https://api.inference.net/v1",
        api: "openai-completions",
        apiKeyEnv: "INFERENCE_API_KEY",
      },
    });
    expect(Object.keys(config["models"] as object)).toEqual([
      "kimi-k3",
      "glm-5.3-flash",
      "gpt-5.6-luna",
    ]);
    expect(
      (config["models"] as Record<string, unknown>)["gpt-5.6-luna"],
    ).toEqual({ providers: ["inference-net"] });
  });

  it("defaults defaultModel to the first model and label to the provider key", () => {
    const { config } = writtenConfig({
      provider: {
        name: "inference-net",
        baseUrl: "https://api.inference.net/v1",
        apiKeyEnv: "INFERENCE_API_KEY",
      },
      models: ["glm-5.3-flash", "kimi-k3"],
    });
    expect(config["defaultModel"]).toBe("glm-5.3-flash");
    expect(
      (config["providers"] as Record<string, { name: string }>)["inference-net"]
        ?.name,
    ).toBe("inference-net");
  });
});
