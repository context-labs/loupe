import type { Logger } from "@loupe/logger";

export type Line = {
  level: string;
  message: string;
  props?: Record<string, unknown>;
};

/** A logger that records its lines for assertions. */
export function recorder(): { log: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const log: Logger = {
    debug: (message, props) => lines.push({ level: "debug", message, props }),
    info: (message, props) => lines.push({ level: "info", message, props }),
    warn: (message, props) => lines.push({ level: "warn", message, props }),
    error: (message, props) => lines.push({ level: "error", message, props }),
    child: () => log,
  };
  return { log, lines };
}
