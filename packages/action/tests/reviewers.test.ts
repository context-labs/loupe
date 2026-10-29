import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { asDirs, loadReviewers, loadSettings } from "../src/reviewers";

function config(json: object): string {
  const dir = mkdtempSync(join(tmpdir(), "loupe-cfg-"));
  const p = join(dir, "loupe.json");
  writeFileSync(p, JSON.stringify(json));
  return p;
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
};

describe("dir setting", () => {
  it("keeps accepting the original single-string form unchanged", () => {
    const p = config({
      dir: "inference",
      reviewers: [{ name: "code", prompt: "x" }],
    });
    expect(loadSettings(p).dirs).toEqual(["inference"]);
    expect(loadReviewers(p)[0]!.dirs).toBeUndefined();
  });

  it("accepts a list at the top level and per reviewer", () => {
    const p = config({
      dir: ["inference", "elixir_engine"],
      reviewers: [
        { name: "code", prompt: "x" },
        { name: "engine", prompt: "y", dir: "elixir_engine" },
        { name: "both", prompt: "z", dir: ["inference", "elixir_engine"] },
      ],
    });
    expect(loadSettings(p).dirs).toEqual(["inference", "elixir_engine"]);
    const [code, engine, both] = loadReviewers(p);
    expect(code!.dirs).toBeUndefined();
    expect(engine!.dirs).toEqual(["elixir_engine"]);
    expect(both!.dirs).toEqual(["inference", "elixir_engine"]);
  });

  it("asDirs splits the comma form used by the Action input and CLI flag", () => {
    expect(asDirs("inference, elixir_engine")).toEqual([
      "inference",
      "elixir_engine",
    ]);
    expect(asDirs("inference")).toEqual(["inference"]);
    expect(asDirs("")).toBeUndefined();
    expect(asDirs(undefined)).toBeUndefined();
  });

  it("loadSettings surfaces a top-level promptCache so the resolvers can honor it", () => {
    // A repo-wide escape hatch: top-level promptCache:false must reach
    // config.ts (env ?? file) and cli.ts (opts ?? settings) — the Action input
    // and CLI flag default to unset, so this file value is what wins.
    const p = config({
      promptCache: false,
      reviewers: [{ name: "code", prompt: "x" }],
    });
    expect(loadSettings(p).promptCache).toBe(false);
    // A per-reviewer value overrides the file default too.
    const q = config({
      promptCache: true,
      reviewers: [{ name: "code", prompt: "x", promptCache: false }],
    });
    expect(loadReviewers(q)[0]!.promptCache).toBe(false);
  });
});

describe("maxComments", () => {
  it("loads as a top-level default and per reviewer, reviewer overriding the file", () => {
    const p = config({
      maxComments: 20,
      reviewers: [
        { name: "code", prompt: "x", maxComments: 5 },
        { name: "engine", prompt: "y" },
      ],
    });
    // Top-level default surfaces for the Action input / CLI flag chain.
    expect(loadSettings(p).maxComments).toBe(20);
    const [code, engine] = loadReviewers(p);
    expect(code!.maxComments).toBe(5);
    // A reviewer without its own value inherits the top-level default at
    // call time (r.maxComments ?? maxComments), staying undefined here.
    expect(engine!.maxComments).toBeUndefined();
  });

  it("rejects non-positive and fractional values at both levels", () => {
    for (const bad of [0, -3, 2.5]) {
      const top = config({
        maxComments: bad,
        reviewers: [{ name: "code", prompt: "x" }],
      });
      expect(() => loadSettings(top)).toThrow();
      const perReviewer = config({
        reviewers: [{ name: "code", prompt: "x", maxComments: bad }],
      });
      expect(() => loadReviewers(perReviewer)).toThrow();
    }
  });
});

describe("promptFile containment (F-90)", () => {
  it("reads an in-workspace relative promptFile", () => {
    const p = config({
      reviewers: [{ name: "code", promptFile: "guide.md" }],
    });
    writeFileSync(join(dirname(p), "guide.md"), "be thorough");
    expect(loadReviewers(p)[0]!.guidance).toBe("be thorough");
  });

  it("rejects an absolute promptFile path", () => {
    const p = config({
      reviewers: [{ name: "code", promptFile: "/etc/passwd" }],
    });
    expect(() => loadReviewers(p)).toThrow(/escapes the workspace root/);
  });

  it("rejects a ../ traversal promptFile path", () => {
    const p = config({
      reviewers: [{ name: "code", promptFile: "../../../etc/passwd" }],
    });
    expect(() => loadReviewers(p)).toThrow(/escapes the workspace root/);
  });

  it("rejects an in-workspace symlink that points outside the workspace", () => {
    // A fork author controls the checkout, so a symlink that passes the lexical
    // containment check must still be rejected once its target is resolved.
    const outside = mkdtempSync(join(tmpdir(), "loupe-secret-"));
    writeFileSync(join(outside, "creds"), "secret");
    const p = config({
      reviewers: [{ name: "code", promptFile: "link" }],
    });
    symlinkSync(join(outside, "creds"), join(dirname(p), "link"));
    expect(() => loadReviewers(p)).toThrow(/escapes the workspace root/);
  });
});

describe("whip provider egress validation (F-90)", () => {
  const whip = (provider: object) => ({
    reviewers: [{ name: "code", prompt: "x" }],
    whip: {
      provider: { name: "p", ...provider },
      models: ["kimi-k3"],
    },
  });

  it("rejects a non-https baseUrl", () => {
    const p = config(
      whip({ baseUrl: "http://evil.test/v1", apiKeyEnv: "KEY" }),
    );
    expect(() => loadSettings(p)).toThrow();
  });

  it("rejects a non-URL baseUrl", () => {
    const p = config(whip({ baseUrl: "not a url", apiKeyEnv: "KEY" }));
    expect(() => loadSettings(p)).toThrow();
  });

  it("rejects an apiKeyEnv that is not an env-var name", () => {
    const p = config(
      whip({ baseUrl: "https://api.test/v1", apiKeyEnv: "rm -rf /" }),
    );
    expect(() => loadSettings(p)).toThrow();
  });

  it("rejects a host absent from a non-empty allow-list", () => {
    const p = config(
      whip({ baseUrl: "https://evil.test/v1", apiKeyEnv: "KEY" }),
    );
    expect(() =>
      loadSettings(p, { allowedProviderHosts: ["api.inference.net"], logger }),
    ).toThrow(/not in the allowed provider hosts/);
  });

  it("accepts a host present on the allow-list", () => {
    const p = config(
      whip({ baseUrl: "https://api.inference.net/v1", apiKeyEnv: "KEY" }),
    );
    expect(
      loadSettings(p, {
        allowedProviderHosts: ["api.inference.net"],
        logger,
      }).whip?.provider.baseUrl,
    ).toBe("https://api.inference.net/v1");
  });

  it("allows any host with a warning when the allow-list is empty", () => {
    logger.warn.mockClear();
    const p = config(
      whip({ baseUrl: "https://whatever.test/v1", apiKeyEnv: "KEY" }),
    );
    expect(
      loadSettings(p, { allowedProviderHosts: [], logger }).whip,
    ).toBeDefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("rejects an apiKeyEnv naming a job-infrastructure secret, even with an empty allow-list", () => {
    const p = config(
      whip({
        baseUrl: "https://api.inference.net/v1",
        apiKeyEnv: "GITHUB_TOKEN",
      }),
    );
    expect(() => loadSettings(p, { allowedProviderHosts: [], logger })).toThrow(
      /job-infrastructure secret/,
    );
  });
});
