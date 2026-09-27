/**
 * Pinned-whip installer: which `whipcode` binary loupe drives. The harness in
 * index.ts only calls resolveWhipBinary(), which prefers LOUPE_WHIP_BIN, then a
 * `whipcode` on PATH, then a pinned release (PINNED_WHIP_TAG) downloaded on
 * demand into a private cache dir. The download is single-flighted so
 * concurrent reviewers inside one loupe process share one install.
 */

import { spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "@loupe/logger";

/**
 * The whip release loupe installs on demand when no `whipcode` is on PATH.
 * Pinned so the vendored SDK (vendor/@whip/VERSION) and the daemon it talks to
 * come from the same release; bump both together.
 */
export const PINNED_WHIP_TAG = "v1.0.0";

/** Minimal logging surface so this module works without a real logger. */
type WhipLogger = Pick<Logger, "info" | "warn">;

const noLogger: WhipLogger = {
  info: () => {},
  warn: () => {},
};

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

export function installPinnedWhip(
  logger: WhipLogger | null,
): Promise<string | null> {
  if (inFlight) return inFlight;
  const log = logger ?? noLogger;
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
 * The one entry point the whip harness uses: resolve which binary to spawn.
 * LOUPE_WHIP_BIN wins, then a `whipcode` on PATH, else the pinned release from
 * the private cache (installed on demand). Returns null only when nothing is
 * on PATH and the download failed.
 */
export async function resolveWhipBinary(
  logger: WhipLogger | null,
): Promise<string | null> {
  const override = process.env.LOUPE_WHIP_BIN;
  if (override) return override;
  if (await onPath("whipcode")) return "whipcode";
  const installed = await installPinnedWhip(logger);
  if (installed) {
    logger?.info(
      `no whipcode on PATH; using pinned release ${PINNED_WHIP_TAG} from ${installed}`,
    );
  }
  return installed;
}
