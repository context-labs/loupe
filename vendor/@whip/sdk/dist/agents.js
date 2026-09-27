import { Session } from './session.js';
import { Turn } from './turn.js';
import { WhipError, abortError, asError } from './errors.js';
import { describesObject, formatIssues, isStandardSchema, toJsonSchema, validateWith } from './schema.js';
/**
 * Declare one custom tool. The input schema's JSON Schema goes to the daemon,
 * which validates every call against it before the handler runs; the output
 * schema types execute's return and is checked before the result is posted.
 */
export function tool(options) {
    const { name, description, input, output, execute, timeoutMs, validate = true } = options;
    if (typeof name !== 'string' || !name.trim())
        throw new TypeError('tool name is required');
    if (typeof description !== 'string')
        throw new TypeError(`tool ${name}: description is required`);
    if (typeof execute !== 'function')
        throw new TypeError(`tool ${name}: execute is required`);
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0))
        throw new TypeError(`tool ${name}: timeoutMs must be a non-negative integer`);
    const inputSchema = toJsonSchema(input, 'input', `tool ${name} input`);
    if (!describesObject(inputSchema))
        throw new TypeError(`tool ${name}: input schema must describe an object; the cell passes keyword arguments`);
    const outputSchema = output === undefined ? null : toJsonSchema(output, 'output', `tool ${name} output`);
    return { spec: { name, description, input_schema: inputSchema, output_schema: outputSchema, timeout_millis: timeoutMs ?? 0 }, input, output, validate, execute };
}
/**
 * Build the canonical definition document from authoring input. The daemon is
 * the authority on validation; this only rejects shapes that cannot be sent.
 */
