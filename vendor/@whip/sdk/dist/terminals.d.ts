import type { TerminalOpenResult } from '@whip/protocol';
import type { CallOptions, WhipClient } from './client.js';
/** Keystroke batches match the daemon's per-write bound. */
export declare const MAX_TERMINAL_WRITE_BYTES: number;
export interface TerminalAttachment {
    /** Absolute cursor of the first replayed byte; live output follows from there. */
    cursor: number;
    cwd: string;
    cols: number;
    rows: number;
    exited: boolean;
    exitCode?: number;
    signal?: string;
}
export interface TerminalOutput {
    id: string;
    cursor: number;
    bytes: Uint8Array<ArrayBuffer>;
}
export interface TerminalExit {
    id: string;
    exitCode: number;
    signal?: string;
}
/**
 * Workspace terminals: one login shell per tab, running where the daemon runs.
 * Output reaches only the connection that attached last; the daemon replays
 * retained output from the cursor an attach names, so a reload or reconnect
 * resumes without loss. Closing ends the shell; disconnecting does not.
 */
export declare class Terminals {
    private readonly client;
    constructor(client: WhipClient);
    /** Start a login shell. Omitted cwd resolves to the named session's directory, then the daemon home. */
    open(params: {
        cwd?: string;
        rootId?: string;
        cols: number;
        rows: number;
    }, options?: CallOptions): Promise<TerminalOpenResult>;
    /** cursor -1 asks for live output only; a cursor older than the retained ring is clamped to its start. */
    attach(id: string, cursor: number, options?: CallOptions): Promise<TerminalAttachment>;
    write(id: string, data: Uint8Array | string, options?: CallOptions): Promise<void>;
    resize(id: string, cols: number, rows: number, options?: CallOptions): Promise<void>;
    /** Ends the shell. Use it when the tab closes, never on unmount or disconnect. */
    close(id: string, options?: CallOptions): Promise<void>;
    onOutput(listener: (output: TerminalOutput) => void): () => void;
    onExited(listener: (exit: TerminalExit) => void): () => void;
    onDetached(listener: (id: string) => void): () => void;
}
