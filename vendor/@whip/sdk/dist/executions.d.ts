import type { ContentHandle, RootSnapshot, StreamEvent } from '@whip/protocol';
import type { DeepReadonly, HistoryView, SessionViewSnapshot } from './state.js';
export interface ExecutionHostCall {
    readonly display?: NonNullable<StreamEvent['display']>;
    readonly id: string;
    readonly invocationId?: string;
    readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
    readonly name: string;
    readonly summary: string;
    readonly duration: string;
    readonly error?: string;
}
export interface ExecutionCell {
    readonly partId?: string;
    readonly kind: 'cell';
    readonly id: string;
    readonly callId: string;
    readonly agentId: string;
    readonly turnId?: string;
    /** First observed event, retained when this cell joins recorded history. */
    readonly eventSeq?: string;
    /** Retained tool-event identities for joining bounded presentation prefixes. */
    readonly presentationSeqs?: readonly string[];
    /** Transcript sequence, when a recorded call is available. */
    readonly seq?: number;
    readonly code: string;
    readonly output: string;
    readonly value?: string;
    readonly hasValue?: boolean;
    readonly executionEngine?: string;
    readonly language?: string;
    readonly error?: string;
    /** Bounded checkpoint warning and omitted-binding details. */
    readonly scratch?: string;
    readonly status: 'writing' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'unknown';
    readonly hosts: readonly ExecutionHostCall[];
    readonly steps?: number;
    readonly quickjsJobs?: number;
    /** Wall time observed by this client, never inferred from replay. */
    readonly observedStartedAt?: number;
    readonly observedEndedAt?: number;
    readonly truncated?: boolean;
    /** This retained observation could not be safely associated with initial history. */
    readonly historyUnmatched?: boolean;
    readonly body?: ContentHandle;
    readonly codeBody?: ContentHandle;
}
export interface ExecutionRestart {
    readonly kind: 'restart';
    readonly historyUnmatched?: boolean;
    readonly id: string;
    readonly agentId: string;
    readonly text: string;
    readonly seq?: number;
}
export type ExecutionRow = ExecutionCell | ExecutionRestart;
type ObservedRow = ExecutionRow & {
    readonly eventSeq: string;
    readonly turnId?: string;
    readonly afterSeq: number;
    readonly closed?: boolean;
    readonly recordedId?: string;
    readonly recordedResultSeq?: number;
    readonly historyUnknown?: boolean;
    readonly historyUnmatched?: boolean;
};
/** Supplemental observation only. Recorded transcript bodies stay in HistoryView. */
export interface ExecutionEvidence {
    readonly rootId: string;
    readonly revision: string;
    readonly cursor: string;
    readonly rows: readonly ObservedRow[];
    readonly truncated: boolean;
}
/** Decode the top-level code string while arguments are still arriving. */
export declare function executionCode(args: string): string;
export declare function emptyExecutionEvidence(rootId: string, revision: string): ExecutionEvidence;
/** Pure folding called only by the existing root stream; no transport or secondary cache. */
export declare function observeExecution(evidence: ExecutionEvidence, event: {
    seq: string;
    kind: string;
    payload: unknown;
}, activeTurns: Readonly<Record<string, string>>, history: DeepReadonly<Record<string, HistoryView>>, observedAt?: number): ExecutionEvidence;
export declare function boundExecutionEvidence(evidence: ExecutionEvidence, maxBytes?: number): ExecutionEvidence;
export declare function settleExecutions(evidence: ExecutionEvidence, activeTurns?: Readonly<Record<string, string>>): ExecutionEvidence;
/** Reconcile loaded history without copying its bodies into the supplemental evidence. */
export declare function reconcileExecutions(evidence: ExecutionEvidence, history: DeepReadonly<Record<string, HistoryView>>): ExecutionEvidence;
export declare function seedExecutions(previous: ExecutionEvidence | undefined, root: RootSnapshot, history: Record<string, HistoryView>): ExecutionEvidence;
/** Immutable notebook rows derived from the loaded history and bounded observed evidence. */
export declare function executionRows(snapshot: DeepReadonly<SessionViewSnapshot>, agentId: string): readonly ExecutionRow[];
export {};
