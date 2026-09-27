import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { Logger } from "@loupe/logger";

/**
 * A whip provider + model catalog, declared in loupe's config so the review
 * workflow doesn't have to hand-write `~/.whipcode/config.json` in a CI step.
 * When present and its API key is available, loupe materializes it into a
 * throwaway home and starts a dedicated daemon there — never touching a
 * developer's real `~/.whipcode`.
 */
export type WhipConfig = {
  /** OpenAI-compatible provider whip routes through. */
  readonly provider: {
    /** Provider key (e.g. "inference-net"). */
    readonly name: string;
    readonly baseUrl: string;
    /** Env var whip reads the API key from at runtime (e.g. "INFERENCE_API_KEY"). */
    readonly apiKeyEnv: string;
    /** Display label; defaults to `name`. */
    readonly label?: string;
  };
  /** Models whip may route to (the panel). The first is the default if unset. */
  readonly models: readonly string[];
  /** Default model; defaults to the review's model, else the first in `models`. */
  readonly defaultModel?: string;
};

/**
 * The whip release loupe installs on demand when no `whipcode` is on PATH.
 * Pinned so the vendored SDK (vendor/@whip/VERSION) and the daemon it talks to
 * come from the same release; bump both together.
 */
export const PINNED_WHIP_TAG = "v1.0.0";

/** Minimal logging surface so the installer works without a real logger. */
type WhipLogger = Pick<Logger, "info" | "warn">;

/** The cache path where the pinned binary lives once installed. */
export function pinnedWhipPath(): string {
  const home = process.env.HOME ?? tmpdir();
  return join(home, ".loupe", "bin", "whipcode");
}

/** The release asset for this platform (`whipcode-linux-x64` and friends). */
export function pinnedWhipAsset(
  platform = process.platform,
  arch = process.arch,
): string {
  const os = platform === "darwin" ? "darwin" : "linux";
  return `whipcode-${os}-${arch === "arm64" ? "arm64" : "x64"}`;
}

/** True when a complete, executable binary is already at the cache path. */
function isInstalled(dest: string): boolean {
  try {
    accessSync(dest);
    chmodSync(dest, 0o755);
    return true;
  } catch {
    return false;
  }
}

/**
 * Single-flight wrapper: reviewers run concurrently inside one loupe process,
 * so simultaneous callers must share one download. The memoized promise makes
 * every caller await the same install; on completion or failure the memo
 * clears so the next attempt is a fresh one.
 */
let inFlight: Promise<string | null> | null = null;

export function installPinnedWhip(log: WhipLogger): Promise<string | null> {
  if (inFlight) return inFlight;
  const attempt = downloadPinnedWhip(log).then(
    (result) => {
      if (inFlight === attempt) inFlight = null;
      return result;
    },
    (err: unknown) => {
      if (inFlight === attempt) inFlight = null;
      throw err;
    },
  );
  inFlight = attempt;
  return attempt;
}

/**
 * One actual install attempt. Downloads into a unique temp dir and renames
 * into place, so the destination only ever exists complete; if another
 * attempt (or another process) won the rename while we were mid-flight, the
 * destination holds a valid binary and we return it.
 */
function downloadPinnedWhip(log: WhipLogger): Promise<string | null> {
  const dest = pinnedWhipPath();
  const binDir = join(dest, "..");
  mkdirSync(binDir, { recursive: true });
  if (isInstalled(dest)) return Promise.resolve(dest);
  const url = `https://github.com/context-labs/whip/releases/download/${PINNED_WHIP_TAG}/${pinnedWhipAsset()}`;
  // Unique staging dir per attempt: safe against same-process concurrency and
  // a same-machine second process. Inside binDir so rename stays on one fs.
  const stagingDir = mkdtempSync(join(binDir, ".download-"));
  const staging = join(stagingDir, "whipcode");
  return new Promise((resolve) => {
    const cleanup = (): void => {
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // best-effort; an orphaned .download-* temp dir is harmless
      }
    };
    const child = spawn("curl", ["-fsSL", "--retry", "2", "-o", staging, url]);
    child.on("error", (err) => {
      cleanup();
      log.warn("pinned whip download failed to start", { error: String(err) });
      resolve(null);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        // A concurrent winner may have finished while we were downloading.
        cleanup();
        log.warn("pinned whip download failed", { code, url });
        resolve(isInstalled(dest) ? dest : null);
        return;
      }
      try {
        chmodSync(staging, 0o755);
        // Atomic within the same filesystem: dest only ever exists complete.
        // If another attempt renamed first, its binary is valid - use it.
        try {
          renameSync(staging, dest);
        } catch {
          if (!isInstalled(dest)) throw new Error("rename failed and no dest");
        }
        resolve(dest);
      } catch (err) {
        log.warn("failed to stage pinned whip", { error: String(err) });
        resolve(isInstalled(dest) ? dest : null);
      } finally {
        cleanup();
      }
    });
  });
}

