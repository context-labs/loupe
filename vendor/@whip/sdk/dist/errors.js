/** Errors here describe client/protocol failures, never a guessed execution outcome. */
export class WhipError extends Error {
    kind;
    constructor(kind, message, options) {
        super(message, options);
        this.kind = kind;
        this.name = 'WhipError';
    }
}
export class RpcError extends WhipError {
    rpc;
    code;
    constructor(rpc) {
        super(rpc.data?.kind ?? 'execution_failed', rpc.message);
        this.rpc = rpc;
        this.name = 'RpcError';
        this.code = rpc.code;
    }
}
export class DeliveryUncertainError extends WhipError {
    commandId;
    constructor(commandId, cause) {
        super('delivery_uncertain', 'Command acceptance is unknown; reconcile its original identity before retrying.', { cause });
        this.commandId = commandId;
        this.name = 'DeliveryUncertainError';
    }
}
export function asError(value) {
    return value instanceof Error ? value : new WhipError('client_error', String(value));
}
export function abortError(signal) {
    return signal?.reason instanceof Error ? signal.reason : new DOMException('Operation aborted', 'AbortError');
}
//# sourceMappingURL=errors.js.map