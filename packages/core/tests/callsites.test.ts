import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  changedExports,
  findCallSites,
  renderCallSites,
  transitiveCallSites,
} from "../src/callsites";

describe("changedExports", () => {
  it("collects exported declarations the diff adds, removes, or rewrites", () => {
    const names = changedExports([
      {
        path: "lib/auth.ts",
        patch: [
          "@@ -1,3 +1,3 @@",
          "-export function selectPrimaryProject(p: P[]): P {",
          "+export async function selectPrimaryProject(p: P[]): Promise<P> {",
          "+export type Organization = { id: string };",
          " const local = 1;",
          "+export const helper = () => 1;",
        ].join("\n"),
      },
      { path: "img.png", patch: undefined },
    ]);
    expect(names).toEqual(["Organization", "helper", "selectPrimaryProject"]);
  });
});

describe("findCallSites", () => {
  it("finds whole-word references outside the diff and skips vendored dirs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "loupe-callsites-"));
    mkdirSync(join(cwd, "lib"));
    mkdirSync(join(cwd, "commands"));
    mkdirSync(join(cwd, "node_modules", "x"), { recursive: true });
    writeFileSync(join(cwd, "lib", "auth.ts"), "export function login() {}\n");
    writeFileSync(
      join(cwd, "commands", "harness.ts"),
      'import { login } from "../lib/auth";\nawait withProgress("x", () => login());\nconst loginCount = 2;\n',
    );
    writeFileSync(join(cwd, "node_modules", "x", "i.ts"), "login();\n");
    writeFileSync(join(cwd, "README.md"), "run login\n");

    const sites = findCallSites(cwd, ["login"], new Set(["lib/auth.ts"]));
    const hits = sites.get("login")!.map((s) => `${s.path}:${s.line}`);
    expect(hits).toEqual(["commands/harness.ts:1", "commands/harness.ts:2"]);
  });

  it("returns nothing for no names", () => {
    expect(findCallSites("/", [], new Set()).size).toBe(0);
  });

  it("follows one more hop through a thin wrapper's exports", () => {
    const cwd = mkdtempSync(join(tmpdir(), "loupe-callsites2-"));
    mkdirSync(join(cwd, "lib"));
    mkdirSync(join(cwd, "commands"));
    // Changed: selectProject (lib/auth.ts). Wrapper: login (commands/auth.ts).
    // Bug site: harness.ts wraps login() in a spinner.
    writeFileSync(
      join(cwd, "lib", "auth.ts"),
      "export async function selectProject() {}\n",
    );
    writeFileSync(
      join(cwd, "commands", "auth.ts"),
      'import { selectProject } from "../lib/auth";\nexport async function login() {\n  await selectProject();\n}\n',
    );
    writeFileSync(
      join(cwd, "commands", "harness.ts"),
      'import { login } from "./auth";\nawait withProgress("Connecting", () => login());\n',
    );
    const groups = transitiveCallSites(
      cwd,
      ["selectProject"],
      new Set(["lib/auth.ts"]),
    );
    expect(groups.map((g) => g.name)).toEqual(["selectProject", "login"]);
    expect(groups[1]!.via).toEqual({
      file: "commands/auth.ts",
      uses: "selectProject",
    });
    const rendered = renderCallSites(groups, "svc/");
    expect(rendered).toContain(
      "`login` (exported by svc/commands/auth.ts, which calls changed `selectProject`",
    );
    expect(rendered).toContain(
      "- svc/commands/harness.ts:2  await withProgress",
    );
  });
});
