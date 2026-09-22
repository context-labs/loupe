import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HarnessError } from "@loupe/harness";

import { setOutput, statusForError } from "../src/output";

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
