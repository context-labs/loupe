import type { CreateSessionParams, DefinitionList, SubmitPayload, DefinitionRecord, DefinitionRegisterParams, DefinitionRegisterResult, HookInvokeParams } from '@whip/protocol';
import type { CallOptions, WhipClient } from './client.js';
import type { CommandOptions } from './command.js';
import { Session } from './session.js';
import { Turn, type RunOptions } from './turn.js';
import { type InferInput, type InferOutput, type Schema } from './schema.js';
export type { InferInput, InferOutput, JsonSchema, Schema, StandardSchemaWithJSON } from './schema.js';
/** The wire document the daemon validates and stores. Generated from the Go definition. */
export type Definition = DefinitionRegisterParams['definition'];
export type ToolSpec = NonNullable<Definition['tools']>[number];
export type ChildDefinition = Definition['children'][string];
/** Context handed to a tool handler for one invocation. */
export interface ToolContext {
    /** The daemon's ledger operation id; reuse it to make side effects idempotent. */
    readonly invocationId: string;
    readonly rootId: string;
    readonly agentId: string;
    readonly turnId: string;
    /** Unix milliseconds after which the daemon settles the call as timed out. */
    readonly deadline: number;
    /** Aborted on cancellation, deadline, executor close, or disconnect. */
    readonly signal: AbortSignal;
    /** Report intermediate output; the daemon streams it to the session. */
    progress(text: string): void;
}
/** What execute must return: the output schema's type when one is declared, otherwise anything JSON. */
export type ToolReturn<O> = O extends Schema ? InferOutput<O> : unknown;
export type ToolHandler<I extends Schema = Schema, O extends Schema | undefined = Schema | undefined> = (input: InferInput<I>, context: ToolContext) => ToolReturn<O> | Promise<ToolReturn<O>>;
export interface ToolOptions<I extends Schema, O extends Schema | undefined = undefined> {
    /** Lowercase identifier; the cell calls tools.<name>. */
    name: string;
    description: string;
    /** Keyword arguments the cell passes. A Standard JSON Schema (zod, ArkType, Valibot) infers the handler's input type; raw JSON Schema types it unknown. */
    input: I;
    /** What execute returns. Typed at compile time and validated locally before the result is posted. */
    output?: O;
    execute(input: InferInput<I>, context: ToolContext): ToolReturn<O> | Promise<ToolReturn<O>>;
    /** Default 5 minutes, ceiling 15. */
    timeoutMs?: number;
    /** Run the schemas' own validation around execute (default true); raw JSON Schema has none. */
    validate?: boolean;
}
export interface ToolDefinition<I extends Schema = Schema, O extends Schema | undefined = Schema | undefined> {
    readonly spec: ToolSpec;
    readonly input: I;
    readonly output: O | undefined;
    readonly validate: boolean;
    execute(input: InferInput<I>, context: ToolContext): ToolReturn<O> | Promise<ToolReturn<O>>;
}
/** Wire shapes a before_spawn hook sees: the request as the model wrote it and what it resolved to. */
export type SpawnRequest = NonNullable<HookInvokeParams['spawn']>['request'];
export type ResolvedChild = NonNullable<HookInvokeParams['spawn']>['resolved'];
export type HookName = 'before_tool' | 'before_spawn' | 'turn_start';
/** Identity every hook event carries. */
export interface HookContext {
    readonly invocationId: string;
    readonly rootId: string;
    readonly agentId: string;
    readonly turnId: string;
    /** The session's permission mode; hooks only narrow it. */
    readonly permissionMode: string;
    /** Unix milliseconds after which the daemon applies the hook's required or optional rule. */
    readonly deadline: number;
    /** Aborted on cancellation, deadline, executor close, or disconnect. */
    readonly signal: AbortSignal;
}
export interface BeforeToolEvent extends HookContext {
    /** module.operation, such as shell.run or tools.lookup_ticket. */
    readonly operation: string;
    readonly arguments: Record<string, unknown>;
}
/** Every field is optional; returning nothing allows the operation unchanged. */
export interface BeforeToolResult {
    decision?: 'allow' | 'deny';
    reason?: string;
    arguments?: Record<string, unknown>;
}
export interface BeforeSpawnEvent extends HookContext {
    readonly spawn: SpawnRequest;
    readonly resolved: ResolvedChild;
}
export interface BeforeSpawnResult {
    decision?: 'allow' | 'deny';
    reason?: string;
    spawn?: SpawnRequest;
}
export interface TurnStartEvent extends HookContext {
    readonly input: string;
}
export interface TurnStartResult {
    context?: string;
}
export type HookHandler<E, R> = (event: E) => Promise<R | void> | R | void;
export interface HookOptions {
    /** Proceed with a notice when unanswered or failing, instead of denying. */
    optional?: boolean;
    /** Default 30 seconds, ceiling 60. */
    timeoutMs?: number;
}
export interface HooksInput {
    /** Runs before every host operation the agent's cells call; `operations` narrows it to module.operation names. */
    beforeTool?: HookHandler<BeforeToolEvent, BeforeToolResult> | (HookOptions & {
        handler: HookHandler<BeforeToolEvent, BeforeToolResult>;
        operations?: string[];
    });
    /** Runs after a spawn request is parsed and resolved, before the child is admitted. */
    beforeSpawn?: HookHandler<BeforeSpawnEvent, BeforeSpawnResult> | (HookOptions & {
        handler: HookHandler<BeforeSpawnEvent, BeforeSpawnResult>;
    });
    /** Contributes ephemeral context to each turn; it never gates. */
    turnStart?: HookHandler<TurnStartEvent, TurnStartResult> | (HookOptions & {
        handler: HookHandler<TurnStartEvent, TurnStartResult>;
    });
}
export interface HookHandlers {
    readonly before_tool?: HookHandler<BeforeToolEvent, BeforeToolResult>;
    readonly before_spawn?: HookHandler<BeforeSpawnEvent, BeforeSpawnResult>;
    readonly turn_start?: HookHandler<TurnStartEvent, TurnStartResult>;
}
export interface InstructionsInput {
    persona?: string;
    rules?: string;
    /** Project instruction files read along the authorized directory chain. Omit to disable discovery. */
    projectFiles?: string[];
    skillDiscovery?: boolean;
    standingInstructions?: boolean;
}
export interface ModelInput {
    model?: string;
    provider?: string;
    effort?: string;
}
export interface CompactionInput {
    model?: string;
    provider?: string;
    threshold?: number;
}
export interface ChildInput {
    instructions?: InstructionsInput;
    modules?: string[];
    capabilities?: string[];
    tools?: string[];
    model?: ModelInput;
    budgets?: Record<string, number>;
    report?: 'notice' | 'inline' | 'message';
    /** Replaces the parent's output contract for this child. */
    output?: Schema;
}
/** The turn result type an agent's output contract implies: the schema's type, or unknown without one. */
export type AgentOutput<O> = O extends Schema ? InferOutput<O> : unknown;
export interface AgentInput<O extends Schema | undefined = undefined> {
    /** Lowercase id, letters, digits and hyphens; must not shadow a built-in. */
    id: string;
    instructions?: InstructionsInput;
    /** Built-in host modules the model may call. */
    modules: string[];
    capabilities?: string[];
    model?: ModelInput;
    compaction?: CompactionInput;
    /** Named MCP servers from host configuration; omit for every configured server. Requires the mcp capability. */
    mcp?: {
        servers?: string[];
    };
    tools?: readonly ToolDefinition[];
    children?: Record<string, ChildInput>;
    surface?: {
        autoTitle?: boolean;
        goalLoop?: boolean;
    };
    hooks?: HooksInput;
    /** What a turn returns: an object schema the daemon enforces on the final message. It types the turn result. */
    output?: O;
}
/** An authored agent: the document the daemon stores plus the tools and hooks an executor serves. */
export interface AgentDefinition<Output = unknown> {
    readonly document: Definition;
    /** Tool definitions by name; serve runs their execute and validates around it. */
    readonly handlers: ReadonlyMap<string, ToolDefinition>;
    readonly hooks: HookHandlers;
    /** Carries the output contract's type; never set at runtime. */
    readonly outputType?: Output;
}
/**
 * Declare one custom tool. The input schema's JSON Schema goes to the daemon,
 * which validates every call against it before the handler runs; the output
 * schema types execute's return and is checked before the result is posted.
 */
