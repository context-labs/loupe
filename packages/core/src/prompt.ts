import { renderDiff, type DiffFile } from "./diff";

export type PromptInput = {
  readonly title: string;
  readonly description: string;
  readonly files: readonly DiffFile[];
  /** Convention docs pulled from the target repo (CLAUDE.md/AGENTS.md/etc.). */
  readonly conventions: string;
};

const OUTPUT_CONTRACT = `
Respond with ONE JSON object and nothing else, matching:
{
  "summary": "<2-4 sentence overall assessment>",
  "findings": [
    {
      "path": "<repo-relative file path, exactly as in the diff>",
      "line": <line number in the NEW version of the file, must be a changed or nearby context line shown in the diff>,
      "severity": "blocker" | "warning" | "nit",
      "body": "<the comment; be specific and actionable>"
    }
  ]
}
Only comment on lines that appear in the diff below. If a file is fine, omit it.
Do not invent line numbers. Return {"summary": "...", "findings": []} if nothing is worth flagging.`.trim();

export function buildPrompt(input: PromptInput): string {
  const conventions = input.conventions.trim();
  return [
    "You are a senior engineer reviewing a pull request.",
    conventions
      ? `Enforce this repository's own conventions:\n\n${conventions}`
      : "No repository conventions were provided; apply general best practices.",
    `PR title: ${input.title}`,
    input.description ? `PR description:\n${input.description}` : "",
    "Diff under review:",
    renderDiff(input.files),
    OUTPUT_CONTRACT,
  ]
    .filter(Boolean)
    .join("\n\n");
}
