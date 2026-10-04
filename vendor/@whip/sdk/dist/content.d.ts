import { type ContentHandle, type SubmitPayload } from '@whip/protocol';
import type { CallOptions, WhipClient } from './client.js';
export interface ContentScope {
    rootId: string;
    agentId?: string;
}
export type InputAttachment = NonNullable<SubmitPayload['attachments']>[number];
export interface ReadContentOptions extends CallOptions {
    maxBytes: number;
}
export interface UploadOptions extends ContentScope, CallOptions {
    mediaType?: string;
    source?: string;
}
/** Immutable scoped reference. Constructing a reference never fetches its body. */
export declare class ContentReference {
    private readonly client;
    readonly handle: Readonly<ContentHandle>;
    readonly scope: Readonly<ContentScope>;
    constructor(client: WhipClient, handle: ContentHandle, scope: ContentScope);
    /** An input reference, without downloading or embedding the content body. */
    asAttachment(kind: 'image' | 'text', name?: string): InputAttachment;
    readBytes(options: ReadContentOptions): Promise<Uint8Array<ArrayBuffer>>;
    readText(options: ReadContentOptions): Promise<string>;
    readJSON(options: ReadContentOptions): Promise<unknown>;
}
export declare function upload(client: WhipClient, input: Uint8Array<ArrayBuffer>, options: UploadOptions, transport?: 'auto' | 'connection'): Promise<ContentReference>;
