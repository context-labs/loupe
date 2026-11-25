import { describe, expect, it, vi } from "vitest";

import { HarnessError } from "@loupe/harness";

import { withRateLimitRetry } from "../src/index";

const noSleep = () => Promise.resolve();

describe("withRateLimitRetry", () => {
  it("retries a rate-limit error with exponential backoff, then succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const out = await withRateLimitRetry(
      () => {
        calls++;
        if (calls < 3)
          return Promise.reject(
            new HarnessError("429 rate limit", "rate-limit"),
          );
        return Promise.resolve("ok");
      },
      { baseMs: 1000, sleep: (ms) => (sleeps.push(ms), Promise.resolve()) },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]); // 1000*2^0, 1000*2^1
  });

  it("does NOT retry a quota error", async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        () => {
          calls++;
          return Promise.reject(new HarnessError("402 insufficient", "quota"));
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow("402 insufficient");
    expect(calls).toBe(1);
  });

  it("gives up after the retry budget and throws the last error", async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        () => {
          calls++;
          return Promise.reject(new HarnessError("429", "rate-limit"));
        },
        { retries: 2, sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(HarnessError);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("honors a parseable Retry-After hint over the exponential default", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await withRateLimitRetry(
      () => {
        calls++;
        if (calls < 2)
          return Promise.reject(
            new HarnessError("rate limited, retry after 7s", "rate-limit"),
          );
        return Promise.resolve("done");
      },
      { baseMs: 1000, sleep: (ms) => (sleeps.push(ms), Promise.resolve()) },
    );
    expect(sleeps).toEqual([7000]);
  });

  it("does not retry a plain (non-HarnessError) failure", async () => {
    const spy = vi.fn(() => Promise.reject(new Error("boom")));
    await expect(withRateLimitRetry(spy, { sleep: noSleep })).rejects.toThrow(
      "boom",
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
