import { afterEach, describe, expect, it, vi } from "vitest";

import { armTimeout, HarnessError } from "../src/index";

describe("armTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills the child and rejects once the timeout elapses", () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const reject = vi.fn();
    armTimeout({ kill }, "whip", reject);

    // Well past the 15-minute default ceiling.
    vi.advanceTimersByTime(16 * 60_000);

    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(reject).toHaveBeenCalledTimes(1);
    const err = reject.mock.calls[0]![0] as HarnessError;
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.message).toContain("timed out");
  });

  it("does nothing once cleared (normal completion)", () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const reject = vi.fn();
    const clear = armTimeout({ kill }, "whip", reject);

    clear();
    vi.advanceTimersByTime(16 * 60_000);

    expect(kill).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });
});