export declare function tool<I extends Schema, O extends Schema | undefined = undefined>(options: ToolOptions<I, O>): ToolDefinition<I, O>;
/**
 * Build the canonical definition document from authoring input. The daemon is
 * the authority on validation; this only rejects shapes that cannot be sent.
 */
export declare function defineAgent<O extends Schema | undefined = undefined>(input: AgentInput<O>): AgentDefinition<AgentOutput<O>>;
export interface ServeOptions {
    signal?: AbortSignal;
}
/** Session creation on a served definition; the definition and its revision come from the runtime. */
export type RuntimeSessionParams = Pick<CreateSessionParams, 'cwd'> & Partial<Omit<CreateSessionParams, 'cwd' | 'definition' | 'kind'>>;
/** A session on a served definition: run() returns a turn typed by the agent's output contract. */
export declare class AgentSession<Output = unknown> extends Session {
    run(input: string | SubmitPayload, options?: RunOptions): Turn<Output>;
}
/**
 * A served agent: this process answers its tools and hooks for one definition
 * revision, and the sessions created here pin that revision, so a runtime
 * never drives a session whose tools it does not serve.
 */
export interface AgentRuntime<Output = unknown> {
    readonly definition: string;
    readonly revision: string;
    /** Current lease generation; a reconnect re-binds and changes it. */
    readonly generation: string;
    /** Tool and hook handlers currently running. */
    readonly active: number;
    readonly sessions: {
        /** Create a session on this definition and return it once the daemon has admitted it and it pins this revision. */
        create(params: RuntimeSessionParams, options?: CommandOptions): Promise<AgentSession<Output>>;
        /** Open an existing session after checking that it pins this definition and revision. */
        open(rootId: string, options?: CallOptions): Promise<AgentSession<Output>>;
    };
    /** Stop serving. Running handlers are aborted; later invocations fail fast. Sessions outlive the runtime. */
    close(): void;
    /** Settles when serving stops. */
    readonly done: Promise<void>;
}
/** The pre-runtime name; kept as an alias for one release. */
export type Executor = AgentRuntime;
/** Registry operations. Registration is idempotent on content: the same document yields the same revision. */
export declare class Agents {
    private readonly client;
    constructor(client: WhipClient);
    /**
     * Register the agent, bind this connection as its executor, and run its tool
     * handlers until close(). Bind before creating sessions: a tool call with no
     * executor fails after a short wait. The executor re-binds after a reconnect
     * and drains invocations that were pending for it.
     */
    serve<Output>(agent: AgentDefinition<Output>, options?: ServeOptions): Promise<AgentRuntime<Output>>;
    register(agent: AgentDefinition | Definition, options?: CallOptions): Promise<DefinitionRegisterResult>;
    get(id: string, revision?: string, options?: CallOptions): Promise<DefinitionRecord>;
    list(options?: CallOptions): Promise<DefinitionList>;
}
