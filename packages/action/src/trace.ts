import { appendFileSync } from "node:fs";

import type { HarnessTraceEvent } from "@loupe/harness";

/** Bounds keep the Actions summary readable and below GitHub's limits. */
export const SECTION_MAX_CHARS = 30000;
export const SUMMARY_MAX_CHARS = 100000;
export const BLOB_CHARS = 4000;
export const REASONING_CHARS = 6000;
const PHASE_MAX_CHARS = 24000;

export type ReviewerTrace = {
  readonly reviewer: string;
  readonly harness?: string;
  readonly events: readonly HarnessTraceEvent[];
};

export function createTraceCollector(
  reviewer: string,
  harness?: string,
): {
  readonly events: HarnessTraceEvent[];
  readonly emit: (e: HarnessTraceEvent) => void;
  readonly read: () => ReviewerTrace;
} {
  const events: HarnessTraceEvent[] = [];
  return {
    events,
    emit: (e) => events.push(e),
    read: () => ({ reviewer, harness, events: [...events] }),
  };
}

function inline(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "\\`")
    .replace(/\r?\n/g, " ");
}

function blob(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fenceFor(value: string): string {
  const longest = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), (m) => m[0].length),
  );
  return "`".repeat(Math.max(3, longest + 1));
}

function truncate(value: string, max = BLOB_CHARS): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const newline = cut.lastIndexOf("\n");
  const space = cut.lastIndexOf(" ");
  const boundary = Math.max(newline, space);
  return `${boundary > max / 2 ? cut.slice(0, boundary) : cut}\n… truncated (${value.length.toLocaleString()} characters total)`;
}

function pretty(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value) as unknown, null, 2);
  } catch {
    return value;
  }
}

function code(value: string, language = "text", max = BLOB_CHARS): string {
  const content = blob(truncate(pretty(value), max));
  const fence = fenceFor(content);
  return `${fence}${language}\n${content}\n${fence}`;
}

type PhaseTrace = {
  readonly name: string;
  readonly model?: string;
  readonly events: HarnessTraceEvent[];
};

function splitPhases(events: readonly HarnessTraceEvent[]): PhaseTrace[] {
  const phases: PhaseTrace[] = [];
  let current: PhaseTrace | undefined;
  for (const event of events) {
    const name = event.phase ?? current?.name ?? "review";
    if (!current || current.name !== name) {
      current = { name, model: event.model, events: [] };
      phases.push(current);
    }
    current.events.push(event);
  }
  return phases;
}

function phaseKind(phase: PhaseTrace): string {
  return phase.name.split(":")[0] ?? phase.name;
}

function phaseTitle(phase: PhaseTrace): string {
  const labels: Record<string, string> = {
    primary: "Review",
    fallback: "Retry",
    ensemble: "Independent review",
    verify: "Verify findings",
    review: "Review",
  };
  const kind = phaseKind(phase);
  return labels[kind] ?? kind;
}

