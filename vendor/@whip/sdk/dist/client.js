import { assertValid, manifest, rpcOperations, runtimeOperations, validate, } from '@whip/protocol';
import { CommandHandle } from './command.js';
import { ContentReference, upload } from './content.js';
import { Host, Permissions, Providers, Configuration, MCPImport } from './services.js';
import { Agents } from './agents.js';
import { Terminals } from './terminals.js';
import { BrowserProviders } from './browser.js';
import { Session, Sessions } from './session.js';
import { Subscription } from './subscription.js';
import { WhipError, RpcError, abortError, asError } from './errors.js';
import { webSocket } from './transport.js';
import { byteLength, frozen, notify, object, withSignal, uuid, digestHex } from './util.js';
/** Owns one connection. It never starts, stops, or implicitly replaces a daemon. */
export class WhipClient {
    clientId;
    clientKind;
    recoveryStorage;
    sessions;
    providers;
    configuration;
    mcpImport;
    permissions;
    host;
    agents;
    terminals;
    browser;
    events = {
        subscribe: async (rootId, cursor, options = {}) => {
            this.requireConnected();
            const limit = this.snapshot.info.limits.root_subscriptions;
            if (this.streams.size >= limit)
                throw new WhipError('resource_limit', 'Root subscription limit reached');
            const stream = new Subscription(this, rootId, cursor, options);
            // Register before sending: notifications may arrive before the acknowledgement.
            this.streams.set(stream.id, stream);
            try {
                await stream.start(options.signal);
                return stream;
            }
            catch (error) {
                stream.fail(asError(error));
                throw error;
            }
        },
        replay: async (rootId, cursor, options = {}) => {
            const page = await this.call('events.replay', { root_id: rootId, cursor, limit: options.limit ?? 1000 }, options);
            return { ...page, events: (page.events ?? []).map(event => this.decodeEvent(event)) };
        },
    };
    options;
    factory;
    snapshot = Object.freeze({ state: 'closed' });
    listeners = new Set();
    eventListeners = new Set();
    commandListeners = new Set();
    notificationListeners = new Map();
    pending = new Map();
    streams = new Map();
    lookups = new Map();
    ticks = new Set();
    ticker;
    connection;
    controller;
    opening;
    heartbeat;
    retryTimer;
    retries = 0;
    epoch = 0;
    nextId = 0;
    closed = false;
    paused = false;
    runtimeId;
    constructor(options) {
        if (!options.clientId.trim())
            throw new TypeError('clientId is required; persist it to recover command identities');
        for (const value of [options.queryTimeoutMs, options.connectTimeoutMs, options.heartbeatIntervalMs, options.heartbeatTimeoutMs, options.commandPollMs]) {
            if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
                throw new TypeError('Timeouts and polling intervals must be positive integer milliseconds');
        }
        this.options = { ...options };
        this.clientId = options.clientId;
        this.clientKind = options.clientKind ?? 'automation';
        this.recoveryStorage = options.recoveryStorage;
        this.factory = typeof options.endpoint === 'string' ? webSocket(options.endpoint) : options.endpoint;
        this.sessions = new Sessions(this);
        this.providers = new Providers(this);
        this.configuration = new Configuration(this);
        this.mcpImport = new MCPImport(this);
        this.permissions = new Permissions(this);
        this.host = new Host(this);
        this.agents = new Agents(this);
        this.terminals = new Terminals(this);
        this.browser = new BrowserProviders(this);
    }
    getSnapshot = () => this.snapshot;
    subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    onEvent(listener) { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
    onCommand(listener) { this.commandListeners.add(listener); return () => this.commandListeners.delete(listener); }
    /** Notifications addressed to this connection; agents.serve and terminals consume them. */
    onNotification(method, listener) {
        let listeners = this.notificationListeners.get(method);
        if (!listeners) {
            listeners = new Set();
            this.notificationListeners.set(method, listeners);
        }
        const typed = listener;
        listeners.add(typed);
        return () => { listeners.delete(typed); };
    }
    session(rootId) { return new Session(this, rootId); }
    get transportKind() { return this.connection?.kind; }
    get httpEndpoint() { return this.connection?.httpEndpoint; }
    get lifetimeSignal() { this.requireConnected(); return this.controller.signal; }
    async connect(options = {}) {
        options.signal?.throwIfAborted();
        if (this.closed)
            throw new WhipError('closed', 'Client is closed; create a new client to attach again');
        if (this.snapshot.state === 'incompatible')
            throw this.snapshot.error;
        if (this.paused)
            throw new WhipError('paused', 'Client observation is paused; resume it before connecting');
        if (this.snapshot.state === 'connected')
            return;
        if (!this.opening) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
            this.opening = this.open().finally(() => { this.opening = undefined; });
        }
        return withSignal(this.opening, options.signal);
    }
    async open() {
        const epoch = ++this.epoch;
        const controller = new AbortController();
        this.controller = controller;
        this.setState(this.runtimeId ? 'reconnecting' : 'connecting');
        const timer = setTimeout(() => controller.abort(new WhipError('timeout', 'Daemon initialization timed out')), this.options.connectTimeoutMs ?? 5000);
        try {
            const connection = await this.factory({
                message: message => { if (epoch === this.epoch)
                    this.receive(message); },
                close: error => { if (epoch === this.epoch)
                    this.disconnected(error); },
            }, controller.signal);
            if (epoch !== this.epoch || this.closed || controller.signal.aborted) {
                connection.close();
                throw abortError(controller.signal);
            }
            this.connection = connection;
            const info = await this.dispatch('initialize', {
                protocol_major: manifest.major, client_id: this.clientId, client_kind: this.clientKind,
                build_id: this.options.buildId ?? '@whip/sdk', capabilities: ['commands', 'events', 'snapshots', 'uploads', 'history_pages', 'collections', 'host_configuration', 'workspace_completion', 'host_skill_completion', 'host_global_skill_completion', 'skill_catalog_completion', 'host_views', 'themes', 'mailbox_inspection', 'input_attachments', 'session_summaries', 'execution_engines', ...(this.options.browserProvider ? ['desktop-browser-v1', 'desktop-browser-v2'] : [])],
            }, { signal: controller.signal }, true);
            if (epoch !== this.epoch || this.closed || controller.signal.aborted)
                throw abortError(controller.signal);
            if (info.protocol_major !== manifest.major)
                throw new WhipError('unsupported_protocol', 'Daemon protocol major is incompatible');
            const expectedRuntime = this.runtimeId ?? this.options.expectedRuntimeId;
            if (expectedRuntime && expectedRuntime !== info.runtime_id)
                throw new WhipError('runtime_changed', 'The endpoint now serves a different runtime; create a new client explicitly');
            if (!info.runtime_id || info.limits.frame_bytes < 1 || info.limits.in_flight_requests < 1 || BigInt(info.limits.outbound_bytes) < 1n || info.limits.root_subscriptions < 1 || info.limits.content_chunk_bytes < 1 || BigInt(info.limits.upload_bytes) < 0n) {
                throw new WhipError('invalid_response', 'Daemon reported invalid identity or limits');
            }
            this.runtimeId = info.runtime_id;
            this.retries = 0;
            this.setState('connected', undefined, frozen(info));
            this.scheduleHeartbeat();
        }
        catch (value) {
            const error = asError(value);
            if (epoch === this.epoch)
                this.disconnected(error);
            throw error;
        }
        finally {
            clearTimeout(timer);
        }
    }
    setState(state, error, info = this.snapshot.info) {
        this.snapshot = Object.freeze({ state, ...(info ? { info } : {}), ...(error ? { error } : {}) });
        notify(this.listeners, undefined);
        this.wakeCommands();
    }
    disconnected(error) {
        ++this.epoch;
        const connection = this.connection;
        this.connection = undefined;
        this.controller?.abort(error);
        connection?.close();
        clearTimeout(this.heartbeat);
        for (const pending of this.pending.values())
            pending.reject(error);
        this.pending.clear();
        this.lookups.clear();
        for (const stream of [...this.streams.values()])
            stream.fail(error);
        if (this.closed)
            return;
        if (this.paused) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
            this.setState('paused');
            return;
        }
        const incompatible = error instanceof WhipError && ['unsupported_protocol', 'runtime_changed'].includes(error.kind);
        this.setState(incompatible ? 'incompatible' : this.options.reconnect === false ? 'closed' : 'reconnecting', error);
        if (!incompatible && this.options.reconnect !== false) {
            clearTimeout(this.retryTimer);
            const delay = Math.min(10_000, 250 * 2 ** Math.min(this.retries++, 6)) * (0.75 + Math.random() * 0.5);
            this.retryTimer = setTimeout(() => { void this.connect().catch(() => { }); }, delay);
        }
    }
    /** Refreshes a connection without replaying pending requests. */
    reconnect() {
        this.requireConnected();
        this.disconnected(new WhipError('disconnected', 'Refreshing daemon connection'));
    }
    /** Suspend observation without cancelling accepted work or discarding command identities. */
    pause() {
        if (this.closed || this.paused || this.snapshot.state === 'incompatible')
            return;
        this.paused = true;
        this.disconnected(new WhipError('paused', 'Client observation paused'));
    }
    /** Resume the same runtime; commands are reconciled, never resubmitted. */
    async resume(options = {}) {
        options.signal?.throwIfAborted();
        this.paused = false;
        const resuming = (async () => {
            // A paused initialization may still be unwinding its aborted transport.
            await this.opening?.catch(() => { });
            await this.connect();
        })();
        return withSignal(resuming, options.signal);
    }
    createId() { return (this.options.randomUUID ?? uuid)(); }
    async digestHex(bytes) {
        if (!this.options.sha256)
            return digestHex(bytes);
        const digest = await this.options.sha256(bytes);
        if (digest.byteLength !== 32)
            throw new WhipError('invalid_response', 'SHA-256 provider returned an invalid digest');
        return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        clearTimeout(this.retryTimer);
        clearTimeout(this.heartbeat);
        clearTimeout(this.ticker);
        this.disconnected(new WhipError('closed', 'Client closed'));
        this.setState('closed');
        this.listeners.clear();
        this.eventListeners.clear();
        this.commandListeners.clear();
    }
    requireConnected() {
        if (this.snapshot.state !== 'connected' || !this.connection)
            throw this.snapshot.error ?? new WhipError('disconnected', 'Connect to the daemon before sending requests');
        return this.snapshot.info;
    }
    async whenConnected(signal) {
        signal?.throwIfAborted();
        if (this.snapshot.state === 'connected')
            return this.snapshot.info;
        if (this.closed || this.snapshot.state === 'incompatible' || this.snapshot.state === 'closed')
            throw this.snapshot.error ?? new WhipError('closed', 'Client is not connected');
        return new Promise((resolve, reject) => {
            const cleanup = () => { unsubscribe(); signal?.removeEventListener('abort', abort); };
            const check = () => {
                if (this.snapshot.state === 'connected') {
                    cleanup();
                    resolve(this.snapshot.info);
                }
                else if (['closed', 'incompatible'].includes(this.snapshot.state)) {
                    cleanup();
                    reject(this.snapshot.error ?? new WhipError('closed', 'Client closed'));
                }
            };
            const abort = () => { cleanup(); reject(abortError(signal)); };
            const unsubscribe = this.subscribe(check);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted)
                abort();
            else
                check();
        });
    }
    supports(surface, name) {
        return this.snapshot.info?.operations?.some(operation => operation.surface === surface && operation.name === name) ?? false;
    }
    call(method, params, options = {}) {
        return this.dispatch(method, params, options);
    }
    /** Internal exact JSON path for command retries. */
    callEncoded(method, paramsJSON, options = {}) {
        return this.dispatch(method, JSON.parse(paramsJSON), options, false, paramsJSON);
    }
    async dispatch(method, params, options = {}, initializing = false, encoded) {
        options.signal?.throwIfAborted();
        if (!initializing)
            this.requireConnected();
        if (!Object.hasOwn(rpcOperations, method))
            throw new WhipError('unsupported_operation', 'Unknown RPC method');
        if (!initializing && !this.supports('rpc', method))
            throw new WhipError('unsupported_operation', `Daemon does not support ${method}`);
        const metadata = rpcOperations[method];
        assertValid(metadata.params_type, params);
        this.validateNested(method, params);
        const limit = this.snapshot.info?.limits;
        if (this.pending.size >= (limit?.in_flight_requests ?? 32))
            throw new WhipError('resource_limit', 'In-flight request limit reached');
        const id = String(++this.nextId);
        const data = `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":${JSON.stringify(method)},"params":${encoded ?? JSON.stringify(params)}}`;
        const connection = this.connection;
        const bytes = byteLength(data) + (connection.kind === 'unix' ? 1 : 0);
        if (bytes > (limit?.frame_bytes ?? 1 << 20))
            throw new WhipError('resource_limit', 'Request exceeds the frame limit; upload large content separately');
        if (BigInt(connection.bufferedAmount + bytes) > BigInt(limit?.outbound_bytes ?? 8 << 20))
            throw new WhipError('resource_limit', 'Outbound byte limit reached');
        return new Promise((resolve, reject) => {
            const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); this.pending.delete(id); };
            const fail = (error) => { cleanup(); reject(error); };
            const abort = () => fail(abortError(options.signal));
            const timer = setTimeout(() => fail(new WhipError('timeout', `Request timed out: ${method}`)), options.timeoutMs ?? this.options.queryTimeoutMs ?? 10_000);
            this.pending.set(id, { method, resolve: value => { cleanup(); resolve(value); }, reject: fail });
            options.signal?.addEventListener('abort', abort, { once: true });
            try {
                connection.send(data);
            }
            catch (error) {
                fail(asError(error));
            }
        });
    }
    validateNested(method, value) {
        if (!['command.submit', 'query', 'operation.invoke'].includes(method) || !object(value))
            return;
        const operation = value.operation;
        if (!Object.hasOwn(runtimeOperations, operation))
            throw new WhipError('unsupported_operation', 'Unknown runtime operation');
        const metadata = runtimeOperations[operation];
        const expected = method === 'command.submit' ? 'command' : method === 'query' ? 'query' : 'ephemeral';
        if (metadata.execution !== expected)
            throw new WhipError('invalid_arguments', `Operation must use the ${metadata.execution} interface`);
        if (!this.supports('runtime', operation))
            throw new WhipError('unsupported_operation', `Daemon does not support ${operation}`);
        assertValid(metadata.params_type, value.payload ?? {});
    }
    receive(text) {
        try {
            if (byteLength(text) > (this.snapshot.info?.limits.frame_bytes ?? 1 << 20))
                throw new WhipError('resource_limit', 'Received message exceeds the frame limit');
            const envelope = JSON.parse(text);
            if (!object(envelope) || envelope.jsonrpc !== '2.0')
                throw new WhipError('invalid_response', 'Invalid JSON-RPC envelope');
            if (Object.hasOwn(envelope, 'id')) {
                if (typeof envelope.id !== 'string')
                    throw new WhipError('invalid_response', 'Response ID must match the string request ID');
                const pending = this.pending.get(envelope.id);
                if (!pending)
                    return; // Late reply after cancellation/timeout.
                const hasError = Object.hasOwn(envelope, 'error');
                if (hasError === Object.hasOwn(envelope, 'result'))
                    throw new WhipError('invalid_response', 'Expected one response result or error');
                if (hasError) {
                    assertValid('RPCError', envelope.error, 'response');
                    pending.reject(new RpcError(envelope.error));
                }
                else {
                    // Older compatible hosts predate MCP import/logo settings. Supply only
                    // absent fields for features they do not advertise; malformed values
                    // and hosts claiming those features still use strict validation.
                    if (rpcOperations[pending.method].result_type === 'RuntimeConfiguration' && object(envelope.result)) {
                        if (!Object.hasOwn(envelope.result, 'mcp_import_offered') && !this.supports('rpc', 'mcp.import.candidates'))
                            envelope.result.mcp_import_offered = true;
                        if (!Object.hasOwn(envelope.result, 'brand_icons') && !this.supports('rpc', 'mcp.brand.icons'))
                            envelope.result.brand_icons = false;
                    }
                    assertValid(rpcOperations[pending.method].result_type, envelope.result, 'response');
                    pending.resolve(frozen(envelope.result));
                }
                return;
            }
            if (typeof envelope.method !== 'string')
                throw new WhipError('invalid_response', 'Notification method is missing');
            if (envelope.method === 'event') {
                assertValid('EventNotification', envelope.params, 'response');
                const event = this.decodeEvent(envelope.params.event);
                const stream = event.subscription_id ? this.streams.get(event.subscription_id) : undefined;
                if (!stream)
                    return;
                stream.push(event);
                notify(this.eventListeners, event);
                this.wakeCommands();
            }
            else if (envelope.method === 'subscription.failed') {
                assertValid('SubscriptionFailure', envelope.params, 'response');
                const failure = envelope.params;
                this.streams.get(failure.subscription_id)?.fail(failure.error ? new RpcError(failure.error) : new WhipError('resynchronization_required', 'Subscription failed'));
            }
            else if (Object.hasOwn(manifest.events, envelope.method)) {
                // Connection-addressed notifications are typed by the generated contract; anything else is malformed.
                assertValid(manifest.events[envelope.method], envelope.params, 'response');
                const listeners = this.notificationListeners.get(envelope.method);
                if (listeners)
                    notify(listeners, frozen(envelope.params));
            }
        }
        catch (error) {
            this.disconnected(new WhipError('invalid_response', 'Malformed daemon response', { cause: error }));
        }
    }
    decodeEvent(input) {
        const wrapper = { event: input };
        assertValid('EventNotification', wrapper, 'response');
        const value = wrapper.event;
        const schema = Object.hasOwn(manifest.event_payloads, value.kind) ? manifest.event_payloads[value.kind] : undefined;
        if (!schema)
            return frozen({ ...value, payload: value.payload, unknown: true });
        if (!validate(schema, value.payload, 'response') && !validate('ContentEventPayload', value.payload, 'response'))
            throw new WhipError('invalid_response', `Invalid ${value.kind} event payload`);
        return frozen({ ...value, unknown: false });
    }
    scheduleHeartbeat() {
        clearTimeout(this.heartbeat);
        if (this.snapshot.state !== 'connected')
            return;
        const epoch = this.epoch;
        this.heartbeat = setTimeout(() => {
            if (epoch !== this.epoch || this.closed)
                return;
            void this.call('daemon.ping', {}, { timeoutMs: this.options.heartbeatTimeoutMs ?? 10_000 })
                .then(() => { if (epoch === this.epoch && !this.closed)
                this.scheduleHeartbeat(); }, error => { if (epoch === this.epoch && !this.closed)
                this.disconnected(asError(error)); });
        }, this.options.heartbeatIntervalMs ?? 30_000);
    }
    releaseSubscription(id) { this.streams.delete(id); }
    query(operation, payload, options = {}) {
        return this.runtimeCall('query', operation, payload, options);
    }
    invoke(operation, payload, options = {}) {
        return this.runtimeCall('operation.invoke', operation, payload, options);
    }
    async runtimeCall(method, operation, payload, options) {
        const result = await this.call(method, { operation, payload, ...(options.rootId ? { root_id: options.rootId } : {}) }, options);
        if (result.result !== undefined)
            assertValid(runtimeOperations[operation].result_type, result.result, 'response');
        return result;
    }
    submit(operation, payload, options = {}) {
        const info = this.requireConnected();
        if (!Object.hasOwn(runtimeOperations, operation) || runtimeOperations[operation].execution !== 'command')
            throw new WhipError('invalid_arguments', 'Only durable runtime commands can be submitted');
        if (!this.supports('runtime', operation))
            throw new WhipError('unsupported_operation', `Daemon does not support ${operation}`);
        assertValid(runtimeOperations[operation].params_type, payload);
        return CommandHandle.submit(this, info.runtime_id, operation, payload, options);
    }
    recover(record, payload) {
        if (record.version !== 1 || record.clientId !== this.clientId || !record.commandId || !Object.hasOwn(runtimeOperations, record.operation) || runtimeOperations[record.operation].execution !== 'command')
            throw new WhipError('invalid_arguments', 'Invalid recovery record or command namespace');
        return CommandHandle.recover(this, record, payload);
    }
    async recoveryRecords() { return this.recoveryStorage ? this.recoveryStorage.list() : []; }
    async forget(record) {
        if (record.clientId !== this.clientId)
            throw new WhipError('invalid_arguments', 'Recovery record belongs to a different client namespace');
        await this.recoveryStorage?.delete(record);
    }
    async commandStatus(record, options = {}) {
        options.signal?.throwIfAborted();
        if (record.clientId !== this.clientId)
            throw new WhipError('invalid_arguments', 'Command belongs to another client namespace');
        const info = await this.whenConnected(options.signal);
        if (info.runtime_id !== record.runtimeId)
            throw new WhipError('runtime_changed', 'Command belongs to a different persistent runtime');
        let pending = this.lookups.get(record.commandId);
        if (!pending) {
            pending = this.call('command.status', { command_id: record.commandId });
            this.lookups.set(record.commandId, pending);
            void pending.finally(() => { if (this.lookups.get(record.commandId) === pending)
                this.lookups.delete(record.commandId); }).catch(() => { });
        }
        const result = await withSignal(pending, options.signal);
        return this.commandOutcome(record, result);
    }
    commandOutcome(record, result) {
        if (result.command_id !== record.commandId || result.operation !== record.operation || !['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(result.status))
            throw new WhipError('invalid_response', 'Command response does not match its identity or lifecycle');
        if (result.status === 'succeeded' && result.result !== undefined)
            assertValid(runtimeOperations[record.operation].result_type, result.result, 'response');
        const outcome = result;
        notify(this.commandListeners, outcome);
        return outcome;
    }
    waitForCommandTick(signal) {
        if (this.closed)
            return Promise.reject(new WhipError('closed', 'Client closed'));
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                this.ticks.delete(done);
                signal?.removeEventListener('abort', abort);
                if (this.ticks.size === 0) {
                    clearTimeout(this.ticker);
                    this.ticker = undefined;
                }
            };
            const done = () => { cleanup(); resolve(); };
            const abort = () => { cleanup(); reject(abortError(signal)); };
            this.ticks.add(done);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) {
                abort();
                return;
            }
            if (!this.paused && !this.closed)
                this.ticker ??= setTimeout(() => this.wakeCommands(), this.options.commandPollMs ?? 250);
        });
    }
    wakeCommands() {
        clearTimeout(this.ticker);
        this.ticker = undefined;
        for (const done of [...this.ticks])
            done();
    }
    content(handle, scope) { return new ContentReference(this, handle, scope); }
    upload(bytes, options) { return upload(this, bytes, options); }
}
export function createWhipClient(options) { return new WhipClient(options); }
//# sourceMappingURL=client.js.map