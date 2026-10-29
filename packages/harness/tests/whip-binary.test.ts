import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXPECTED_DIGESTS, pinnedWhipPath, verified } from "../src/whip-binary";

// A key that no platform ever produces, so tests own it without colliding with
// the real pinned digests.
const TEST_KEY = "test/fixture";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("pinnedWhipPath", () => {
  const originalHome = process.env.HOME;
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it("never returns a cwd-relative path when HOME is empty", () => {
    process.env.HOME = "";
    // The vuln: `??` kept "" and produced join("",...) = relative-to-cwd.
    expect(isAbsolute(pinnedWhipPath())).toBe(true);
  });

  it("keys the cache path by tag so a bump evicts the old entry", () => {
    process.env.HOME = "/home/someone";
    expect(pinnedWhipPath()).toContain("v0.6.5");
  });
});

describe("verified", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "whip-verify-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete EXPECTED_DIGESTS[TEST_KEY];
  });

  it("returns false when the key has no pinned digest (fail closed)", () => {
    const f = join(dir, "whip");
    writeFileSync(f, "whatever");
    expect(verified(f, TEST_KEY)).toBe(false);
  });

  it("returns true for a regular file whose bytes hash to the expected digest", () => {
    const f = join(dir, "whip");
    const bytes = Buffer.from("genuine pinned bytes");
    writeFileSync(f, bytes);
    EXPECTED_DIGESTS[TEST_KEY] = sha256(bytes);
    expect(verified(f, TEST_KEY)).toBe(true);
  });

  it("returns false for a non-existent file", () => {
    EXPECTED_DIGESTS[TEST_KEY] = sha256("anything");
    expect(verified(join(dir, "missing"), TEST_KEY)).toBe(false);
  });

  it("returns false for a digest mismatch", () => {
    const f = join(dir, "whip");
    writeFileSync(f, "tampered");
    EXPECTED_DIGESTS[TEST_KEY] = sha256("original");
    expect(verified(f, TEST_KEY)).toBe(false);
  });

  it("returns false for a symlink even if its target's bytes match", () => {
    const target = join(dir, "real");
    const bytes = Buffer.from("genuine pinned bytes");
    writeFileSync(target, bytes);
    const link = join(dir, "whip");
    symlinkSync(target, link);
    EXPECTED_DIGESTS[TEST_KEY] = sha256(bytes);
    expect(verified(link, TEST_KEY)).toBe(false);
  });

  it("does not treat a planted file as installed (the F-91 regression)", () => {
    // Attacker drops an executable at the cache path during a checkout. Its
    // digest can't match the pinned release, so it is never trusted.
    const planted = join(dir, "whip");
    writeFileSync(planted, "#!/bin/sh\nexfiltrate\n");
    EXPECTED_DIGESTS[TEST_KEY] = sha256("the real pinned binary");
    expect(verified(planted, TEST_KEY)).toBe(false);
  });
});