function renderPhase(phase: PhaseTrace): string {
  let reasoning = "";
  let reply = "";
  const tools: { name: string; args?: string; result?: string }[] = [];
  let outcome: { status: "done" | "error"; text: string } | undefined;

  for (const event of phase.events) {
    switch (event.type) {
      case "reasoning":
        reasoning += event.delta;
        break;
      case "text":
        reply += event.delta;
        break;
      case "tool_start":
        tools.push({ name: event.name, args: event.args });
        break;
      case "tool_end": {
        const match = [...tools]
          .reverse()
          .find(
            (tool) => tool.result === undefined && tool.name === event.name,
          );
        if (match) match.result = event.result;
        else tools.push({ name: event.name, result: event.result });
        break;
      }
      case "done":
        outcome = { status: "done", text: event.text };
        break;
      case "error":
        outcome = { status: "error", text: event.error };
        break;
    }
  }

  const status = outcome?.status === "error" ? "⚠️" : outcome ? "✅" : "⏳";
  const stats = [
    phase.model ? `\`${inline(phase.model)}\`` : undefined,
    reasoning
      ? `${reasoning.length.toLocaleString()} thinking chars`
      : undefined,
    tools.length
      ? `${tools.length} inspection${tools.length === 1 ? "" : "s"}`
      : undefined,
  ].filter(Boolean);
  const out = [`#### ${status} ${phaseTitle(phase)}`, stats.join(" · ")];
  const terminal =
    outcome?.status === "error"
      ? `> [!WARNING]\n> This phase failed.\n\n${code(outcome.text)}`
      : !outcome
        ? "> [!NOTE]\n> This phase ended without a terminal event. See the job log for details."
        : undefined;
  const reserved = terminal ? terminal.length + 2 : 0;
  let truncated = false;

  const pushBlock = (block: string): boolean => {
    if ([...out, block].join("\n\n").length + reserved > PHASE_MAX_CHARS) {
      out.push(
        "> [!NOTE]\n> Phase truncated at a complete block. Additional detail remains in the job log.",
      );
      truncated = true;
      return false;
    }
    out.push(block);
    return true;
  };
  const finish = (): string => {
    if (terminal) out.push(terminal);
    return out.filter(Boolean).join("\n\n");
  };

  if (
    reasoning &&
    !pushBlock(
      `<details>\n<summary><strong>🧠 Thinking</strong> · ${reasoning.length.toLocaleString()} chars</summary>\n\n${code(reasoning, "text", REASONING_CHARS)}\n\n</details>`,
    )
  ) {
    return finish();
  }

  if (tools.length) {
    out.push("**Inspected**");
    for (const [index, tool] of tools.entries()) {
      const summary = `${index + 1}. <code>${inline(tool.name)}</code>${tool.args ? ` · ${inline(truncate(tool.args, 180))}` : ""}`;
      const body = [
        tool.args ? `**Input**\n\n${code(tool.args, "json")}` : undefined,
        tool.result
          ? `**Result**\n\n${code(tool.result)}`
          : "_No result was captured._",
      ]
        .filter(Boolean)
        .join("\n\n");
      if (
        !pushBlock(
          `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`,
        )
      ) {
        return finish();
      }
    }
  }

  // The final done payload normally repeats the streamed reply. Show one copy.
  const final = outcome?.status === "done" ? outcome.text : reply;
  if (
    final &&
    !pushBlock(
      `<details>\n<summary><strong>📝 Output</strong> · ${final.length.toLocaleString()} chars</summary>\n\n${code(final, "json")}\n\n</details>`,
    )
  ) {
    return finish();
  }

  // Successful phases need no terminal callout; failures and incomplete streams
  // always retain theirs, even when earlier detail hit the phase cap.
  if (!truncated || terminal) return finish();
  return out.filter(Boolean).join("\n\n");
}

export function renderTraceSection(
  name: string,
  events: readonly HarnessTraceEvent[],
  opts: { harness?: string } = {},
): string {
  const phases = splitPhases(events);
  const model = events.find((event) => event.model)?.model;
  const tools = events.filter((event) => event.type === "tool_start").length;
  const failed = events.some((event) => event.type === "error");
  const completed = events.some((event) => event.type === "done");

  const meta = [
    `\`${inline(opts.harness ?? "unknown")}\``,
    model ? `\`${inline(model)}\`` : undefined,
    `${tools} inspection${tools === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const out = [
    `### ${failed ? "⚠️" : completed ? "✅" : "➖"} ${inline(name)}`,
    meta,
  ];

  if (opts.harness && opts.harness !== "whip") {
    out.push(
      `> [!NOTE]\n> Detailed reasoning and tool traces are currently available only for Whip. This reviewer used \`${inline(opts.harness)}\`.`,
    );
  }

  if (!events.length) out.push("_No trace events were captured._");
  else phases.forEach((phase) => out.push("---", renderPhase(phase)));

  const kept: string[] = [];
  for (const block of out) {
    const next = [...kept, block].join("\n\n");
    if (next.length > SECTION_MAX_CHARS) {
      kept.push(
        `> [!NOTE]\n> Trace truncated at a complete block. Additional detail remains in the job log.`,
      );
      break;
    }
    kept.push(block);
  }
  return kept.join("\n\n");
}

export function renderReviewsTrace(traces: readonly ReviewerTrace[]): string {
  const parts = [
    `## 🔎 Loupe trace`,
    `${traces.length} reviewer${traces.length === 1 ? "" : "s"} · Review → verify → post`,
  ];
  for (const trace of traces) {
    const section = renderTraceSection(trace.reviewer, trace.events, {
      harness: trace.harness,
    });
    const next = [...parts, "", section].join("\n");
    if (next.length > SUMMARY_MAX_CHARS) {
      parts.push(
        "",
        "> [!NOTE]\n> Summary truncated between reviewers. Additional detail remains in the job log.",
      );
      break;
    }
    parts.push("", section);
  }
  return parts.join("\n");
}

export function writeReviewsTraceToSummary(
  traces: readonly ReviewerTrace[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path || traces.length === 0) return;
  appendFileSync(path, `\n${renderReviewsTrace(traces)}\n`);
}
