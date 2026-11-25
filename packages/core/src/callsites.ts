import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DiffFile } from "./diff";

/** An exported value the diff touches, with the file that declares it. */
export type ChangedExport = { readonly name: string; readonly file: string };

/** TS/JS `export function foo` … and Elixir `def foo(`/`defmacro foo(` (public only; defp is private). */
const VALUE_DECL =
  /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)|^\s*def(?:macro)?\s+([a-z_][\w?!]*)/;

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
      const m = text ? VALUE_DECL.exec(text) : null;
      const name = m ? (m[1] ?? m[2]) : undefined;
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
  /** Up to four non-blank source lines before `line`, so a wrapper call such as `withProgress(` is visible without opening the file. */
  readonly context?: readonly string[];
};

const SOURCE_GLOBS = [
  "*.ts",
  "*.tsx",
  "*.js",
  "*.jsx",
  "*.mjs",
  "*.cjs",
  "*.ex",
  "*.exs",
];
/** Files that mark a package root; callers of a package's exports live inside it. */
const PACKAGE_MARKERS = [
  "package.json",
  "mix.exs",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
];
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
    if (PACKAGE_MARKERS.some((m) => existsSync(join(cwd, dir, m)))) return dir;
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

const FN_DECL =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/;

/** Source lines of `path` under `cwd`, or [] when unreadable. Cached per call tree. */
function linesOf(
  cache: Map<string, string[]>,
  cwd: string,
  path: string,
): string[] {
  let lines = cache.get(path);
  if (!lines) {
    try {
      lines = readFileSync(join(cwd, path), "utf8").split("\n");
    } catch {
      lines = [];
    }
    cache.set(path, lines);
  }
  return lines;
}

/** Name of the nearest function declaration above `line` (1-based), exported or not. */
function enclosingFunction(
  lines: readonly string[],
  line: number,
): string | undefined {
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const m = FN_DECL.exec(lines[i] ?? "");
    if (m) return m[1] ?? m[2];
  }
  return undefined;
}

/**
 * True when `lines` contains an import/require statement that pulls in `name`.
 * A sibling package that imports a symbol of the same name as a changed export
 * is almost certainly consuming that export; an unrelated same-named function
 * defined locally has no such import. This gate is what lets the caller search
 * cross the package boundary without dragging in same-name collisions.
 */
function importsSymbol(lines: readonly string[], name: string): boolean {
  const re = new RegExp(`\\b${name}\\b`);
  for (const l of lines) {
    if (/\b(?:import|require)\b/.test(l) && re.test(l)) return true;
  }
  return false;
}

function withContext(lines: readonly string[], site: CallSite): CallSite {
  const ctx: string[] = [];
  for (let i = site.line - 2; i >= 0 && ctx.length < 4; i--) {
    const t = (lines[i] ?? "").trim();
    if (t) ctx.unshift(t.slice(0, 120));
  }
  return ctx.length ? { ...site, context: ctx } : site;
}

export type CallSiteGroup = {
  readonly name: string;
  /** For a later hop: the file that defines this function and the changed-or-derived function it calls. */
  readonly via?: { readonly file: string; readonly uses: string };
  readonly sites: readonly CallSite[];
};

/** How many caller hops to follow from a changed export. */
const MAX_HOPS = 3;

/**
 * Callers of the changed exports, followed up to MAX_HOPS through the
 * functions that enclose each call site (exported or not), each hop scoped to
 * the package of the file being searched. A changed function behind a thin
 * wrapper (a `login()` that calls the changed selector, itself called from an
 * `ensureSession()` that a spinner wraps) breaks the outermost caller just the
 * same, and that is exactly where an agent stops looking when it runs out of
 * turns. Every site carries a few lines of preceding context so the wrapper is
 * visible in the prompt.
 */
