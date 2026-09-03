import { renderDiff, renderFileTree, type DiffFile } from "./diff";
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
- Prefer a few high-signal findings over many low-value ones. Do not pad the
  review with nitpicks. If the PR is clean, say so and return no findings.
- ANCHOR TO LINES. If an issue relates to specific line(s), it MUST be a
  "finding" with a real line number (it becomes an inline comment). Use
  "concerns" ONLY for issues that genuinely span the whole PR and cannot point
  to any single line. Default to findings; concerns are the exception.

Writing style — be RUTHLESSLY terse (assume the reader has 20 seconds):
- Lead with the problem and the fix. No preamble, no praise, no restating the
  diff, no "this PR…" throat-clearing.
- Finding bodies: 1-2 short sentences. Say what's wrong and what to do. That's it.
- summary: 1-2 sentences. concern details: 1-2 sentences.
- Short sentences, active voice, concrete nouns. Cut every word that isn't
  load-bearing.

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
  "summary": "<1-2 sentences: what this PR does + your verdict. Terse.>",
  "concerns": [
    {
      "title": "<short title of a PR-level issue not tied to any single line>",
      "detail": "<1-2 sentences: the problem and the fix>",
      "severity": "blocker" | "warning" | "nit"
    }
  ],
  "highlights": ["<one short clause; only if genuinely notable; usually omit>"],
  "diagram": "<optional Mermaid diagram body (no code fences); ONLY for a genuinely complex new control/data flow; usually omit>",
  "findings": [
    {
      "path": "<repo-relative file path, exactly as shown in the diff>",
      "line": <line number in the NEW version of the file; must be a changed or context line shown in the diff>,
      "severity": "blocker" | "warning" | "nit",
      "body": "<1-2 sentences: the problem on THIS line and the fix. Terse.>"
    }
  ]
}
PREFER "findings" — if an issue relates to specific line(s), emit it as a finding
with the diff line number (it becomes an inline comment). Reserve "concerns" for
truly PR-wide issues with no line to point at. Every section terse; empty arrays
when nothing to say. "highlights" usually empty.`.trim();

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
may use your tools to read files. The user message gives you the LIST of changed
files (not the full diff) and the path to a file holding the complete diff —
read each changed file's hunks from there on demand, then inspect the
surrounding code. Investigate only what the change touches; do not slurp the
whole diff or unrelated files into context. Use your tools deliberately to
assess real-world impact — the actual schema/table definitions, related
migrations, model and query code, and existing indexes/constraints the diff
interacts with. Ground each finding in what you actually found, not a guess.

Use SUBAGENTS heavily. Fan out independent investigations in parallel — one
subagent per file, per suspected issue, or per question — instead of exploring
serially yourself. Spawn many; they are cheap and fast.

Convene a PANEL OF MODELS to pressure-test anything important. When you suspect a
real bug (especially a blocker), do NOT trust a single opinion: spawn 2-3
subagents on DIFFERENT models to independently confirm or refute it, and only
report it if the panel agrees. Diversify the models across subagents — use a mix
of glm-5.3-flash, glm-5.2-fast, and deepseek-v4-pro-0813 — so you get genuinely
independent judgment, not the same model agreeing with itself.

Be efficient with your OWN turns: delegate exploration to subagents, then
synthesize. Once the panel has confirmed the findings, STOP and respond with
ONLY the final JSON object — do not keep exploring.`.trim();

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
  /** Loaded skill docs (SKILL.md bodies) to fold into the reviewer's behavior. */
  skills?: readonly string[];
  /** Repo convention docs (CLAUDE.md/AGENTS.md/…). Stable per repo → kept in the
   * system prompt so it stays a cacheable prefix across PRs. */
  conventions?: string;
}): string {
  const skillsBlock =
    opts.skills && opts.skills.length > 0
      ? "Follow these skills for how you work and write:\n\n" +
        opts.skills.map((s) => s.trim()).join("\n\n---\n\n")
      : "";
  const conventionsBlock = opts.conventions?.trim()
    ? `Repository conventions to enforce (cite these where relevant):\n\n${opts.conventions.trim()}`
    : "";
  // Order matters for prompt caching: everything here is stable per reviewer/
  // repo, so the whole system message is a cacheable prefix. Per-PR content (the
  // diff, path notes, current date) lives in the user message instead.
  return [
    opts.guidance?.trim() || DEFAULT_REVIEW_GUIDANCE,
    skillsBlock,
    conventionsBlock,
    REASONING_NOTE[opts.reasoning],
    PROFILE_DIRECTIVE[opts.profile ?? "chill"],
    opts.agentic ? AGENTIC_DIRECTIVE : HEADLESS_DIRECTIVE,
    OUTPUT_CONTRACT,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Resolve a timezone label (IANA or common abbreviation) to a date/time line. */
function environmentLine(timezone: string | undefined): string {
  const tz = timezone?.trim() || "UTC";
  const iana: Record<string, string> = {
    PST: "America/Los_Angeles",
    PDT: "America/Los_Angeles",
    PT: "America/Los_Angeles",
    EST: "America/New_York",
    EDT: "America/New_York",
    ET: "America/New_York",
    CST: "America/Chicago",
    UTC: "UTC",
  };
  let when: string;
  try {
    when = new Intl.DateTimeFormat("en-US", {
      timeZone: iana[tz] ?? tz,
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date());
  } catch {
    when = new Date().toISOString();
  }
  return `Environment: current date/time is ${when} (${tz}).`;
}

export type UserPromptInput = {
  readonly title: string;
  readonly description: string;
  readonly files: readonly DiffFile[];
  /** Extra natural-language instructions for files matching a glob. */
  readonly pathInstructions?: readonly string[];
  /** Timezone label for the environment line (e.g. "PST"). */
  readonly timezone?: string;
  /**
   * Absolute path to a file holding the full unified diff. When set (agentic
   * reviews with a real checkout), the message carries only the changed-file
   * TREE and points the agent at this file to read hunks on demand — the diff
   * is not inlined, so it isn't re-sent in every turn. Omit for headless
   * reviews, where the full diff must be inlined.
   */
  readonly diffPath?: string;
};

/** The per-PR user message: environment, metadata, per-path notes, and either
 * the full inline diff (headless) or a changed-file tree + a pointer to the
 * diff file the agent reads on demand (agentic). Repo conventions live in the
 * system prompt (stable/cacheable), not here. */
export function buildUserPrompt(input: UserPromptInput): string {
  const pathNotes = input.pathInstructions?.length
    ? `Extra instructions for some of the changed files:\n${input.pathInstructions
        .map((i) => `- ${i}`)
        .join("\n")}`
    : "";
  const diffSection = input.diffPath
    ? [
        "Changed files (the full diff is NOT inlined — explore it yourself):",
        renderFileTree(input.files),
        `The complete unified diff is written to \`${input.diffPath}\`. For each file you review, read its hunks from that file (e.g. with grep/sed by the \`### <path>\` header) and inspect the surrounding code in the checkout. Read only what the change touches — do not read the whole diff up front.`,
      ].join("\n\n")
    : ["Diff under review:", renderDiff(input.files)].join("\n\n");
  return [
    environmentLine(input.timezone),
    `PR title: ${input.title}`,
    input.description ? `PR description:\n${input.description}` : "",
    pathNotes,
    diffSection,
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
