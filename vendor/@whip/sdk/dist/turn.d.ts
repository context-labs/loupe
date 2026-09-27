import type { CommandResult, StreamEvent, SubmitPayload } from '@whip/protocol';
import type { SdkEvent } from './client.js';
import type { Session } from './session.js';
export interface RunOptions {
    /** Cancels the turn and stops observing when aborted. */
    signal?: AbortSignal;
    /** Also yield the events of agents spawned during this turn, tagged with their agentId. Child lifecycle events are always yielded. */
    includeChildren?: boolean;
    /** Bounds the unread event buffer; exceeding it fails the iterable, never the result. */
    maxMessages?: number;
    maxBytes?: number;
    /** How long result() waits for the end event after the command settled. */
    endTimeoutMs?: number;
}
export type TurnStatus = 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type TurnFailure = NonNullable<CommandResult['failure']>;
export type TurnUsage = NonNullable<StreamEvent['usage']>;
export interface QuestionOption {
    readonly label: string;
    readonly description?: string;
    readonly recommended?: boolean;
}
export interface QuestionSet {
    readonly question: string;
    readonly options: readonly QuestionOption[];
    readonly multiple: boolean;
}
/** One entry of a batched answer; null skips that question. */
export type QuestionAnswer = {
    readonly answer: readonly string[];
    readonly dismissed?: boolean;
} | null;
/** An open user.ask prompt. answer and dismiss post once; repeated calls return the first promise. */
export interface QuestionEvent extends TurnEventBase {
    readonly type: 'question';
    readonly id: string;
    readonly question: string;
    readonly options: readonly QuestionOption[];
    readonly multiple: boolean;
    /** Present when the agent asked several questions at once; answer then takes one entry per question. */
    readonly questions?: readonly QuestionSet[];
    answer(answers: readonly string[] | readonly QuestionAnswer[]): Promise<void>;
    dismiss(): Promise<void>;
}
/** An open permission prompt. allow and deny post one decision; repeated calls return the first promise. */
export interface PermissionEvent extends TurnEventBase {
    readonly type: 'permission';
    readonly id: string;
    readonly operation: string;
    readonly command: string;
    readonly rule: string;
    readonly path: string;
    /** remember installs the prompt's rule for the session tree or globally. */
    allow(options?: {
        remember?: 'tree' | 'global';
    }): Promise<void>;
    deny(reason?: string): Promise<void>;
}
/** Every turn event carries its ordinal and the agent and turn it belongs to. */
export interface TurnEventBase {
    readonly seq: string;
    readonly agentId: string;
    readonly turnId: string;
}
export type TurnEvent = TurnEventBase & ({
    readonly type: 'text';
    readonly delta: string;
} | {
    readonly type: 'reasoning';
    readonly delta: string;
} | {
    readonly type: 'cell';
    readonly id: string;
    readonly status: 'called' | 'running' | 'completed';
    readonly code?: string;
    readonly output?: string;
    readonly result?: string;
} | {
    readonly type: 'host';
    readonly id: string;
    readonly invocationId: string;
    readonly operation: string;
    readonly summary: string;
    readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
    readonly error?: string;
    readonly duration?: string;
} | {
    readonly type: 'progress';
    readonly id: string;
    readonly operation: string;
    readonly text: string;
} | {
    readonly type: 'hook';
    readonly hook: string;
    readonly operation: string;
    readonly decision: string;
    readonly reason: string;
} | QuestionEvent | PermissionEvent | {
    readonly type: 'child';
    readonly childId: string;
    readonly kind: string;
    readonly status: string;
} | {
    readonly type: 'notice';
    readonly text: string;
}
/** The provider stream failed after output; the client discarded `discarded` streamed characters and is regenerating the message. */
 | {
    readonly type: 'discard';
    readonly discarded: number;
} | {
    readonly type: 'usage';
    readonly usage: TurnUsage;
} | {
    readonly type: 'end';
    readonly status: TurnStatus;
    readonly error?: string;
} | {
    readonly type: 'raw';
    readonly event: SdkEvent;
});
export type TurnResult<Output = unknown> = {
    readonly status: 'succeeded';
    readonly turnId: string;
    readonly text: string;
    readonly output: Output;
    readonly usage?: TurnUsage;
} | {
    readonly status: 'failed' | 'cancelled' | 'interrupted';
    readonly turnId?: string;
    readonly text?: string;
    readonly failure: TurnFailure;
    readonly usage?: TurnUsage;
};
/** Build a question event whose reply methods post through the session exactly once. */
export declare function questionEvent(session: Session, base: TurnEventBase, payload: Record<string, unknown>): QuestionEvent;
/** Build a permission event whose decision methods post through the client exactly once. */
export declare function permissionEvent(session: Session, base: TurnEventBase, payload: Record<string, unknown>): PermissionEvent;
/**
 * One root turn: the submit command plus every event the daemon journals for
 * it, mapped to a small typed union. The subscription starts before the
 * command so nothing is missed; the turn is identified by the turn.started
 * whose inbox sequence is the command's ingress sequence. The command outcome
 * is authoritative; the event stream is best effort.
 */
export declare class Turn<Output = unknown> implements AsyncIterable<TurnEvent> {
    private readonly session;
    private readonly payload;
    private readonly options;
    private readonly queue;
    private queuedBytes;
    private waiter?;
    private iterableError?;
    private iterableClosed;
    private subscription?;
    private command?;
    private readonly started;
    private readonly pump;
    private readonly ended;
    private resolveEnded;
    private turnIdentity?;
    private resolveTurn;
    private rejectTurn;
    private readonly children;
    private accumulated;
    private lastUsage?;
    private endStatus?;
    /** Resolves once the daemon has started the turn; rejects when the command settles without one. */
    readonly turnId: Promise<string>;
    constructor(session: Session, payload: SubmitPayload, options?: RunOptions);
    private begin;
    private map;
    private push;
    /** Ends iteration; the result still resolves from the command. */
    private fail;
    private finish;
    [Symbol.asyncIterator](): AsyncIterator<TurnEvent>;
    /** The command's terminal outcome, joined with the end event when the turn ran. */
    result(): Promise<TurnResult<Output>>;
    /** The final text, or a rejection carrying the failure. */
    text(): Promise<string>;
    /** Command-targeted cancellation; resolves once the daemon accepted it. */
    cancel(): Promise<void>;
}
