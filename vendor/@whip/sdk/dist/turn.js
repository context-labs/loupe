import { DeliveryUncertainError, WhipError, abortError, asError } from './errors.js';
import { executionCode } from './executions.js';
import { object } from './util.js';
const text = (value) => typeof value === 'string' ? value : '';
/** Build a question event whose reply methods post through the session exactly once. */
export function questionEvent(session, base, payload) {
    const id = text(payload.question_id);
    let posted;
    const post = (answers, dismissed) => posted ??= (async () => {
        const batched = answers.some(entry => entry === null || typeof entry === 'object');
        const handle = batched
            ? session.answerQuestions(id, answers.map(entry => entry ? { answer: [...entry.answer], dismissed: entry.dismissed } : null))
            : session.answerQuestion(id, [...answers], dismissed);
        const outcome = await handle.result();
        if (outcome.status !== 'succeeded')
            throw new WhipError(outcome.failure?.data?.kind ?? 'execution_failed', outcome.failure?.message ?? `question answer ${outcome.status}`, { cause: outcome.failure ?? undefined });
    })();
    return {
        ...base, type: 'question', id, question: text(payload.question), options: Array.isArray(payload.options) ? payload.options : [], multiple: payload.multiple === true,
        ...(Array.isArray(payload.questions) && payload.questions.length > 0 ? { questions: payload.questions } : {}),
        answer: answers => post(answers, false),
        dismiss: () => post([], true),
    };
}
/** Build a permission event whose decision methods post through the client exactly once. */
export function permissionEvent(session, base, payload) {
    const id = text(payload.permission_id) || text(payload.id);
    let posted;
    const post = (allow, extra) => posted ??= (async () => {
        await session.client.permissions.decide({ root_id: session.rootId, permission_id: id, allow, ...extra });
    })();
    return {
        ...base, type: 'permission', id, operation: text(payload.operation), command: text(payload.command), rule: text(payload.rule), path: text(payload.canonical_path),
        allow: (options = {}) => post(true, options.remember ? { remember: options.remember } : {}),
        deny: reason => post(false, reason ? { reason } : {}),
    };
}
const childKinds = ['agent.admitted', 'agent.turn.started', 'agent.turn.succeeded', 'agent.turn.failed', 'agent.turn.cancelled', 'agent.turn.interrupted', 'agent.subtree.stopped', 'agent.subtree.deleted', 'agent.prompt.queued'];
const endKinds = { 'turn.succeeded': 'succeeded', 'turn.failed': 'failed', 'turn.cancelled': 'cancelled', 'turn.interrupted': 'interrupted' };
/**
 * One root turn: the submit command plus every event the daemon journals for
 * it, mapped to a small typed union. The subscription starts before the
 * command so nothing is missed; the turn is identified by the turn.started
 * whose inbox sequence is the command's ingress sequence. The command outcome
 * is authoritative; the event stream is best effort.
 */
