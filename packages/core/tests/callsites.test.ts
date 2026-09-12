import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  changedExports,
  findCallSites,
  packageRoot,
  renderCallSites,
  transitiveCallSites,
} from "../src/callsites";

describe("changedExports", () => {
  it("collects rewritten declarations, hunk-header and context declarations; skips types", () => {
    const names = changedExports([
      {
        path: "lib/auth.ts",
        patch: [
          "@@ -1,3 +1,3 @@",
          "-export function selectPrimaryProject(p: P[]): P {",
          "+export async function selectPrimaryProject(p: P[]): Promise<P> {",
          "+export type Organization = { id: string };",
          "@@ -115,7 +115,7 @@ export async function signInWithDevice(): Promise<R> {",
          " export async function loadAndPersistPrimaryProject(): Promise<P> {",
          "-  const project = selectPrimaryProject(projects);",
          "+  const project = await selectPrimaryProject(projects);",
        ].join("\n"),
      },
      { path: "img.png", patch: undefined },
    ]);
    expect(names).toEqual([
      { name: "selectPrimaryProject", file: "lib/auth.ts" },
      { name: "signInWithDevice", file: "lib/auth.ts" },
      { name: "loadAndPersistPrimaryProject", file: "lib/auth.ts" },
    ]);
  });
});

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "loupe-callsites-"));
  // apps/fast: the package under review. apps/other: same names, unrelated.
  for (const d of [
    "apps/fast/lib",
    "apps/fast/commands",
    "apps/other/src",
    "apps/fast/node_modules/x",
    "apps/fast/tests",
  ]) {
    mkdirSync(join(cwd, d), { recursive: true });
  }
  writeFileSync(join(cwd, "apps/fast/package.json"), "{}");
  writeFileSync(join(cwd, "apps/other/package.json"), "{}");
  writeFileSync(
    join(cwd, "apps/fast/lib/auth.ts"),
    "export async function selectProject() {}\n",
  );
  writeFileSync(
    join(cwd, "apps/fast/commands/auth.ts"),
    [
      'import { selectProject } from "../lib/auth";',
      "// selectProject is called below",
      'console.log("selectProject done");',
      "export async function login() {",
      "  await selectProject();",
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "apps/fast/commands/harness.ts"),
    'import { login } from "./auth";\nawait withProgress("Connecting", () => login());\n',
  );
  writeFileSync(
    join(cwd, "apps/other/src/x.ts"),
    "export function selectProject() {}\nselectProject();\n",
  );
  writeFileSync(
    join(cwd, "apps/fast/node_modules/x/i.ts"),
    "selectProject();\n",
  );
  return cwd;
}

describe("findCallSites", () => {
  it("finds identifier references in the package only, skipping strings, comments, tests, vendored dirs", () => {
    const cwd = repo();
    expect(packageRoot(cwd, "apps/fast/lib/auth.ts")).toBe("apps/fast");
    const sites = findCallSites(
      cwd,
      ["selectProject"],
      new Set(["apps/fast/lib/auth.ts"]),
      "apps/fast",
    );
    expect(
      sites.get("selectProject")!.map((s) => `${s.path}:${s.line}`),
    ).toEqual(["apps/fast/commands/auth.ts:1", "apps/fast/commands/auth.ts:5"]);
  });

  it("returns nothing for no names", () => {
    expect(findCallSites("/", [], new Set()).size).toBe(0);
  });
});

describe("transitiveCallSites", () => {
  it("follows callers through enclosing functions, exported or not, with preceding context", () => {
    const cwd = repo();
    // Add a private helper in harness.ts that a spinner wraps: the 3-hop chain
    // selectProject <- login <- ensureSession <- withProgress(() => ensureSession()).
    writeFileSync(
      join(cwd, "apps/fast/commands/harness.ts"),
      [
        'import { login } from "./auth";',
        "async function ensureSession() {",
        "  await login();",
        "}",
        "const session = await withProgress(",
        '  "Checking your session",',
        "  () => ensureSession(),",
        ");",
      ].join("\n"),
    );
    const groups = transitiveCallSites(
      cwd,
      [{ name: "selectProject", file: "apps/fast/lib/auth.ts" }],
      new Set(["apps/fast/lib/auth.ts"]),
    );
    expect(groups.map((g) => g.name)).toEqual([
      "selectProject",
      "login",
      "ensureSession",
    ]);
    expect(groups[2]!.via).toEqual({
      file: "apps/fast/commands/harness.ts",
      uses: "login",
    });
    const spinner = groups[2]!.sites[0]!;
    expect(spinner.line).toBe(7);
    expect(spinner.context).toEqual([
      "await login();",
      "}",
      "const session = await withProgress(",
      '"Checking your session",',
    ]);
    const rendered = renderCallSites(groups, "svc/");
    expect(rendered).toContain(
      "`ensureSession` (svc/apps/fast/commands/harness.ts) calls `login`",
    );
    expect(rendered).toContain("      | const session = await withProgress(");
    expect(rendered).toContain(
      "- svc/apps/fast/commands/harness.ts:7  () => ensureSession(),",
    );
    expect(rendered).not.toContain("apps/other");
    expect(rendered).not.toContain("import {");
  });
});
