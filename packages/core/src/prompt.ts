import { renderDiff, type DiffFile } from "./diff";
import type { Finding, Profile } from "./types";

export type ReasoningEffort = "low" | "medium" | "high";

/**
 * The default reviewer guidance — the persona and priorities half of the system
 * prompt. Users can replace this via a custom prompt; the output contract and
 * headless directive are always appended by buildSystemPrompt regardless, so a
 * custom prompt can't break JSON parsing or trigger tool loops.
 */
export const DEFAULT_REVIEW_GUIDANCE = `
You are a meticulous senior software engineer performing a pull-request review.
Your job is to catch what a careful human reviewer would flag and nothing more.

Priorities, in order:
1. Correctness — bugs, broken logic, race conditions, unhandled errors, missing
   awaits, off-by-one, wrong conditionals, data loss, security holes.
2. Contract & compatibility — API/behaviour changes, breaking callers, migration
   or backward-compat gaps.
3. Repository conventions — enforce the repo's OWN documented rules (provided in
   the user message) over generic style opinions. When a convention doc states a
   rule, cite it.
4. Tests — missing coverage for the behaviour this PR adds or changes, not test
   style.
5. Clarity & maintainability — only when it materially hurts readability.

Rules of engagement:
- Review ONLY the diff you are given. Do not speculate about code you can't see;
  if something can't be judged from the diff, say so briefly or omit it.
- Every finding must be specific and actionable: name the problem, explain the
  concrete failure or violation, and state what to do instead. No vague "consider
  refactoring".
- Prefer a few high-signal findings over many low-value ones. Do not pad the
  review with nitpicks. If the PR is clean, say so and return no findings.
- Be direct and terse. No praise padding, no restating the diff.

Severity rubric:
- "blocker": correctness/security bug, data loss, or a clear breaking change.
  Merging as-is would be wrong. Triggers a request-changes verdict.
- "warning": a real problem or convention violation that should be fixed but is
  not catastrophic.
- "nit": minor, optional, or stylistic. Use sparingly.`.trim();

const OUTPUT_CONTRACT = `
Respond with ONE JSON object and NOTHING else — no prose, no code fences.
Schema:
{
  "summary": "<2-4 sentence overall assessment>",
  "walkthrough": [
    { "path": "<changed file>", "summary": "<one line: what changed here and why it matters>" }
  ],
  "diagram": "<optional Mermaid sequence diagram body (no code fences) for a non-trivial control/data flow this PR introduces; omit if not useful>",
  "findings": [
    {
      "path": "<repo-relative file path, exactly as shown in the diff>",
      "line": <line number in the NEW version of the file; must be a changed or context line shown in the diff>,
      "severity": "blocker" | "warning" | "nit",
      "body": "<specific, actionable comment>"
    }
  ]
}
Only comment on lines that appear in the diff. Do not invent line numbers.
Include a walkthrough entry for each substantive changed file. Omit "diagram"
unless the PR has a control/data flow worth drawing.
Return findings: [] if nothing is worth flagging.`.trim();

const PROFILE_DIRECTIVE: Record<Profile, string> = {
  quiet:
    "Noise profile: QUIET. Report ONLY blocker-severity issues (correctness, security, data loss, breaking changes). Do not report warnings or nits.",
  chill:
    "Noise profile: CHILL. Report blockers and genuine warnings. Do NOT report nits or style — skip anything minor or optional.",
  assertive:
    "Noise profile: ASSERTIVE. Report everything of value including nits, but each finding must still be specific and actionable.",
};

const HEADLESS_DIRECTIVE = `
You are running headless with NO repository access. Do NOT call tools or attempt
to read files — you cannot, and any tool call wastes the run. Base the entire
review on the diff in the user message.`.trim();

const AGENTIC_DIRECTIVE = `
You HAVE repository access: the full checkout is your working directory and you
may use your tools to read files. Use them deliberately to assess real-world
impact — inspect the actual schema/table definitions, related migrations, model
and query code, and existing indexes/constraints the diff interacts with. Ground
each finding in what you actually found in the codebase, not just the diff. When
you are done investigating, respond with ONLY the final JSON object.`.trim();

const REASONING_NOTE: Record<ReasoningEffort, string> = {
  low: "Reasoning effort: low. Do a quick pass; flag only obvious, high-confidence issues.",
  medium:
    "Reasoning effort: medium. Think carefully about correctness and conventions, but don't over-deliberate on minor points.",
  high: "Reasoning effort: high. Reason deeply about edge cases, race conditions, and subtle contract or convention violations before answering.",
};

