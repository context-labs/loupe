export interface Transport {
    readonly kind: 'websocket' | 'unix';
    readonly bufferedAmount: number;
    readonly httpEndpoint?: string;
    send(message: string): void;
    close(): void;
}
export interface TransportHandlers {
    message(message: string): void;
    close(error: Error): void;
}
export type TransportFactory = (handlers: TransportHandlers, signal: AbortSignal) => Promise<Transport>;
/** One native WebSocket text message per JSON-RPC envelope. */
export declare function webSocket(endpoint: string): TransportFactory;
