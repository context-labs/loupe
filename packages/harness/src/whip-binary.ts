/**
 * Pinned-whip installer - one home for the "whip binary may be missing or
 * renamed" patch logic. Everything loupe needs to run harness "whip" lives
 * here; the harness in index.ts only calls resolveWhipBinary().
 *
 * Background: the upstream whip CLI renamed its binary to `whipcode` at v1.0.0
 * (and its config dir to ~/.whipcode/WHIPCODE_HOME). Environments that install
 * "latest" now have a renamed or missing `whip`, so loupe:
 *   1. identity-checks any `whip` on PATH (`whip --version` must report whip),
 *      rejecting renamings like whipcode masquerading as `whip`;
 *   2. falls back to a pinned release (PINNED_WHIP_TAG), downloaded on demand
 *      into a private cache dir; and
 *   3. single-flights the download so concurrent reviewers inside one loupe
 *      process share a single install instead of racing one another.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { Logger } from "@loupe/logger";

/**
 * whip v0.6.5 - the pinned release loupe installs on demand. The latest whip
 * release (v1.0.0+) renamed the binary to `whipcode` and broke the harness, so
 * when a user selects harness "whip" and no genuine `whip` is on PATH, loupe
 * downloads this exact tag instead of failing with "CLI is not installed."
 * Bump deliberately when adopting the v1+ whipcode generation.
 */
export const PINNED_WHIP_TAG = "v0.6.5";

/**
 * SHA-256 of each pinned release binary, keyed by `${tag}/${mode}`. This is the
 * root of trust: a file at the cache path is only ever executed when its bytes
 * hash to the expected digest here, so a file planted at the cache path (e.g.
 * during a PR checkout) can never short-circuit the download or be run.
 *
 * Digests were captured from the published GitHub release assets:
 *   curl -fsSL https://github.com/context-labs/whip/releases/download/${PINNED_WHIP_TAG}/whip-${mode} | sha256sum
 * Any key missing here fails closed in verified() - no digest, no execution.
 */
export const EXPECTED_DIGESTS: Record<string, string> = {
  "v0.6.5/linux-x64":
    "c1a3a0039a648513cb68d6f2ab23152b0605f41a141c8e863d1d5c81f3c0fce9",
  "v0.6.5/linux-arm64":
    "b4ddc9cc21632f31283916df141788c4ed55bd4a4c4c81f0eb41de04779ba949",
  "v0.6.5/darwin-x64":
    "76dd6f63cc16b3b596d0fa6285714fe21b5a1eaefb468a39e16ef5896933adea",
  "v0.6.5/darwin-arm64":
    "7ff776a82477cb5458695fc5b936feff5e4052a2037f7d8c054844410cbb324d",
};

/** The release asset suffix for the current platform/arch. */
function pinnedMode(): string {
  return process.platform === "darwin" && process.arch === "arm64"
    ? "darwin-arm64"
    : process.platform === "darwin"
      ? "darwin-x64"
      : process.platform === "linux" && process.arch === "arm64"
        ? "linux-arm64"
        : "linux-x64";
}

/** Minimal logging surface so this module works without a real logger. */
type WhipLogger = Pick<Logger, "info" | "warn">;

const noLogger: WhipLogger = {
  info: () => {},
  warn: () => {},
};

/**
 * Run `whip --version` and check the binary identifies itself as genuine whip
 * (output starting with "whip v"). The v1.0.0 release renamed the CLI to
 * whipcode, but many CI install steps still download "latest" and save it as
 * `whip` - so a PATH hit may actually be whipcode, which reads a different
 * config dir and rejects loupe's model panel:
 *   whipcode: unknown model "glm-5.3" (models: ...)
 */
export function isGenuineWhipOnPath(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("whip", ["--version"]);
    let stdout = "";
    p.on("error", () => resolve(false));
    p.on("close", () => resolve(/^\s*whip v/i.test(stdout)));
    p.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
  });
}

