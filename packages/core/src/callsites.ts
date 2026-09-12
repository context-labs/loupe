import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DiffFile } from "./diff";

/**
 * Exported identifiers whose declaration line the diff adds, removes, or
 * rewrites. A changed export is the one place a diff can silently break code
 * it never shows, so these are the names worth locating callers for.
 */
export function changedExports(files: readonly DiffFile[]): string[] {
  const names = new Set<string>();
  const decl =
    /^[+-]\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
  for (const f of files) {
    for (const line of f.patch?.split("\n") ?? []) {
      const m = decl.exec(line);
      if (m?.[1]) names.add(m[1]);
    }
  }
  return [...names].sort();
}

export type CallSite = {
  readonly path: string;
  readonly line: number;
  readonly text: string;
};

const SOURCE_GLOBS = [
  "*.ts",
  "*.tsx",
  "*.js",
  "*.jsx",
  "*.mjs",
  "*.cjs",
  "*.py",
  "*.go",
  "*.rs",
];
const EXCLUDE_DIRS = ["node_modules", "dist", "build", ".git", "coverage"];

/**
 * Whole-word references to `names` in the checkout under `cwd`, excluding the
 * files already in the diff and generated/vendored directories. Paths come
 * back relative to `cwd`. Best-effort: no grep, or a grep error, yields an
 * empty list. Capped so a hot identifier cannot flood the prompt.
 */
export function findCallSites(
  cwd: string,
  names: readonly string[],
  excludePaths: ReadonlySet<string>,
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
    ".",
  ];
  const res = spawnSync("grep", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error || (res.status !== 0 && res.status !== 1)) return out;
  const wordRe = new Map(names.map((n) => [n, new RegExp(`\\b${n}\\b`)]));
  for (const raw of res.stdout.split("\n")) {
    const m = /^\.\/(.+?):(\d+):(.*)$/.exec(raw);
    const [, path, lineNo, rest] = m ?? [];
    if (!path || !lineNo || rest === undefined) continue;
    if (excludePaths.has(path)) continue;
    const text = rest.trim();
    for (const [name, re] of wordRe) {
      if (!re.test(text)) continue;
      const list = out.get(name) ?? [];
      if (list.length < perNameCap) {
        list.push({ path, line: Number(lineNo), text: text.slice(0, 160) });
      }
      out.set(name, list);
    }
  }
  return out;
}

const EXPORT_DECL =
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

/** Exported value names declared in one source file (best-effort, regex). */
function exportsOf(cwd: string, path: string): string[] {
  try {
    const src = readFileSync(join(cwd, path), "utf8");
    return [...src.matchAll(EXPORT_DECL)]
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
 * Two hops of callers. Hop 1: callers of the changed exports. Hop 2: for every
 * file found in hop 1, its own exports and THEIR callers — a changed function
 * behind a thin wrapper (a `login()` that calls the changed selector) breaks
 * the wrapper's callers just the same, and those are where the agent stops
 * looking when it runs out of turns.
 */
export function transitiveCallSites(
  cwd: string,
  names: readonly string[],
  excludePaths: ReadonlySet<string>,
): CallSiteGroup[] {
  const groups: CallSiteGroup[] = [];
  const hop1 = findCallSites(cwd, names, excludePaths);
  for (const [name, sites] of hop1) {
    if (sites.length > 0) groups.push({ name, sites });
  }
  const seen = new Set(names);
  const callerFiles = new Map<string, string>(); // file -> changed export it uses
  for (const [name, sites] of hop1) {
    for (const s of sites)
      if (!callerFiles.has(s.path)) callerFiles.set(s.path, name);
  }
  for (const [file, uses] of callerFiles) {
    const exps = exportsOf(cwd, file).filter((n) => !seen.has(n));
    if (exps.length === 0) continue;
    for (const n of exps) seen.add(n);
    const hop2 = findCallSites(cwd, exps, new Set([...excludePaths, file]), 8);
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
