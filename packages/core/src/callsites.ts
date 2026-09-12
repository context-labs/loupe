import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DiffFile } from "./diff";

/** An exported value the diff touches, with the file that declares it. */
export type ChangedExport = { readonly name: string; readonly file: string };

const VALUE_DECL =
  /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;

/**
 * Exported values (not types) the diff touches: a declaration line it adds or
 * rewrites, a declaration named in a hunk header (git prints the enclosing
 * declaration after the second `@@`), or a declaration appearing as context
 * inside a hunk (the edit landed within a few lines of it). A changed export is
 * the one place a diff can silently break code it never shows, so these are
 * the names worth locating callers for.
 */
export function changedExports(files: readonly DiffFile[]): ChangedExport[] {
  const out: ChangedExport[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    for (const line of f.patch?.split("\n") ?? []) {
      let text: string | undefined;
      if (line.startsWith("@@")) text = line.replace(/^@@[^@]*@@\s*/, "");
      else if (/^[+\- ]/.test(line)) text = line.slice(1);
      const name = text ? VALUE_DECL.exec(text)?.[1] : undefined;
      if (!name) continue;
      const key = `${f.path}\0${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, file: f.path });
    }
  }
  return out;
}

export type CallSite = {
  readonly path: string;
  readonly line: number;
  readonly text: string;
};

const SOURCE_GLOBS = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"];
const EXCLUDE_DIRS = ["node_modules", "dist", "build", ".git", "coverage"];
/** Test code calls everything and breaks nothing at runtime; it only crowds out real callers. */
const TEST_PATH =
  /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/;

/**
 * The nearest ancestor of `file` (relative to `cwd`) that holds a
 * package.json, or "" for the whole checkout. Callers of a package's exports
 * live in that package; grepping wider drags in same-named functions from
 * unrelated packages.
 */
export function packageRoot(cwd: string, file: string): string {
  let dir = dirname(file);
  while (dir !== "." && dir !== "/" && dir !== "") {
    if (existsSync(join(cwd, dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return "";
}

/** True when the only occurrences of `name` on the line sit inside a string literal or a comment. */
function inStringOrComment(text: string, name: string): boolean {
  const trimmed = text.trimStart();
  if (/^(\/\/|\*|\/\*|#)/.test(trimmed)) return true;
  const stripped = text.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
  return !new RegExp(`\\b${name}\\b`).test(stripped);
}

/**
 * Whole-word references to `names` under `cwd/searchDir`, excluding the files
 * already in the diff, generated/vendored directories, and matches that occur
 * only inside strings or comments. Paths come back relative to `cwd`.
 * Best-effort: no grep, or a grep error, yields an empty map. Capped so a hot
 * identifier cannot flood the prompt.
 */
export function findCallSites(
  cwd: string,
  names: readonly string[],
  excludePaths: ReadonlySet<string>,
  searchDir = "",
  perNameCap = 12,
): Map<string, CallSite[]> {
  const out = new Map<string, CallSite[]>();
  if (names.length === 0) return out;
  const args = [
    "-rnw",
    ...SOURCE_GLOBS.flatMap((g) => ["--include", g]),
    ...EXCLUDE_DIRS.flatMap((d) => ["--exclude-dir", d]),
    "-e",
    names.join("\\|"),
    searchDir || ".",
  ];
  const res = spawnSync("grep", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error || (res.status !== 0 && res.status !== 1)) return out;
  const wordRe = new Map(names.map((n) => [n, new RegExp(`\\b${n}\\b`)]));
  for (const raw of res.stdout.split("\n")) {
    const m = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(raw);
    const [, path, lineNo, rest] = m ?? [];
    if (!path || !lineNo || rest === undefined) continue;
    if (excludePaths.has(path) || TEST_PATH.test(path)) continue;
    const text = rest.trim();
    for (const [name, re] of wordRe) {
      if (!re.test(text) || inStringOrComment(text, name)) continue;
      const list = out.get(name) ?? [];
      if (list.length < perNameCap) {
        list.push({ path, line: Number(lineNo), text: text.slice(0, 160) });
      }
      out.set(name, list);
    }
  }
  return out;
}

const EXPORT_DECL_G = new RegExp(`^\\s*${VALUE_DECL.source}`, "gm");

/** Exported value names declared in one source file (best-effort, regex). */
function exportsOf(cwd: string, path: string): string[] {
  try {
    const src = readFileSync(join(cwd, path), "utf8");
    return [...src.matchAll(EXPORT_DECL_G)]
      .map((m) => m[1] ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

export type CallSiteGroup = {
  readonly name: string;
  /** For a second-hop export: the caller file that defines it and the changed export it uses. */
  readonly via?: { readonly file: string; readonly uses: string };
  readonly sites: readonly CallSite[];
};

/**
 * Two hops of callers, each scoped to the package of the file being searched
 * from. Hop 1: callers of the changed exports. Hop 2: for every file found in
 * hop 1, its own exports and THEIR callers — a changed function behind a thin
 * wrapper (a `login()` that calls the changed selector) breaks the wrapper's
 * callers just the same, and those are where an agent stops looking when it
 * runs out of turns.
 */
export function transitiveCallSites(
  cwd: string,
  changed: readonly ChangedExport[],
  excludePaths: ReadonlySet<string>,
): CallSiteGroup[] {
  const groups: CallSiteGroup[] = [];
  const seen = new Set(changed.map((c) => c.name));
  const callerFiles = new Map<string, string>(); // file -> changed export it uses

  const byRoot = new Map<string, string[]>();
  for (const c of changed) {
    const root = packageRoot(cwd, c.file);
    byRoot.set(root, [...(byRoot.get(root) ?? []), c.name]);
  }
  for (const [root, names] of byRoot) {
    const hop1 = findCallSites(cwd, names, excludePaths, root);
    for (const [name, sites] of hop1) {
      if (sites.length === 0) continue;
      groups.push({ name, sites });
      for (const s of sites) {
        if (!callerFiles.has(s.path)) callerFiles.set(s.path, name);
      }
    }
  }
  for (const [file, uses] of callerFiles) {
    const exps = exportsOf(cwd, file).filter((n) => !seen.has(n));
    if (exps.length === 0) continue;
    for (const n of exps) seen.add(n);
    const hop2 = findCallSites(
      cwd,
      exps,
      new Set([...excludePaths, file]),
      packageRoot(cwd, file),
      8,
    );
    for (const [name, sites] of hop2) {
      if (sites.length > 0) groups.push({ name, via: { file, uses }, sites });
    }
  }
  return groups;
}

/** Prompt section: one block per export with its callers outside the diff. */
export function renderCallSites(
  groups: readonly CallSiteGroup[],
  pathPrefix = "",
): string {
  return groups
    .map((g) => {
      const head = g.via
        ? `\`${g.name}\` (exported by ${pathPrefix}${g.via.file}, which calls changed \`${g.via.uses}\`; its callers inherit the change):`
        : `\`${g.name}\` (changed in this diff):`;
      return `${head}\n${g.sites
        .map((s) => `- ${pathPrefix}${s.path}:${s.line}  ${s.text}`)
        .join("\n")}`;
    })
    .join("\n\n");
}