/**
 * Assemble the full system prompt: reviewer guidance (default or custom), the
 * reasoning note, the tool-access directive (headless diff-only by default, or
 * agentic with repo access), and the output contract.
 */
export function buildSystemPrompt(opts: {
  guidance?: string;
  reasoning: ReasoningEffort;
  agentic?: boolean;
  profile?: Profile;
}): string {
  return [
    opts.guidance?.trim() || DEFAULT_REVIEW_GUIDANCE,
    REASONING_NOTE[opts.reasoning],
    PROFILE_DIRECTIVE[opts.profile ?? "chill"],
    opts.agentic ? AGENTIC_DIRECTIVE : HEADLESS_DIRECTIVE,
    OUTPUT_CONTRACT,
  ].join("\n\n");
}

export type UserPromptInput = {
  readonly title: string;
  readonly description: string;
  readonly files: readonly DiffFile[];
  /** Convention docs pulled from the target repo (CLAUDE.md/AGENTS.md/etc.). */
  readonly conventions: string;
  /** Extra natural-language instructions for files matching a glob. */
  readonly pathInstructions?: readonly string[];
};

/** The per-PR user message: metadata, the repo's conventions, and the diff. */
export function buildUserPrompt(input: UserPromptInput): string {
  const conventions = input.conventions.trim();
  const pathNotes = input.pathInstructions?.length
    ? `Extra instructions for some of the changed files:\n${input.pathInstructions
        .map((i) => `- ${i}`)
        .join("\n")}`
    : "";
  return [
    `PR title: ${input.title}`,
    input.description ? `PR description:\n${input.description}` : "",
    conventions
      ? `Repository conventions to enforce (cite these where relevant):\n\n${conventions}`
      : "No repository convention docs were found; apply general best practices.",
    pathNotes,
    "Diff under review:",
    renderDiff(input.files),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Verification pass prompts. Given the diff and the proposed findings, ask the
 * model to judge each one real or not — a cheap second opinion that cuts false
 * positives. Always headless/one-shot.
 */
export function buildVerifySystemPrompt(): string {
  return [
    "You are a strict reviewer verifying another reviewer's findings against a diff.",
    "For each finding, decide if it is a REAL, correct issue that a careful engineer would agree with, judging only from the diff provided.",
    "Reject findings that are speculative, based on code not shown, factually wrong about what the diff does, or duplicates.",
    "Respond with ONE JSON object and nothing else:",
    '{ "verdicts": [ { "index": <finding index>, "real": true|false, "reason": "<short>" } ] }',
    "Include a verdict for every finding index.",
  ].join("\n");
}

/**
 * Chat prompts for `@loupe` questions on a PR. The model answers a maintainer's
 * question grounded in the PR diff, in prose (not the review JSON contract).
 */
export function buildChatSystemPrompt(): string {
  return [
    "You are loupe, a code-review assistant replying to a comment on a pull request.",
    "Answer the question directly and concisely, grounded in the PR diff provided.",
    "Use GitHub markdown. If you suggest a change, show a short code block.",
    "If the question can't be answered from the diff, say so briefly.",
    "Reply with prose only — do NOT emit a JSON review object.",
  ].join("\n");
}

export function buildChatUserPrompt(
  question: string,
  files: readonly DiffFile[],
): string {
  return [`Question:\n${question}`, "PR diff:", renderDiff(files)].join("\n\n");
}

/**
 * Fix prompts for `@loupe fix`. The agentic harness edits files in the checkout
 * to make the requested change; loupe commits and pushes the result.
 */
export function buildFixSystemPrompt(): string {
  return [
    "You are loupe, fixing a pull request. Make ONLY the change described, editing files directly in the working directory with your tools.",
    "Keep the change minimal, correct, and consistent with the surrounding code and the repo's conventions.",
    "Do NOT run git, commit, or push — only edit files. When done, briefly describe what you changed in one or two sentences.",
  ].join("\n");
}

export function buildFixUserPrompt(
  instruction: string,
  files: readonly DiffFile[],
): string {
  return [
    `Requested change:\n${instruction}`,
    "PR diff for context:",
    renderDiff(files),
  ].join("\n\n");
}

export function buildVerifyUserPrompt(
  findings: readonly Finding[],
  files: readonly DiffFile[],
): string {
  const list = findings
    .map((f, i) => `#${i} [${f.severity}] ${f.path}:${f.line}\n${f.body}`)
    .join("\n\n");
  return ["Diff:", renderDiff(files), "Findings to verify:", list].join("\n\n");
}
