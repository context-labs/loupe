import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runTypeCheck } from "../src/index";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => logger),
} as never;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "loupe-tc-"));
}

describe("runTypeCheck", () => {
  it("keeps only diagnostic lines that mention a changed file", async () => {
    const cwd = tmp();
    const cmd =
      "printf 'src/a.ts(1,1): error TS2322 bad\\nsrc/other.ts(2,2): error TS1 nope\\n'";
    const r = await runTypeCheck(cwd, cmd, ["src/a.ts"], logger);
    expect(r.status).toBe("ran");
    expect(r.report).toContain("src/a.ts(1,1): error TS2322");
    expect(r.report).not.toContain("src/other.ts");
  });

  it("reports a clean result when nothing touches the changed files", async () => {
    const cwd = tmp();
    const cmd = "printf 'src/unrelated.ts(1,1): error\\n'";
    const r = await runTypeCheck(cwd, cmd, ["src/a.ts"], logger);
    expect(r.status).toBe("ran");
    expect(r.report).toMatch(/no diagnostics on the changed files/i);
  });

  it("skips (does not fail) when the command cannot be spawned", async () => {
    const r = await runTypeCheck(
      "/this/dir/does/not/exist",
      "echo hi",
      ["src/a.ts"],
      logger,
    );
    expect(r.status).toBe("skipped");
    expect(r.report).toBeUndefined();
  });

  it("memoizes per (cwd, cmd) so N reviewers trigger one run", async () => {
    const cwd = tmp();
    const marker = join(cwd, "ran.count");
    // Append a byte each invocation; a single byte proves it ran once.
    const cmd = `printf x >> ${marker}`;
    await Promise.all([
      runTypeCheck(cwd, cmd, ["src/a.ts"], logger),
      runTypeCheck(cwd, cmd, ["src/a.ts"], logger),
      runTypeCheck(cwd, cmd, ["src/a.ts"], logger),
    ]);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("x");
  });
});
