import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PINNED_WHIP_TAG,
  homeEnvName,
  materializeWhipHome,
  pinnedWhipAsset,
  pinnedWhipPath,
  planDaemonEnv,
  type WhipConfig,
} from "../src/daemon";

const cfg: WhipConfig = {
  provider: {
    name: "inference-net",
    baseUrl: "https://api.inference.net/v1",
    apiKeyEnv: "INFERENCE_API_KEY",
  },
  models: ["kimi-k3"],
};

describe("homeEnvName", () => {
  it("derives the home variable from the binary name like whip does", () => {
    expect(homeEnvName("whip")).toBe("WHIP_HOME");
    expect(homeEnvName("/usr/local/bin/whipcode")).toBe("WHIPCODE_HOME");
  });
});

describe("planDaemonEnv", () => {
  it("uses the local daemon when there is no whip block", () => {
    const plan = planDaemonEnv({ bin: "whip", env: { PATH: "/bin" } });
    expect(plan).toEqual({ env: { PATH: "/bin" }, throwaway: false });
  });

  it("falls back to the local login, with a warning, when the key is absent", () => {
    const plan = planDaemonEnv({ bin: "whip", whipConfig: cfg, env: {} });
    expect(plan.throwaway).toBe(false);
    expect(plan.warning).toMatch(/INFERENCE_API_KEY is not set/);
    expect(plan.env["WHIP_HOME"]).toBeUndefined();
  });

  it("materializes a throwaway home for the binary when the key is present", () => {
    const plan = planDaemonEnv({
      bin: "whipcode",
      whipConfig: cfg,
      env: { INFERENCE_API_KEY: "k" },
    });
    expect(plan.throwaway).toBe(true);
    const home = plan.env["WHIPCODE_HOME"];
    expect(home).toBeTruthy();
    const written = JSON.parse(
      readFileSync(join(home!, "config.json"), "utf8"),
    ) as { defaultProvider: string };
    expect(written.defaultProvider).toBe("inference-net");
  });
});

describe("pinned whipcode release", () => {
  it("is the release the vendored SDK came from", () => {
    expect(PINNED_WHIP_TAG).toBe("v1.0.0");
  });

  it("names the v1 release assets per platform", () => {
    expect(pinnedWhipAsset("linux", "x64")).toBe("whipcode-linux-x64");
    expect(pinnedWhipAsset("linux", "arm64")).toBe("whipcode-linux-arm64");
    expect(pinnedWhipAsset("darwin", "arm64")).toBe("whipcode-darwin-arm64");
    expect(pinnedWhipAsset("darwin", "x64")).toBe("whipcode-darwin-x64");
  });

  it("caches the binary under its v1 name", () => {
    expect(pinnedWhipPath()).toMatch(/\/\.loupe\/bin\/whipcode$/);
  });
});

describe("materializeWhipHome", () => {
  const full: WhipConfig = {
    ...cfg,
    provider: { ...cfg.provider, label: "Inference.net" },
    models: ["kimi-k3", "glm-5.3-flash", "gpt-5.6-luna"],
    defaultModel: "kimi-k3",
  };
  const written = (c: WhipConfig): Record<string, unknown> => {
    const env = materializeWhipHome(c);
    return JSON.parse(
      readFileSync(join(env["WHIPCODE_HOME"]!, "config.json"), "utf8"),
    ) as Record<string, unknown>;
  };

  it("writes a WHIPCODE_HOME config with the provider and full model panel", () => {
    const config = written(full);
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
    const config = written({ ...cfg, models: ["glm-5.3-flash", "kimi-k3"] });
    expect(config["defaultModel"]).toBe("glm-5.3-flash");
    expect(
      (config["providers"] as Record<string, { name: string }>)["inference-net"]
        ?.name,
    ).toBe("inference-net");
  });
});
