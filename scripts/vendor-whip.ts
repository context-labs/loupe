#!/usr/bin/env bun
/**
 * Refresh vendor/@whip from a whip checkout: build the SDK there, copy the
 * built protocol and SDK packages here, and rewrite their manifests as plain
 * workspace packages. Usage: bun run scripts/vendor-whip.ts [path-to-whip]
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const whip = resolve(process.argv[2] ?? "../whip");
const out = resolve(import.meta.dir, "..", "vendor", "@whip");

function run(cmd: string, args: readonly string[], cwd: string): string {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${res.stderr}`);
  }
  return res.stdout.trim();
}

type Manifest = Record<string, unknown>;

function manifest(path: string, edit: (m: Manifest) => void): string {
  const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  for (const k of ["private", "scripts", "engines", "devDependencies"]) {
    delete m[k];
  }
  edit(m);
  return JSON.stringify(m, null, 2) + "\n";
}

run("npm", ["run", "build"], join(whip, "packages", "sdk"));

const protocol = join(out, "protocol");
const sdk = join(out, "sdk");
rmSync(join(protocol, "generated"), { recursive: true, force: true });
rmSync(join(sdk, "dist"), { recursive: true, force: true });
mkdirSync(protocol, { recursive: true });
mkdirSync(sdk, { recursive: true });
cpSync(join(whip, "packages/protocol/generated"), join(protocol, "generated"), {
  recursive: true,
});
cpSync(join(whip, "packages/sdk/dist"), join(sdk, "dist"), {
  recursive: true,
});
cpSync(join(whip, "packages/sdk/README.md"), join(sdk, "README.md"));
writeFileSync(
  join(protocol, "package.json"),
  manifest(join(whip, "packages/protocol/package.json"), () => {}),
);
writeFileSync(
  join(sdk, "package.json"),
  manifest(join(whip, "packages/sdk/package.json"), (m) => {
    m["dependencies"] = { "@whip/protocol": "workspace:*" };
    delete m["peerDependencies"];
    delete m["peerDependenciesMeta"];
  }),
);

// The wire protocol version the daemon reports (protocol_major.protocol_minor);
// the npm package version says nothing about daemon compatibility.
const wire = /Major\s*=\s*(\d+)[\s\S]*?Minor\s*=\s*(\d+)/.exec(
  readFileSync(join(whip, "internal/protocol/types.go"), "utf8"),
);
const version = wire ? `${wire[1]}.${wire[2]}` : "unknown";
// A tag when HEAD sits on one (a release), else the branch name.
const ref = spawnSync("git", ["describe", "--tags", "--exact-match"], {
  cwd: whip,
  encoding: "utf8",
});
const source =
  ref.status === 0
    ? ref.stdout.trim()
    : run("git", ["rev-parse", "--abbrev-ref", "HEAD"], whip);
const commit = run("git", ["rev-parse", "--short", "HEAD"], whip);
writeFileSync(
  join(out, "VERSION"),
  [
    `source: context-labs/whip ${source} @ ${commit}`,
    `protocol: ${version}`,
    `built: ${new Date().toISOString().slice(0, 16)}Z`,
    "refresh: task vendor:whip WHIP=<whip checkout>",
    "",
  ].join("\n"),
);
console.log(
  `vendored @whip/sdk (protocol ${version}) from ${source} @ ${commit}`,
);