/**
 * The cache path where the pinned binary lives once installed, keyed by tag and
 * platform so bumping PINNED_WHIP_TAG lands on a fresh path and never reuses a
 * stale (or poisoned) entry from a previous tag.
 *
 * `||` not `??`: an empty HOME must also fall back to tmpdir. With `??` an empty
 * string is kept and join("", ...) yields a RELATIVE path resolved against cwd
 * (the PR checkout during review) - exactly the plant-a-binary vector. We still
 * assert the result is absolute, so no env shape can ever produce a cwd-relative
 * destination.
 */
export function pinnedWhipPath(): string {
  const home = process.env.HOME || tmpdir();
  const dest = join(
    home,
    ".loupe",
    "bin",
    PINNED_WHIP_TAG,
    pinnedMode(),
    "whip",
  );
  if (!isAbsolute(dest)) {
    throw new Error(`refusing non-absolute whip cache path: ${dest}`);
  }
  return dest;
}

/**
 * True only for a genuine pinned binary: a regular (non-symlink) file at the
 * cache path whose SHA-256 matches the expected digest for this tag/platform.
 * Fails closed - a missing key, a symlink, a directory, or any digest mismatch
 * returns false, so a file merely discovered at the cache path is never trusted
 * and never executed. Never chmods: the execute bit is granted only to a
 * freshly downloaded, digest-verified staging file (see downloadPinnedWhip).
 */
export function verified(dest: string, key: string = pinnedKey()): boolean {
  const expected = EXPECTED_DIGESTS[key];
  if (!expected) return false;
  try {
    const stat = lstatSync(dest, { throwIfNoEntry: false });
    if (!stat?.isFile()) return false;
    const actual = createHash("sha256")
      .update(readFileSync(dest))
      .digest("hex");
    return actual === expected;
  } catch {
    return false;
  }
}

/** The EXPECTED_DIGESTS key for the current tag and platform. */
function pinnedKey(): string {
  return `${PINNED_WHIP_TAG}/${pinnedMode()}`;
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
  const key = pinnedKey();
  const binDir = join(dest, "..");
  mkdirSync(binDir, { recursive: true });
  // Verify, not just presence: a file at the cache path is trusted only when
  // its digest matches, so a planted binary can't short-circuit the download.
  if (verified(dest, key)) return Promise.resolve(dest);
  const mode = pinnedMode();
  const url = `https://github.com/context-labs/whip/releases/download/${PINNED_WHIP_TAG}/whip-${mode}`;
  // Unique staging dir per attempt: safe against same-process concurrency and
  // a same-machine second process. Inside binDir so rename stays on one fs.
  const stagingDir = mkdtempSync(join(binDir, ".download-"));
  const staging = join(stagingDir, "whip");
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
        resolve(verified(dest, key) ? dest : null);
        return;
      }
      try {
        // Verify the bytes we actually fetched before granting the execute bit
        // or publishing them: a compromised mirror / MITM that returns a 200
        // must not install. chmod the staging file only - never the cache path.
        if (!verified(staging, key)) {
          log.warn("pinned whip digest mismatch; discarding download", {
            url,
            key,
          });
          resolve(null);
          return;
        }
        chmodSync(staging, 0o755);
        // Atomic within the same filesystem: dest only ever exists complete.
        // If another attempt renamed first, its binary is valid - use it.
        try {
          renameSync(staging, dest);
        } catch {
          if (!verified(dest, key))
            throw new Error("rename failed and no dest");
        }
        resolve(dest);
      } catch (err) {
        log.warn("failed to stage pinned whip", { error: String(err) });
        resolve(verified(dest, key) ? dest : null);
      } finally {
        cleanup();
      }
    });
  });
}

/**
 * The one entry point the whip harness uses: resolve which binary to spawn.
 * Prefers a genuine `whip` on PATH (identity-checked), else installs/returns
 * the pinned release from the private cache. Returns null only when neither
 * is possible (no genuine PATH binary and the download failed).
 */
export async function resolveWhipBinary(
  logger: WhipLogger | null,
): Promise<string | null> {
  if (await isGenuineWhipOnPath()) return "whip";
  const installed = await installPinnedWhip(logger);
  if (installed && installed !== "whip") {
    logger?.info(
      `no genuine whip on PATH; using pinned release ${PINNED_WHIP_TAG} from ${installed}`,
    );
  }
  return installed;
}
