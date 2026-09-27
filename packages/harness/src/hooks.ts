import { resolve, sep } from "node:path";

import type { BeforeToolEvent, BeforeToolResult } from "@whip/sdk/agents";

type ToolCall = Pick<BeforeToolEvent, "operation" | "arguments">;

const deny = (reason: string): BeforeToolResult => ({
  decision: "deny",
  reason,
});

/** A string argument, or "" when absent or not a string. */
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** Is `path` (relative to `root` when not absolute) inside `root`? */
export function inside(root: string, path: string): boolean {
  const base = resolve(root);
  const target = resolve(base, path);
  return target === base || target.startsWith(base + sep);
}

/**
 * A reviewer already lacks the write capability; this hook makes an attempted
 * edit visible as a hook decision in the run log instead of a bare capability
 * error, so a prompt that is failing to keep the model read-only shows up.
 */
export function reviewerBeforeTool(
  call: ToolCall,
): BeforeToolResult | undefined {
  if (call.operation === "files.write" || call.operation === "files.patch") {
    return deny("reviewers are read-only");
  }
  return undefined;
}

/** Shell commands the fixer may never run: loupe owns git, and nothing may
 * escalate or delete recursively. */
const FORBIDDEN_SHELL: readonly RegExp[] = [
  /\bgit\s+(commit|push|reset|checkout|switch|rebase|merge|clean|stash|tag|branch\s+-[dD])\b/,
  /\brm\s+-[a-zA-Z]*[rR]/,
  /\bsudo\b/,
  /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/,
];

/** The operations the fixer hook inspects; everything else passes untouched. */
export const FIXER_HOOK_OPERATIONS = [
  "shell.run",
  "shell.start",
  "files.write",
  "files.patch",
] as const;

/** The operations the reviewer hook inspects. */
export const REVIEWER_HOOK_OPERATIONS = ["files.write", "files.patch"] as const;

/**
 * `@loupe fix` holds write and shell so it can edit and run tests, but edits
 * stay inside the checkout and it never touches git: loupe commits and pushes.
 */
export function fixerBeforeTool(
  cwd: string,
  call: ToolCall,
): BeforeToolResult | undefined {
  const args = call.arguments;
  switch (call.operation) {
    case "shell.run":
    case "shell.start": {
      const command = text(args["command"]);
      const hit = FORBIDDEN_SHELL.find((re) => re.test(command));
      if (hit)
        return deny(
          `the fixer may not run this command: ${command.slice(0, 120)}`,
        );
      return undefined;
    }
    case "files.write":
    case "files.patch": {
      if (!inside(cwd, text(args["path"]))) {
        return deny("edits must stay inside the checkout");
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
