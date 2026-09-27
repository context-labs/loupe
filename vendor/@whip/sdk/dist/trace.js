export const MAX_TRACE_SPANS = 4096;
export const MAX_TRACE_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const kinds = new Set(['agent', 'llm', 'tool', 'host', 'wait']);
const statuses = new Set(['running', 'ok', 'error', 'cancelled', 'interrupted']);
const nanosToMs = (value) => {
    if (!/^\d+$/.test(value))
        return 0;
    const nanos = BigInt(value);
    return Number(nanos / 1000000n) + Number(nanos % 1000000n) / 1_000_000;
};
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
/** Decode one wire record; undefined when it is not a span. */
export function toTraceSpan(record) {
    const raw = object(record);
    if (typeof raw.id !== 'string' || !raw.id || typeof raw.trace_id !== 'string' || typeof raw.root_id !== 'string'
        || typeof raw.agent_id !== 'string' || typeof raw.start_ns !== 'string' || typeof raw.updated_seq !== 'string')
        return undefined;
    if (!kinds.has(raw.kind) || !statuses.has(raw.status))
        return undefined;
    const links = Array.isArray(raw.links) ? raw.links.flatMap(link => {
        const value = object(link);
        return typeof value.trace_id === 'string' && typeof value.span_id === 'string' ? [{ traceId: value.trace_id, spanId: value.span_id }] : [];
    }) : [];
    return {
        id: raw.id, traceId: raw.trace_id, parentId: raw.parent_id ?? '', rootId: raw.root_id, agentId: raw.agent_id, turnId: raw.turn_id ?? '',
        kind: raw.kind, name: typeof raw.name === 'string' ? raw.name : '', status: raw.status,
        startMs: nanosToMs(raw.start_ns), endMs: typeof raw.end_ns === 'string' ? nanosToMs(raw.end_ns) : 0,
        attrs: Object.freeze({ ...object(raw.attrs) }), links: Object.freeze(links), updatedSeq: raw.updated_seq,
    };
}
export function emptyTraceEvidence(rootId) {
    return { rootId, pageCursor: '0', spans: {}, loaded: false, loading: false, hasMore: false, truncated: false, clockOffsetMs: 0 };
}
const newer = (a, b) => BigInt(a) > BigInt(b);
function upsert(spans, span) {
    const existing = spans[span.id];
    if (existing && !newer(span.updatedSeq, existing.updatedSeq))
        return false;
    spans[span.id] = span;
    return true;
}
/** Fold one journal event; anything but a span event returns the evidence unchanged. */
export function observeSpan(evidence, event) {
    if (event.kind !== 'span.started' && event.kind !== 'span.ended')
        return evidence;
    const span = toTraceSpan(event.payload);
    if (!span || span.rootId !== evidence.rootId)
        return evidence;
    const spans = { ...evidence.spans };
    if (!upsert(spans, span))
        return evidence;
    return boundTraceEvidence({ ...evidence, spans });
}
/** Merge one durable page and record the server clock it was read at. */
export function mergeSpanPage(evidence, page, receivedAtMs = Date.now()) {
    const spans = { ...evidence.spans };
    for (const record of page.spans ?? []) {
        const span = toTraceSpan(record);
        if (span && span.rootId === evidence.rootId)
            upsert(spans, span);
    }
    const serverNow = nanosToMs(page.server_time_ns);
    return boundTraceEvidence({
        ...evidence, spans, loaded: true, loading: false, hasMore: page.has_more, error: undefined,
        pageCursor: newer(page.next_seq, evidence.pageCursor) ? page.next_seq : evidence.pageCursor,
        clockOffsetMs: serverNow > 0 ? serverNow - receivedAtMs : evidence.clockOffsetMs,
    });
}
/** Evict whole traces, oldest first, until the span count and byte budget hold. */
export function boundTraceEvidence(evidence, maxSpans = MAX_TRACE_SPANS, maxBytes = MAX_TRACE_BYTES) {
    let spans = evidence.spans;
    let count = Object.keys(spans).length;
    let bytes = count > maxSpans ? Infinity : encoder.encode(JSON.stringify(spans)).byteLength;
    if (count <= maxSpans && bytes <= maxBytes)
        return evidence;
    const starts = new Map();
    for (const span of Object.values(spans))
        starts.set(span.traceId, Math.min(starts.get(span.traceId) ?? Infinity, span.startMs));
    const traces = [...starts.entries()].sort((a, b) => a[1] - b[1]).map(([traceId]) => traceId);
    let truncated = evidence.truncated;
    while (traces.length > 1 && (count > maxSpans || bytes > maxBytes)) {
        const oldest = traces.shift();
        spans = Object.fromEntries(Object.entries(spans).filter(([, span]) => span.traceId !== oldest));
        count = Object.keys(spans).length;
        bytes = encoder.encode(JSON.stringify(spans)).byteLength;
        truncated = true;
    }
    if (count > maxSpans || bytes > maxBytes) {
        // One trace alone is over budget: keep its newest spans, drop closed old ones first.
        const ordered = Object.values(spans).sort((a, b) => Number(a.endMs === 0) - Number(b.endMs === 0) || a.startMs - b.startMs);
        while (ordered.length && (ordered.length > maxSpans || bytes > maxBytes)) {
            ordered.shift();
            bytes = encoder.encode(JSON.stringify(ordered)).byteLength;
        }
        spans = Object.fromEntries(ordered.map(span => [span.id, span]));
        truncated = true;
    }
    return { ...evidence, spans, truncated };
}
/** Spans of one trace (or every trace) in start order. */
export function traceSpans(snapshot, traceId) {
    const evidence = snapshot.trace;
    if (!evidence)
        return [];
    return Object.values(evidence.spans)
        .filter(span => !traceId || span.traceId === traceId)
        .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
}
/** Turn spans that start a trace, newest first: the trace picker's list. */
export function traceRoots(snapshot) {
    const evidence = snapshot.trace;
    if (!evidence)
        return [];
    return Object.values(evidence.spans)
        .filter(span => span.kind === 'agent' && span.parentId === '')
        .sort((a, b) => b.startMs - a.startMs || a.id.localeCompare(b.id));
}
/** The daemon's current time as this client can best estimate it. */
export function serverNowMs(evidence, clientNowMs = Date.now()) {
    return clientNowMs + (evidence?.clockOffsetMs ?? 0);
}
//# sourceMappingURL=trace.js.map