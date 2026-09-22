/**
 * Categorical failure kinds for harness subprocesses. The classifier maps a
 * raw provider message (and optional HTTP status) onto one of these so callers
 * can decide retry policy and surface a machine-readable result without
 * pattern-matching strings themselves.
 *
 * - "quota":      402 Payment Required / insufficient balance / billing — the
 *                  account is out of money. Retrying the call (in any mode)
 *                  cannot help; the agentic→one-shot fallback must not fire.
 * - "rate-limit": 429 / rate limit exceeded / too many requests — the provider
 *                  throttled us. A mode-switch retry hits the same provider so
 *                  it is also doomed; suppress it (a backoff retry is a future
 *                  concern).
 * - "unknown":    anything we cannot classify (a crash, a parse failure, a
 *                  transient network blip). Preserves today's behavior: the
 *                  agentic→one-shot fallback still runs.
 */
export type HarnessErrorKind = "quota" | "rate-limit" | "unknown";

/**
 * Every failure from a harness subprocess is wrapped in `HarnessError` so a
 * caller can distinguish "the harness CLI failed" from unrelated errors (an
 * Octokit call, a config parse) with a single `instanceof` check, and branch on
 * `kind`. `kind: "unknown"` preserves today's behavior for unclassified errors.
 */
export class HarnessError extends Error {
  readonly kind: HarnessErrorKind;
  readonly status?: number;
  constructor(
    message: string,
    kind: HarnessErrorKind = "unknown",
    status?: number,
  ) {
    super(message);
    this.name = "HarnessError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Map a raw harness message (stderr, NDJSON error payload, etc.) and an optional
 * HTTP status onto an error kind. Best-effort: the harnesses surface provider
 * errors as human-readable text rather than structured fields, so we match on
 * common substrings. Anything unmatched falls back to "unknown".
 */
export function classifyHarnessError(
  message: string,
  status?: number,
): HarnessErrorKind {
  const text = (
    status != null ? `${message} ${status}` : message
  ).toLowerCase();
  if (
    /\b(402|payment required|insufficient balance|quota|billing)\b/.test(text)
  ) {
    return "quota";
  }
  if (/\b(429|rate limit|too many requests)\b/.test(text)) {
    return "rate-limit";
  }
  return "unknown";
}

/** Kinds where the agentic→one-shot fallback must NOT fire. */
const NON_RETRYABLE: readonly HarnessErrorKind[] = ["quota", "rate-limit"];

/**
 * True only for a `HarnessError` whose kind is one we must not retry by switching
 * modes (quota, rate-limit). Bare `Error`s and `HarnessError` with kind
 * "unknown" return false, preserving the existing fallback for unclassified
 * failures.
 */
export function isNonRetryableHarnessError(err: unknown): boolean {
  return err instanceof HarnessError && NON_RETRYABLE.includes(err.kind);
}
