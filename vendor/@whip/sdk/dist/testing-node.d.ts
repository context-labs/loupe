import { type SpawnOptions } from 'node:child_process';
export * from './testing.js';
/** The repository root; the live daemon is built from its Go sources. */
export declare const repository: string;
export declare function fixtureExternalOrigin(value: unknown): string | undefined;
export declare function run(command: string, args: string[], options?: SpawnOptions): Promise<void>;
export declare function eventually<T>(check: () => T | Promise<T>, { timeout, interval, description }?: {
    timeout?: number | undefined;
    interval?: number | undefined;
    description?: string | undefined;
}): Promise<NonNullable<T>>;
/** What the daemon fixture writes once it is serving. */
export interface LiveDaemonInfo {
    generation: number;
    endpoint: string;
    frontend: string;
    [key: string]: unknown;
}
export interface LiveDaemonOptions {
    allowedOrigins?: string[];
    retainOnFailure?: boolean;
    /** Fixture lifetime; four minutes by default, at most thirty. */
    lifetimeMs?: number;
    externalOrigin?: string;
    /** Extra environment for the daemon process, such as WHIP_SDK_AGENTS_FIXTURE=1 for the recursive runtime behind a scripted model. */
    env?: Record<string, string>;
}
export interface LiveDaemon {
    readonly info: LiveDaemonInfo;
    readonly exited: Promise<unknown[]>;
    readonly directory: string;
    readonly pid: number | undefined;
    readonly output: string;
    crashAndRestart(options?: {
        beforeRestart?: () => Promise<void> | void;
    }): Promise<LiveDaemonInfo>;
    release(key: string): Promise<void>;
    effects(): Promise<unknown[]>;
    close(): Promise<void>;
}
/**
 * A real daemon for acceptance tests: the integration test binary serving the
 * WHIP protocol from an isolated home, attach-only from the SDK's perspective.
 * Keeping the binary lets restart tests kill the daemon process itself. Node
 * only; it builds and spawns Go.
 */
export declare function startFixture({ allowedOrigins, retainOnFailure, lifetimeMs, externalOrigin, env }?: LiveDaemonOptions): Promise<LiveDaemon>;
/** A live daemon under the name the plan uses. */
export declare const liveDaemon: typeof startFixture;
