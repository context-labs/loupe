import { abortError, WhipError } from './errors.js';
export const utf8 = new TextEncoder();
export const byteLength = (text) => utf8.encode(text).byteLength;
export function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function frozen(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value))
            frozen(child);
    }
    return value;
}
export function withSignal(promise, signal) {
    if (!signal)
        return promise;
    if (signal.aborted) {
        void promise.catch(() => { });
        return Promise.reject(abortError(signal));
    }
    return new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(abortError(signal)); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}
export function decodeBase64(value) {
    try {
        return Uint8Array.from(atob(value), char => char.charCodeAt(0));
    }
    catch {
        throw new WhipError('invalid_response', 'Invalid base64 data');
    }
}
export function encodeBase64(bytes) {
    let text = '';
    for (let start = 0; start < bytes.length; start += 8192) {
        text += String.fromCharCode(...bytes.subarray(start, start + 8192));
    }
    return btoa(text);
}
export async function sha256(bytes) {
    if (!globalThis.crypto?.subtle)
        throw new WhipError('unavailable_capability', 'WebCrypto is unavailable. Use a secure browser context for content integrity checks.');
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
export async function digestHex(bytes) {
    return Array.from(await sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function uuid() {
    if (!globalThis.crypto?.randomUUID)
        throw new WhipError('unavailable_capability', 'A secure context with crypto.randomUUID is required to create command identities.');
    return crypto.randomUUID();
}
export function notify(listeners, value) {
    for (const listener of [...listeners]) {
        try {
            listener(value);
        }
        catch (error) {
            queueMicrotask(() => { throw error; });
        }
    }
}
//# sourceMappingURL=util.js.map