export class Turn {
    session;
    payload;
    options;
    queue = [];
    queuedBytes = 0;
    waiter;
    iterableError;
    iterableClosed = false;
    subscription;
    command;
    started;
    pump;
    ended;
    resolveEnded;
    turnIdentity;
    resolveTurn;
    rejectTurn;
    children = new Set();
    accumulated = '';
    lastUsage;
    endStatus;
    /** Resolves once the daemon has started the turn; rejects when the command settles without one. */
    turnId;
    constructor(session, payload, options = {}) {
        this.session = session;
        this.payload = payload;
        this.options = options;
        this.turnId = new Promise((resolve, reject) => { this.resolveTurn = resolve; this.rejectTurn = reject; });
        void this.turnId.catch(() => { });
        this.ended = new Promise(resolve => { this.resolveEnded = resolve; });
        let resolveStarted;
        let rejectStarted;
        this.started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
        void this.started.catch(() => { });
        this.pump = this.begin(resolveStarted, rejectStarted).catch(error => { this.fail(asError(error)); });
        if (options.signal) {
            const abort = () => { void this.cancel().catch(() => { }); this.fail(abortError(options.signal)); };
            if (options.signal.aborted)
                abort();
            else
                options.signal.addEventListener('abort', abort, { once: true });
        }
    }
    async begin(resolveStarted, rejectStarted) {
        const { session } = this;
        let ingressSeq;
        try {
            const snapshot = await session.snapshot();
            this.subscription = await session.client.events.subscribe(session.rootId, snapshot.cursor, { maxMessages: this.options.maxMessages, maxBytes: this.options.maxBytes });
            this.command = session.submit(this.payload);
            resolveStarted(this.command);
            try {
                ingressSeq = (await this.command.accepted()).ingress_seq;
            }
            catch (error) {
                if (!(error instanceof DeliveryUncertainError))
                    throw error;
            }
        }
        catch (error) {
            rejectStarted(asError(error));
            throw error;
        }
        for await (const event of this.subscription) {
            const payload = object(event.payload) ? event.payload : {};
            const agentId = text(payload.agent_id);
            const eventTurn = text(payload.turn_id);
            if (this.turnIdentity === undefined) {
                // The turn whose inbox sequence is this command's ingress sequence; with acceptance unknown, the next root turn.
                if (event.kind === 'turn.started' && agentId === session.rootId && (ingressSeq === undefined || text(payload.inbox_seq) === ingressSeq)) {
                    this.turnIdentity = eventTurn;
                    this.resolveTurn(eventTurn);
                    this.push({ type: 'raw', event, seq: event.seq, agentId, turnId: eventTurn });
                }
                continue;
            }
            const isRoot = agentId === session.rootId;
            const child = childKinds.includes(event.kind) && agentId !== '' && !isRoot;
            if (event.kind === 'agent.admitted' && child)
                this.children.add(agentId);
            const belongs = eventTurn === this.turnIdentity || (eventTurn === '' && isRoot) || (this.children.has(agentId) && (child || this.options.includeChildren === true));
            if (!belongs)
                continue;
            const mapped = this.map(event, payload, agentId, eventTurn || this.turnIdentity, child);
            if (mapped)
                this.push(mapped);
            if (mapped?.type === 'end')
                break;
        }
        this.finish();
    }
    map(event, payload, agentId, turnId, child) {
        const base = { seq: event.seq, agentId, turnId };
        if (child)
            return { ...base, type: 'child', childId: agentId, kind: event.kind, status: text(payload.status) };
        const isRoot = agentId === this.session.rootId;
        switch (event.kind) {
            case 'stream.text':
                if (isRoot)
                    this.accumulated += text(payload.text);
                return { ...base, type: 'text', delta: text(payload.text) };
            case 'stream.reasoning': return { ...base, type: 'reasoning', delta: text(payload.text) };
            case 'stream.tool.call':
            case 'stream.tool.started':
            case 'stream.tool.output':
            case 'stream.tool.completed': {
                if (event.kind !== 'stream.tool.output' && payload.name !== 'rlm_exec')
                    return { ...base, type: 'raw', event };
                const id = text(payload.id);
                if (event.kind === 'stream.tool.call')
                    return { ...base, type: 'cell', id, status: 'called', code: executionCode(text(payload.args)) };
                if (event.kind === 'stream.tool.started')
                    return { ...base, type: 'cell', id, status: 'running', code: executionCode(text(payload.args)) };
                if (event.kind === 'stream.tool.output')
                    return { ...base, type: 'cell', id, status: 'running', output: text(payload.text) };
                return { ...base, type: 'cell', id, status: 'completed', result: text(payload.result) };
            }
            case 'stream.cell.host.started':
                return { ...base, type: 'host', id: text(payload.id), invocationId: text(payload.invocation_id), operation: text(payload.name), summary: text(payload.args), status: 'running' };
            case 'stream.cell.host': {
                const hostStatus = text(payload.host_status);
                const status = hostStatus === 'cancelled' ? 'cancelled' : hostStatus === 'failed' || text(payload.result) !== '' ? 'failed' : 'completed';
                return { ...base, type: 'host', id: text(payload.id), invocationId: text(payload.invocation_id), operation: text(payload.name), summary: text(payload.args), status, ...(text(payload.result) ? { error: text(payload.result) } : {}), duration: text(payload.text) };
            }
            case 'stream.tool.progress': return { ...base, type: 'progress', id: text(payload.id), operation: text(payload.name), text: text(payload.text) };
            case 'stream.hook.decision': return { ...base, type: 'hook', hook: text(payload.name), operation: text(payload.args), decision: text(payload.text), reason: text(payload.result) };
            case 'question.pending': return questionEvent(this.session, base, payload);
            case 'permission.pending': return permissionEvent(this.session, base, payload);
            case 'stream.notice': return { ...base, type: 'notice', text: text(payload.text) };
            case 'stream.discard':
                if (isRoot)
                    this.accumulated = '';
                return { ...base, type: 'discard', discarded: Number(text(payload.text)) || 0 };
            case 'stream.usage': {
                if (!object(payload.usage))
                    return { ...base, type: 'raw', event };
                const usage = payload.usage;
                if (isRoot)
                    this.lastUsage = usage;
                return { ...base, type: 'usage', usage };
            }
            default: {
                const status = endKinds[event.kind];
                if (status && isRoot) {
                    this.endStatus = status;
                    return { ...base, type: 'end', status, ...(text(payload.error) ? { error: text(payload.error) } : {}) };
                }
                return { ...base, type: 'raw', event };
            }
        }
    }
    push(event) {
        if (this.iterableClosed || this.iterableError)
            return;
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = undefined;
            waiter.resolve({ done: false, value: event });
            return;
        }
        const bytes = JSON.stringify(event).length;
        if (this.queue.length >= (this.options.maxMessages ?? 1024) || this.queuedBytes + bytes > (this.options.maxBytes ?? 8 << 20)) {
            this.iterableError = new WhipError('resynchronization_required', 'Turn event consumer fell behind; the result still settles from the command');
            this.queue.length = 0;
            this.queuedBytes = 0;
            return;
        }
        this.queue.push(event);
        this.queuedBytes += bytes;
    }
    /** Ends iteration; the result still resolves from the command. */
    fail(error) {
        if (!this.iterableError && !this.iterableClosed) {
            this.iterableError = error;
            this.waiter?.reject(error);
            this.waiter = undefined;
        }
        if (this.turnIdentity === undefined)
            this.rejectTurn(error);
        void this.subscription?.dispose().catch(() => { });
        this.resolveEnded();
    }
    finish() {
        this.iterableClosed = true;
        this.waiter?.resolve({ done: true, value: undefined });
        this.waiter = undefined;
        if (this.turnIdentity === undefined)
            this.rejectTurn(new WhipError('execution_failed', 'The turn ended before it started'));
        void this.subscription?.dispose().catch(() => { });
        this.resolveEnded();
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => {
                const next = this.queue.shift();
                if (next) {
                    this.queuedBytes -= JSON.stringify(next).length;
                    return Promise.resolve({ done: false, value: next });
                }
                if (this.iterableError)
                    return Promise.reject(this.iterableError);
                if (this.iterableClosed)
                    return Promise.resolve({ done: true, value: undefined });
                if (this.waiter)
                    return Promise.reject(new WhipError('invalid_arguments', 'A turn supports one iterator consumer'));
                return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
            },
            return: async () => { this.iterableClosed = true; this.waiter = undefined; return { done: true, value: undefined }; },
        };
    }
    /** The command's terminal outcome, joined with the end event when the turn ran. */
    async result() {
        const command = await this.started;
        const outcome = await command.result({ signal: this.options.signal });
        if (this.turnIdentity !== undefined && !this.endStatus) {
            await Promise.race([this.ended, this.pump, new Promise(resolve => setTimeout(resolve, this.options.endTimeoutMs ?? 5_000))]);
        }
        // The command is the truth: once it has settled, nothing further can start
        // this turn, and an end event that has not arrived by now is not waited for.
        if (!this.iterableClosed && !this.iterableError)
            this.finish();
        const result = object(outcome.result) ? outcome.result : {};
        const usage = this.lastUsage ? { usage: this.lastUsage } : {};
        if (outcome.status === 'succeeded') {
            return { status: 'succeeded', turnId: this.turnIdentity ?? '', text: text(result.text) || this.accumulated, output: result.output, ...usage };
        }
        const status = outcome.status === 'cancelled' || outcome.status === 'interrupted' ? outcome.status : 'failed';
        const failure = outcome.failure ?? { code: -32000, message: `turn ${outcome.status}`, data: { kind: 'execution_failed' } };
        return { status, ...(this.turnIdentity !== undefined ? { turnId: this.turnIdentity } : {}), ...(this.accumulated ? { text: this.accumulated } : {}), failure, ...usage };
    }
    /** The final text, or a rejection carrying the failure. */
    async text() {
        const result = await this.result();
        if (result.status === 'succeeded')
            return result.text;
        throw new WhipError(result.failure.data?.kind ?? 'execution_failed', result.failure.message, { cause: result.failure });
    }
    /** Command-targeted cancellation; resolves once the daemon accepted it. */
    async cancel() {
        const command = await this.started;
        await command.cancel().accepted();
    }
}
//# sourceMappingURL=turn.js.map