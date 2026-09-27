import { type CommandResult, type ConfigurationUpdate, type HostAttentionParams, type HostDirectoryParams, type HostDirectoryPickParams, type MCPBrandIconsParams, type MCPImportApplyParams, type MCPImportCandidatesParams, type PermissionDecision, type PermissionDecisionResult, type ProviderCreateParams, type ProviderDisconnectParams, type ProviderKeySetup, type ProviderLoginBeginParams, type ProviderRemoveParams, type ProviderUpdateParams, type ProviderValidateParams } from '@whip/protocol';
import type { CallOptions, WhipClient } from './client.js';
import type { CommandOptions } from './command.js';
/** Host reads do not construct session actors or change client preferences. */
export declare class Host {
    private readonly client;
    constructor(client: WhipClient);
    directories(params?: Partial<HostDirectoryParams>, options?: CallOptions): Promise<import("@whip/protocol").HostDirectoryResult>;
    /** Opens the OS folder chooser on the execution host; rejects where the host has no desktop picker. */
    pickDirectory(params?: HostDirectoryPickParams, options?: CallOptions): Promise<import("@whip/protocol").HostDirectoryPickResult>;
    /** Advisory paged attention index. Refresh its first page to see newly active roots. */
    attention(params?: Partial<HostAttentionParams>, options?: CallOptions): Promise<import("@whip/protocol").HostAttentionResult>;
    readonly themes: {
        list: (options?: CallOptions) => Promise<import("@whip/protocol").CatalogResult>;
        resolve: (name: string, options?: CallOptions) => Promise<import("@whip/protocol").Resolved>;
        resolveJSON: (json: string, options?: CallOptions) => Promise<import("@whip/protocol").Resolved>;
    };
}
export type PermissionDecisionStatus = Pick<CommandResult, 'command_id' | 'ingress_seq'> & {
    operation: 'permission.decide';
} & ({
    status: 'queued' | 'running' | 'waiting';
    result?: never;
    failure?: never;
} | {
    status: 'succeeded';
    result: PermissionDecisionResult;
    failure?: never;
} | {
    status: 'failed' | 'cancelled' | 'interrupted';
    result?: never;
    failure: NonNullable<CommandResult['failure']>;
});
export declare class Permissions {
    private readonly client;
    constructor(client: WhipClient);
    /** A decision is sent once. After an uncertain reply, inspect pending state before retrying. */
    decide(decision: Omit<PermissionDecision, 'command_id'> & {
        command_id?: string;
    }, options?: CallOptions): Promise<PermissionDecisionResult>;
    /** Inspect the original client-scoped decision identity without resending it. */
    status(commandId: string, options?: CallOptions): Promise<PermissionDecisionStatus>;
    setMode(rootId: string, externalPermissions: boolean, options?: Pick<CommandOptions, 'commandId'>): import("./command.js").CommandHandle<"permission.mode">;
}
export declare class Configuration {
    private readonly client;
    constructor(client: WhipClient);
    get(options?: CallOptions): Promise<import("@whip/protocol").RuntimeConfiguration>;
    update(patch: ConfigurationUpdate, options?: CallOptions): Promise<import("@whip/protocol").RuntimeConfiguration>;
}
/** MCP servers other agents configured on the execution host, and the import that makes them native. */
export declare class MCPImport {
    private readonly client;
    constructor(client: WhipClient);
    /** Reads config files only: nothing is dialed or launched, and no candidate carries a secret. */
    candidates(params?: MCPImportCandidatesParams, options?: CallOptions): Promise<import("@whip/protocol").MCPImportCandidatesResult>;
    /** Copies the named candidates into the host's native configuration; an empty list only records that the offer was seen. */
    apply(params: MCPImportApplyParams, options?: CallOptions): Promise<import("@whip/protocol").MCPImportApplyResult>;
    /** Small data: URIs for registrable domains the app has no bundled mark for; empty when the host keeps lookups local. */
    brandIcons(params: MCPBrandIconsParams, options?: CallOptions): Promise<import("@whip/protocol").MCPBrandIconsResult>;
}
export declare class Providers {
    private readonly client;
    constructor(client: WhipClient);
    /** Persist missing routes using named keys on the execution host; never sends credential values. */
    discover({ model, provider, ...options }?: CallOptions & {
        model?: string;
        provider?: string;
    }): Promise<import("@whip/protocol").ProviderList>;
    list({ model, provider, ...options }?: CallOptions & {
        model?: string;
        provider?: string;
    }): Promise<import("@whip/protocol").ProviderList>;
    /** Read an execution host's editable definition without retrieving its secret. */
    get(provider: string, options?: CallOptions): Promise<import("@whip/protocol").ProviderConfiguration>;
    /** Sent once without recovery storage. After an uncertain result, reread the provider before retrying. */
    create(params: ProviderCreateParams, options?: CallOptions): Promise<import("@whip/protocol").ProviderConfiguration>;
    /** Omitted fields are retained; credentials remain host-owned and are never journaled. */
    update(params: ProviderUpdateParams, options?: CallOptions): Promise<import("@whip/protocol").ProviderConfiguration>;
    /** Remove an unreferenced custom definition using its current configuration revision. */
    remove(params: ProviderRemoveParams, options?: CallOptions): Promise<import("@whip/protocol").ProviderRemoveResult>;
    disconnect(params: ProviderDisconnectParams, options?: CallOptions): Promise<import("@whip/protocol").ProviderStatus>;
    catalogs({ refresh, provider, ...options }?: CallOptions & {
        refresh?: boolean;
        provider?: string;
    }): Promise<import("./client.js").QueryOutcome<"provider.catalogs">>;
    status(name: string, options?: CallOptions): Promise<import("@whip/protocol").ProviderStatus>;
    setKey(params: ProviderKeySetup, options?: CallOptions): Promise<import("@whip/protocol").RuntimeConfiguration>;
    validate(params: ProviderValidateParams, options?: CallOptions): Promise<import("@whip/protocol").ProviderValidateResult>;
    rotateKey(name: string, options?: CallOptions): Promise<import("@whip/protocol").ProviderStatus>;
    logout(name: string, options?: CallOptions): Promise<import("@whip/protocol").ProviderStatus>;
    readonly login: {
        begin: (options?: CallOptions & ProviderLoginBeginParams) => Promise<import("@whip/protocol").ProviderLoginStatus>;
        list: (options?: CallOptions) => Promise<import("@whip/protocol").ProviderLoginList>;
        status: (flowId: string, options?: CallOptions) => Promise<import("@whip/protocol").ProviderLoginStatus>;
        cancel: (flowId: string, options?: CallOptions) => Promise<import("@whip/protocol").ProviderLoginStatus>;
        selectTeam: (flowId: string, teamId: string, options?: CallOptions) => Promise<import("@whip/protocol").ProviderLoginStatus>;
        selectProject: (flowId: string, projectId: string, options?: CallOptions) => Promise<import("@whip/protocol").ProviderLoginStatus>;
        createProject: (flowId: string, name: string, options?: CallOptions) => Promise<import("@whip/protocol").ProviderLoginStatus>;
    };
}