export function transitiveCallSites(
  cwd: string,
  changed: readonly ChangedExport[],
  excludePaths: ReadonlySet<string>,
): CallSiteGroup[] {
  const groups: CallSiteGroup[] = [];
  const cache = new Map<string, string[]>();
  const seen = new Set(changed.map((c) => c.name));
  // Functions to look up next: name -> where it is defined and what it calls.
  let frontier = changed.map((c) => ({ name: c.name, file: c.file, uses: "" }));

  for (let hop = 1; hop <= MAX_HOPS && frontier.length > 0; hop++) {
    const next: typeof frontier = [];
    const byRoot = new Map<string, typeof frontier>();
    for (const f of frontier) {
      const root = packageRoot(cwd, f.file);
      byRoot.set(root, [...(byRoot.get(root) ?? []), f]);
    }
    for (const [root, fns] of byRoot) {
      // Diff files are excluded (the agent reads those hunks anyway), but a
      // later hop's own file is not: a private helper's callers usually sit
      // in the same file. Its declaration and import lines are dropped below.
      const found = findCallSites(
        cwd,
        fns.map((f) => f.name),
        excludePaths,
        root,
        hop === 1 ? 12 : 6,
      );
      for (const fn of fns) {
        const sites = (found.get(fn.name) ?? [])
          .filter((s) => !FN_DECL.test(s.text) && !/^import\b/.test(s.text))
          .map((s) => withContext(linesOf(cache, cwd, s.path), s));
        if (sites.length === 0) continue;
        groups.push({
          name: fn.name,
          via: fn.uses ? { file: fn.file, uses: fn.uses } : undefined,
          sites,
        });
        for (const s of sites) {
          const enclosing = enclosingFunction(
            linesOf(cache, cwd, s.path),
            s.line,
          );
          if (!enclosing || seen.has(enclosing)) continue;
          seen.add(enclosing);
          next.push({ name: enclosing, file: s.path, uses: fn.name });
        }
      }
    }
    frontier = next;
  }

  // Cross-package callers. The per-package search above deliberately scopes each
  // export to its own package to avoid same-named functions in unrelated
  // packages, but that hides the one caller a monorepo change most often
  // breaks: a sibling package that imports the changed export. Search the whole
  // checkout for the changed exports and keep a site only when its file is in a
  // different package AND imports the symbol — the import gate separates a real
  // consumer from an unrelated same-named definition.
  const declRoot = new Map(
    changed.map((c) => [c.name, packageRoot(cwd, c.file)]),
  );
  const wide = findCallSites(
    cwd,
    changed.map((c) => c.name),
    excludePaths,
  );
  const crossByName = new Map<string, CallSite[]>();
  for (const c of changed) {
    if (crossByName.has(c.name)) continue;
    const extra = (wide.get(c.name) ?? [])
      .filter(
        (s) =>
          packageRoot(cwd, s.path) !== declRoot.get(c.name) &&
          !FN_DECL.test(s.text) &&
          !/^import\b/.test(s.text) &&
          importsSymbol(linesOf(cache, cwd, s.path), c.name),
      )
      .map((s) => withContext(linesOf(cache, cwd, s.path), s));
    if (extra.length > 0) crossByName.set(c.name, extra);
  }
  if (crossByName.size === 0) return groups;

  // Merge cross-package sites into each changed export's existing group (or add
  // a group when its only callers are cross-package), deduped by path:line.
  const merged: CallSiteGroup[] = [];
  const done = new Set<string>();
  for (const g of groups) {
    const extra = g.via ? undefined : crossByName.get(g.name);
    if (!extra) {
      merged.push(g);
      continue;
    }
    const seenSite = new Set(g.sites.map((s) => `${s.path}:${s.line}`));
    const add = extra.filter((s) => !seenSite.has(`${s.path}:${s.line}`));
    merged.push(add.length ? { ...g, sites: [...g.sites, ...add] } : g);
    done.add(g.name);
  }
  for (const c of changed) {
    const extra = crossByName.get(c.name);
    if (!extra || done.has(c.name)) continue;
    merged.push({ name: c.name, sites: extra });
    done.add(c.name);
  }
  return merged;
}

/** Prompt section: one block per export with its callers outside the diff. */
export function renderCallSites(
  groups: readonly CallSiteGroup[],
  pathPrefix = "",
): string {
  return groups
    .map((g) => {
      const head = g.via
        ? `\`${g.name}\` (${pathPrefix}${g.via.file}) calls \`${g.via.uses}\`, so its callers inherit the change:`
        : `\`${g.name}\` (changed in this diff) is called from:`;
      return `${head}\n${g.sites
        .map((s) => {
          const ctx = (s.context ?? []).map((c) => `      | ${c}`).join("\n");
          return `${ctx ? `${ctx}\n` : ""}- ${pathPrefix}${s.path}:${s.line}  ${s.text}`;
        })
        .join("\n")}`;
    })
    .join("\n\n");
}
