import { WhipError } from './errors.js';
import { decodeBase64, encodeBase64 } from './util.js';
/** Keystroke batches match the daemon's per-write bound. */
export const MAX_TERMINAL_WRITE_BYTES = 16 << 10;
const encoder = new TextEncoder();
const cursorOf = (value) => {
    const cursor = Number(value);
    if (!Number.isSafeInteger(cursor))
        throw new WhipError('invalid_response', 'Terminal cursor is not a safe integer');
    return cursor;
};
/**
 * Workspace terminals: one login shell per tab, running where the daemon runs.
 * Output reaches only the connection that attached last; the daemon replays
 * retained output from the cursor an attach names, so a reload or reconnect
 * resumes without loss. Closing ends the shell; disconnecting does not.
 */
export class Terminals {
    client;
    constructor(client) {
        this.client = client;
    }
    /** Start a login shell. Omitted cwd resolves to the named session's directory, then the daemon home. */
    open(params, options = {}) {
        return this.client.call('terminal.open', {
            ...(params.cwd ? { cwd: params.cwd } : {}), ...(params.rootId ? { root_id: params.rootId } : {}),
            cols: params.cols, rows: params.rows,
        }, options);
    }
    /** cursor -1 asks for live output only; a cursor older than the retained ring is clamped to its start. */
    async attach(id, cursor, options = {}) {
        const result = await this.client.call('terminal.attach', { id, cursor: String(cursor) }, options);
        return {
            cursor: cursorOf(result.cursor), cwd: result.cwd, cols: result.cols, rows: result.rows, exited: result.exited,
            ...(result.exit_code === undefined ? {} : { exitCode: result.exit_code }),
            ...(result.signal ? { signal: result.signal } : {}),
        };
    }
    async write(id, data, options = {}) {
        const bytes = typeof data === 'string' ? encoder.encode(data) : data;
        if (!bytes.byteLength || bytes.byteLength > MAX_TERMINAL_WRITE_BYTES)
            throw new WhipError('invalid_request', `Terminal writes must be 1..${MAX_TERMINAL_WRITE_BYTES} bytes`);
        await this.client.call('terminal.write', { id, bytes: encodeBase64(bytes) }, options);
    }
    async resize(id, cols, rows, options = {}) {
        await this.client.call('terminal.resize', { id, cols, rows }, options);
    }
    /** Ends the shell. Use it when the tab closes, never on unmount or disconnect. */
    async close(id, options = {}) {
        await this.client.call('terminal.close', { id }, options);
    }
    onOutput(listener) {
        return this.client.onNotification('terminal.output', params => {
            listener({ id: params.id, cursor: cursorOf(params.cursor), bytes: decodeBase64(params.bytes ?? '') });
        });
    }
    onExited(listener) {
        return this.client.onNotification('terminal.exited', params => {
            listener({ id: params.id, exitCode: params.exit_code, ...(params.signal ? { signal: params.signal } : {}) });
        });
    }
    onDetached(listener) {
        return this.client.onNotification('terminal.detached', params => listener(params.id));
    }
}
//# sourceMappingURL=terminals.js.map