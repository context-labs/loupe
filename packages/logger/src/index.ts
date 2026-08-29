import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { OpenTelemetryTransportV3 } from "@opentelemetry/winston-transport";
import {
  createLogger,
  format,
  transports,
  type Logger as Winston,
  type transport as WinstonTransport,
} from "winston";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export type LogProps = Record<string, unknown>;

/** Structured logger: `logger.info("msg", { field })`, mirrors the monorepo shape. */
export type Logger = {
  debug(message: string, props?: LogProps): void;
  info(message: string, props?: LogProps): void;
  warn(message: string, props?: LogProps): void;
  error(message: string, props?: LogProps): void;
  child(name: string, props?: LogProps): Logger;
};

function parseLevel(raw: string | undefined): LogLevel {
  if (!raw) return "info";
  const lower = raw.toLowerCase();
  if ((LEVELS as readonly string[]).includes(lower)) return lower as LogLevel;
  throw new Error(`Invalid LOG_LEVEL "${raw}". Use: ${LEVELS.join(", ")}`);
}

const isDeployed =
  process.env.CI === "true" || process.env.IS_DEPLOYED === "true";

let provider: LoggerProvider | undefined;

/**
 * Build the winston pipeline. Pretty output locally, JSON in CI. When
 * OTEL_EXPORTER_OTLP_ENDPOINT is set, also bridge every record to OTLP logs
 * via the official winston→OTel transport (attaches trace context if a span is
 * active) — otherwise stays stdout-only so the tool runs with no collector.
 */
function buildWinston(serviceName: string): Winston {
  const level = parseLevel(process.env.LOG_LEVEL);
  const sinks: WinstonTransport[] = [
    new transports.Console({
      format: isDeployed
        ? format.combine(format.timestamp(), format.json())
        : format.combine(
            format.colorize(),
            format.timestamp({ format: "HH:mm:ss" }),
            format.printf((info) => {
              const { timestamp, level: lvl, message, ...rest } = info;
              const extra = Object.keys(rest).length
                ? ` ${JSON.stringify(rest)}`
                : "";
              return `${timestamp as string} ${lvl} ${message as string}${extra}`;
            }),
          ),
    }),
  ];

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint) {
    provider = new LoggerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
      processors: [
        new BatchLogRecordProcessor(new OTLPLogExporter({ url: endpoint })),
      ],
    });
    logs.setGlobalLoggerProvider(provider);
    sinks.push(new OpenTelemetryTransportV3());
  }

  return createLogger({ level, transports: sinks });
}

function wrap(winston: Winston): Logger {
  return {
    debug: (m, p) => void winston.debug(m, p),
    info: (m, p) => void winston.info(m, p),
    warn: (m, p) => void winston.warn(m, p),
    error: (m, p) => void winston.error(m, p),
    child: (name, p) => wrap(winston.child({ component: name, ...p })),
  };
}

/** Create the root logger for a service/tool. Call once at startup. */
export function createRootLogger(serviceName: string): Logger {
  return wrap(buildWinston(serviceName));
}

/** Flush and close the OTLP exporter, if one was configured. Call at exit. */
export async function shutdownLogger(): Promise<void> {
  if (provider) await provider.shutdown();
}
