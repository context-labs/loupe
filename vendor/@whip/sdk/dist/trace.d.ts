import type { SpanPage } from '@whip/protocol';
import type { DeepReadonly, SessionViewSnapshot } from './state.js';
/**
 * Trace evidence is the client's copy of the daemon's span table for one root:
 * durable pages (`trace.page`) merged with live `span.started` / `span.ended`
 * events by span id. Spans are bounded per root; when the cap is reached the
 * oldest traces are evicted whole so the newest trace stays complete and the
 * view says it is truncated. Timing is server-measured; open spans are drawn
 * to the server's clock through `clockOffsetMs`.
 */
export type TraceSpanKind = 'agent' | 'llm' | 'tool' | 'host' | 'wait';
export type TraceSpanStatus = 'running' | 'ok' | 'error' | 'cancelled' | 'interrupted';
export interface TraceSpan {
    readonly id: string;
    readonly traceId: string;
    readonly parentId: string;
    readonly rootId: string;
    readonly agentId: string;
    readonly turnId: string;
    readonly kind: TraceSpanKind;
    readonly name: string;
    readonly status: TraceSpanStatus;
    /** Wall clock in milliseconds since the epoch, fractional. */
    readonly startMs: number;
    /** 0 while the span is open. */
    readonly endMs: number;
    readonly attrs: Readonly<Record<string, unknown>>;
    readonly links: readonly {
        readonly traceId: string;
        readonly spanId: string;
    }[];
    readonly updatedSeq: string;
}
export interface TraceEvidence {
    readonly rootId: string;
    /** Page cursor: the last `updated_seq` a durable page returned. */
    readonly pageCursor: string;
    readonly spans: Readonly<Record<string, TraceSpan>>;
    readonly loaded: boolean;
    readonly loading: boolean;
    readonly hasMore: boolean;
    readonly truncated: boolean;
    /** Server clock minus client clock at the last page, so open spans grow against the daemon's time. */
    readonly clockOffsetMs: number;
    readonly error?: Error;
}
export declare const MAX_TRACE_SPANS = 4096;
export declare const MAX_TRACE_BYTES: number;
/** Decode one wire record; undefined when it is not a span. */
export declare function toTraceSpan(record: unknown): TraceSpan | undefined;
export declare function emptyTraceEvidence(rootId: string): TraceEvidence;
/** Fold one journal event; anything but a span event returns the evidence unchanged. */
export declare function observeSpan(evidence: TraceEvidence, event: {
    kind: string;
    payload: unknown;
}): TraceEvidence;
/** Merge one durable page and record the server clock it was read at. */
export declare function mergeSpanPage(evidence: TraceEvidence, page: SpanPage, receivedAtMs?: number): TraceEvidence;
/** Evict whole traces, oldest first, until the span count and byte budget hold. */
export declare function boundTraceEvidence(evidence: TraceEvidence, maxSpans?: number, maxBytes?: number): TraceEvidence;
/** Spans of one trace (or every trace) in start order. */
export declare function traceSpans(snapshot: DeepReadonly<SessionViewSnapshot>, traceId?: string): readonly TraceSpan[];
/** Turn spans that start a trace, newest first: the trace picker's list. */
export declare function traceRoots(snapshot: DeepReadonly<SessionViewSnapshot>): readonly TraceSpan[];
/** The daemon's current time as this client can best estimate it. */
export declare function serverNowMs(evidence: DeepReadonly<TraceEvidence> | undefined, clientNowMs?: number): number;
