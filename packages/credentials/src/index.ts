import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * A source of secrets. Providers are tried in order; the first to return a
 * value for a key wins. Keep them dumb: given a key, return a value or
 * undefined. No caching, no precedence logic — the chain owns precedence.
 */
export type CredentialProvider = {
  readonly name: string;
  get(key: string): Promise<string | undefined>;
};

/** Reads from `process.env`. */
export function envProvider(): CredentialProvider {
  return {
    name: "env",
    get(key) {
      return Promise.resolve(process.env[key]);
    },
  };
}

/**
 * Reads `KEY=value` lines from a dotenv file. Missing file is not an error —
 * it just yields nothing, so an absent `.env` doesn't break CI.
 */
export function dotenvProvider(path = ".env"): CredentialProvider {
  let parsed: Record<string, string> | undefined;
  const load = (): Record<string, string> => {
    if (parsed) return parsed;
    parsed = {};
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return parsed;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const k = trimmed.slice(0, eq).trim();
      let v = trimmed.slice(eq + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      parsed[k] = v;
    }
    return parsed;
  };
  return {
    name: `dotenv(${path})`,
    get(key) {
      return Promise.resolve(load()[key]);
    },
  };
}

/**
 * Reads a secret via the Infisical CLI (`infisical secrets get <KEY> --plain`).
 * Requires the CLI to be authenticated in the environment. This is the one
 * Inference uses; open-source consumers can drop it and supply their own.
 */
export function infisicalProvider(
  opts: { env?: string; projectId?: string } = {},
): CredentialProvider {
  return {
    name: "infisical",
    get(key) {
      const args = ["secrets", "get", key, "--plain"];
      if (opts.env) args.push("--env", opts.env);
      if (opts.projectId) args.push("--projectId", opts.projectId);
      const res = spawnSync("infisical", args, { encoding: "utf8" });
      if (res.status !== 0) return Promise.resolve(undefined);
      const value = res.stdout.trim();
      return Promise.resolve(value.length > 0 ? value : undefined);
    },
  };
}

/**
 * Resolve each key against the provider chain, first hit wins. Keys that no
 * provider can supply are omitted (callers decide what's required).
 */
export async function resolveCredentials(
  keys: readonly string[],
  providers: readonly CredentialProvider[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    for (const provider of providers) {
      const value = await provider.get(key);
      if (value !== undefined) {
        out[key] = value;
        break;
      }
    }
  }
  return out;
}
