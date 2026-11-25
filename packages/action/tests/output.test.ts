import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HarnessError } from "@loupe/harness";

import {
  CombinedSummaryPublicationError,
  type ReviewerOutcome,
} from "../src/orchestrate";
import {
  annotateFailure,
  setOutput,
  statusForError,
  statusForOutcomes,
} from "../src/output";

let outputDir: string;
let outputFile: string;

beforeEach(() => {
  outputDir = mkdtempSync(join(tmpdir(), "loupe-github-output-"));
  outputFile = join(outputDir, "out.txt");
  process.env["GITHUB_OUTPUT"] = outputFile;
});

afterEach(() => {
  delete process.env["GITHUB_OUTPUT"];
  rmSync(outputDir, { recursive: true, force: true });
});

describe("setOutput", () => {
  it("writes a name=value line to $GITHUB_OUTPUT", () => {
    setOutput("status", "ok");
    expect(readFileSync(outputFile, "utf8")).toBe("status=ok\n");
  });

  it("appends multiple lines", () => {
    setOutput("a", "1");
    setOutput("b", "2");
    expect(readFileSync(outputFile, "utf8")).toBe("a=1\nb=2\n");
  });

  it("is a no-op when GITHUB_OUTPUT is unset", () => {
    delete process.env["GITHUB_OUTPUT"];
    setOutput("status", "ok"); // must not throw
  });
});

describe("annotateFailure", () => {
  afterEach(() => {
    delete process.env["GITHUB_ACTIONS"];
  });

  it("writes a GitHub error-annotation command on one line under Actions", () => {
    process.env["GITHUB_ACTIONS"] = "true";
    const writes: string[] = [];
    const spy = (s: string) => (writes.push(s), true);
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = spy as typeof process.stdout.write;
    try {
      annotateFailure("code (quota)\nsecond line");
    } finally {
      process.stdout.write = orig;
    }
    expect(writes.join("")).toBe(
      "::error title=loupe review failed::code (quota) second line\n",
    );
  });

  it("is a no-op outside GitHub Actions", () => {
    delete process.env["GITHUB_ACTIONS"];
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => (
      writes.push(s),
      true
    )) as typeof process.stdout.write;
    try {
      annotateFailure("should not print");
    } finally {
      process.stdout.write = orig;
    }
    expect(writes).toHaveLength(0);
  });
});

describe("statusForError", () => {
  it("maps a quota HarnessError to 'quota'", () => {
    expect(
      statusForError(new HarnessError("insufficient balance", "quota")),
    ).toBe("quota");
  });

  it("maps a rate-limit HarnessError to 'rate-limit'", () => {
    expect(
      statusForError(new HarnessError("429 Too Many Requests", "rate-limit")),
    ).toBe("rate-limit");
  });

  it("maps an unknown HarnessError to 'failed'", () => {
    expect(statusForError(new HarnessError("exited 1: boom", "unknown"))).toBe(
      "failed",
    );
  });

  it("maps a bare Error to 'failed'", () => {
    expect(statusForError(new Error("transient"))).toBe("failed");
  });

  it("maps a non-Error value to 'failed'", () => {
    expect(statusForError("oops")).toBe("failed");
  });
});

// Helpers for building outcomes without the full ReviewResult shape.
const ok = (name: string): ReviewerOutcome => ({
  name,
  ok: true,
  result: {} as never,
});
const fail = (
  name: string,
  error: string,
  kind?: "quota" | "rate-limit" | "unknown",
): ReviewerOutcome => ({ name, ok: false, error, kind });

describe("statusForOutcomes", () => {
  it("is 'ok' when every reviewer succeeded", () => {
    expect(statusForOutcomes([ok("a"), ok("b")])).toBe("ok");
  });

  it("is 'quota' when a reviewer failed with kind 'quota'", () => {
    expect(
      statusForOutcomes([ok("a"), fail("b", "402 Payment Required", "quota")]),
    ).toBe("quota");
  });

  it("is 'rate-limit' when a reviewer failed with kind 'rate-limit'", () => {
    expect(
      statusForOutcomes([
        ok("a"),
        fail("b", "429 Too Many Requests", "rate-limit"),
      ]),
    ).toBe("rate-limit");
  });

  it("is 'failed' when a reviewer failed with no kind", () => {
    expect(statusForOutcomes([ok("a"), fail("b", "boom")])).toBe("failed");
  });

  it("ranks the most actionable kind across mixed failures (quota > rate-limit > failed)", () => {
    expect(
      statusForOutcomes([
        fail("a", "transient", "unknown"),
        fail("b", "429", "rate-limit"),
        fail("c", "402", "quota"),
      ]),
    ).toBe("quota");
    expect(
      statusForOutcomes([
        fail("a", "transient", "unknown"),
        fail("b", "429", "rate-limit"),
      ]),
    ).toBe("rate-limit");
    expect(
      statusForOutcomes([fail("a", "boom"), fail("b", "also boom", "unknown")]),
    ).toBe("failed");
  });
});

describe("CombinedSummaryPublicationError status recovery", () => {
  it("carries the reviewer outcomes so status survives a summary-post failure", () => {
    const outcomes = [ok("a"), fail("b", "402 Payment Required", "quota")];
    const err = new CombinedSummaryPublicationError(
      new Error("summary post 500"),
      outcomes,
    );
    // A caller recovers the run's real status from the carried outcomes
    // instead of the blanket "failed" the catch would otherwise derive.
    expect(err.outcomes).toBe(outcomes);
    expect(statusForOutcomes(err.outcomes)).toBe("quota");
  });
});

describe("statusForOutcomes with a failed summary post", () => {
  it("is 'failed' when every reviewer succeeded but the summary failed to post", () => {
    expect(statusForOutcomes([ok("a"), ok("b")], true)).toBe("failed");
  });

  it("is 'quota' when a reviewer hit quota even though the summary post failed", () => {
    expect(statusForOutcomes([ok("a"), fail("b", "402", "quota")], true)).toBe(
      "quota",
    );
  });

  it("is 'rate-limit' when a reviewer hit rate-limit even though the summary post failed", () => {
    expect(statusForOutcomes([fail("a", "429", "rate-limit")], true)).toBe(
      "rate-limit",
    );
  });
});
