#!/usr/bin/env bun
/**
 * Review-trace fixture preview.
 *
 * Renders a realistic review-traces Markdown payload (whip reasoning deltas,
 * text, tool calls/results, ensemble/verify phases, a done outcome and an error
 * reviewer) and writes it to a path — no model calls, no GitHub, no real
 * harness. Handy for eyeballing the summary output locally.
 *
 *   bun run trace:preview                 # print to stdout
 *   bun run trace:preview /tmp/trace.md   # write to a file
 *
 * The path is a plain write; it does not touch GITHUB_STEP_SUMMARY or the repo.
 */
import { writeFileSync } from "node:fs";

import type { HarnessTraceEvent } from "@loupe/harness";

import { renderReviewsTrace, type ReviewerTrace } from "./trace";

/** Realistic, bounded fake events for one reviewer. */
function reviewerTrace(
  reviewer: string,
  harness: string,
  model: string,
): ReviewerTrace {
  const base = (phase: string): HarnessTraceEvent[] => [
    {
      type: "reasoning",
      delta: `${reviewer}: scanning the diff for ${model} … checking for path traversal. `,
      model,
      phase: `${phase}:${model}`,
    },
    {
      type: "reasoning",
      delta: "the include glob matches src/**; scope looks right. ",
      model,
      phase: `${phase}:${model}`,
    },
    {
      type: "tool_start",
      name: "read",
      args: '{"path":"src/buffer.ts"}',
      model,
      phase: `${phase}:${model}`,
    },
    {
      type: "tool_end",
      name: "read",
      result: "export function read(buf, off) { return buf.slice(off); }",
      model,
      phase: `${phase}:${model}`,
    },
    {
      type: "text",
      delta: '{"summary":',
      model,
      phase: `${phase}:${model}`,
    },
    {
      type: "text",
      delta: '"no findings"}',
      model,
      phase: `${phase}:${model}`,
    },
    {
      type: "done",
      text: '{"summary":"no findings","findings":[],"concerns":[]}',
      model,
      phase: `${phase}:${model}`,
    },
  ];
  return { reviewer, harness, events: base("primary") };
}

/** A non-whip reviewer — no enriched events, so the note is exercised. */
function nonWhipTrace(reviewer: string): ReviewerTrace {
  return {
    reviewer,
    harness: "claude",
    events: [
      { type: "done", text: '{"summary":"ok","findings":[],"concerns":[]}' },
    ],
  };
}

function fixture(): ReviewerTrace[] {
  return [
    reviewerTrace("code", "whip", "kimi-k3"),
    {
      ...reviewerTrace("chemist", "whip", "o3-mini"),
      harness: "whip",
      events: [
        ...reviewerTrace("chemist", "whip", "o3-mini").events.slice(0, 4),
        {
          type: "error",
          error: "exit 1: milestone patch did not apply cleanly (see job logs)",
          model: "o3-mini",
          phase: "primary:o3-mini",
        },
      ],
    },
    nonWhipTrace("docs"),
  ];
}

const path = process.argv[2];
const body = renderReviewsTrace(fixture());
if (path) {
  writeFileSync(path, `${body}\n`);
  console.error(`wrote review-trace preview to ${path}`);
} else {
  process.stdout.write(`${body}\n`);
}
