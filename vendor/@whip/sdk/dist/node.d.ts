import type { TransportFactory } from './transport.js';
export { createWhipClient, WhipClient } from './client.js';
/** Attach to an existing daemon without enabling its network listener. */
export declare function unixSocket(path: string, maxFrameBytes?: number): TransportFactory;
