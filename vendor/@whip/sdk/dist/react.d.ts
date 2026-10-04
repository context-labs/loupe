import type { WhipClient } from './client.js';
import type { SessionListView, SessionView } from './state.js';
/** The application owns start/dispose, including across StrictMode remounts. */
export declare function useSessionView(view: SessionView): {
    readonly status: "error" | "closed" | "idle" | "loading" | "live" | "stale";
    readonly root?: {
        readonly collection_revision?: string | undefined;
        readonly active_turns: {
            readonly [x: string]: string;
        };
        readonly omitted?: {
            readonly [x: string]: boolean;
        } | undefined;
        readonly message_seqs: readonly number[] | null;
        readonly first_message_seq?: number | undefined;
        readonly history_revision: string;
        readonly root_id: string;
        readonly cursor: string;
        readonly meta: {
            readonly execution_engine: string;
            readonly definition: string;
            readonly definition_revision: string;
            readonly id: string;
            readonly kind: string;
            readonly title: string;
            readonly model: string;
            readonly provider: string;
            readonly cwd: string;
            readonly goal: string;
            readonly forked_from: string;
            readonly fork_seq: number;
            readonly tags: readonly string[] | null;
            readonly archived: boolean;
            readonly pinned: boolean;
            readonly effort: string;
            readonly usage_in: number;
            readonly usage_cached: number;
            readonly usage_out: number;
            readonly updated_at: string;
        };
        readonly messages: readonly {
            readonly presentation?: {
                readonly design_context?: {
                    readonly context_attachment_id: string;
                    readonly screenshot_attachment_id?: string | undefined;
                    readonly elements: readonly {
                        readonly label: string;
                        readonly selector?: string | undefined;
                    }[] | null;
                    readonly element_count: number;
                    readonly page_url?: string | undefined;
                    readonly page_title?: string | undefined;
                    readonly context_part_index: number;
                    readonly screenshot_part_index?: null | number | undefined;
                } | null | undefined;
                readonly version: number;
                readonly turn_id?: string | undefined;
                readonly parts?: readonly {
                    readonly id: string;
                    readonly kind: string;
                    readonly start?: number | undefined;
                    readonly end?: number | undefined;
                    readonly text?: string | undefined;
                    readonly tool_name?: string | undefined;
                    readonly status?: string | undefined;
                    readonly call_id?: string | undefined;
                    readonly hosts?: readonly {
                        readonly invocation_id: string;
                        readonly name: string;
                        readonly summary?: string | undefined;
                        readonly status: string;
                        readonly duration?: string | undefined;
                        readonly error?: string | undefined;
                        readonly display?: {
                            readonly target?: string | undefined;
                            readonly command?: string | undefined;
                            readonly query?: string | undefined;
                            readonly child_id?: string | undefined;
                            readonly label?: string | undefined;
                        } | null | undefined;
                    }[] | null | undefined;
                    readonly omitted?: number | undefined;
                }[] | null | undefined;
                readonly omitted?: number | undefined;
            } | null | undefined;
            readonly role: string;
            readonly content: string | readonly {
                readonly type: string;
                readonly text?: string | undefined;
                readonly image_url?: {
                    readonly url: string;
                } | null | undefined;
                readonly w?: number | undefined;
                readonly h?: number | undefined;
            }[];
            readonly tool_calls?: readonly {
                readonly id: string;
                readonly type: string;
                readonly function: {
                    readonly name: string;
                    readonly arguments: string;
                };
                readonly duration_ms?: number | undefined;
                readonly exit_code?: number | undefined;
            }[] | null | undefined;
            readonly tool_call_id?: string | undefined;
            readonly name?: string | undefined;
            readonly authored?: boolean | undefined;
            readonly sent_at?: null | string | undefined;
            readonly usage?: {
                readonly reported?: boolean | undefined;
                readonly cost?: null | number | undefined;
                readonly prompt_tokens: number;
                readonly completion_tokens: number;
                readonly prompt_tokens_details?: {
                    readonly cached_tokens: number;
                } | null | undefined;
                readonly completion_tokens_details?: {
                    readonly reasoning_tokens: number;
                } | null | undefined;
            } | null | undefined;
            readonly model?: string | undefined;
            readonly rewound_from?: string | undefined;
            readonly call_id?: string | undefined;
        }[] | null;
        readonly presentation: readonly {
            readonly seq: string;
            readonly kind: string;
            readonly payload: unknown;
        }[] | null;
        readonly agent_presentations: {
            readonly [x: string]: readonly {
                readonly seq: string;
                readonly kind: string;
                readonly payload: unknown;
            }[] | null;
        };
        readonly agents: readonly {
            readonly execution_engine: string;
            readonly last_turn?: {
                readonly turn_id?: string | undefined;
                readonly status: string;
                readonly started_at?: string | undefined;
                readonly finished_at?: string | undefined;
                readonly event_seq: string;
                readonly error?: string | undefined;
                readonly error_truncated?: boolean | undefined;
                readonly error_details?: {
                    readonly inline?: unknown;
                    readonly text?: null | string | undefined;
                    readonly binary?: string | null | undefined;
                    readonly reference_id: string;
                    readonly digest: string;
                    readonly size: string;
                    readonly media_type: string;
                    readonly source: string;
                } | null | undefined;
                readonly model_calls?: number | undefined;
                readonly compactions?: number | undefined;
                readonly last_activity_at?: string | undefined;
            } | null | undefined;
            readonly id: string;
            readonly root_id: string;
            readonly parent_id: string;
            readonly name: string;
            readonly model: string;
            readonly provider: string;
            readonly effort: string;
            readonly cwd: string;
            readonly report: string;
            readonly status: string;
            readonly pending_mail: number;
            readonly lifecycle_phase: string;
            readonly blocking_reason: string;
            readonly terminal_cause: string;
            readonly allowed_controls: readonly string[] | null;
        }[] | null;
        readonly inbox: readonly {
            readonly delivery_seq?: string | undefined;
            readonly origin?: string | undefined;
            readonly command_client_id?: string | undefined;
            readonly command_id?: string | undefined;
            readonly steer_turn_id?: string | undefined;
            readonly preview?: {
                readonly design_context?: {
                    readonly context_attachment_id: string;
                    readonly screenshot_attachment_id?: string | undefined;
                    readonly elements: readonly {
                        readonly label: string;
                        readonly selector?: string | undefined;
                    }[] | null;
                    readonly element_count: number;
                    readonly page_url?: string | undefined;
                    readonly page_title?: string | undefined;
                } | null | undefined;
                readonly text: string;
                readonly truncated?: boolean | undefined;
                readonly attachments?: readonly {
                    readonly kind: string;
                    readonly name?: string | undefined;
                    readonly content: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                }[] | null | undefined;
                readonly attachment_count?: number | undefined;
            } | null | undefined;
            readonly root_id: string;
            readonly agent_id: string;
            readonly seq: string;
            readonly kind: string;
            readonly status: string;
            readonly payload: {
                readonly inline?: unknown;
                readonly text?: null | string | undefined;
                readonly binary?: string | null | undefined;
                readonly reference_id: string;
                readonly digest: string;
                readonly size: string;
                readonly media_type: string;
                readonly source: string;
            };
        }[] | null;
        readonly blackboard: readonly {
            readonly key: string;
            readonly version: string;
            readonly author_agent_id: string;
            readonly payload: {
                readonly inline?: unknown;
                readonly text?: null | string | undefined;
                readonly binary?: string | null | undefined;
                readonly reference_id: string;
                readonly digest: string;
                readonly size: string;
                readonly media_type: string;
                readonly source: string;
            };
        }[] | null;
        readonly budgets: readonly {
            readonly agent_id: string;
            readonly state: {
                readonly kind: string;
                readonly limit: string | null;
                readonly used: string;
                readonly reserved: string;
                readonly remaining: string | null;
                readonly uncertain: string;
                readonly incomplete: boolean;
            };
        }[] | null;
        readonly accounting?: {
            readonly root_id: string;
            readonly agent_id: string;
            readonly scope: string;
            readonly revision: string;
            readonly reported_cost_micros: string;
            readonly estimated_cost_micros: string;
            readonly reported_cost_calls: string;
            readonly estimated_cost_calls: string;
            readonly unknown_cost_calls: string;
            readonly reported_calls: string;
            readonly estimated_calls: string;
            readonly pending_calls: string;
        } | undefined;
        readonly capabilities: readonly {
            readonly id: string;
            readonly root_id: string;
            readonly agent_id: string;
            readonly issuer_agent_id: string;
            readonly operations: readonly string[] | null;
            readonly scopes: readonly string[] | null;
            readonly file_scope?: string | undefined;
            readonly file_issuer_id?: string | undefined;
            readonly file_issuer_generation?: string | undefined;
            readonly mcp: readonly {
                readonly server: string;
                readonly tool: string;
                readonly definition: string;
            }[] | null;
            readonly mcp_all: boolean;
            readonly browser?: {
                readonly provider_id: string;
                readonly provider_epoch: string;
                readonly tab_id: string;
                readonly tab_generation: string;
                readonly profile_id: string;
                readonly attachment_id?: string | undefined;
                readonly attachment_generation?: string | undefined;
                readonly rights: readonly string[] | null;
                readonly preview?: {
                    readonly host_id: string;
                    readonly host_identity: string;
                    readonly connection_generation: string;
                    readonly environment_id: string;
                    readonly loopback: string;
                    readonly ports: readonly number[] | null;
                } | null | undefined;
            } | null | undefined;
            readonly browser_issuer_id?: string | undefined;
            readonly browser_issuer_generation?: number | undefined;
            readonly browser_delegation_only?: boolean | undefined;
            readonly generation: string;
            readonly status: string;
            readonly expires_at: string;
            readonly created_at: string;
            readonly updated_at: string;
        }[] | null;
        readonly schedules: readonly {
            readonly id: number;
            readonly schedule: string;
            readonly prompt: string;
            readonly anchor: string;
            readonly last_fire: string;
        }[] | null;
        readonly upcoming_schedules?: readonly {
            readonly id: number;
            readonly next_fire: string;
            readonly prompt: string;
            readonly prompt_truncated?: boolean | undefined;
        }[] | null | undefined;
        readonly upcoming_schedule_count?: null | number | undefined;
        readonly permissions: readonly {
            readonly id: string;
            readonly agent_id: string;
            readonly operation_id: string;
            readonly operation: string;
            readonly canonical_path: string;
            readonly request_digest: string;
            readonly capability_id: string;
            readonly capability_generation: string;
            readonly status: string;
            readonly command: string;
            readonly rule: string;
        }[] | null;
        readonly questions: readonly {
            readonly turn_id?: string | undefined;
            readonly root_id?: string | undefined;
            readonly agent_id?: string | undefined;
            readonly sender_agent_id?: string | undefined;
            readonly inbox_seq?: string | undefined;
            readonly inbox_kind?: string | undefined;
            readonly delivery?: string | undefined;
            readonly message_id?: string | undefined;
            readonly phase?: string | undefined;
            readonly status?: string | undefined;
            readonly terminal_cause?: string | undefined;
            readonly command_client_id?: string | undefined;
            readonly command_id?: string | undefined;
            readonly operation_id?: string | undefined;
            readonly trace_id?: string | undefined;
            readonly schedule_id?: number | undefined;
            readonly slot?: string | undefined;
            readonly error?: string | undefined;
            readonly model_call?: {
                readonly id: string;
                readonly logical_id: string;
                readonly number: number;
                readonly purpose: string;
                readonly usage_source: string;
                readonly cost_source: string;
                readonly tokens: string;
                readonly cost_micros: string;
                readonly elapsed_millis: string;
                readonly exhausted: boolean;
            } | null | undefined;
            readonly acknowledged_inbox?: readonly string[] | undefined;
            readonly subscription_id?: string | undefined;
            readonly key?: string | undefined;
            readonly version?: string | undefined;
            readonly expected_version?: string | undefined;
            readonly restored?: readonly string[] | null | undefined;
            readonly not_restored?: readonly {
                readonly name: string;
                readonly reason: string;
            }[] | null | undefined;
            readonly attempt?: string | undefined;
            readonly budget_kind?: string | undefined;
            readonly amount?: string | undefined;
            readonly limit?: string | undefined;
            readonly used?: string | undefined;
            readonly reserved?: string | undefined;
            readonly capability_id?: string | undefined;
            readonly generation?: string | undefined;
            readonly permission_id?: string | undefined;
            readonly operation?: string | undefined;
            readonly canonical_path?: string | undefined;
            readonly request_digest?: string | undefined;
            readonly command?: string | undefined;
            readonly rule?: string | undefined;
            readonly rule_source?: string | undefined;
            readonly question_id?: string | undefined;
            readonly question?: string | undefined;
            readonly options?: readonly {
                readonly label: string;
                readonly description?: string | undefined;
                readonly recommended?: boolean | undefined;
            }[] | null | undefined;
            readonly multiple?: boolean | undefined;
            readonly questions?: readonly {
                readonly question: string;
                readonly options?: readonly {
                    readonly label: string;
                    readonly description?: string | undefined;
                    readonly recommended?: boolean | undefined;
                }[] | null | undefined;
                readonly multiple?: boolean | undefined;
            }[] | null | undefined;
            readonly answer?: readonly string[] | null | undefined;
            readonly dismissed?: boolean | undefined;
            readonly answers?: readonly {
                readonly answer?: readonly string[] | null | undefined;
                readonly dismissed?: boolean | undefined;
            }[] | null | undefined;
        }[] | null;
        readonly permission_mode?: string | undefined;
    } | undefined;
    readonly history: {
        readonly [x: string]: {
            readonly revision: string;
            readonly throughSeq: number;
            readonly nextSeq: number;
            readonly hasMore: boolean;
            readonly loading: boolean;
            readonly messages: readonly {
                readonly presentation?: {
                    readonly design_context?: {
                        readonly context_attachment_id: string;
                        readonly screenshot_attachment_id?: string | undefined;
                        readonly elements: readonly {
                            readonly label: string;
                            readonly selector?: string | undefined;
                        }[] | null;
                        readonly element_count: number;
                        readonly page_url?: string | undefined;
                        readonly page_title?: string | undefined;
                        readonly context_part_index: number;
                        readonly screenshot_part_index?: null | number | undefined;
                    } | null | undefined;
                    readonly version: number;
                    readonly turn_id?: string | undefined;
                    readonly parts?: readonly {
                        readonly id: string;
                        readonly kind: string;
                        readonly start?: number | undefined;
                        readonly end?: number | undefined;
                        readonly text?: string | undefined;
                        readonly tool_name?: string | undefined;
                        readonly status?: string | undefined;
                        readonly call_id?: string | undefined;
                        readonly hosts?: readonly {
                            readonly invocation_id: string;
                            readonly name: string;
                            readonly summary?: string | undefined;
                            readonly status: string;
                            readonly duration?: string | undefined;
                            readonly error?: string | undefined;
                            readonly display?: {
                                readonly target?: string | undefined;
                                readonly command?: string | undefined;
                                readonly query?: string | undefined;
                                readonly child_id?: string | undefined;
                                readonly label?: string | undefined;
                            } | null | undefined;
                        }[] | null | undefined;
                        readonly omitted?: number | undefined;
                    }[] | null | undefined;
                    readonly omitted?: number | undefined;
                } | null | undefined;
                readonly role?: string | undefined;
                readonly authored?: boolean | undefined;
                readonly sent_at?: null | string | undefined;
                readonly seq: number;
                readonly message?: {
                    readonly presentation?: {
                        readonly design_context?: {
                            readonly context_attachment_id: string;
                            readonly screenshot_attachment_id?: string | undefined;
                            readonly elements: readonly {
                                readonly label: string;
                                readonly selector?: string | undefined;
                            }[] | null;
                            readonly element_count: number;
                            readonly page_url?: string | undefined;
                            readonly page_title?: string | undefined;
                            readonly context_part_index: number;
                            readonly screenshot_part_index?: null | number | undefined;
                        } | null | undefined;
                        readonly version: number;
                        readonly turn_id?: string | undefined;
                        readonly parts?: readonly {
                            readonly id: string;
                            readonly kind: string;
                            readonly start?: number | undefined;
                            readonly end?: number | undefined;
                            readonly text?: string | undefined;
                            readonly tool_name?: string | undefined;
                            readonly status?: string | undefined;
                            readonly call_id?: string | undefined;
                            readonly hosts?: readonly {
                                readonly invocation_id: string;
                                readonly name: string;
                                readonly summary?: string | undefined;
                                readonly status: string;
                                readonly duration?: string | undefined;
                                readonly error?: string | undefined;
                                readonly display?: {
                                    readonly target?: string | undefined;
                                    readonly command?: string | undefined;
                                    readonly query?: string | undefined;
                                    readonly child_id?: string | undefined;
                                    readonly label?: string | undefined;
                                } | null | undefined;
                            }[] | null | undefined;
                            readonly omitted?: number | undefined;
                        }[] | null | undefined;
                        readonly omitted?: number | undefined;
                    } | null | undefined;
                    readonly role: string;
                    readonly content: string | readonly {
                        readonly type: string;
                        readonly text?: string | undefined;
                        readonly image_url?: {
                            readonly url: string;
                        } | null | undefined;
                        readonly w?: number | undefined;
                        readonly h?: number | undefined;
                    }[];
                    readonly tool_calls?: readonly {
                        readonly id: string;
                        readonly type: string;
                        readonly function: {
                            readonly name: string;
                            readonly arguments: string;
                        };
                        readonly duration_ms?: number | undefined;
                        readonly exit_code?: number | undefined;
                    }[] | null | undefined;
                    readonly tool_call_id?: string | undefined;
                    readonly name?: string | undefined;
                    readonly authored?: boolean | undefined;
                    readonly sent_at?: null | string | undefined;
                    readonly usage?: {
                        readonly reported?: boolean | undefined;
                        readonly cost?: null | number | undefined;
                        readonly prompt_tokens: number;
                        readonly completion_tokens: number;
                        readonly prompt_tokens_details?: {
                            readonly cached_tokens: number;
                        } | null | undefined;
                        readonly completion_tokens_details?: {
                            readonly reasoning_tokens: number;
                        } | null | undefined;
                    } | null | undefined;
                    readonly model?: string | undefined;
                    readonly rewound_from?: string | undefined;
                    readonly call_id?: string | undefined;
                } | null | undefined;
                readonly body?: {
                    readonly inline?: unknown;
                    readonly text?: null | string | undefined;
                    readonly binary?: string | null | undefined;
                    readonly reference_id: string;
                    readonly digest: string;
                    readonly size: string;
                    readonly media_type: string;
                    readonly source: string;
                } | null | undefined;
            }[];
            readonly truncated: boolean;
            readonly error?: {
                readonly name: string;
                readonly message: string;
                readonly stack?: string | undefined;
                readonly cause?: unknown;
            } | undefined;
            readonly gaps?: readonly {
                readonly fromSeq: number;
                readonly toSeq: number;
                readonly status: "pending" | "loading" | "paused" | "error";
                readonly error?: string | undefined;
            }[] | undefined;
            readonly latestMissing?: boolean | undefined;
        };
    };
    readonly collections: {
        readonly [x: string]: {
            readonly root_id: string;
            readonly collection: string;
            readonly revision: string;
            readonly event_cursor: string;
            readonly items: readonly ({
                readonly agent: {
                    readonly execution_engine: string;
                    readonly last_turn?: {
                        readonly turn_id?: string | undefined;
                        readonly status: string;
                        readonly started_at?: string | undefined;
                        readonly finished_at?: string | undefined;
                        readonly event_seq: string;
                        readonly error?: string | undefined;
                        readonly error_truncated?: boolean | undefined;
                        readonly error_details?: {
                            readonly inline?: unknown;
                            readonly text?: null | string | undefined;
                            readonly binary?: string | null | undefined;
                            readonly reference_id: string;
                            readonly digest: string;
                            readonly size: string;
                            readonly media_type: string;
                            readonly source: string;
                        } | null | undefined;
                        readonly model_calls?: number | undefined;
                        readonly compactions?: number | undefined;
                        readonly last_activity_at?: string | undefined;
                    } | null | undefined;
                    readonly id: string;
                    readonly root_id: string;
                    readonly parent_id: string;
                    readonly name: string;
                    readonly model: string;
                    readonly provider: string;
                    readonly effort: string;
                    readonly cwd: string;
                    readonly report: string;
                    readonly status: string;
                    readonly pending_mail: number;
                    readonly lifecycle_phase: string;
                    readonly blocking_reason: string;
                    readonly terminal_cause: string;
                    readonly allowed_controls: readonly string[] | null;
                } | null;
                readonly inbox?: {
                    readonly delivery_seq?: string | undefined;
                    readonly origin?: string | undefined;
                    readonly command_client_id?: string | undefined;
                    readonly command_id?: string | undefined;
                    readonly steer_turn_id?: string | undefined;
                    readonly preview?: {
                        readonly design_context?: {
                            readonly context_attachment_id: string;
                            readonly screenshot_attachment_id?: string | undefined;
                            readonly elements: readonly {
                                readonly label: string;
                                readonly selector?: string | undefined;
                            }[] | null;
                            readonly element_count: number;
                            readonly page_url?: string | undefined;
                            readonly page_title?: string | undefined;
                        } | null | undefined;
                        readonly text: string;
                        readonly truncated?: boolean | undefined;
                        readonly attachments?: readonly {
                            readonly kind: string;
                            readonly name?: string | undefined;
                            readonly content: {
                                readonly inline?: unknown;
                                readonly text?: null | string | undefined;
                                readonly binary?: string | null | undefined;
                                readonly reference_id: string;
                                readonly digest: string;
                                readonly size: string;
                                readonly media_type: string;
                                readonly source: string;
                            };
                        }[] | null | undefined;
                        readonly attachment_count?: number | undefined;
                    } | null | undefined;
                    readonly root_id: string;
                    readonly agent_id: string;
                    readonly seq: string;
                    readonly kind: string;
                    readonly status: string;
                    readonly payload: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                } | null | undefined;
                readonly blackboard?: {
                    readonly key: string;
                    readonly version: string;
                    readonly author_agent_id: string;
                    readonly payload: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                } | null | undefined;
                readonly budget?: {
                    readonly agent_id: string;
                    readonly state: {
                        readonly kind: string;
                        readonly limit: string | null;
                        readonly used: string;
                        readonly reserved: string;
                        readonly remaining: string | null;
                        readonly uncertain: string;
                        readonly incomplete: boolean;
                    };
                } | null | undefined;
                readonly capability?: {
                    readonly id: string;
                    readonly root_id: string;
                    readonly agent_id: string;
                    readonly issuer_agent_id: string;
                    readonly operations: readonly string[] | null;
                    readonly scopes: readonly string[] | null;
                    readonly file_scope?: string | undefined;
                    readonly file_issuer_id?: string | undefined;
                    readonly file_issuer_generation?: string | undefined;
                    readonly mcp: readonly {
                        readonly server: string;
                        readonly tool: string;
                        readonly definition: string;
                    }[] | null;
                    readonly mcp_all: boolean;
                    readonly browser?: {
                        readonly provider_id: string;
                        readonly provider_epoch: string;
                        readonly tab_id: string;
                        readonly tab_generation: string;
                        readonly profile_id: string;
                        readonly attachment_id?: string | undefined;
                        readonly attachment_generation?: string | undefined;
                        readonly rights: readonly string[] | null;
                        readonly preview?: {
                            readonly host_id: string;
                            readonly host_identity: string;
                            readonly connection_generation: string;
                            readonly environment_id: string;
                            readonly loopback: string;
                            readonly ports: readonly number[] | null;
                        } | null | undefined;
                    } | null | undefined;
                    readonly browser_issuer_id?: string | undefined;
                    readonly browser_issuer_generation?: number | undefined;
                    readonly browser_delegation_only?: boolean | undefined;
                    readonly generation: string;
                    readonly status: string;
                    readonly expires_at: string;
                    readonly created_at: string;
                    readonly updated_at: string;
                } | null | undefined;
                readonly schedule?: {
                    readonly id: number;
                    readonly schedule: string;
                    readonly prompt: string;
                    readonly anchor: string;
                    readonly last_fire: string;
                } | null | undefined;
                readonly permission?: {
                    readonly id: string;
                    readonly agent_id: string;
                    readonly operation_id: string;
                    readonly operation: string;
                    readonly canonical_path: string;
                    readonly request_digest: string;
                    readonly capability_id: string;
                    readonly capability_generation: string;
                    readonly status: string;
                    readonly command: string;
                    readonly rule: string;
                } | null | undefined;
                readonly body?: {
                    readonly inline?: unknown;
                    readonly text?: null | string | undefined;
                    readonly binary?: string | null | undefined;
                    readonly reference_id: string;
                    readonly digest: string;
                    readonly size: string;
                    readonly media_type: string;
                    readonly source: string;
                } | null | undefined;
            } | {
                readonly agent?: {
                    readonly execution_engine: string;
                    readonly last_turn?: {
                        readonly turn_id?: string | undefined;
                        readonly status: string;
                        readonly started_at?: string | undefined;
                        readonly finished_at?: string | undefined;
                        readonly event_seq: string;
                        readonly error?: string | undefined;
                        readonly error_truncated?: boolean | undefined;
                        readonly error_details?: {
                            readonly inline?: unknown;
                            readonly text?: null | string | undefined;
                            readonly binary?: string | null | undefined;
                            readonly reference_id: string;
                            readonly digest: string;
                            readonly size: string;
                            readonly media_type: string;
                            readonly source: string;
                        } | null | undefined;
                        readonly model_calls?: number | undefined;
                        readonly compactions?: number | undefined;
                        readonly last_activity_at?: string | undefined;
                    } | null | undefined;
                    readonly id: string;
                    readonly root_id: string;
                    readonly parent_id: string;
                    readonly name: string;
                    readonly model: string;
                    readonly provider: string;
                    readonly effort: string;
                    readonly cwd: string;
                    readonly report: string;
                    readonly status: string;
                    readonly pending_mail: number;
                    readonly lifecycle_phase: string;
                    readonly blocking_reason: string;
                    readonly terminal_cause: string;
                    readonly allowed_controls: readonly string[] | null;
                } | null | undefined;
                readonly inbox: {
                    readonly delivery_seq?: string | undefined;
                    readonly origin?: string | undefined;
                    readonly command_client_id?: string | undefined;
                    readonly command_id?: string | undefined;
                    readonly steer_turn_id?: string | undefined;
                    readonly preview?: {
                        readonly design_context?: {
                            readonly context_attachment_id: string;
                            readonly screenshot_attachment_id?: string | undefined;
                            readonly elements: (readonly {
                                readonly label: string;
                                readonly selector?: string | undefined;
                            }[] & readonly {
                                readonly label: string;
                                readonly selector?: string | undefined;
                            }[]) | null;
                            readonly element_count: number;
                            readonly page_url?: string | undefined;
                            readonly page_title?: string | undefined;
                        } | null | undefined;
                        readonly text: string;
                        readonly truncated?: boolean | undefined;
                        readonly attachments?: (readonly {
                            readonly kind: string;
                            readonly name?: string | undefined;
                            readonly content: {
                                readonly inline?: unknown;
                                readonly text?: null | string | undefined;
                                readonly binary?: string | null | undefined;
                                readonly reference_id: string;
                                readonly digest: string;
                                readonly size: string;
                                readonly media_type: string;
                                readonly source: string;
                            };
                        }[] & readonly {
                            readonly kind: string;
                            readonly name?: string | undefined;
                            readonly content: {
                                readonly inline?: unknown;
                                readonly text?: null | string | undefined;
                                readonly binary?: string | null | undefined;
                                readonly reference_id: string;
                                readonly digest: string;
                                readonly size: string;
                                readonly media_type: string;
                                readonly source: string;
                            };
                        }[]) | null | undefined;
                        readonly attachment_count?: number | undefined;
                    } | null | undefined;
                    readonly root_id: string;
                    readonly agent_id: string;
                    readonly seq: string;
                    readonly kind: string;
                    readonly status: string;
                    readonly payload: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                } | null;
                readonly blackboard?: {
                    readonly key: string;
                    readonly version: string;
                    readonly author_agent_id: string;
                    readonly payload: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                } | null | undefined;
                readonly budget?: {
                    readonly agent_id: string;
                    readonly state: {
                        readonly kind: string;
                        readonly limit: string | null;
                        readonly used: string;
                        readonly reserved: string;
                        readonly remaining: string | null;
                        readonly uncertain: string;
                        readonly incomplete: boolean;
                    };
                } | null | undefined;
                readonly capability?: {
                    readonly id: string;
                    readonly root_id: string;
                    readonly agent_id: string;
                    readonly issuer_agent_id: string;
                    readonly operations: readonly string[] | null;
                    readonly scopes: readonly string[] | null;
                    readonly file_scope?: string | undefined;
                    readonly file_issuer_id?: string | undefined;
                    readonly file_issuer_generation?: string | undefined;
                    readonly mcp: readonly {
                        readonly server: string;
                        readonly tool: string;
                        readonly definition: string;
                    }[] | null;
                    readonly mcp_all: boolean;
                    readonly browser?: {
                        readonly provider_id: string;
                        readonly provider_epoch: string;
                        readonly tab_id: string;
                        readonly tab_generation: string;
                        readonly profile_id: string;
                        readonly attachment_id?: string | undefined;
                        readonly attachment_generation?: string | undefined;
                        readonly rights: readonly string[] | null;
                        readonly preview?: {
                            readonly host_id: string;
                            readonly host_identity: string;
                            readonly connection_generation: string;
                            readonly environment_id: string;
                            readonly loopback: string;
                            readonly ports: readonly number[] | null;
                        } | null | undefined;
                    } | null | undefined;
                    readonly browser_issuer_id?: string | undefined;
                    readonly browser_issuer_generation?: number | undefined;
                    readonly browser_delegation_only?: boolean | undefined;
                    readonly generation: string;
                    readonly status: string;
                    readonly expires_at: string;
                    readonly created_at: string;
                    readonly updated_at: string;
                } | null | undefined;
                readonly schedule?: {
                    readonly id: number;
                    readonly schedule: string;
                    readonly prompt: string;
                    readonly anchor: string;
                    readonly last_fire: string;
                } | null | undefined;
                readonly permission?: {
                    readonly id: string;
                    readonly agent_id: string;
                    readonly operation_id: string;
                    readonly operation: string;
                    readonly canonical_path: string;
                    readonly request_digest: string;
                    readonly capability_id: string;
                    readonly capability_generation: string;
                    readonly status: string;
                    readonly command: string;
                    readonly rule: string;
                } | null | undefined;
                readonly body?: {
                    readonly inline?: unknown;
                    readonly text?: null | string | undefined;
                    readonly binary?: string | null | undefined;
                    readonly reference_id: string;
                    readonly digest: string;
                    readonly size: string;
                    readonly media_type: string;
                    readonly source: string;
                } | null | undefined;
            } | {
                readonly agent?: {
                    readonly execution_engine: string;
                    readonly last_turn?: {
                        readonly turn_id?: string | undefined;
                        readonly status: string;
                        readonly started_at?: string | undefined;
                        readonly finished_at?: string | undefined;
                        readonly event_seq: string;
                        readonly error?: string | undefined;
                        readonly error_truncated?: boolean | undefined;
                        readonly error_details?: {
                            readonly inline?: unknown;
                            readonly text?: null | string | undefined;
                            readonly binary?: string | null | undefined;
                            readonly reference_id: string;
                            readonly digest: string;
                            readonly size: string;
                            readonly media_type: string;
                            readonly source: string;
                        } | null | undefined;
                        readonly model_calls?: number | undefined;
                        readonly compactions?: number | undefined;
                        readonly last_activity_at?: string | undefined;
                    } | null | undefined;
                    readonly id: string;
                    readonly root_id: string;
                    readonly parent_id: string;
                    readonly name: string;
                    readonly model: string;
                    readonly provider: string;
                    readonly effort: string;
                    readonly cwd: string;
                    readonly report: string;
                    readonly status: string;
                    readonly pending_mail: number;
                    readonly lifecycle_phase: string;
                    readonly blocking_reason: string;
                    readonly terminal_cause: string;
                    readonly allowed_controls: readonly string[] | null;
                } | null | undefined;
                readonly inbox?: {
                    readonly delivery_seq?: string | undefined;
                    readonly origin?: string | undefined;
                    readonly command_client_id?: string | undefined;
                    readonly command_id?: string | undefined;
                    readonly steer_turn_id?: string | undefined;
                    readonly preview?: {
                        readonly design_context?: {
                            readonly context_attachment_id: string;
                            readonly screenshot_attachment_id?: string | undefined;
                            readonly elements: readonly {
                                readonly label: string;
                                readonly selector?: string | undefined;
                            }[] | null;
                            readonly element_count: number;
                            readonly page_url?: string | undefined;
                            readonly page_title?: string | undefined;
                        } | null | undefined;
                        readonly text: string;
                        readonly truncated?: boolean | undefined;
                        readonly attachments?: readonly {
                            readonly kind: string;
                            readonly name?: string | undefined;
                            readonly content: {
                                readonly inline?: unknown;
                                readonly text?: null | string | undefined;
                                readonly binary?: string | null | undefined;
                                readonly reference_id: string;
                                readonly digest: string;
                                readonly size: string;
                                readonly media_type: string;
                                readonly source: string;
                            };
                        }[] | null | undefined;
                        readonly attachment_count?: number | undefined;
                    } | null | undefined;
                    readonly root_id: string;
                    readonly agent_id: string;
                    readonly seq: string;
                    readonly kind: string;
                    readonly status: string;
                    readonly payload: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                } | null | undefined;
                readonly blackboard: {
                    readonly key: string;
                    readonly version: string;
                    readonly author_agent_id: string;
                    readonly payload: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                } | null;
                readonly budget?: {
                    readonly agent_id: string;
                    readonly state: {
                        readonly kind: string;
                        readonly limit: string | null;
                        readonly used: string;
                        readonly reserved: string;
                        readonly remaining: string | null;
                        readonly uncertain: string;
                        readonly incomplete: boolean;
                    };
                } | null | undefined;
                readonly capability?: {
                    readonly id: string;
                    readonly root_id: string;
                    readonly agent_id: string;
                    readonly issuer_agent_id: string;
                    readonly operations: readonly string[] | null;
                    readonly scopes: readonly string[] | null;
                    readonly file_scope?: string | undefined;
                    readonly file_issuer_id?: string | undefined;
                    readonly file_issuer_generation?: string | undefined;
                    readonly mcp: readonly {
                        readonly server: string;
                        readonly tool: string;
                        readonly definition: string;
                    }[] | null;
                    readonly mcp_all: boolean;
                    readonly browser?: {
                        readonly provider_id: string;
                        readonly provider_epoch: string;
                        readonly tab_id: string;
                        readonly tab_generation: string;
                        readonly profile_id: string;
                        readonly attachment_id?: string | undefined;
                        readonly attachment_generation?: string | undefined;
                        readonly rights: readonly string[] | null;
                        readonly preview?: {
                            readonly host_id: string;
                            readonly host_identity: string;
                            readonly connection_generation: string;
                            readonly environment_id: string;
                            readonly loopback: string;
                            readonly ports: readonly number[] | null;
                        } | null | undefined;
                    } | null | undefined;
                    readonly browser_issuer_id?: string | undefined;
                    readonly browser_issuer_generation?: number | undefined;
                    readonly browser_delegation_only?: boolean | undefined;
                    readonly generation: string;
                    readonly status: string;
                    readonly expires_at: string;
                    readonly created_at: string;
                    readonly updated_at: string;
                } | null | undefined;
                readonly schedule?: {
                    readonly id: number;
                    readonly schedule: string;
                    readonly prompt: string;
                    readonly anchor: string;
                    readonly last_fire: string;
                } | null | undefined;
                readonly permission?: {
                    readonly id: string;
                    readonly agent_id: string;
                    readonly operation_id: string;
                    readonly operation: string;
                    readonly canonical_path: string;
                    readonly request_digest: string;
                    readonly capability_id: string;
                    readonly capability_generation: string;
                    readonly status: string;
                    readonly command: string;
                    readonly rule: string;
                } | null | undefined;
                readonly body?: {
                    readonly inline?: unknown;
                    readonly text?: null | string | undefined;
                    readonly binary?: string | null | undefined;
                    readonly reference_id: string;
                    readonly digest: string;
                    readonly size: string;
                    readonly media_type: string;
                    readonly source: string;
                } | null | undefined;
            } | {
                readonly agent?: {
                    readonly execution_engine: string;
                    readonly last_turn?: {
                        readonly turn_id?: string | undefined;
                        readonly status: string;
                        readonly started_at?: string | undefined;
                        readonly finished_at?: string | undefined;
                        readonly event_seq: string;
                        readonly error?: string | undefined;
                        readonly error_truncated?: boolean | undefined;
                        readonly error_details?: {
                            readonly inline?: unknown;
                            readonly text?: null | string | undefined;
                            readonly binary?: string | null | undefined;
                            readonly reference_id: string;
                            readonly digest: string;
                            readonly size: string;
                            readonly media_type: string;
                            readonly source: string;
                        } | null | undefined;
                        readonly model_calls?: number | undefined;
                        readonly compactions?: number | undefined;
                        readonly last_activity_at?: string | undefined;
                    } | null | undefined;
                    readonly id: string;
                    readonly root_id: string;
                    readonly parent_id: string;
                    readonly name: string;
                    readonly model: string;
                    readonly provider: string;
                    readonly effort: string;
                    readonly cwd: string;
                    readonly report: string;
                    readonly status: string;
                    readonly pending_mail: number;
                    readonly lifecycle_phase: string;
                    readonly blocking_reason: string;
                    readonly terminal_cause: string;
                    readonly allowed_controls: readonly string[] | null;
                } | null | undefined;
                readonly inbox?: {
                    readonly delivery_seq?: string | undefined;
                    readonly origin?: string | undefined;
                    readonly command_client_id?: string | undefined;
                    readonly command_id?: string | undefined;
                    readonly steer_turn_id?: string | undefined;
                    readonly preview?: {
                        readonly design_context?: {
                            readonly context_attachment_id: string;
                            readonly screenshot_attachment_id?: string | undefined;
                            readonly elements: readonly {
                                readonly label: string;
                                readonly selector?: string | undefined;
                            }[] | null;
                            readonly element_count: number;
                            readonly page_url?: string | undefined;
                            readonly page_title?: string | undefined;
                        } | null | undefined;
                        readonly text: string;
                        readonly truncated?: boolean | undefined;
                        readonly attachments?: readonly {
                            readonly kind: string;
                            readonly name?: string | undefined;
                            readonly content: {
                                readonly inline?: unknown;
                                readonly text?: null | string | undefined;
                                readonly binary?: string | null | undefined;
                                readonly reference_id: string;
                                readonly digest: string;
                                readonly size: string;
                                readonly media_type: string;
                                readonly source: string;
                            };
                        }[] | null | undefined;
                        readonly attachment_count?: number | undefined;
                    } | null | undefined;
                    readonly root_id: string;
                    readonly agent_id: string;
                    readonly seq: string;
                    readonly kind: string;
                    readonly status: string;
                    readonly payload: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                } | null | undefined;
                readonly blackboard?: {
                    readonly key: string;
                    readonly version: string;
                    readonly author_agent_id: string;
                    readonly payload: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                } | null | undefined;
                readonly budget: {
                    readonly agent_id: string;
                    readonly state: {
                        readonly kind: string;
                        readonly limit: string | null;
                        readonly used: string;
                        readonly reserved: string;
                        readonly remaining: string | null;
                        readonly uncertain: string;
                        readonly incomplete: boolean;
                    };
                } | null;
                readonly capability?: {
                    readonly id: string;
                    readonly root_id: string;
                    readonly agent_id: string;
                    readonly issuer_agent_id: string;
                    readonly operations: readonly string[] | null;
                    readonly scopes: readonly string[] | null;
                    readonly file_scope?: string | undefined;
                    readonly file_issuer_id?: string | undefined;
                    readonly file_issuer_generation?: string | undefined;
                    readonly mcp: readonly {
                        readonly server: string;
                        readonly tool: string;
                        readonly definition: string;
                    }[] | null;
                    readonly mcp_all: boolean;
                    readonly browser?: {
                        readonly provider_id: string;
                        readonly provider_epoch: string;
                        readonly tab_id: string;
                        readonly tab_generation: string;
                        readonly profile_id: string;
                        readonly attachment_id?: string | undefined;
                        readonly attachment_generation?: string | undefined;
                        readonly rights: readonly string[] | null;
                        readonly preview?: {
                            readonly host_id: string;
                            readonly host_identity: string;
                            readonly connection_generation: string;
                            readonly environment_id: string;
                            readonly loopback: string;
                            readonly ports: readonly number[] | null;
                        } | null | undefined;
                    } | null | undefined;
                    readonly browser_issuer_id?: string | undefined;
                    readonly browser_issuer_generation?: number | undefined;
                    readonly browser_delegation_only?: boolean | undefined;
                    readonly generation: string;
                    readonly status: string;
                    readonly expires_at: string;
                    readonly created_at: string;
                    readonly updated_at: string;
                } | null | undefined;
                readonly schedule?: {
                    readonly id: number;
                    readonly schedule: string;
                    readonly prompt: string;
                    readonly anchor: string;
                    readonly last_fire: string;
                } | null | undefined;
                readonly permission?: {
                    readonly id: string;
                    readonly agent_id: string;
                    readonly operation_id: string;
                    readonly operation: string;
                    readonly canonical_path: string;
                    readonly request_digest: string;
                    readonly capability_id: string;
                    readonly capability_generation: string;
                    readonly status: string;
                    readonly command: string;
                    readonly rule: string;
                } | null | undefined;
                readonly body?: {
                    readonly inline?: unknown;
                    readonly text?: null | string | undefined;
                    readonly binary?: string | null | undefined;
                    readonly reference_id: string;
                    readonly digest: string;
                    readonly size: string;
                    readonly media_type: string;
                    readonly source: string;
                } | null | undefined;
            } | {
                readonly agent?: {
                    readonly execution_engine: string;
                    readonly last_turn?: {
                        readonly turn_id?: string | undefined;
                        readonly status: string;
                        readonly started_at?: string | undefined;
                        readonly finished_at?: string | undefined;
                        readonly event_seq: string;
                        readonly error?: string | undefined;
                        readonly error_truncated?: boolean | undefined;
                        readonly error_details?: {
                            readonly inline?: unknown;
                            readonly text?: null | string | undefined;
                            readonly binary?: string | null | undefined;
                            readonly reference_id: string;
                            readonly digest: string;
                            readonly size: string;
                            readonly media_type: string;
                            readonly source: string;
                        } | null | undefined;
                        readonly model_calls?: number | undefined;
                        readonly compactions?: number | undefined;
                        readonly last_activity_at?: string | undefined;
                    } | null | undefined;
                    readonly id: string;
                    readonly root_id: string;
                    readonly parent_id: string;
                    readonly name: string;
                    readonly model: string;
                    readonly provider: string;
                    readonly effort: string;
                    readonly cwd: string;
                    readonly report: string;
                    readonly status: string;
                    readonly pending_mail: number;
                    readonly lifecycle_phase: string;
                    readonly blocking_reason: string;
                    readonly terminal_cause: string;
                    readonly allowed_controls: readonly string[] | null;
                } | null | undefined;
                readonly inbox?: {
                    readonly delivery_seq?: string | undefined;
                    readonly origin?: string | undefined;
                    readonly command_client_id?: string | undefined;
                    readonly command_id?: string | undefined;
                    readonly steer_turn_id?: string | undefined;
                    readonly preview?: {
                        readonly design_context?: {
                            readonly context_attachment_id: string;
                            readonly screenshot_attachment_id?: string | undefined;
                            readonly elements: readonly {
                                readonly label: string;
                                readonly selector?: string | undefined;
                            }[] | null;
                            readonly element_count: number;
                            readonly page_url?: string | undefined;
                            readonly page_title?: string | undefined;
                        } | null | undefined;
                        readonly text: string;
                        readonly truncated?: boolean | undefined;
                        readonly attachments?: readonly {
                            readonly kind: string;
                            readonly name?: string | undefined;
                            readonly content: {
                                readonly inline?: unknown;
                                readonly text?: null | string | undefined;
                                readonly binary?: string | null | undefined;
                                readonly reference_id: string;
                                readonly digest: string;
                                readonly size: string;
                                readonly media_type: string;
                                readonly source: string;
                            };
                        }[] | null | undefined;
                        readonly attachment_count?: number | undefined;
                    } | null | undefined;
                    readonly root_id: string;
                    readonly agent_id: string;
                    readonly seq: string;
                    readonly kind: string;
                    readonly status: string;
                    readonly payload: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                } | null | undefined;
                readonly blackboard?: {
                    readonly key: string;
                    readonly version: string;
                    readonly author_agent_id: string;
                    readonly payload: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                } | null | undefined;
                readonly budget?: {
                    readonly agent_id: string;
                    readonly state: {
                        readonly kind: string;
                        readonly limit: string | null;
                        readonly used: string;
                        readonly reserved: string;
                        readonly remaining: string | null;
                        readonly uncertain: string;
                        readonly incomplete: boolean;
                    };
                } | null | undefined;
                readonly capability: {
                    readonly id: string;
                    readonly root_id: string;
                    readonly agent_id: string;
                    readonly issuer_agent_id: string;
                    readonly operations: readonly string[] | null;
                    readonly scopes: readonly string[] | null;
                    readonly file_scope?: string | undefined;
                    readonly file_issuer_id?: string | undefined;
                    readonly file_issuer_generation?: string | undefined;
                    readonly mcp: (readonly {
                        readonly server: string;
                        readonly tool: string;
                        readonly definition: string;
                    }[] & readonly {
                        readonly server: string;
                        readonly tool: string;
                        readonly definition: string;
                    }[]) | null;
                    readonly mcp_all: boolean;
                    readonly browser?: {
                        readonly provider_id: string;
                        readonly provider_epoch: string;
                        readonly tab_id: string;
                        readonly tab_generation: string;
                        readonly profile_id: string;
                        readonly attachment_id?: string | undefined;
                        readonly attachment_generation?: string | undefined;
                        readonly rights: readonly string[] | null;
                        readonly preview?: {
                            readonly host_id: string;
                            readonly host_identity: string;
                            readonly connection_generation: string;
                            readonly environment_id: string;
                            readonly loopback: string;
                            readonly ports: readonly number[] | null;
                        } | null | undefined;
                    } | null | undefined;
                    readonly browser_issuer_id?: string | undefined;
                    readonly browser_issuer_generation?: number | undefined;
                    readonly browser_delegation_only?: boolean | undefined;
                    readonly generation: string;
                    readonly status: string;
                    readonly expires_at: string;
                    readonly created_at: string;
                    readonly updated_at: string;
                } | null;
                readonly schedule?: {
                    readonly id: number;
                    readonly schedule: string;
                    readonly prompt: string;
                    readonly anchor: string;
                    readonly last_fire: string;
                } | null | undefined;
                readonly permission?: {
                    readonly id: string;
                    readonly agent_id: string;
                    readonly operation_id: string;
                    readonly operation: string;
                    readonly canonical_path: string;
                    readonly request_digest: string;
                    readonly capability_id: string;
                    readonly capability_generation: string;
                    readonly status: string;
                    readonly command: string;
                    readonly rule: string;
                } | null | undefined;
                readonly body?: {
                    readonly inline?: unknown;
                    readonly text?: null | string | undefined;
                    readonly binary?: string | null | undefined;
                    readonly reference_id: string;
                    readonly digest: string;
                    readonly size: string;
                    readonly media_type: string;
                    readonly source: string;
                } | null | undefined;
            } | {
                readonly agent?: {
                    readonly execution_engine: string;
                    readonly last_turn?: {
                        readonly turn_id?: string | undefined;
                        readonly status: string;
                        readonly started_at?: string | undefined;
                        readonly finished_at?: string | undefined;
                        readonly event_seq: string;
                        readonly error?: string | undefined;
                        readonly error_truncated?: boolean | undefined;
                        readonly error_details?: {
                            readonly inline?: unknown;
                            readonly text?: null | string | undefined;
                            readonly binary?: string | null | undefined;
                            readonly reference_id: string;
                            readonly digest: string;
                            readonly size: string;
                            readonly media_type: string;
                            readonly source: string;
                        } | null | undefined;
                        readonly model_calls?: number | undefined;
                        readonly compactions?: number | undefined;
                        readonly last_activity_at?: string | undefined;
                    } | null | undefined;
                    readonly id: string;
                    readonly root_id: string;
                    readonly parent_id: string;
                    readonly name: string;
                    readonly model: string;
                    readonly provider: string;
                    readonly effort: string;
                    readonly cwd: string;
                    readonly report: string;
                    readonly status: string;
                    readonly pending_mail: number;
                    readonly lifecycle_phase: string;
                    readonly blocking_reason: string;
                    readonly terminal_cause: string;
                    readonly allowed_controls: readonly string[] | null;
                } | null | undefined;
                readonly inbox?: {
                    readonly delivery_seq?: string | undefined;
                    readonly origin?: string | undefined;
                    readonly command_client_id?: string | undefined;
                    readonly command_id?: string | undefined;
                    readonly steer_turn_id?: string | undefined;
                    readonly preview?: {
                        readonly design_context?: {
                            readonly context_attachment_id: string;
                            readonly screenshot_attachment_id?: string | undefined;
                            readonly elements: readonly {
                                readonly label: string;
                                readonly selector?: string | undefined;
                            }[] | null;
                            readonly element_count: number;
                            readonly page_url?: string | undefined;
                            readonly page_title?: string | undefined;
                        } | null | undefined;
                        readonly text: string;
                        readonly truncated?: boolean | undefined;
                        readonly attachments?: readonly {
                            readonly kind: string;
                            readonly name?: string | undefined;
                            readonly content: {
                                readonly inline?: unknown;
                                readonly text?: null | string | undefined;
                                readonly binary?: string | null | undefined;
                                readonly reference_id: string;
                                readonly digest: string;
                                readonly size: string;
                                readonly media_type: string;
                                readonly source: string;
                            };
                        }[] | null | undefined;
                        readonly attachment_count?: number | undefined;
                    } | null | undefined;
                    readonly root_id: string;
                    readonly agent_id: string;
                    readonly seq: string;
                    readonly kind: string;
                    readonly status: string;
                    readonly payload: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                } | null | undefined;
                readonly blackboard?: {
                    readonly key: string;
                    readonly version: string;
                    readonly author_agent_id: string;
                    readonly payload: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                } | null | undefined;
                readonly budget?: {
                    readonly agent_id: string;
                    readonly state: {
                        readonly kind: string;
                        readonly limit: string | null;
                        readonly used: string;
                        readonly reserved: string;
                        readonly remaining: string | null;
                        readonly uncertain: string;
                        readonly incomplete: boolean;
                    };
                } | null | undefined;
                readonly capability?: {
                    readonly id: string;
                    readonly root_id: string;
                    readonly agent_id: string;
                    readonly issuer_agent_id: string;
                    readonly operations: readonly string[] | null;
                    readonly scopes: readonly string[] | null;
                    readonly file_scope?: string | undefined;
                    readonly file_issuer_id?: string | undefined;
                    readonly file_issuer_generation?: string | undefined;
                    readonly mcp: readonly {
                        readonly server: string;
                        readonly tool: string;
                        readonly definition: string;
                    }[] | null;
                    readonly mcp_all: boolean;
                    readonly browser?: {
                        readonly provider_id: string;
                        readonly provider_epoch: string;
                        readonly tab_id: string;
                        readonly tab_generation: string;
                        readonly profile_id: string;
                        readonly attachment_id?: string | undefined;
                        readonly attachment_generation?: string | undefined;
                        readonly rights: readonly string[] | null;
                        readonly preview?: {
                            readonly host_id: string;
                            readonly host_identity: string;
                            readonly connection_generation: string;
                            readonly environment_id: string;
                            readonly loopback: string;
                            readonly ports: readonly number[] | null;
                        } | null | undefined;
                    } | null | undefined;
                    readonly browser_issuer_id?: string | undefined;
                    readonly browser_issuer_generation?: number | undefined;
                    readonly browser_delegation_only?: boolean | undefined;
                    readonly generation: string;
                    readonly status: string;
                    readonly expires_at: string;
                    readonly created_at: string;
                    readonly updated_at: string;
                } | null | undefined;
                readonly schedule: {
                    readonly id: number;
                    readonly schedule: string;
                    readonly prompt: string;
                    readonly anchor: string;
                    readonly last_fire: string;
                } | null;
                readonly permission?: {
                    readonly id: string;
                    readonly agent_id: string;
                    readonly operation_id: string;
                    readonly operation: string;
                    readonly canonical_path: string;
                    readonly request_digest: string;
                    readonly capability_id: string;
                    readonly capability_generation: string;
                    readonly status: string;
                    readonly command: string;
                    readonly rule: string;
                } | null | undefined;
                readonly body?: {
                    readonly inline?: unknown;
                    readonly text?: null | string | undefined;
                    readonly binary?: string | null | undefined;
                    readonly reference_id: string;
                    readonly digest: string;
                    readonly size: string;
                    readonly media_type: string;
                    readonly source: string;
                } | null | undefined;
            } | {
                readonly agent?: {
                    readonly execution_engine: string;
                    readonly last_turn?: {
                        readonly turn_id?: string | undefined;
                        readonly status: string;
                        readonly started_at?: string | undefined;
                        readonly finished_at?: string | undefined;
                        readonly event_seq: string;
                        readonly error?: string | undefined;
                        readonly error_truncated?: boolean | undefined;
                        readonly error_details?: {
                            readonly inline?: unknown;
                            readonly text?: null | string | undefined;
                            readonly binary?: string | null | undefined;
                            readonly reference_id: string;
                            readonly digest: string;
                            readonly size: string;
                            readonly media_type: string;
                            readonly source: string;
                        } | null | undefined;
                        readonly model_calls?: number | undefined;
                        readonly compactions?: number | undefined;
                        readonly last_activity_at?: string | undefined;
                    } | null | undefined;
                    readonly id: string;
                    readonly root_id: string;
                    readonly parent_id: string;
                    readonly name: string;
                    readonly model: string;
                    readonly provider: string;
                    readonly effort: string;
                    readonly cwd: string;
                    readonly report: string;
                    readonly status: string;
                    readonly pending_mail: number;
                    readonly lifecycle_phase: string;
                    readonly blocking_reason: string;
                    readonly terminal_cause: string;
                    readonly allowed_controls: readonly string[] | null;
                } | null | undefined;
                readonly inbox?: {
                    readonly delivery_seq?: string | undefined;
                    readonly origin?: string | undefined;
                    readonly command_client_id?: string | undefined;
                    readonly command_id?: string | undefined;
                    readonly steer_turn_id?: string | undefined;
                    readonly preview?: {
                        readonly design_context?: {
                            readonly context_attachment_id: string;
                            readonly screenshot_attachment_id?: string | undefined;
                            readonly elements: readonly {
                                readonly label: string;
                                readonly selector?: string | undefined;
                            }[] | null;
                            readonly element_count: number;
                            readonly page_url?: string | undefined;
                            readonly page_title?: string | undefined;
                        } | null | undefined;
                        readonly text: string;
                        readonly truncated?: boolean | undefined;
                        readonly attachments?: readonly {
                            readonly kind: string;
                            readonly name?: string | undefined;
                            readonly content: {
                                readonly inline?: unknown;
                                readonly text?: null | string | undefined;
                                readonly binary?: string | null | undefined;
                                readonly reference_id: string;
                                readonly digest: string;
                                readonly size: string;
                                readonly media_type: string;
                                readonly source: string;
                            };
                        }[] | null | undefined;
                        readonly attachment_count?: number | undefined;
                    } | null | undefined;
                    readonly root_id: string;
                    readonly agent_id: string;
                    readonly seq: string;
                    readonly kind: string;
                    readonly status: string;
                    readonly payload: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                } | null | undefined;
                readonly blackboard?: {
                    readonly key: string;
                    readonly version: string;
                    readonly author_agent_id: string;
                    readonly payload: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                } | null | undefined;
                readonly budget?: {
                    readonly agent_id: string;
                    readonly state: {
                        readonly kind: string;
                        readonly limit: string | null;
                        readonly used: string;
                        readonly reserved: string;
                        readonly remaining: string | null;
                        readonly uncertain: string;
                        readonly incomplete: boolean;
                    };
                } | null | undefined;
                readonly capability?: {
                    readonly id: string;
                    readonly root_id: string;
                    readonly agent_id: string;
                    readonly issuer_agent_id: string;
                    readonly operations: readonly string[] | null;
                    readonly scopes: readonly string[] | null;
                    readonly file_scope?: string | undefined;
                    readonly file_issuer_id?: string | undefined;
                    readonly file_issuer_generation?: string | undefined;
                    readonly mcp: readonly {
                        readonly server: string;
                        readonly tool: string;
                        readonly definition: string;
                    }[] | null;
                    readonly mcp_all: boolean;
                    readonly browser?: {
                        readonly provider_id: string;
                        readonly provider_epoch: string;
                        readonly tab_id: string;
                        readonly tab_generation: string;
                        readonly profile_id: string;
                        readonly attachment_id?: string | undefined;
                        readonly attachment_generation?: string | undefined;
                        readonly rights: readonly string[] | null;
                        readonly preview?: {
                            readonly host_id: string;
                            readonly host_identity: string;
                            readonly connection_generation: string;
                            readonly environment_id: string;
                            readonly loopback: string;
                            readonly ports: readonly number[] | null;
                        } | null | undefined;
                    } | null | undefined;
                    readonly browser_issuer_id?: string | undefined;
                    readonly browser_issuer_generation?: number | undefined;
                    readonly browser_delegation_only?: boolean | undefined;
                    readonly generation: string;
                    readonly status: string;
                    readonly expires_at: string;
                    readonly created_at: string;
                    readonly updated_at: string;
                } | null | undefined;
                readonly schedule?: {
                    readonly id: number;
                    readonly schedule: string;
                    readonly prompt: string;
                    readonly anchor: string;
                    readonly last_fire: string;
                } | null | undefined;
                readonly permission: {
                    readonly id: string;
                    readonly agent_id: string;
                    readonly operation_id: string;
                    readonly operation: string;
                    readonly canonical_path: string;
                    readonly request_digest: string;
                    readonly capability_id: string;
                    readonly capability_generation: string;
                    readonly status: string;
                    readonly command: string;
                    readonly rule: string;
                } | null;
                readonly body?: {
                    readonly inline?: unknown;
                    readonly text?: null | string | undefined;
                    readonly binary?: string | null | undefined;
                    readonly reference_id: string;
                    readonly digest: string;
                    readonly size: string;
                    readonly media_type: string;
                    readonly source: string;
                } | null | undefined;
            } | {
                readonly agent?: {
                    readonly execution_engine: string;
                    readonly last_turn?: {
                        readonly turn_id?: string | undefined;
                        readonly status: string;
                        readonly started_at?: string | undefined;
                        readonly finished_at?: string | undefined;
                        readonly event_seq: string;
                        readonly error?: string | undefined;
                        readonly error_truncated?: boolean | undefined;
                        readonly error_details?: {
                            readonly inline?: unknown;
                            readonly text?: null | string | undefined;
                            readonly binary?: string | null | undefined;
                            readonly reference_id: string;
                            readonly digest: string;
                            readonly size: string;
                            readonly media_type: string;
                            readonly source: string;
                        } | null | undefined;
                        readonly model_calls?: number | undefined;
                        readonly compactions?: number | undefined;
                        readonly last_activity_at?: string | undefined;
                    } | null | undefined;
                    readonly id: string;
                    readonly root_id: string;
                    readonly parent_id: string;
                    readonly name: string;
                    readonly model: string;
                    readonly provider: string;
                    readonly effort: string;
                    readonly cwd: string;
                    readonly report: string;
                    readonly status: string;
                    readonly pending_mail: number;
                    readonly lifecycle_phase: string;
                    readonly blocking_reason: string;
                    readonly terminal_cause: string;
                    readonly allowed_controls: readonly string[] | null;
                } | null | undefined;
                readonly inbox?: {
                    readonly delivery_seq?: string | undefined;
                    readonly origin?: string | undefined;
                    readonly command_client_id?: string | undefined;
                    readonly command_id?: string | undefined;
                    readonly steer_turn_id?: string | undefined;
                    readonly preview?: {
                        readonly design_context?: {
                            readonly context_attachment_id: string;
                            readonly screenshot_attachment_id?: string | undefined;
                            readonly elements: readonly {
                                readonly label: string;
                                readonly selector?: string | undefined;
                            }[] | null;
                            readonly element_count: number;
                            readonly page_url?: string | undefined;
                            readonly page_title?: string | undefined;
                        } | null | undefined;
                        readonly text: string;
                        readonly truncated?: boolean | undefined;
                        readonly attachments?: readonly {
                            readonly kind: string;
                            readonly name?: string | undefined;
                            readonly content: {
                                readonly inline?: unknown;
                                readonly text?: null | string | undefined;
                                readonly binary?: string | null | undefined;
                                readonly reference_id: string;
                                readonly digest: string;
                                readonly size: string;
                                readonly media_type: string;
                                readonly source: string;
                            };
                        }[] | null | undefined;
                        readonly attachment_count?: number | undefined;
                    } | null | undefined;
                    readonly root_id: string;
                    readonly agent_id: string;
                    readonly seq: string;
                    readonly kind: string;
                    readonly status: string;
                    readonly payload: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                } | null | undefined;
                readonly blackboard?: {
                    readonly key: string;
                    readonly version: string;
                    readonly author_agent_id: string;
                    readonly payload: {
                        readonly inline?: unknown;
                        readonly text?: null | string | undefined;
                        readonly binary?: string | null | undefined;
                        readonly reference_id: string;
                        readonly digest: string;
                        readonly size: string;
                        readonly media_type: string;
                        readonly source: string;
                    };
                } | null | undefined;
                readonly budget?: {
                    readonly agent_id: string;
                    readonly state: {
                        readonly kind: string;
                        readonly limit: string | null;
                        readonly used: string;
                        readonly reserved: string;
                        readonly remaining: string | null;
                        readonly uncertain: string;
                        readonly incomplete: boolean;
                    };
                } | null | undefined;
                readonly capability?: {
                    readonly id: string;
                    readonly root_id: string;
                    readonly agent_id: string;
                    readonly issuer_agent_id: string;
                    readonly operations: readonly string[] | null;
                    readonly scopes: readonly string[] | null;
                    readonly file_scope?: string | undefined;
                    readonly file_issuer_id?: string | undefined;
                    readonly file_issuer_generation?: string | undefined;
                    readonly mcp: readonly {
                        readonly server: string;
                        readonly tool: string;
                        readonly definition: string;
                    }[] | null;
                    readonly mcp_all: boolean;
                    readonly browser?: {
                        readonly provider_id: string;
                        readonly provider_epoch: string;
                        readonly tab_id: string;
                        readonly tab_generation: string;
                        readonly profile_id: string;
                        readonly attachment_id?: string | undefined;
                        readonly attachment_generation?: string | undefined;
                        readonly rights: readonly string[] | null;
                        readonly preview?: {
                            readonly host_id: string;
                            readonly host_identity: string;
                            readonly connection_generation: string;
                            readonly environment_id: string;
                            readonly loopback: string;
                            readonly ports: readonly number[] | null;
                        } | null | undefined;
                    } | null | undefined;
                    readonly browser_issuer_id?: string | undefined;
                    readonly browser_issuer_generation?: number | undefined;
                    readonly browser_delegation_only?: boolean | undefined;
                    readonly generation: string;
                    readonly status: string;
                    readonly expires_at: string;
                    readonly created_at: string;
                    readonly updated_at: string;
                } | null | undefined;
                readonly schedule?: {
                    readonly id: number;
                    readonly schedule: string;
                    readonly prompt: string;
                    readonly anchor: string;
                    readonly last_fire: string;
                } | null | undefined;
                readonly permission?: {
                    readonly id: string;
                    readonly agent_id: string;
                    readonly operation_id: string;
                    readonly operation: string;
                    readonly canonical_path: string;
                    readonly request_digest: string;
                    readonly capability_id: string;
                    readonly capability_generation: string;
                    readonly status: string;
                    readonly command: string;
                    readonly rule: string;
                } | null | undefined;
                readonly body: {
                    readonly inline?: unknown;
                    readonly text?: null | string | undefined;
                    readonly binary?: string | null | undefined;
                    readonly reference_id: string;
                    readonly digest: string;
                    readonly size: string;
                    readonly media_type: string;
                    readonly source: string;
                } | null;
            })[] | null;
            readonly next_cursor?: {
                readonly root_id: string;
                readonly collection: string;
                readonly revision: string;
                readonly offset: string;
            } | null | undefined;
            readonly has_more: boolean;
        };
    };
    readonly unverifiedInbox?: readonly {
        readonly delivery_seq?: string | undefined;
        readonly origin?: string | undefined;
        readonly command_client_id?: string | undefined;
        readonly command_id?: string | undefined;
        readonly steer_turn_id?: string | undefined;
        readonly preview?: {
            readonly design_context?: {
                readonly context_attachment_id: string;
                readonly screenshot_attachment_id?: string | undefined;
                readonly elements: readonly {
                    readonly label: string;
                    readonly selector?: string | undefined;
                }[] | null;
                readonly element_count: number;
                readonly page_url?: string | undefined;
                readonly page_title?: string | undefined;
            } | null | undefined;
            readonly text: string;
            readonly truncated?: boolean | undefined;
            readonly attachments?: readonly {
                readonly kind: string;
                readonly name?: string | undefined;
                readonly content: {
                    readonly inline?: unknown;
                    readonly text?: null | string | undefined;
                    readonly binary?: string | null | undefined;
                    readonly reference_id: string;
                    readonly digest: string;
                    readonly size: string;
                    readonly media_type: string;
                    readonly source: string;
                };
            }[] | null | undefined;
            readonly attachment_count?: number | undefined;
        } | null | undefined;
        readonly root_id: string;
        readonly agent_id: string;
        readonly seq: string;
        readonly kind: string;
        readonly status: string;
        readonly payload: {
            readonly inline?: unknown;
            readonly text?: null | string | undefined;
            readonly binary?: string | null | undefined;
            readonly reference_id: string;
            readonly digest: string;
            readonly size: string;
            readonly media_type: string;
            readonly source: string;
        };
    }[] | undefined;
    readonly retainedBytes: number;
    readonly executions?: {
        readonly rootId: string;
        readonly revision: string;
        readonly cursor: string;
        readonly rows: readonly ({
            readonly partId?: string | undefined;
            readonly kind: "cell";
            readonly id: string;
            readonly callId: string;
            readonly agentId: string;
            readonly turnId?: string | undefined;
            readonly eventSeq: string;
            readonly presentationSeqs?: readonly string[] | undefined;
            readonly seq?: number | undefined;
            readonly code: string;
            readonly output: string;
            readonly value?: string | undefined;
            readonly hasValue?: boolean | undefined;
            readonly executionEngine?: string | undefined;
            readonly language?: string | undefined;
            readonly error?: string | undefined;
            readonly scratch?: string | undefined;
            readonly status: "writing" | "running" | "completed" | "failed" | "interrupted" | "cancelled" | "unknown";
            readonly hosts: readonly {
                readonly display?: {
                    readonly target?: string | undefined;
                    readonly command?: string | undefined;
                    readonly query?: string | undefined;
                    readonly child_id?: string | undefined;
                    readonly label?: string | undefined;
                } | undefined;
                readonly id: string;
                readonly invocationId?: string | undefined;
                readonly status: "running" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown";
                readonly name: string;
                readonly summary: string;
                readonly duration: string;
                readonly error?: string | undefined;
            }[];
            readonly steps?: number | undefined;
            readonly quickjsJobs?: number | undefined;
            readonly observedStartedAt?: number | undefined;
            readonly observedEndedAt?: number | undefined;
            readonly truncated?: boolean | undefined;
            readonly historyUnmatched?: boolean | undefined;
            readonly body?: {
                readonly reference_id: string;
                readonly digest: string;
                readonly size: string;
                readonly media_type?: string | undefined;
                readonly source?: string | undefined;
            } | undefined;
            readonly codeBody?: {
                readonly reference_id: string;
                readonly digest: string;
                readonly size: string;
                readonly media_type?: string | undefined;
                readonly source?: string | undefined;
            } | undefined;
            readonly afterSeq: number;
            readonly closed?: boolean | undefined;
            readonly recordedId?: string | undefined;
            readonly recordedResultSeq?: number | undefined;
            readonly historyUnknown?: boolean | undefined;
        } | {
            readonly kind: "restart";
            readonly historyUnmatched?: boolean | undefined;
            readonly id: string;
            readonly agentId: string;
            readonly text: string;
            readonly seq?: number | undefined;
            readonly eventSeq: string;
            readonly turnId?: string | undefined;
            readonly afterSeq: number;
            readonly closed?: boolean | undefined;
            readonly recordedId?: string | undefined;
            readonly recordedResultSeq?: number | undefined;
            readonly historyUnknown?: boolean | undefined;
        })[];
        readonly truncated: boolean;
    } | undefined;
    readonly trace?: {
        readonly rootId: string;
        readonly pageCursor: string;
        readonly spans: {
            readonly [x: string]: {
                readonly id: string;
                readonly traceId: string;
                readonly parentId: string;
                readonly rootId: string;
                readonly agentId: string;
                readonly turnId: string;
                readonly kind: import("./trace.js").TraceSpanKind;
                readonly name: string;
                readonly status: import("./trace.js").TraceSpanStatus;
                readonly startMs: number;
                readonly endMs: number;
                readonly attrs: {
                    readonly [x: string]: unknown;
                };
                readonly links: readonly {
                    readonly traceId: string;
                    readonly spanId: string;
                }[];
                readonly updatedSeq: string;
            };
        };
        readonly loaded: boolean;
        readonly loading: boolean;
        readonly hasMore: boolean;
        readonly truncated: boolean;
        readonly clockOffsetMs: number;
        readonly error?: {
            readonly name: string;
            readonly message: string;
            readonly stack?: string | undefined;
            readonly cause?: unknown;
        } | undefined;
    } | undefined;
    readonly truncated: boolean;
    readonly unavailable: boolean;
    readonly error?: {
        readonly name: string;
        readonly message: string;
        readonly stack?: string | undefined;
        readonly cause?: unknown;
    } | undefined;
};
export declare function useSessionListView(view: SessionListView): {
    readonly status: "error" | "closed" | "idle" | "loading" | "live" | "stale";
    readonly page?: {
        readonly revision: string;
        readonly items: readonly {
            readonly id: string;
            readonly kind: string;
            readonly title: string;
            readonly model: string;
            readonly provider: string;
            readonly cwd: string;
            readonly workspace_id?: string | undefined;
            readonly pinned: boolean;
            readonly archived: boolean;
            readonly updated_at: string;
            readonly truncated: boolean;
        }[] | null;
        readonly next_cursor?: {
            readonly revision: string;
            readonly offset: string;
            readonly search?: string | undefined;
            readonly status: "active" | "archived" | "all";
        } | null | undefined;
        readonly has_more: boolean;
    } | undefined;
    readonly error?: {
        readonly name: string;
        readonly message: string;
        readonly stack?: string | undefined;
        readonly cause?: unknown;
    } | undefined;
    readonly truncated: boolean;
};
export declare function useWhipConnection(client: WhipClient): import("./client.js").ConnectionSnapshot;
