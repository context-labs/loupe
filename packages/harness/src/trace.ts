/**
 * Normalized harness trace events.
 *
 * The whip harness streams a live NDJSON event log (`--format json`); these
 * types normalize that stream into a small, harness-agnostic shape so anything
 * larger than the process (a GitHub Actions step summary, an OTel log, a test)
 * can capture a review's reasoning, visible text, tool calls/results and final
 * outcome without parsing raw subprocess output. Events are emitted, if a
 * consumer supplied a callback, through `HarnessContext.trace`.
 *
 * `phase` / `model` are optional enrichment carried through from the caller
 * (e.g. the model id and whether the run was the primary, fallback, ensemble or
 * verification pass) so downstream renderers can label each event's provenance.
 */
export type HarnessTraceEvent =
  | {
      readonly type: "reasoning";
      /** One reasoning delta chunk (deltas stream in; aggregate them). */
      readonly delta: string;
      readonly model?: string;
      readonly phase?: string;
    }
  | {
      readonly type: "text";
      /** One assistant-text delta chunk (deltas stream in; aggregate them). */
      readonly delta: string;
      readonly model?: string;
      readonly phase?: string;
    }
  | {
      readonly type: "tool_start";
      readonly name: string;
      /** JSON-serialized tool arguments (may be truncated by the emitter). */
      readonly args?: string;
      readonly model?: string;
      readonly phase?: string;
    }
  | {
      readonly type: "tool_end";
      readonly name: string;
      /** Tool result payload (may be truncated by the emitter). */
      readonly result?: string;
      readonly model?: string;
      readonly phase?: string;
    }
  | {
      readonly type: "done";
      /** The final assembled reply text (the review JSON). */
      readonly text: string;
      readonly model?: string;
      readonly phase?: string;
    }
  | {
      readonly type: "error";
      readonly error: string;
      readonly model?: string;
      readonly phase?: string;
    };

/** Convenience: a callback that swallows every event (a no-op trace sink). */
export type TraceSink = (event: HarnessTraceEvent) => void;

/** Text used to replace a matched secret in a trace payload. */
export const REDACTION_MARK = "[REDACTED]";

/**
 * Replace any occurrence of a known secret value in `text` with `[REDACTED]`.
 * Only secrets at least {@link MIN_SECRET_LENGTH} chars long are considered, so
 * short env values ("a", "on") never turn the whole transcript into a redaction
 * haze. Exporting makes the mapping unit-testable without a subprocess.
 */
export const MIN_SECRET_LENGTH = 8;

export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  if (secrets.length === 0) return text;
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_SECRET_LENGTH) continue;
    if (secret.length > out.length) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), REDACTION_MARK);
  }
  return out;
}

/**
 * Collect the secret strings (values, not env var names) that should never leak
 * into a trace payload. The harness hands us `env`; the values it carries from
 * credential resolution are exactly the secrets we must scrub.
 */
export function envSecretValues(
  env: Record<string, string | undefined>,
): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (
      !/(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:$|_)/i.test(key)
    ) {
      continue;
    }
    if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) {
      out.push(value);
    }
  }
  return out;
}
