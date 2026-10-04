import { manifest } from '@whip/protocol';
function snapshot(rootId, cursor, pinned = { definition: 'coding', revision: '' }) {
    return {
        root_id: rootId, cursor, history_revision: '1', active_turns: {},
        meta: { id: rootId, kind: 'agent', title: '', model: 'scripted-model', provider: 'scripted', cwd: '/scripted', execution_engine: 'starlark', definition: pinned.definition, definition_revision: pinned.revision,
            goal: '', forked_from: '', fork_seq: 0, tags: [], archived: false, pinned: false, effort: '', usage_in: 0, usage_cached: 0, usage_out: 0, updated_at: '' },
        messages: [], message_seqs: [], presentation: [], agent_presentations: {}, agents: [], inbox: [], blackboard: [],
        budgets: [], capabilities: [], schedules: [], permissions: [], questions: [],
    };
}
/**
 * A daemon made of replies. The client runs its real protocol processing over
 * an in-memory transport; the test decides what each request receives, pushes
 * journal events, or plays whole turns. Browser-safe.
 */
export function scriptedDaemon(options = {}) {
    const connections = [];
    const table = new Map();
    const commands = new Map();
    const subscriptions = new Map();
    const sequences = new Map();
    const scripts = new Map();
    const turns = new Map();
    const roots = new Map();
    let ingress = 0;
    let generation = 0;
    let created = 0;
    const revisionOf = (id) => `scripted-revision-${id}`;
    let sessions = false;
    const info = {
        protocol_major: manifest.major, protocol_minor: manifest.minor, runtime_id: 'fixture-runtime', connection_id: 'fixture-connection',
        generation: '9007199254740993', build_id: 'fixture', host_platform: 'darwin', host_architecture: 'arm64',
        capabilities: [], negotiated_capabilities: [],
        execution_engines: [{ id: 'starlark', language: 'starlark', label: 'Starlark' }, { id: 'quickjs', language: 'javascript', label: 'JavaScript (QuickJS)' }], default_execution_engine: 'starlark',
        operations: manifest.operations.map(operation => ({ ...operation })),
        limits: { frame_bytes: 1 << 20, connections: 64, in_flight_requests: 32, outbound_messages: 1024,
            outbound_bytes: String(8 << 20), root_subscriptions: 16, content_chunk_bytes: 4, upload_bytes: String(64 << 20) },
        ...options.initialize,
    };
    const emit = (rootId, kind, payload) => {
        const seq = String((sequences.get(rootId) ?? 0) + 1);
        sequences.set(rootId, Number(seq));
        for (const [id, subscription] of subscriptions) {
            if (subscription.rootId === rootId)
                subscription.connection.notify('event', { event: { root_id: rootId, subscription_id: id, seq, kind, payload } });
        }
        return seq;
    };
    const play = async (rootId, commandId, ingressSeq, entry) => {
        await new Promise(resolve => setTimeout(resolve, 0)); // the client sees the submit reply before the turn starts
        const { script } = entry;
        const count = (turns.get(rootId) ?? 0) + 1;
        turns.set(rootId, count);
        const turnId = script.turnId ?? `${rootId}-turn-${count}`;
        const base = { agent_id: rootId, turn_id: turnId };
        emit(rootId, 'turn.started', { ...base, inbox_seq: ingressSeq, phase: 'running', status: 'running' });
        for (const step of script.steps ?? []) {
            if ('text' in step)
                emit(rootId, 'stream.text', { ...base, text: step.text });
            else if ('reasoning' in step)
                emit(rootId, 'stream.reasoning', { ...base, text: step.reasoning });
            else if ('notice' in step)
                emit(rootId, 'stream.notice', { ...base, text: step.notice });
            else if ('question' in step)
                emit(rootId, 'question.pending', { ...base, question_id: step.question.id, question: step.question.question, options: step.question.options, multiple: step.question.multiple ?? false });
            else if ('permission' in step)
                emit(rootId, 'permission.pending', { ...base, permission_id: step.permission.id, operation: step.permission.operation, command: step.permission.command ?? '', rule: step.permission.rule ?? '', canonical_path: step.permission.path ?? '' });
            else if ('hook' in step)
                emit(rootId, 'stream.hook.decision', { ...base, name: step.hook.hook, args: step.hook.operation, text: step.hook.decision, result: step.hook.reason ?? '' });
            else if ('host' in step) {
                emit(rootId, 'stream.cell.host.started', { ...base, id: 'call-1', invocation_id: step.host.id, name: step.host.operation, args: step.host.summary ?? '' });
                emit(rootId, 'stream.cell.host', { ...base, id: 'call-1', invocation_id: step.host.id, name: step.host.operation, args: step.host.summary ?? '', text: '1ms', host_status: step.host.error ? 'failed' : 'succeeded', result: step.host.error ?? '' });
            }
            else
                emit(rootId, step.event.kind, step.event.payload);
        }
        const status = script.status ?? 'succeeded';
        emit(rootId, `turn.${status}`, { ...base, status, ...(script.failure ? { error: script.failure.message } : {}) });
        const record = commands.get(commandId);
        if (record) {
            Object.assign(record, { status }, status === 'succeeded'
                ? { result: { text: script.text ?? '', ...(script.output !== undefined ? { output: script.output } : {}) } }
                : { failure: script.failure ?? { code: -32000, message: `turn ${status}`, data: { kind: status === 'cancelled' ? 'cancelled' : 'execution_failed' } } });
        }
        entry.resolve();
    };
    const defaults = {
        'daemon.ping': () => ({ generation: info.generation, build_id: info.build_id }),
        'root.snapshot': request => snapshot(String(request.params.root_id), String(sequences.get(String(request.params.root_id)) ?? 0), roots.get(String(request.params.root_id))),
        'definitions.register': request => ({ id: request.params.definition.id, revision: revisionOf(request.params.definition.id), created: true }),
        'executor.bind': request => ({ generation: String(++generation), tools: request.params.tools ?? [], ...(request.params.hooks ? { hooks: request.params.hooks } : {}) }),
        'tool.result': () => ({ accepted: true }),
        'tool.progress': () => ({ accepted: true }),
        'hook.result': () => ({ accepted: true }),
        'events.subscribe': (request, connection) => {
            subscriptions.set(String(request.params.subscription_id), { rootId: String(request.params.root_id), connection });
            return { subscription_id: request.params.subscription_id, cursor: request.params.cursor };
        },
        'events.unsubscribe': request => { subscriptions.delete(String(request.params.subscription_id)); return {}; },
        'command.submit': request => {
            const id = String(request.params.command_id);
            const operation = String(request.params.operation);
            const rootId = String(request.params.root_id ?? '');
            const ingressSeq = String(++ingress);
            const record = { operation, command_id: id, ingress_seq: ingressSeq, status: operation === 'submit' ? 'running' : 'succeeded', ...(operation === 'submit' ? {} : { result: {} }) };
            if (operation === 'session.create') {
                const payload = request.params.payload;
                const newRoot = `root-${++created}`;
                roots.set(newRoot, { definition: payload.definition ?? 'coding', revision: payload.definition ? revisionOf(payload.definition) : '' });
                record.result = { root_id: newRoot };
            }
            commands.set(id, record);
            if (operation === 'submit') {
                const queued = scripts.get(rootId)?.shift();
                if (queued)
                    void play(rootId, id, ingressSeq, queued);
            }
            return record;
        },
        'command.status': request => commands.get(String(request.params.command_id)) ?? { operation: 'unknown', command_id: request.params.command_id, ingress_seq: '0', status: 'failed', failure: { code: -32011, message: 'unknown command', data: { kind: 'command_not_found' } } },
        'permission.decide': () => ({ operation_id: 'scripted-operation', lease_id: 'scripted-lease' }),
    };
    const factory = async (handlers) => {
        const answered = new Set();
        const connection = {
            requests: [],
            reply: (request, result) => { answered.add(request.id); handlers.message(JSON.stringify({ jsonrpc: '2.0', id: request.id, result })); },
            error: (request, kind, code = -32000) => { answered.add(request.id); handlers.message(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code, message: kind, data: { kind } } })); },
            fail: (error = new Error('Fixture connection lost')) => handlers.close(error),
            notify: (method, params) => handlers.message(JSON.stringify({ jsonrpc: '2.0', method, params })),
            answered: request => answered.has(request.id),
        };
        connections.push(connection);
        return {
            kind: options.kind ?? 'unix', httpEndpoint: 'http://fixture.invalid', bufferedAmount: 0,
            send(raw) {
                const request = { ...JSON.parse(raw), raw };
                connection.requests.push(request);
                if (request.method === 'initialize') {
                    connection.reply(request, { ...info, connection_id: `${info.connection_id}-${connections.length}` });
                    return;
                }
                const scripted = table.get(request.method);
                if (scripted) {
                    const result = scripted(request, connection);
                    if (result !== undefined) {
                        connection.reply(request, result);
                        return;
                    }
                }
                options.request?.(request, connection);
                if (connection.answered(request) || !sessions)
                    return;
                const fallback = defaults[request.method];
                if (fallback) {
                    const result = fallback(request, connection);
                    if (result !== undefined)
                        connection.reply(request, result);
                }
            },
            close() { },
        };
    };
    const daemon = {
        info, factory, connections, commands,
        get current() { return connections.at(-1); },
        reply(method, handler) { table.set(method, handler); return daemon; },
        emit,
        serveSessions() { sessions = true; return daemon; },
        turn(rootId, script = {}) {
            sessions = true;
            return new Promise(resolve => {
                const queue = scripts.get(rootId) ?? [];
                queue.push({ script, resolve });
                scripts.set(rootId, queue);
            });
        },
    };
    return daemon;
}
/** The scripted daemon under its earlier name. */
export const transportFixture = scriptedDaemon;
//# sourceMappingURL=testing.js.map