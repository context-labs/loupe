import { Turn, permissionEvent, questionEvent } from './turn.js';
import { encodeBase64, object } from './util.js';
/** Root-bound handle. Merely constructing it causes no I/O. */
export class Session {
    client;
    rootId;
    constructor(client, rootId) {
        this.client = client;
        this.rootId = rootId;
        if (!rootId)
            throw new TypeError('rootId is required');
    }
    command(operation, payload, options = {}) {
        return this.client.submit(operation, payload, { ...options, rootId: this.rootId });
    }
    query(operation, payload, options = {}) {
        return this.client.query(operation, payload, { ...options, rootId: this.rootId });
    }
    invoke(operation, payload, options = {}) {
        return this.client.invoke(operation, payload, { ...options, rootId: this.rootId });
    }
    submit(payload, options = {}) { return this.command('submit', payload, options); }
    /** Submit one turn and observe it: an async iterable of typed events plus a typed result. */
    run(input, options = {}) {
        return new Turn(this, typeof input === 'string' ? { text: input } : input, options);
    }
    /** The open questions and permission prompts from a fresh snapshot, with the same reply methods turn events carry. */
    async prompts(options = {}) {
        const snapshot = await this.snapshot(options);
        const base = (payload) => ({ seq: snapshot.cursor, agentId: typeof payload.agent_id === 'string' ? payload.agent_id : this.rootId, turnId: typeof payload.turn_id === 'string' ? payload.turn_id : '' });
        const questions = (snapshot.questions ?? []).filter(object).map(payload => questionEvent(this, base(payload), payload));
        const permissions = (snapshot.permissions ?? []).filter(object).filter(payload => payload.status === 'pending' || payload.status === undefined).map(payload => permissionEvent(this, base(payload), payload));
        return [...questions, ...permissions];
    }
    steer(payload, options = {}) { return this.command('steer', payload, options); }
    inbox = {
        steer: (agentId, inboxSeq, turnId) => this.command('inbox.steer', { id: agentId, inbox_seq: inboxSeq, turn_id: turnId }),
        remove: (agentId, inboxSeq) => this.command('inbox.remove', { id: agentId, inbox_seq: inboxSeq }),
    };
    rename(title) { return this.command('session.rename', { title }); }
    archive(archived) { return this.command('session.archive', { archived }); }
    fork(params) { return this.command('session.fork', params); }
    delete() { return this.client.sessions.delete(this.rootId); }
    snapshot(options = {}) { return this.client.call('root.snapshot', { root_id: this.rootId }, options); }
    configure(params) { return this.command('run.configure', params); }
    setModel(model, provider = '', persistDefault = false) { return this.command('session.model', { model, provider, persist_default: persistDefault }); }
    setEffort(effort, persistDefault = false) { return this.command('session.effort', { effort, persist_default: persistDefault }); }
    /** externalPermissions = prompt connected clients; false = approve automatically. */
    setPermissionMode(externalPermissions) { return this.command('permission.mode', { external_permissions: externalPermissions }); }
    cancelTurn(turnId) { return this.command('cancel', { turn_id: turnId }); }
    /** Reload this session's MCP configuration from its execution host. */
    mcp = {
        refresh: (options = {}) => this.command('mcp.refresh', {}, options),
    };
    history = {
        page: (params = {}, options = {}) => this.client.call('history.page', {
            root_id: this.rootId, agent_id: this.rootId, through_seq: -1, limit: 128, max_bytes: 512 << 10, recent: true, ...params,
        }, options),
        clear: (expectedRevision) => this.command('history.clear', expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
        rewind: (cut, expectedRevision) => this.command('history.rewind', { cut, expected_revision: expectedRevision }),
        compact: () => this.command('history.compact', {}),
    };
    agents = {
        list: (options = {}) => this.query('agents.list', {}, options),
        inspect: (id, options = {}) => this.query('agent.transcript', { id }, options),
        submit: (id, input, delivery = 'queued') => this.command('agent.submit', { id, ...(typeof input === 'string' ? { text: input } : input), delivery }),
        cancelTurn: (id, turnId) => this.command('agent.turn.cancel', { id, turn_id: turnId }),
        control: (id) => this.command('agent.control', { id }),
        delete: (id) => this.command('agent.delete', { id }),
    };
    /** Human inspection does not acknowledge, deliver, or complete agent mail. */
    mailbox = {
        list: (params = {}, options = {}) => this.client.call('mailbox.list', {
            root_id: this.rootId, agent_id: this.rootId, limit: 64, max_bytes: 256 << 10, ...params,
        }, options),
        read: (id, agentId = this.rootId, options = {}) => this.client.call('mailbox.read', {
            root_id: this.rootId, agent_id: agentId, id,
        }, options),
    };
    answerQuestion(id, answer, dismissed = false) { return this.command('question.answer', { id, answer, dismissed }); }
    /** Answer a batched user.ask: one entry per question, null for skipped. */
    answerQuestions(id, answers) {
        return this.command('question.answer', {
            id, answer: [], dismissed: false,
            answers: answers.map((entry) => ({ answer: entry?.answer ?? [], dismissed: entry?.dismissed ?? !entry?.answer?.length })),
        });
    }
    terminalInput(id, bytes, options = {}) {
        return this.invoke('terminal.input', { id, bytes: encodeBase64(bytes) }, options);
    }
}
export class Sessions {
    client;
    constructor(client) {
        this.client = client;
    }
    create(params, options = {}) {
        return this.client.submit('session.create', { kind: 'agent', model: '', provider: '', ...params }, options);
    }
    list(params = {}, options = {}) { return this.client.call('sessions.list', { limit: 128, max_bytes: 512 << 10, ...params }, options); }
    /** Full metadata for one root, without opening its transcript or a subscription. */
    get(rootId, options = {}) { return this.client.call('sessions.get', { root_id: rootId }, options); }
    /** Advisory metadata for up to 32 roots, without opening their views. Check missing before using counts. */
    summaries(rootIds, options = {}) { return this.client.call('sessions.summaries', { root_ids: [...rootIds] }, options); }
    open(rootId, options = {}) { return this.client.query('session.open', { id: rootId }, options); }
    delete(rootId, options = {}) { return this.client.submit('session.delete', { root_id: rootId }, options); }
}
//# sourceMappingURL=session.js.map