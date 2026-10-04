import type { RPCError } from '@whip/protocol';
/** Errors here describe client/protocol failures, never a guessed execution outcome. */
export declare class WhipError extends Error {
    readonly kind: string;
    constructor(kind: string, message: string, options?: ErrorOptions);
}
export declare class RpcError extends WhipError {
    readonly rpc: RPCError;
    readonly code: number;
    constructor(rpc: RPCError);
}
export declare class DeliveryUncertainError extends WhipError {
    readonly commandId: string;
    constructor(commandId: string, cause?: unknown);
}
export declare function asError(value: unknown): Error;
export declare function abortError(signal?: AbortSignal): Error;
