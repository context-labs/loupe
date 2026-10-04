import { type CommandOperation, type CommandResult, type RuntimeOperations } from '@whip/protocol';
import type { WhipClient, CallOptions } from './client.js';
export type CommandStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type CommandOutcome<O extends CommandOperation = CommandOperation> = Omit<CommandResult, 'result' | 'status'> & {
    status: CommandStatus;
    result?: RuntimeOperations[O]['result'];
};
export interface CommandOptions {
    rootId?: string;
    commandId?: string;
}
export interface RecoveryRecord<O extends CommandOperation = CommandOperation> {
    readonly version: 1;
    readonly runtimeId: string;
    readonly clientId: string;
    readonly commandId: string;
    readonly operation: O;
    readonly rootId?: string;
}
/** Application-owned storage. These records deliberately contain no request body. */
export interface RecoveryStorage {
    list(): Promise<readonly RecoveryRecord[]>;
    put(record: RecoveryRecord): Promise<void>;
    delete(record: RecoveryRecord): Promise<void>;
}
export declare function isTerminal(status: string): boolean;
export declare class CommandHandle<O extends CommandOperation = CommandOperation> {
    readonly client: WhipClient;
    readonly record: RecoveryRecord<O>;
    private readonly beforeSend?;
    private initial?;
    private last?;
    private knownAccepted;
    private encoded?;
    private retrying?;
    private constructor();
    static submit<O extends CommandOperation>(client: WhipClient, runtimeId: string, operation: O, payload: RuntimeOperations[O]['params'], options: CommandOptions, beforeSend?: () => Promise<unknown>): CommandHandle<O>;
    static recover<O extends CommandOperation>(client: WhipClient, record: RecoveryRecord<O>, payload?: RuntimeOperations[O]['params']): CommandHandle<O>;
    get commandId(): string;
    get operation(): O;
    private observe;
    private send;
    /** Acceptance is committed input, not completion. Aborting only stops this waiter. */
    accepted(options?: Pick<CallOptions, 'signal'>): Promise<CommandOutcome<O>>;
    status(options?: CallOptions): Promise<CommandOutcome<O>>;
    /** Resolves a structured terminal outcome; execution failures remain daemon outcomes. */
    result(options?: Pick<CallOptions, 'signal'>): Promise<CommandOutcome<O>>;
    /** Explicit retry: identical identity and bytes, only after a definitive missing lookup. */
    retry(options?: Pick<CallOptions, 'signal'>): Promise<CommandOutcome<O>>;
    private retryOnce;
    cancel(): CommandHandle<'cancel'>;
}
