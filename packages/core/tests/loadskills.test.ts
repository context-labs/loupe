import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "@loupe/logger";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSkills } from "../src/index";

const warn = vi.fn();
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn,
  error: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

const tmpDirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "loupe-skills-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

describe("loadSkills — containment and basename guards", () => {
  it("refuses a non-SKILL.md basename and never returns its content", () => {
    const workdir = workspace();
    mkdirSync(join(workdir, ".git"));
    writeFileSync(join(workdir, ".git", "config"), "token = secret");

    const out = loadSkills(workdir, [".git/config"], logger);

    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("refuses a SKILL.md that symlinks outside the workspace", () => {
    const workdir = workspace();
    const outside = workspace();
    writeFileSync(join(outside, "secret.md"), "escaped content");
    mkdirSync(join(workdir, "skills", "evil"), { recursive: true });
    symlinkSync(
      join(outside, "secret.md"),
      join(workdir, "skills", "evil", "SKILL.md"),
    );

    const out = loadSkills(workdir, ["skills/evil"], logger);

    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("loads a legit in-tree skill directory", () => {
    const workdir = workspace();
    mkdirSync(join(workdir, "skills", "foo"), { recursive: true });
    writeFileSync(join(workdir, "skills", "foo", "SKILL.md"), "# Foo skill");

    const out = loadSkills(workdir, ["skills/foo"], logger);

    expect(out).toEqual(["# Foo skill"]);
  });
});
