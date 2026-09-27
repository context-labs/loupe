import { createHash } from "node:crypto";

import type { Schema } from "@whip/sdk";
import {
  defineAgent,
  type AgentDefinition,
  type AgentInput,
} from "@whip/sdk/agents";

import {
  FIXER_HOOK_OPERATIONS,
  REVIEWER_HOOK_OPERATIONS,
  fixerBeforeTool,
  reviewerBeforeTool,
} from "./hooks";

/** `loupe-<name>` fitted to whip's definition id rules. */
export function definitionId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `loupe-${slug || "review"}`.slice(0, 64).replace(/-+$/, "");
}

/**
 * A definition id that changes with the definition's content. A new session
 * takes the id's most recently *created* revision, and registration is
 * idempotent on content, so two variants sharing an id (agentic and one-shot,
 * or a reviewer before and after its conventions changed) would hand a
 * session the wrong one; the runtime refuses that instead of running it, and
 * a content hash in the id keeps it from ever happening.
 */
export function contentId(name: string, ...parts: unknown[]): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 8);
  return `${definitionId(name).slice(0, 64 - 9)}-${hash}`;
}

/** Define an agent whose id carries the hash of its canonical document. */
function defineNamed(
  name: string,
  input: Omit<AgentInput<Schema | undefined>, "id">,
): AgentDefinition {
  const draft = defineAgent({ ...input, id: "loupe-draft" });
  const id = contentId(name, { ...draft.document, id: "" });
  return defineAgent({ ...input, id });
}

const readOnlyHook = {
  beforeTool: {
    operations: [...REVIEWER_HOOK_OPERATIONS],
    handler: reviewerBeforeTool,
  },
};

/**
 * A reviewer: loupe's system prompt as the persona, read-only authority, the
 * file module only when the review is agentic, and an output contract the
 * daemon enforces on its final message. whip appends its own runtime guide,
 * so the model learns the modules it may call and the shape it must answer
 * with.
 */
export function reviewerAgent(spec: {
  readonly name?: string;
  readonly systemPrompt: string;
  readonly agentic: boolean;
  /** The review schema the final message must match. */
  readonly output?: Schema;
}): AgentDefinition {
  return defineNamed(spec.name ?? "review", {
    instructions: { persona: spec.systemPrompt },
    modules: spec.agentic ? ["context", "files"] : ["context"],
    capabilities: ["read"],
    output: spec.output,
    hooks: spec.agentic ? readOnlyHook : undefined,
  });
}

/** Second opinion on findings, answering under a contract: reads the
 * checkout when the review was agentic, the diff alone otherwise. */
export function verifierAgent(spec: {
  readonly systemPrompt: string;
  readonly agentic: boolean;
  readonly output?: Schema;
}): AgentDefinition {
  return defineNamed("verifier", {
    instructions: { persona: spec.systemPrompt },
    modules: spec.agentic ? ["context", "files"] : ["context"],
    capabilities: ["read"],
    output: spec.output,
    hooks: spec.agentic ? readOnlyHook : undefined,
  });
}

/** Prose answers to `@loupe <question>`; diff only. */
export function chatAgent(systemPrompt: string): AgentDefinition {
  return defineNamed("chat", {
    instructions: { persona: systemPrompt },
    modules: ["context"],
    capabilities: ["read"],
  });
}

/**
 * `@loupe fix`: edits the checkout at `cwd` and may run tests there; a hook
 * keeps edits inside the checkout and git out of its hands. loupe commits and
 * pushes afterwards.
 */
export function fixerAgent(systemPrompt: string, cwd: string): AgentDefinition {
  return defineNamed("fixer", {
    instructions: { persona: systemPrompt },
    modules: ["context", "files", "shell"],
    capabilities: ["read", "write", "shell"],
    hooks: {
      beforeTool: {
        operations: [...FIXER_HOOK_OPERATIONS],
        handler: (event) => fixerBeforeTool(cwd, event),
      },
    },
  });
}
