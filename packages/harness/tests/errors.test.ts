import { describe, expect, it } from "vitest";

import {
  HarnessError,
  classifyHarnessError,
  isNonRetryableHarnessError,
} from "../src/errors";

describe("classifyHarnessError", () => {
  it("maps billing/quota messages to 'quota'", () => {
    expect(classifyHarnessError("402 Payment Required")).toBe("quota");
    expect(classifyHarnessError("insufficient balance")).toBe("quota");
    expect(classifyHarnessError("quota exceeded")).toBe("quota");
    expect(classifyHarnessError("billing: account suspended")).toBe("quota");
    expect(classifyHarnessError("error", 402)).toBe("quota");
  });

  it("maps throttle messages to 'rate-limit'", () => {
    expect(classifyHarnessError("429 Too Many Requests")).toBe("rate-limit");
    expect(classifyHarnessError("rate limit exceeded")).toBe("rate-limit");
    expect(classifyHarnessError("error", 429)).toBe("rate-limit");
  });

  it("maps unclassified messages to 'unknown'", () => {
    expect(classifyHarnessError("exited 1: syntax error")).toBe("unknown");
    expect(classifyHarnessError("whip error: boom")).toBe("unknown");
    expect(classifyHarnessError("Error: connection reset")).toBe("unknown");
    expect(classifyHarnessError("error", 500)).toBe("unknown");
  });
});

describe("HarnessError", () => {
  it("carries kind and status, and defaults kind to 'unknown'", () => {
    const quota = new HarnessError("insufficient balance", "quota", 402);
    expect(quota.kind).toBe("quota");
    expect(quota.status).toBe(402);
    expect(quota.name).toBe("HarnessError");
    expect(quota.message).toBe("insufficient balance");
    expect(quota).toBeInstanceOf(Error);

    const bare = new HarnessError("boom");
    expect(bare.kind).toBe("unknown");
    expect(bare.status).toBeUndefined();
  });
});

describe("isNonRetryableHarnessError", () => {
  it("is true for quota and rate-limit HarnessErrors", () => {
    expect(isNonRetryableHarnessError(new HarnessError("q", "quota"))).toBe(
      true,
    );
    expect(
      isNonRetryableHarnessError(new HarnessError("r", "rate-limit")),
    ).toBe(true);
  });

  it("is false for unknown HarnessErrors, bare Errors, and other values", () => {
    expect(isNonRetryableHarnessError(new HarnessError("u", "unknown"))).toBe(
      false,
    );
    expect(isNonRetryableHarnessError(new Error("insufficient balance"))).toBe(
      false,
    );
    expect(isNonRetryableHarnessError("402")).toBe(false);
    expect(isNonRetryableHarnessError(null)).toBe(false);
  });
});
