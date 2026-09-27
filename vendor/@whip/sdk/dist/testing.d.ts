import { type InitializeResult } from '@whip/protocol';
import type { TransportFactory } from './transport.js';
/** One request the client sent, as the scripted daemon saw it. */
export interface FixtureRequest {
    id: string;
    method: string;
    params: Record<string, unknown>;
    raw: string;
}
/** One client connection to the scripted daemon; replies, errors, notifications, and failure are under test control. */
export interface FixtureConnection {
    readonly requests: FixtureRequest[];
    reply(request: FixtureRequest, result: unknown): void;
    error(request: FixtureRequest, kind: string, code?: number): void;
    fail(error?: Error): void;
    notify(method: string, params: unknown): void;
    /** Whether a reply or error was sent for the request. */
    answered(request: FixtureRequest): boolean;
}
export interface ScriptedDaemonOptions {
    kind?: 'unix' | 'websocket';
    initialize?: Partial<InitializeResult>;
    /** Legacy per-request hook; runs after table replies and before the session defaults. */
    request?: (request: FixtureRequest, connection: FixtureConnection) => void;
}
export type ReplyHandler = (request: FixtureRequest, connection: FixtureConnection) => unknown;
export type TurnScriptStep = {
    text: string;
} | {
    reasoning: string;
} | {
    notice: string;
} | {
    question: {
        id: string;
        question: string;
        options: {
            label: string;
            description?: string;
            recommended?: boolean;
        }[];
        multiple?: boolean;
    };
} | {
    permission: {
        id: string;
        operation: string;
        command?: string;
        rule?: string;
        path?: string;
    };
} | {
    hook: {
        hook: string;
        operation: string;
        decision: string;
        reason?: string;
    };
} | {
    host: {
        id: string;
        operation: string;
        summary?: string;
        error?: string;
    };
} | {
    event: {
        kind: string;
        payload: unknown;
    };
};
/** A whole turn for session.run: journal events after turn.started, then how the command settles. */
export interface TurnScript {
    turnId?: string;
    steps?: TurnScriptStep[];
    status?: 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
    /** The submit result's text on success. */
    text?: string;
    /** The submit result's output on success (phase 6 output contracts). */
    output?: unknown;
    failure?: {
        code: number;
        message: string;
        data?: {
            kind: string;
        };
    };
}
export interface ScriptedDaemon {
    readonly info: InitializeResult;
    readonly factory: TransportFactory;
    readonly connections: readonly FixtureConnection[];
    readonly current: FixtureConnection;
    /** Reply to a method from a table: a returned value is the reply; undefined leaves the request for other handlers. */
    reply(method: string, handler: ReplyHandler): ScriptedDaemon;
    /** Push one journal event to every live subscription of a root; returns its sequence. */
    emit(rootId: string, kind: string, payload: unknown): string;
    /** Answer snapshot, subscribe, submit, status, decide, and ping for sessions so session.run works without a daemon. */
    serveSessions(): ScriptedDaemon;
    /** Play a scripted turn for the next submit on a root; resolves once its events are emitted and the command settled. */
    turn(rootId: string, script?: TurnScript): Promise<void>;
    /** Durable command records by id, as command.status reports them. */
    readonly commands: ReadonlyMap<string, Record<string, unknown>>;
}
/**
 * A daemon made of replies. The client runs its real protocol processing over
 * an in-memory transport; the test decides what each request receives, pushes
 * journal events, or plays whole turns. Browser-safe.
 */
export declare function scriptedDaemon(options?: ScriptedDaemonOptions): ScriptedDaemon;
/** The scripted daemon under its earlier name. */
export declare const transportFixture: typeof scriptedDaemon;