export function defineAgent(input) {
    if (!input.id.trim())
        throw new TypeError('agent id is required');
    const contract = (schema, subject) => {
        if (schema === undefined)
            return null;
        const derived = toJsonSchema(schema, 'output', subject);
        if (!describesObject(derived))
            throw new TypeError(`${subject}: output contract must describe an object`);
        return derived;
    };
    if (!Array.isArray(input.modules) || input.modules.length === 0)
        throw new TypeError(`agent ${input.id}: select at least one host module`);
    const handlers = new Map();
    const tools = [];
    for (const definition of input.tools ?? []) {
        if (handlers.has(definition.spec.name))
            throw new TypeError(`agent ${input.id}: tool ${definition.spec.name} is declared twice`);
        handlers.set(definition.spec.name, definition);
        tools.push(definition.spec);
    }
    const children = {};
    for (const [name, child] of Object.entries(input.children ?? {})) {
        children[name] = {
            instructions: child.instructions ? instructions(child.instructions) : null,
            modules: list(child.modules), capabilities: list(child.capabilities), tools: list(child.tools),
            model: model(child.model), budgets: { ...(child.budgets ?? {}) }, report: child.report ?? '',
            output: contract(child.output, `agent ${input.id} child ${name} output`),
        };
    }
    const hooks = {};
    const hookSpecs = { before_tool: null, before_spawn: null, turn_start: null };
    const declare = (name, value) => {
        if (!value)
            return;
        const options = typeof value === 'function' ? {} : value;
        const handler = typeof value === 'function' ? value : value.handler;
        if (typeof handler !== 'function')
            throw new TypeError(`agent ${input.id}: hook ${name} needs a handler`);
        if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0))
            throw new TypeError(`agent ${input.id}: hook ${name} timeoutMs must be a non-negative integer`);
        if (options.operations !== undefined && name !== 'before_tool')
            throw new TypeError(`agent ${input.id}: only before_tool accepts operations`);
        hooks[name] = handler;
        hookSpecs[name] = { operations: list(options.operations), optional: options.optional ?? false, timeout_millis: options.timeoutMs ?? 0 };
    };
    declare('before_tool', input.hooks?.beforeTool);
    declare('before_spawn', input.hooks?.beforeSpawn);
    declare('turn_start', input.hooks?.turnStart);
    const document = {
        id: input.id,
        instructions: instructions(input.instructions ?? {}),
        modules: [...input.modules],
        capabilities: list(input.capabilities),
        model: model(input.model),
        compaction: { model: input.compaction?.model ?? '', provider: input.compaction?.provider ?? '', threshold: input.compaction?.threshold ?? 0 },
        // The daemon distinguishes null (every host server) from [] (no servers);
        // an explicit empty allowlist must not widen to everything.
        mcp: { servers: input.mcp?.servers === undefined ? null : [...input.mcp.servers] },
        tools: tools.length > 0 ? tools : null,
        output: contract(input.output, `agent ${input.id} output`),
        children,
        surface: { auto_title: input.surface?.autoTitle ?? true, goal_loop: input.surface?.goalLoop ?? false },
        hooks: Object.keys(hooks).length > 0 ? hookSpecs : null,
    };
    return { document: Object.freeze(document), handlers, hooks: Object.freeze(hooks) };
}
/** Turn a handler's return value into the optional-field hook reply. */
function hookReply(result) {
    if (!result || typeof result !== 'object')
        return {};
    const value = result;
    const reply = {};
    if (value.decision)
        reply.decision = value.decision;
    if (value.reason)
        reply.reason = value.reason;
    if (value.arguments)
        reply.arguments = value.arguments;
    if (value.spawn)
        reply.spawn = value.spawn;
    if (value.context)
        reply.context = value.context;
    return reply;
}
function instructions(input) {
    return {
        persona: input.persona ?? '', rules: input.rules ?? '', project_files: list(input.projectFiles),
        skill_discovery: input.skillDiscovery ?? false, standing_instructions: input.standingInstructions ?? false,
    };
}
function model(input) {
    return { model: input?.model ?? '', provider: input?.provider ?? '', effort: input?.effort ?? '' };
}
/** Absent or empty lists are null in the canonical document. */
function list(values) {
    return values && values.length > 0 ? [...values] : null;
}
/** A session on a served definition: run() returns a turn typed by the agent's output contract. */
export class AgentSession extends Session {
    run(input, options = {}) {
        return new Turn(this, typeof input === 'string' ? { text: input } : input, options);
    }
}
/** Registry operations. Registration is idempotent on content: the same document yields the same revision. */
export class Agents {
    client;
    constructor(client) {
        this.client = client;
    }
    /**
     * Register the agent, bind this connection as its executor, and run its tool
     * handlers until close(). Bind before creating sessions: a tool call with no
     * executor fails after a short wait. The executor re-binds after a reconnect
     * and drains invocations that were pending for it.
     */
    async serve(agent, options = {}) {
        const hookNames = ['before_tool', 'before_spawn', 'turn_start'].filter(name => agent.hooks?.[name]);
        if (agent.handlers.size === 0 && hookNames.length === 0)
            throw new TypeError(`agent ${agent.document.id} declares no tools or hooks to serve`);
        options.signal?.throwIfAborted();
        const client = this.client;
        const registered = await this.register(agent, options);
        const definition = agent.document.id;
        const revision = registered.revision;
        const tools = [...agent.handlers.keys()];
        const running = new Map();
        let generation = '';
        let closed = false;
        let resolveDone;
        const done = new Promise(resolve => { resolveDone = resolve; });
        const bind = async () => {
            const lease = await client.call('executor.bind', { definition, revision, tools, ...(hookNames.length > 0 ? { hooks: hookNames } : {}) }, options);
            generation = lease.generation;
        };
        const settleHook = async (invocation, body) => {
            try {
                await client.call('hook.result', { invocation_id: invocation.invocation_id, generation: invocation.generation, ...body });
            }
            catch { /* the lease moved or the hook already settled; the daemon's rule applies */ }
        };
        const runHook = async (invocation) => {
            if (closed) {
                await settleHook(invocation, { error: 'executor closed' });
                return;
            }
            const handler = agent.hooks?.[invocation.hook];
            if (!handler) {
                await settleHook(invocation, { error: `no handler for hook ${invocation.hook}` });
                return;
            }
            const controller = new AbortController();
            running.set(invocation.invocation_id, controller);
            const deadline = Number(invocation.deadline_millis);
            const timer = setTimeout(() => controller.abort(new WhipError('timeout', 'Hook deadline passed')), Math.max(0, deadline - Date.now()));
            const context = {
                invocationId: invocation.invocation_id, rootId: invocation.root_id, agentId: invocation.agent_id, turnId: invocation.turn_id,
                permissionMode: invocation.permission_mode, deadline, signal: controller.signal,
            };
            try {
                let event;
                if (invocation.hook === 'before_tool')
                    event = { ...context, operation: invocation.operation ?? '', arguments: (invocation.arguments ?? {}) };
                else if (invocation.hook === 'before_spawn')
                    event = { ...context, spawn: invocation.spawn.request, resolved: invocation.spawn.resolved };
                else
                    event = { ...context, input: invocation.input ?? '' };
                const result = await handler(event);
                if (!controller.signal.aborted)
                    await settleHook(invocation, hookReply(result));
            }
            catch (error) {
                if (!controller.signal.aborted)
                    await settleHook(invocation, { error: asError(error).message || 'hook failed' });
            }
            finally {
                clearTimeout(timer);
                running.delete(invocation.invocation_id);
            }
        };
        const settle = async (invocation, body) => {
            try {
                await client.call('tool.result', { invocation_id: invocation.invocation_id, generation: invocation.generation, ...body });
            }
            catch { /* the lease moved or the call already settled; the daemon's record wins */ }
        };
        const run = async (invocation) => {
            if (closed) {
                await settle(invocation, { error: 'executor closed' });
                return;
            }
            const definition = agent.handlers.get(invocation.tool);
            if (!definition) {
                await settle(invocation, { error: `no handler for tool ${invocation.tool}` });
                return;
            }
            const controller = new AbortController();
            running.set(invocation.invocation_id, controller);
            const deadline = Number(invocation.deadline_millis);
            const timer = setTimeout(() => controller.abort(new WhipError('timeout', 'Tool deadline passed')), Math.max(0, deadline - Date.now()));
            // The daemon handles requests concurrently, so progress reports are
            // sent one at a time, each acknowledged before the next, and the result
            // is posted only after the last report landed. Order is preserved and no
            // report arrives after the result and gets rejected as late.
            let reports = Promise.resolve();
            const context = {
                invocationId: invocation.invocation_id, rootId: invocation.root_id, agentId: invocation.agent_id, turnId: invocation.turn_id,
                deadline, signal: controller.signal,
                progress: text => {
                    if (controller.signal.aborted)
                        return;
                    reports = reports.then(() => client.call('tool.progress', { invocation_id: invocation.invocation_id, generation: invocation.generation, text })).catch(() => { });
                },
            };
            try {
                // The daemon validated the input against the same JSON Schema; the
                // library's own check adds refinements the schema cannot express and
                // applies its defaults and transforms.
                let input = invocation.input ?? {};
                if (definition.validate && isStandardSchema(definition.input)) {
                    const checked = await validateWith(definition.input, input);
                    if (checked.issues) {
                        await settle(invocation, { error: `tool ${invocation.tool} rejected its input: ${formatIssues(checked.issues)}` });
                        return;
                    }
                    input = checked.value;
                }
                let output = await definition.execute(input, context);
                if (definition.validate && isStandardSchema(definition.output)) {
                    const checked = await validateWith(definition.output, output);
                    if (checked.issues) {
                        await reports;
                        if (!controller.signal.aborted)
                            await settle(invocation, { error: `tool ${invocation.tool} returned a value that does not match its output schema (the handler already ran): ${formatIssues(checked.issues)}` });
                        return;
                    }
                    output = checked.value;
                }
                await reports;
                if (!controller.signal.aborted)
                    await settle(invocation, { output: output === undefined ? null : output });
            }
            catch (error) {
                await reports;
                if (!controller.signal.aborted)
                    await settle(invocation, { error: asError(error).message || 'tool failed' });
            }
            finally {
                clearTimeout(timer);
                running.delete(invocation.invocation_id);
            }
        };
        const abortAll = (reason) => { for (const controller of [...running.values()])
            controller.abort(reason); running.clear(); };
        // The invoke listener outlives close(): the daemon keeps routing to this
        // connection's lease until it drops, and a fast "executor closed" beats a
        // five-minute timeout. Only the lease this executor last held is answered.
        client.onNotification('tool.invoke', invocation => {
            if (invocation.definition !== definition || invocation.revision !== revision || invocation.generation !== generation)
                return;
            void run(invocation);
        });
        client.onNotification('hook.invoke', invocation => {
            if (invocation.definition !== definition || invocation.revision !== revision || invocation.generation !== generation)
                return;
            void runHook(invocation);
        });
        const cancelled = (cancel) => { running.get(cancel.invocation_id)?.abort(new WhipError('cancelled', `Invocation cancelled: ${cancel.reason}`)); };
        const unsubscribe = [client.onNotification('tool.cancel', cancelled), client.onNotification('hook.cancel', cancelled)];
        // After a reconnect the daemon has dropped this lease and failed its calls;
        // bind again and drain anything still addressed to the new lease.
        let connected = true;
        unsubscribe.push(client.subscribe(() => {
            const state = client.getSnapshot().state;
            if (state === 'closed' || state === 'incompatible') {
                close();
                return;
            }
            if (state !== 'connected') {
                if (connected) {
                    connected = false;
                    abortAll(new WhipError('disconnected', 'Executor connection lost'));
                }
                return;
            }
            if (connected || closed)
                return;
            connected = true;
            void bind().then(() => client.call('executor.pending', { definition, revision, generation: generation }))
                .then(pending => {
                for (const invocation of pending.invocations ?? [])
                    void run(invocation);
                for (const invocation of pending.hooks ?? [])
                    void runHook(invocation);
            })
                .catch(() => { });
        }));
        const close = () => {
            if (closed)
                return;
            closed = true;
            for (const stop of unsubscribe)
                stop();
            abortAll(new WhipError('closed', 'Executor closed'));
            resolveDone();
        };
        options.signal?.addEventListener('abort', close, { once: true });
        try {
            await bind();
        }
        catch (error) {
            close();
            throw error;
        }
        if (options.signal?.aborted) {
            close();
            throw abortError(options.signal);
        }
        // Creation resolves the definition's latest revision; a registration that
        // raced ahead would leave the session pinned to tools this process does
        // not serve, so both paths read the pin back before handing out a session.
        const pinned = async (session, callOptions = {}) => {
            const snapshot = await session.snapshot(callOptions);
            if (snapshot.meta.definition !== definition || snapshot.meta.definition_revision !== revision) {
                throw new WhipError('conflict', `session ${session.rootId} runs ${snapshot.meta.definition || 'coding'}@${snapshot.meta.definition_revision.slice(0, 12) || 'built-in'}, not ${definition}@${revision.slice(0, 12)} served here`);
            }
            return session;
        };
        const sessions = {
            create: async (params, commandOptions = {}) => {
                const outcome = await client.sessions.create({ ...params, definition }, commandOptions).result();
                if (outcome.status !== 'succeeded' || !outcome.result)
                    throw new WhipError('execution_failed', `session creation ${outcome.status}: ${outcome.failure?.message ?? 'no root was returned'}`, { cause: outcome.failure ?? undefined });
                return pinned(new AgentSession(client, outcome.result.root_id));
            },
            open: (rootId, callOptions = {}) => pinned(new AgentSession(client, rootId), callOptions),
        };
        return { definition, revision, get generation() { return generation; }, get active() { return running.size; }, sessions, close, done };
    }
    register(agent, options = {}) {
        const definition = 'document' in agent ? agent.document : agent;
        return this.client.call('definitions.register', { definition }, options);
    }
    get(id, revision, options = {}) {
        const params = revision ? { id, revision } : { id };
        return this.client.call('definitions.get', params, options);
    }
    list(options = {}) {
        return this.client.call('definitions.list', {}, options);
    }
}
//# sourceMappingURL=agents.js.map