import { describe, expect, it } from "vitest";

import {
  PINNED_WHIP_TAG,
  pinnedWhipAsset,
  pinnedWhipPath,
} from "../src/whip-binary";

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
