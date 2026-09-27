import { type BrowserInventoryRequest, type BrowserInventoryResultParams, type BrowserCommand, type BrowserCommandCancel, type BrowserCommandResultParams, type BrowserProviderBindParams, type BrowserProviderBindResult, type BrowserProviderEventParams } from '@whip/protocol';
import type { CallOptions, WhipClient } from './client.js';
/** Structural native adapter. SDK never imports Electron or application packages. */
export interface BrowserProviderBridge {
    select(input: {
        offer: BrowserProviderBindParams;
        provider: BrowserProviderBindResult;
        connectionId?: string;
        projectId?: string;
    }): Promise<void>;
    inventory?(request: BrowserInventoryRequest): Promise<BrowserInventoryResultParams>;
    dispatch(command: BrowserCommand): Promise<BrowserCommandResultParams & {
        screenshotBytes?: Uint8Array;
    }>;
    cancel(input: BrowserCommandCancel): void;
    release(input: {
        rootId: string;
        providerEpoch: string;
    }): Promise<void>;
    onEvent(listener: (event: {
        kind: string;
        event?: BrowserProviderEventParams;
    }) => void): () => void;
}
export interface BrowserSelectionOptions extends CallOptions {
    connectionId?: string;
    projectId?: string;
    onError?(error: Error): void;
}
export interface BrowserSelection {
    readonly provider: Readonly<BrowserProviderBindResult>;
    readonly active: boolean;
    /** Releases this exact epoch only. It never closes human Browser tabs. */
    release(): Promise<void>;
}
/** Explicit root association, not a default/newest-wins browser destination. */
export declare class BrowserProviders {
    private readonly client;
    private readonly roots;
    constructor(client: WhipClient);
    select(input: BrowserProviderBindParams, bridge: BrowserProviderBridge, options?: BrowserSelectionOptions): Promise<BrowserSelection>;
}
