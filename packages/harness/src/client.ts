import { randomUUID } from "node:crypto";

import type { Logger } from "@loupe/logger";
import type {
  Session,
  Turn,
  TurnEvent,
  TurnResult,
  TurnUsage,
} from "@whip/sdk";
import type { AgentDefinition } from "@whip/sdk/agents";
import type { WhipClient } from "@whip/sdk/node";
import { createWhipClient, unixSocket } from "@whip/sdk/node";

import type { DaemonHandle } from "./daemon";
import { RunProgress } from "./progress";

/** Attach to the daemon over its Unix socket. */
export async function connect(
  daemon: DaemonHandle,
  logger: Logger,
): Promise<WhipClient> {
  const client = createWhipClient({
    endpoint: unixSocket(daemon.socket),
    clientId: `loupe-${randomUUID()}`,
    clientKind: "automation",
  });
  await client.connect();
  const info = client.getSnapshot().info;
  logger.debug("Connected to whip daemon", {
    socket: daemon.socket,
    build: info?.build_id,
    protocol: `${info?.protocol_major}.${info?.protocol_minor}`,
  });
  return client;
}

/** How one session on a served agent is set up. */
export type SessionParams = {
  /** Working directory the session's host modules operate in. */
  readonly cwd: string;
  /** Model id; empty uses the daemon's default. */
  readonly model?: string;
  /** Provider the model is routed through; empty uses the daemon's default. */
  readonly provider?: string;
  /** Reasoning effort for this session; unset leaves the daemon's default. */
  readonly effort?: string;
  /** Cap on tool-call rounds per turn; 0 or omitted is uncapped. */
  readonly maxTurns?: number;
  /** Stable prompt-cache key (repo/reviewer) shared across runs. */
  readonly cacheKey?: string;
};

export type RunSpec = SessionParams & {
  readonly agent: AgentDefinition;
  readonly prompt: string;
  /** Sees every turn event (after the log has); a trace sink hangs here. */
  readonly onEvent?: (event: TurnEvent) => void;
  readonly logger: Logger;
};

/** What one turn hands back: the final reply and, under an output contract, the validated value. */
export type RunOutcome = {
  readonly text: string;
  /** The daemon-validated output; undefined without a contract or when the
   * turn cap answered without the check (see core's outcomeText). */
  readonly output: unknown;
  readonly usage?: TurnUsage;
};

/** A session on a served agent that can take several turns. */
export interface AgentRun {
  readonly rootId: string;
  /** Run one turn and return its outcome; a failed turn throws. */
  run(
    prompt: string,
    onEvent?: (event: TurnEvent) => void,
  ): Promise<RunOutcome>;
  /** Delete the session so one-off runs don't pile up in the daemon. */
  close(): Promise<void>;
}

/** A definition this process serves (or has registered) and can open sessions on. */
export interface ServedAgent {
  readonly definition: string;
  session(params: SessionParams): Promise<AgentRun>;
  /** Stop serving; open sessions may still be closed afterwards. */
  close(): void;
}

function failed(
  operation: string,
  outcome: { status: string; failure?: null | { message: string } },
): Error {
  return new Error(
    `whip ${operation} failed: ${outcome.failure?.message ?? outcome.status}`,
  );
}

/** An agent with tools or hooks needs this process bound as its executor; a
 * plain definition only needs registering, and `serve` refuses it. */
function needsExecutor(agent: AgentDefinition): boolean {
  return (
    agent.handlers.size > 0 ||
    Boolean(
      agent.hooks.before_tool ??
      agent.hooks.before_spawn ??
      agent.hooks.turn_start,
    )
  );
}

/** Feed a turn's events to the log and settle its result; a consumer that
 * falls behind fails the iterable, never the result. */
async function observe(
  turn: Turn,
  progress: RunProgress,
  onEvent: ((event: TurnEvent) => void) | undefined,
  log: Logger,
): Promise<TurnResult> {
  try {
    for await (const event of turn) {
      progress.observe(event);
      onEvent?.(event);
    }
  } catch (err: unknown) {
    log.debug("turn event stream ended early", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return turn.result();
}

/**
 * Serve an agent from this process (or only register it when it has no tools
 * or hooks) and hand back a handle that opens sessions pinned to it. Each
 * session is created in automatic permission mode, configured headless with
 * its turn cap and cache key, and runs turns through `session.run`, whose
 * typed events feed the log and whose result carries the output contract's
 * validated value.
 */
export async function serveAgent(
  client: WhipClient,
  agent: AgentDefinition,
  logger: Logger,
): Promise<ServedAgent> {
  const log = logger.child("whip");
  const runtime = needsExecutor(agent)
    ? await client.agents.serve(agent)
    : undefined;
  const definition = runtime
    ? runtime.definition
    : (await client.agents.register(agent)).id;
  log.debug("Serving agent", { definition, executor: Boolean(runtime) });

  const open = async (params: SessionParams): Promise<Session> => {
    const create = {
      cwd: params.cwd,
      model: params.model ?? "",
      provider: params.provider ?? "",
      permission_mode: "automatic",
    };
    if (runtime) return runtime.sessions.create(create);
    const created = await client.sessions
      .create({ ...create, definition })
      .result();
    if (created.status !== "succeeded" || !created.result) {
      throw failed("session.create", created);
    }
    return client.session(created.result.root_id);
  };

  return {
    definition,
    async session(params) {
      const session = await open(params);
      const configured = await session
        .configure({
          headless: true,
          ...(params.maxTurns ? { max_turns: params.maxTurns } : {}),
          ...(params.cacheKey ? { cache_key: params.cacheKey } : {}),
        })
        .result();
      if (configured.status !== "succeeded") {
        throw failed("run.configure", configured);
      }
      if (params.effort) {
        const effort = await session.setEffort(params.effort, false).result();
        if (effort.status !== "succeeded")
          throw failed("session.effort", effort);
      }
      return {
        rootId: session.rootId,
        async run(prompt, onEvent) {
          const progress = new RunProgress(log, session.rootId);
          const result = await observe(
            session.run(prompt, { includeChildren: true }),
            progress,
            onEvent,
            log,
          );
          progress.finish(result.usage);
          if (result.status !== "succeeded") throw failed("turn", result);
          return {
            text: result.text,
            output: result.output,
            usage: result.usage,
          };
        },
        close: () =>
          client.sessions
            .delete(session.rootId)
            .result()
            .then(() => undefined)
            .catch(() => undefined),
      };
    },
    close: () => runtime?.close(),
  };
}

/** Serve an agent, run one turn on a fresh session, and let go of both. */
export async function runAgent(
  client: WhipClient,
  spec: RunSpec,
): Promise<RunOutcome> {
  const served = await serveAgent(client, spec.agent, spec.logger);
  try {
    const session = await served.session(spec);
    try {
      return await session.run(spec.prompt, spec.onEvent);
    } finally {
      await session.close();
    }
  } finally {
    served.close();
  }
}
