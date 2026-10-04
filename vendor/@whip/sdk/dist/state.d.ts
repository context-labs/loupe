import type { BoundedTranscriptPage, RootCollectionPage, RootSnapshot, SessionCatalogPage } from '@whip/protocol';
import type { WhipClient } from './client.js';
import type { Session } from './session.js';
import { type ExecutionEvidence } from './executions.js';
import { type TraceEvidence } from './trace.js';
export { executionRows, type ExecutionCell, type ExecutionHostCall, type ExecutionRestart, type ExecutionRow } from './executions.js';
export { traceSpans, traceRoots, serverNowMs, toTraceSpan, MAX_TRACE_SPANS, type TraceSpan, type TraceEvidence, type TraceSpanKind, type TraceSpanStatus } from './trace.js';
export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends object ? {
    readonly [K in keyof T]: DeepReadonly<T[K]>;
} : T;
type Message = NonNullable<BoundedTranscriptPage['messages']>[number];
type Status = 'idle' | 'loading' | 'live' | 'stale' | 'error' | 'closed';
export interface HistoryGap {
    fromSeq: number;
    toSeq: number;
    status: 'pending' | 'loading' | 'paused' | 'error';
    error?: string;
}
export interface HistoryView {
    revision: string;
    throughSeq: number;
    nextSeq: number;
    hasMore: boolean;
    loading: boolean;
    messages: Message[];
    truncated: boolean;
    error?: Error;
    /** Missing raw records between retained sections, not offloaded bodies. */
    gaps?: HistoryGap[];
    /** Explicit navigation evicted a newer suffix; Latest can reload it. */
    latestMissing?: boolean;
}
export interface SessionViewSnapshot {
    status: Status;
    root?: RootSnapshot;
    history: Record<string, HistoryView>;
    collections: Record<string, RootCollectionPage>;
    /** Previously observed waiting inputs omitted by a partial snapshot. Never actionable until verified. */
    unverifiedInbox?: NonNullable<RootSnapshot['inbox']>;
    retainedBytes: number;
    /** Bounded supplemental REPL evidence; transcript bodies remain in history. */
    executions?: ExecutionEvidence;
    /** Bounded span evidence for the trace view: durable pages plus live span events, merged by id. */
    trace?: TraceEvidence;
    truncated: boolean;
    unavailable: boolean;
    error?: Error;
}
/** Merge bounded inbox pages with snapshot truth; absent partial rows remain visibly unverified. */
export declare function inboxItems(state: DeepReadonly<SessionViewSnapshot>, agentId: string): {
    rows: {
        item: NonNullable<DeepReadonly<RootSnapshot>["inbox"]>[number];
        stale: boolean;
    }[];
    hasMore: boolean;
};
export interface SessionViewOptions {
    maxBytes?: number;
    maxMessages?: number;
    /** Warm at most one older root page after the first live snapshot; off by default. */
    initialHistoryWarmup?: boolean;
    /** Notification batching only; every event is processed in order. */
    notificationIntervalMs?: number;
}
/** One root subscription and a bounded, reconstructible projection of daemon state. */
export declare class SessionView {
    readonly session: Session;
    private current;
    private published;
    private readonly listeners;
    private readonly opened;
    private readonly lifetime;
    private readonly historyRequests;
    private repair?;
    private traceRequest?;
    private readonly recentRecoveryCursor;
    private stream?;
    private disconnectListener?;
    private commandListener?;
    private noticeTimer?;
    private refreshTimer?;
    private refreshPromise?;
    private refreshAgain;
    private epoch;
    private started;
    private initialHistoryWarmup;
    private runtimeID?;
    private lastConnectionID?;
    private streamConnectionID?;
    private presentationGaps;
    private incompatibleRuntime;
    private unknownSeen;
    private pendingBytes;
    private readonly maxBytes;
    private readonly maxMessages;
    private readonly notificationInterval;
    constructor(session: Session, options?: SessionViewOptions);
    getSnapshot: () => DeepReadonly<SessionViewSnapshot>;
    subscribe: (listener: () => void) => (() => void);
    start(): Promise<void>;
    dispose(): Promise<void>;
    /** Refresh reconciles metadata without erasing observed activity in the same turn. */
    refresh(): Promise<void>;
    openAgent(agentId: string): Promise<void>;
    closeAgent(agentId: string): void;
    loadOlder(agentId?: string): Promise<void>;
    /** Load one page of a known gap. toSeq remains stable as its beginning fills. */
    loadHistoryGap(agentId: string, toSeq: number): Promise<void>;
    loadLatest(agentId?: string): Promise<void>;
    private cancelHistoryReads;
    loadCollection(name: string, options?: {
        more?: boolean;
    }): Promise<void>;
    private connectionChanged;
    private scheduleRefresh;
    private synchronize;
    private consume;
    private apply;
    /**
     * Page the root's durable spans into the view. The first call reads from the
     * beginning; later calls continue from the page cursor, so a reconnect that
     * missed journal events catches up without discarding what live events built.
     */
    loadTrace(): Promise<void>;
    private cancelTraceRead;
    private fetchTrace;
    private repairHistory;
    private warmInitialHistory;
    private setGap;
    private readHistory;
    private fetchHistory;
    private set;
    private publish;
}
export declare function createSessionView(session: Session, options?: SessionViewOptions): SessionView;
export interface SessionListSnapshot {
    status: Status;
    page?: SessionCatalogPage;
    error?: Error;
    truncated: boolean;
}
/** Catalog polling is active only while observed; it never opens root subscriptions. */
export declare class SessionListView {
    readonly client: WhipClient;
    private current;
    private readonly listeners;
    private readonly lifetime;
    private timer?;
    private stopConnection?;
    private stopCommands?;
    private pending?;
    private started;
    private epoch;
    private refreshAgain;
    private runtimeID?;
    private readonly interval;
    private readonly maxBytes;
    constructor(client: WhipClient, options?: {
        pollIntervalMs?: number;
        maxBytes?: number;
    });
    getSnapshot: () => DeepReadonly<SessionListSnapshot>;
    subscribe: (listener: () => void) => (() => void);
    start(): Promise<void>;
    refresh(): Promise<void>;
    loadMore(): Promise<void>;
    dispose(): Promise<void>;
    private fetch;
    private pollLater;
    private set;
}
export declare function createSessionListView(client: WhipClient, options?: {
    pollIntervalMs?: number;
    maxBytes?: number;
}): SessionListView;
