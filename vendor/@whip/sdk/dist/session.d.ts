import type { CommandOperation, RuntimeOperations, QueryOperation, EphemeralOperation, CreateSessionParams, SessionCatalogParams, SubmitPayload, HistoryPageParams, MailboxPageParams } from '@whip/protocol';
import type { WhipClient, CallOptions } from './client.js';
import type { CommandOptions } from './command.js';
import { Turn, type PermissionEvent, type QuestionEvent, type RunOptions } from './turn.js';
/** Root-bound handle. Merely constructing it causes no I/O. */
export declare class Session {
    readonly client: WhipClient;
    readonly rootId: string;
    constructor(client: WhipClient, rootId: string);
    command<O extends CommandOperation>(operation: O, payload: RuntimeOperations[O]['params'], options?: Omit<CommandOptions, 'rootId'>): import("./command.js").CommandHandle<O>;
    query<O extends QueryOperation>(operation: O, payload: RuntimeOperations[O]['params'], options?: CallOptions): Promise<import("./client.js").QueryOutcome<O>>;
    invoke<O extends EphemeralOperation>(operation: O, payload: RuntimeOperations[O]['params'], options?: CallOptions): Promise<import("./client.js").QueryOutcome<O>>;
    submit(payload: SubmitPayload, options?: Omit<CommandOptions, 'rootId'>): import("./command.js").CommandHandle<"submit">;
    /** Submit one turn and observe it: an async iterable of typed events plus a typed result. */
    run(input: string | SubmitPayload, options?: RunOptions): Turn;
    /** The open questions and permission prompts from a fresh snapshot, with the same reply methods turn events carry. */
    prompts(options?: CallOptions): Promise<(QuestionEvent | PermissionEvent)[]>;
    steer(payload: SubmitPayload, options?: Omit<CommandOptions, 'rootId'>): import("./command.js").CommandHandle<"steer">;
    readonly inbox: {
        steer: (agentId: string, inboxSeq: string, turnId: string) => import("./command.js").CommandHandle<"inbox.steer">;
        remove: (agentId: string, inboxSeq: string) => import("./command.js").CommandHandle<"inbox.remove">;
    };
    rename(title: string): import("./command.js").CommandHandle<"session.rename">;
    archive(archived: boolean): import("./command.js").CommandHandle<"session.archive">;
    fork(params: RuntimeOperations['session.fork']['params']): import("./command.js").CommandHandle<"session.fork">;
    delete(): import("./command.js").CommandHandle<"session.delete">;
    snapshot(options?: CallOptions): Promise<import("@whip/protocol").RootSnapshot>;
    configure(params: RuntimeOperations['run.configure']['params']): import("./command.js").CommandHandle<"run.configure">;
    setModel(model: string, provider?: string, persistDefault?: boolean): import("./command.js").CommandHandle<"session.model">;
    setEffort(effort: string, persistDefault?: boolean): import("./command.js").CommandHandle<"session.effort">;
    /** externalPermissions = prompt connected clients; false = approve automatically. */
    setPermissionMode(externalPermissions: boolean): import("./command.js").CommandHandle<"permission.mode">;
    cancelTurn(turnId: string): import("./command.js").CommandHandle<"cancel">;
    /** Reload this session's MCP configuration from its execution host. */
    readonly mcp: {
        refresh: (options?: Omit<CommandOptions, "rootId">) => import("./command.js").CommandHandle<"mcp.refresh">;
    };
    readonly history: {
        page: (params?: Partial<Omit<HistoryPageParams, "root_id">>, options?: CallOptions) => Promise<import("@whip/protocol").BoundedTranscriptPage>;
        clear: (expectedRevision?: string) => import("./command.js").CommandHandle<"history.clear">;
        rewind: (cut: number, expectedRevision: string) => import("./command.js").CommandHandle<"history.rewind">;
        compact: () => import("./command.js").CommandHandle<"history.compact">;
    };
    readonly agents: {
        list: (options?: CallOptions) => Promise<import("./client.js").QueryOutcome<"agents.list">>;
        inspect: (id: string, options?: CallOptions) => Promise<import("./client.js").QueryOutcome<"agent.transcript">>;
        submit: (id: string, input: string | SubmitPayload, delivery?: string) => import("./command.js").CommandHandle<"agent.submit">;
        cancelTurn: (id: string, turnId: string) => import("./command.js").CommandHandle<"agent.turn.cancel">;
        control: (id: string) => import("./command.js").CommandHandle<"agent.control">;
        delete: (id: string) => import("./command.js").CommandHandle<"agent.delete">;
    };
    /** Human inspection does not acknowledge, deliver, or complete agent mail. */
    readonly mailbox: {
        list: (params?: Partial<Omit<MailboxPageParams, "root_id">>, options?: CallOptions) => Promise<import("@whip/protocol").MailboxPage>;
        read: (id: string, agentId?: string, options?: CallOptions) => Promise<import("@whip/protocol").MailboxInspection>;
    };
    answerQuestion(id: string, answer: string[], dismissed?: boolean): import("./command.js").CommandHandle<"question.answer">;
    /** Answer a batched user.ask: one entry per question, null for skipped. */
    answerQuestions(id: string, answers: ({
        answer: string[];
        dismissed?: boolean;
    } | null)[]): import("./command.js").CommandHandle<"question.answer">;
    terminalInput(id: string, bytes: Uint8Array, options?: CallOptions): Promise<import("./client.js").QueryOutcome<"terminal.input">>;
}
export declare class Sessions {
    private readonly client;
    constructor(client: WhipClient);
    create(params: Pick<CreateSessionParams, 'cwd'> & Partial<Omit<CreateSessionParams, 'cwd'>>, options?: CommandOptions): import("./command.js").CommandHandle<"session.create">;
    list(params?: Partial<SessionCatalogParams>, options?: CallOptions): Promise<import("@whip/protocol").SessionCatalogPage>;
    /** Full metadata for one root, without opening its transcript or a subscription. */
    get(rootId: string, options?: CallOptions): Promise<import("@whip/protocol").SessionMetadata>;
    /** Advisory metadata for up to 32 roots, without opening their views. Check missing before using counts. */
    summaries(rootIds: readonly string[], options?: CallOptions): Promise<import("@whip/protocol").SessionSummariesResult>;
    open(rootId: string, options?: CallOptions): Promise<import("./client.js").QueryOutcome<"session.open">>;
    delete(rootId: string, options?: Omit<CommandOptions, 'rootId'>): import("./command.js").CommandHandle<"session.delete">;
}
