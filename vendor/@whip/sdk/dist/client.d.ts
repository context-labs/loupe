import { type CommandOperation, type CommandResult, type EphemeralOperation, type InitializeResult, type QueryOperation, type QueryResult, type RootEvent, type RpcMethod, type RpcMethods, type RuntimeOperation, type RuntimeOperations, type HookInvokeParams, type ToolCancelParams, type ToolInvokeParams, type TerminalDetachedParams, type TerminalExitedParams, type TerminalOutputParams, type BrowserInventoryRequest, type BrowserCommand, type BrowserCommandCancel, type BrowserProviderRevoked } from '@whip/protocol';
import { CommandHandle, type CommandOptions, type RecoveryRecord, type RecoveryStorage, type CommandOutcome } from './command.js';
import { ContentReference, type ContentScope, type UploadOptions } from './content.js';
import { Host, Permissions, Providers, Configuration, MCPImport } from './services.js';
import { Agents } from './agents.js';
import { Terminals } from './terminals.js';
import { BrowserProviders } from './browser.js';
import { Session, Sessions } from './session.js';
import { Subscription, type SubscriptionOptions } from './subscription.js';
import { type Transport, type TransportFactory } from './transport.js';
export type SdkEvent = RootEvent;
/** Notifications the daemon addresses to one connection: executor leases and terminal attachments. */
export interface Notifications {
    'browser.inventory': BrowserInventoryRequest;
    'browser.command': BrowserCommand;
    'browser.command.cancel': BrowserCommandCancel;
    'browser.provider.revoked': BrowserProviderRevoked;
    'tool.invoke': ToolInvokeParams;
    'tool.cancel': ToolCancelParams;
    'hook.invoke': HookInvokeParams;
    'hook.cancel': ToolCancelParams;
    'terminal.output': TerminalOutputParams;
    'terminal.exited': TerminalExitedParams;
    'terminal.detached': TerminalDetachedParams;
}
export type Notification = keyof Notifications;
/** Notifications the daemon sends to the connection holding an executor lease. */
export type ExecutorNotifications = Pick<Notifications, 'tool.invoke' | 'tool.cancel' | 'hook.invoke' | 'hook.cancel'>;
export type ExecutorNotification = keyof ExecutorNotifications;
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'incompatible' | 'paused' | 'closed';
export interface ConnectionSnapshot {
    readonly state: ConnectionState;
    readonly info?: Readonly<InitializeResult>;
    readonly error?: Error;
}
export interface CallOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}
export interface ClientOptions {
    endpoint: string | TransportFactory;
    clientId: string;
    clientKind?: 'human' | 'automation';
    /** Refuse attachment to another installation before exposing connected state. */
    expectedRuntimeId?: string;
    buildId?: string;
    /** Advertise native Browser provider support; selection remains explicit per root. */
    browserProvider?: boolean;
    reconnect?: boolean;
    queryTimeoutMs?: number;
    connectTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    commandPollMs?: number;
    recoveryStorage?: RecoveryStorage;
    /** Native runtimes can supply OS-backed primitives without global polyfills. */
    randomUUID?: () => string;
    sha256?: (bytes: Uint8Array<ArrayBuffer>) => Promise<Uint8Array<ArrayBuffer>>;
}
export type QueryOutcome<O extends RuntimeOperation> = Omit<QueryResult, 'result'> & {
    result?: RuntimeOperations[O]['result'];
};
/** Owns one connection. It never starts, stops, or implicitly replaces a daemon. */
export declare class WhipClient {
    readonly clientId: string;
    readonly clientKind: 'human' | 'automation';
    readonly recoveryStorage?: RecoveryStorage;
    readonly sessions: Sessions;
    readonly providers: Providers;
    readonly configuration: Configuration;
    readonly mcpImport: MCPImport;
    readonly permissions: Permissions;
    readonly host: Host;
    readonly agents: Agents;
    readonly terminals: Terminals;
    readonly browser: BrowserProviders;
    readonly events: {
        subscribe: (rootId: string, cursor: string, options?: SubscriptionOptions) => Promise<Subscription>;
        replay: (rootId: string, cursor: string, options?: CallOptions & {
            limit?: number;
        }) => Promise<{
            events: RootEvent[];
            latest: string;
            expired?: boolean;
        }>;
    };
    private readonly options;
    private readonly factory;
    private snapshot;
    private readonly listeners;
    private readonly eventListeners;
    private readonly commandListeners;
    private readonly notificationListeners;
    private readonly pending;
    private readonly streams;
    private readonly lookups;
    private readonly ticks;
    private ticker?;
    private connection?;
    private controller?;
    private opening?;
    private heartbeat?;
    private retryTimer?;
    private retries;
    private epoch;
    private nextId;
    private closed;
    private paused;
    private runtimeId?;
    constructor(options: ClientOptions);
    getSnapshot: () => ConnectionSnapshot;
    subscribe: (listener: () => void) => (() => void);
    onEvent(listener: (event: SdkEvent) => void): () => void;
    onCommand(listener: (outcome: CommandResult) => void): () => void;
    /** Notifications addressed to this connection; agents.serve and terminals consume them. */
    onNotification<M extends Notification>(method: M, listener: (params: Notifications[M]) => void): () => void;
    session(rootId: string): Session;
    get transportKind(): Transport['kind'] | undefined;
    get httpEndpoint(): string | undefined;
    get lifetimeSignal(): AbortSignal;
    connect(options?: Pick<CallOptions, 'signal'>): Promise<void>;
    private open;
    private setState;
    private disconnected;
    /** Refreshes a connection without replaying pending requests. */
    reconnect(): void;
    /** Suspend observation without cancelling accepted work or discarding command identities. */
    pause(): void;
    /** Resume the same runtime; commands are reconciled, never resubmitted. */
    resume(options?: Pick<CallOptions, 'signal'>): Promise<void>;
    createId(): string;
    digestHex(bytes: Uint8Array<ArrayBuffer>): Promise<string>;
    close(): void;
    requireConnected(): Readonly<InitializeResult>;
    whenConnected(signal?: AbortSignal): Promise<Readonly<InitializeResult>>;
    supports(surface: 'rpc' | 'runtime', name: string): boolean;
    call<M extends RpcMethod>(method: M, params: RpcMethods[M]['params'], options?: CallOptions): Promise<RpcMethods[M]['result']>;
    /** Internal exact JSON path for command retries. */
    callEncoded<M extends RpcMethod>(method: M, paramsJSON: string, options?: CallOptions): Promise<RpcMethods[M]['result']>;
    private dispatch;
    private validateNested;
    private receive;
    private decodeEvent;
    private scheduleHeartbeat;
    releaseSubscription(id: string): void;
    query<O extends QueryOperation>(operation: O, payload: RuntimeOperations[O]['params'], options?: CallOptions & {
        rootId?: string;
    }): Promise<QueryOutcome<O>>;
    invoke<O extends EphemeralOperation>(operation: O, payload: RuntimeOperations[O]['params'], options?: CallOptions & {
        rootId?: string;
    }): Promise<QueryOutcome<O>>;
    private runtimeCall;
    submit<O extends CommandOperation>(operation: O, payload: RuntimeOperations[O]['params'], options?: CommandOptions): CommandHandle<O>;
    recover<O extends CommandOperation>(record: RecoveryRecord<O>, payload?: RuntimeOperations[O]['params']): CommandHandle<O>;
    recoveryRecords(): Promise<readonly RecoveryRecord[]>;
    forget(record: RecoveryRecord): Promise<void>;
    commandStatus<O extends CommandOperation>(record: RecoveryRecord<O>, options?: CallOptions): Promise<CommandOutcome<O>>;
    commandOutcome<O extends CommandOperation>(record: RecoveryRecord<O>, result: CommandResult): CommandOutcome<O>;
    waitForCommandTick(signal?: AbortSignal): Promise<void>;
    private wakeCommands;
    content(handle: ConstructorParameters<typeof ContentReference>[1], scope: ContentScope): ContentReference;
    upload(bytes: Uint8Array<ArrayBuffer>, options: UploadOptions): Promise<ContentReference>;
}
export declare function createWhipClient(options: ClientOptions): WhipClient;
