import { readFileSync } from "node:fs";

import {
  dotenvProvider,
  envProvider,
  infisicalProvider,
  type CredentialProvider,
} from "@loupe/credentials";
import { z } from "zod";

/**
 * All environment reading happens here, parsed with Zod, then passed inward as
 * typed values. Nothing downstream touches process.env.
 */
const envSchema = z.object({
  GITHUB_TOKEN: z.string().min(1, "GITHUB_TOKEN is required"),
  GITHUB_REPOSITORY: z.string().regex(/^[^/]+\/[^/]+$/, "expected owner/repo"),
  GITHUB_EVENT_PATH: z.string().optional(),
  GITHUB_WORKSPACE: z.string().optional(),
  LOUPE_PR_NUMBER: z.coerce.number().int().positive().optional(),
  LOUPE_HARNESS: z.string().default("claude"),
  LOUPE_CONVENTION_PATHS: z
    .string()
    .default("CLAUDE.md,AGENTS.md,.loupe.md,CONTRIBUTING.md"),
  LOUPE_CREDENTIAL_PROVIDERS: z.string().default("env,dotenv"),
  LOUPE_INFISICAL_ENV: z.string().optional(),
  LOUPE_INFISICAL_PROJECT_ID: z.string().optional(),
});

export type Config = {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly harnessName: string;
  readonly workdir: string;
  readonly conventionPaths: readonly string[];
  readonly providers: readonly CredentialProvider[];
};

export function loadConfig(): Config {
  const env = envSchema.parse(process.env);
  const [owner, repo] = env.GITHUB_REPOSITORY.split("/") as [string, string];

  return {
    token: env.GITHUB_TOKEN,
    owner,
    repo,
    pullNumber: resolvePullNumber(env.LOUPE_PR_NUMBER, env.GITHUB_EVENT_PATH),
    harnessName: env.LOUPE_HARNESS,
    workdir: env.GITHUB_WORKSPACE ?? process.cwd(),
    conventionPaths: env.LOUPE_CONVENTION_PATHS.split(",")
      .map((p) => p.trim())
      .filter(Boolean),
    providers: buildProviders(env),
  };
}

function resolvePullNumber(
  explicit: number | undefined,
  eventPath: string | undefined,
): number {
  if (explicit) return explicit;
  if (eventPath) {
    const event: unknown = JSON.parse(readFileSync(eventPath, "utf8"));
    const parsed = z
      .object({ pull_request: z.object({ number: z.number() }) })
      .safeParse(event);
    if (parsed.success) return parsed.data.pull_request.number;
  }
  throw new Error(
    "Could not determine PR number: set LOUPE_PR_NUMBER or run on a pull_request event",
  );
}

/** Build a provider chain from a comma-separated spec like "env,dotenv,infisical". */
export function resolveProviders(
  spec: string,
  infisical: { env?: string; projectId?: string } = {},
): readonly CredentialProvider[] {
  return spec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((name) => {
      switch (name) {
        case "env":
          return envProvider();
        case "dotenv":
          return dotenvProvider();
        case "infisical":
          return infisicalProvider(infisical);
        default:
          throw new Error(`Unknown credential provider "${name}"`);
      }
    });
}

function buildProviders(
  env: z.infer<typeof envSchema>,
): readonly CredentialProvider[] {
  return resolveProviders(env.LOUPE_CREDENTIAL_PROVIDERS, {
    env: env.LOUPE_INFISICAL_ENV,
    projectId: env.LOUPE_INFISICAL_PROJECT_ID,
  });
}
