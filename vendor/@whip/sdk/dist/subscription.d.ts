import type { CallOptions, SdkEvent, WhipClient } from './client.js';
export interface SubscriptionOptions extends Pick<CallOptions, 'signal'> {
    maxMessages?: number;
    maxBytes?: number;
}
/** One ordered, bounded consumer. Fan out UI components through a SessionView. */
export declare class Subscription implements AsyncIterableIterator<SdkEvent> {
    private readonly client;
    readonly rootId: string;
    cursor: string;
    private readonly options;
    readonly id: string;
    private queue;
    private bytes;
    private waiter?;
    private error?;
    private closed;
    private lastReceived;
    private abortListener?;
    constructor(client: WhipClient, rootId: string, cursor: string, options: SubscriptionOptions);
    start(signal?: AbortSignal): Promise<void>;
    push(event: SdkEvent): void;
    next(): Promise<IteratorResult<SdkEvent>>;
    [Symbol.asyncIterator](): AsyncIterableIterator<SdkEvent>;
    return(): Promise<IteratorResult<SdkEvent>>;
    fail(error: Error): void;
    private finish;
    private unsubscribe;
    dispose(): Promise<void>;
}