function onPath(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("which", [cmd], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

/**
 * The binary loupe drives: LOUPE_WHIP_BIN wins, then a `whipcode` on PATH,
 * else the pinned release from the private cache (installed on demand).
 */
export async function resolveWhipBinary(log: WhipLogger): Promise<string> {
  const override = process.env.LOUPE_WHIP_BIN;
  if (override) return override;
  if (await onPath("whipcode")) return "whipcode";
  const installed = await installPinnedWhip(log);
  if (!installed) {
    throw new Error(
      `whipcode is not installed and the pinned ${PINNED_WHIP_TAG} download failed (set LOUPE_WHIP_BIN to a whipcode binary).`,
    );
  }
  log.info(
    `no whipcode on PATH; using pinned release ${PINNED_WHIP_TAG} from ${installed}`,
  );
  return installed;
}

/**
 * The env var a whip binary reads its home from: WHIPCODE_HOME for `whipcode`,
 * WHIP_HOME for an older `whip`. Derived from the binary name the same way
 * whip derives it.
 */
export function homeEnvName(bin: string): string {
  return `${basename(bin)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")}_HOME`;
}

/**
 * Materialize a WhipConfig into a throwaway config dir and return the env
 * that points whip at it. Keeps loupe's `whip` block out of a developer's real
 * home and removes the hand-written config step from CI.
 */
export function materializeWhipHome(
  cfg: WhipConfig,
  bin = "whipcode",
): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "loupe-whip-"));
  const providerKey = cfg.provider.name;
  const defaultModel = cfg.defaultModel ?? cfg.models[0];
  const config = {
    defaultModel,
    defaultProvider: providerKey,
    providers: {
      [providerKey]: {
        name: cfg.provider.label ?? providerKey,
        baseUrl: cfg.provider.baseUrl,
        api: "openai-completions",
        apiKeyEnv: cfg.provider.apiKeyEnv,
      },
    },
    models: Object.fromEntries(
      cfg.models.map((m) => [m, { providers: [providerKey] }]),
    ),
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  return { [homeEnvName(bin)]: dir };
}

/** A daemon loupe can attach to, and how to let go of it afterwards. */
export type DaemonHandle = {
  readonly bin: string;
  /** Unix socket path the SDK connects to. */
  readonly socket: string;
  /** Env the daemon was started with (a throwaway home when materialized). */
  readonly env: Record<string, string>;
  /** Stops the daemon only if loupe started it in a throwaway home. */
  stop(): Promise<void>;
};

type DaemonStatus = {
  state: string;
  socket: string;
  error?: string;
  daemon_build?: string;
};

function run(
  bin: string,
  args: readonly string[],
  env: Record<string, string>,
): string {
  const res = spawnSync(bin, args, { encoding: "utf8", env });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `whip CLI "${bin}" is not installed (set LOUPE_WHIP_BIN to override).`,
      );
    }
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(
      `${bin} ${args.join(" ")} exited ${res.status}: ${res.stderr.slice(0, 2000)}`,
    );
  }
  return res.stdout;
}

function status(bin: string, env: Record<string, string>): DaemonStatus {
  return JSON.parse(
    run(bin, ["daemon", "status", "--json"], env),
  ) as DaemonStatus;
}

/** Decide where the daemon lives: a throwaway home when the whip block's API
 * key is available, else the local login. Pure, so it is testable. */
export function planDaemonEnv(opts: {
  bin: string;
  whipConfig?: WhipConfig;
  env: Record<string, string>;
}): { env: Record<string, string>; throwaway: boolean; warning?: string } {
  if (!opts.whipConfig) return { env: opts.env, throwaway: false };
  const keyEnv = opts.whipConfig.provider.apiKeyEnv;
  if (!opts.env[keyEnv]) {
    return {
      env: opts.env,
      throwaway: false,
      warning: `${keyEnv} is not set; ignoring the whip provider block and using the local whip login`,
    };
  }
  return {
    env: { ...opts.env, ...materializeWhipHome(opts.whipConfig, opts.bin) },
    throwaway: true,
  };
}

/**
 * Make sure a whip daemon is running and return how to reach it. With a
 * `whipConfig` whose API key is present (CI), a dedicated daemon starts in a
 * throwaway home and is stopped by `stop()`. Otherwise the local daemon is
 * used (started if needed) and left running, like the desktop app leaves it.
 */
export async function ensureDaemon(opts: {
  whipConfig?: WhipConfig;
  /** Resolved secrets to expose to the daemon (e.g. the provider's API key). */
  credentials?: Record<string, string>;
  logger: Logger;
}): Promise<DaemonHandle> {
  const log = opts.logger.child("whip-daemon");
  const bin = await resolveWhipBinary(log);
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined) base[k] = v;
  Object.assign(base, opts.credentials ?? {});
  const plan = planDaemonEnv({ bin, whipConfig: opts.whipConfig, env: base });
  if (plan.warning) log.warn(plan.warning);
  if (plan.throwaway) {
    log.info("Starting a dedicated whip daemon", {
      home: plan.env[homeEnvName(bin)],
      provider: opts.whipConfig?.provider.name,
    });
  }

  let current = status(bin, plan.env);
  if (current.state !== "running") {
    log.info("Starting whip daemon", { bin, state: current.state });
    run(bin, ["daemon", "start"], plan.env);
    current = status(bin, plan.env);
    if (current.state !== "running") {
      throw new Error(
        `whip daemon did not start: ${current.error ?? current.state}`,
      );
    }
  }
  log.debug("whip daemon ready", {
    socket: current.socket,
    build: current.daemon_build,
  });
  return {
    bin,
    socket: current.socket,
    env: plan.env,
    stop: async () => {
      if (!plan.throwaway) return;
      try {
        run(bin, ["daemon", "stop"], plan.env);
      } catch (err) {
        log.warn("Could not stop the dedicated whip daemon", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
