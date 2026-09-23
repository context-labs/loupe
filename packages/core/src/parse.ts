import { jsonrepair } from "jsonrepair";

import {
  concernSchema,
  findingSchema,
  reviewOutputSchema,
  salvagedFindingSchema,
  verificationSchema,
  type Finding,
  type Note,
  type ReviewOutput,
} from "./types";

/**
 * Parse JSON, repairing LLM-malformed output (truncation, unescaped chars in
 * freeform strings, trailing commas) rather than throwing. Models routinely emit
 * *almost* valid JSON; a strict parse would drop the whole review.
 */
function parseLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(jsonrepair(text));
  }
}

/** A parsed review plus what the parser had to discard to produce it. */
export type ParsedReview = {
  readonly review: ReviewOutput;
  /**
   * Findings that failed the per-item schema but still carry a path and body,
   * kept as off-diff notes instead of being discarded.
   */
  readonly salvagedFindings: readonly Note[];
  /** Findings that failed the per-item schema and were dropped. */
  readonly malformedFindings: number;
  /** Concerns that failed the per-item schema and were dropped. */
  readonly malformedConcerns: number;
};

/**
 * Pull the review JSON out of a harness's raw stdout. CLIs wrap output in prose
 * or code fences, so we grab the last balanced {...} block and validate it.
 * Throws if no recognizable review object is found — a malformed review is a
 * hard failure, not a silent empty review. "Recognizable" means the object
 * carries a string `summary`; `findings` and `concerns` may be omitted for a
 * clean review but must be arrays when present. An unrelated object like
 * `{"status":"done"}` must not parse as an empty clean review.
 */
export function parseReviewOutput(stdout: string): ParsedReview {
  if (stdout.trim().length === 0) {
    throw new Error(
      "Harness produced no output. It may have failed to authenticate, hit a " +
        "turn/timeout limit, or exited without emitting a review. Re-run with " +
        "LOG_LEVEL=debug to see the harness stdout/stderr.",
    );
  }
  // Prefer the last balanced {...}; if none closes (truncated output), fall back
  // to everything from the first "{" so jsonrepair can complete it.
  const start = stdout.indexOf("{");
  if (start === -1) {
    throw new Error(
      `No JSON object found in harness output:\n${stdout.slice(0, 1000)}`,
    );
  }
  const candidate = extractLastJsonObject(stdout) ?? stdout.slice(start);
  const parsed: unknown = parseLenient(candidate);
  const shape = parsed as {
    summary?: unknown;
    findings?: unknown;
    concerns?: unknown;
  } | null;
  const isArrayOrAbsent = (v: unknown): boolean =>
    v === undefined || Array.isArray(v);
  if (
    typeof shape !== "object" ||
    shape === null ||
    typeof shape.summary !== "string" ||
    !isArrayOrAbsent(shape.findings) ||
    !isArrayOrAbsent(shape.concerns)
  ) {
    throw new Error(
      `Harness output is not a review (needs a string "summary"; "findings"/"concerns" must be arrays when present):\n${candidate.slice(0, 1000)}`,
    );
  }
  const { summary, findings, concerns, highlights, diagram } =
    reviewOutputSchema.parse(parsed);
  // Validate each item independently; drop malformed ones rather than rejecting
  // the entire review.
  const pick = <T>(
    items: unknown[],
    schema: { safeParse: (x: unknown) => { success: boolean; data?: T } },
  ): T[] =>
    items.flatMap((i) => {
      const r = schema.safeParse(i);
      return r.success && r.data !== undefined ? [r.data] : [];
    });
  const keptFindings: Finding[] = [];
  const salvagedFindings: Note[] = [];
  let malformedFindings = 0;
  for (const item of findings) {
    const kept = findingSchema.safeParse(item);
    if (kept.success) {
      keptFindings.push(kept.data);
      continue;
    }
    // A rejected finding is usually just a bad line number. Keep it as a note
    // when the path and body still read — the model's work is otherwise lost
    // with nothing but a count to show for it.
    const salvaged = salvagedFindingSchema.safeParse(item);
    if (salvaged.success) salvagedFindings.push(salvaged.data);
    else malformedFindings++;
  }
  const keptConcerns = pick(concerns, concernSchema);
  return {
    review: {
      summary,
      findings: keptFindings,
      concerns: keptConcerns,
      highlights: highlights.map((h) => h.trim()).filter(Boolean),
      diagram: diagram?.trim() ? diagram.trim() : undefined,
    },
    salvagedFindings,
    malformedFindings,
    malformedConcerns: concerns.length - keptConcerns.length,
  };
}

export type Verdict = { readonly real: boolean; readonly reason?: string };

/**
 * The verification pass result. `valid` is true only when the output carries
 * exactly one verdict for every expected finding index; anything less (no JSON,
 * schema failure, missing, duplicate, or out-of-range indices) is `invalid` and
 * the caller keeps every finding.
 */
export type VerificationResult =
  | { readonly valid: true; readonly verdicts: ReadonlyMap<number, Verdict> }
  | { readonly valid: false; readonly reasons: readonly string[] };

export function parseVerification(
  stdout: string,
  expectedCount: number,
): VerificationResult {
  const candidate = extractLastJsonObject(stdout);
  if (!candidate) return { valid: false, reasons: ["no JSON object"] };
  let parsed: unknown;
  try {
    parsed = parseLenient(candidate);
  } catch (err) {
    return {
      valid: false,
      reasons: [
        `unparseable JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
  const result = verificationSchema.safeParse(parsed);
  if (!result.success) return { valid: false, reasons: ["schema mismatch"] };
  const verdicts = new Map<number, Verdict>();
  const reasons: string[] = [];
  for (const v of result.data.verdicts) {
    if (v.index >= expectedCount) reasons.push(`index ${v.index} out of range`);
    else if (verdicts.has(v.index)) reasons.push(`duplicate index ${v.index}`);
    else verdicts.set(v.index, { real: v.real, reason: v.reason });
  }
  for (let i = 0; i < expectedCount; i++) {
    if (!verdicts.has(i)) reasons.push(`missing verdict for #${i}`);
  }
  return reasons.length > 0
    ? { valid: false, reasons }
    : { valid: true, verdicts };
}

/** Scan for the last top-level {...} by brace-depth, ignoring string contents. */
function extractLastJsonObject(text: string): string | undefined {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let last: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) last = text.slice(start, i + 1);
    }
  }
  return last;
}
