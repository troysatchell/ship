/**
 * Config resolution for `ship login`/`ship whoami` (PF-600). Deliberately
 * tiny and pure (every function takes the values it needs as arguments,
 * including `env`, rather than reading `process.env` internally) so it is
 * testable with a plain object literal — no `vi.stubEnv`/global mutation
 * needed anywhere in this file's own tests.
 */
import os from 'node:os';
import path from 'node:path';

/** Thrown for a configuration problem the user needs to fix (a missing
 *  client id, not a network/auth failure once the flow is running) — a
 *  distinct type from `ShipSdkError` so `commands/*`'s error rendering can
 *  tell "you haven't configured this yet" apart from "the server said no". */
export class CliConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliConfigError';
  }
}

/**
 * The OAuth `client_id` this CLI authenticates as (RFC 8628 device flow —
 * every `POST /oauth/device/code` request requires one, `deviceLogin.ts`'s
 * own header). PLUGFORGE.MD's PF-102 (app registration) is an admin-only
 * endpoint with no fixed, pre-seeded "the CLI's client_id" value anywhere in
 * this repo (verified: no `ship_cli`/similar row in `api/src/db/seed.ts`) —
 * so unlike `baseUrl` below, there is no sane hardcoded default here. An
 * operator who has registered an OAuth app for this CLI sets
 * `SHIP_CLI_CLIENT_ID`; `--client-id` overrides it per-invocation.
 */
export const CLIENT_ID_ENV_VAR = 'SHIP_CLI_CLIENT_ID';

export function resolveClientId(argClientId: string | undefined, env: NodeJS.ProcessEnv): string {
  const fromArg = argClientId && argClientId.length > 0 ? argClientId : undefined;
  const fromEnv = env[CLIENT_ID_ENV_VAR] && env[CLIENT_ID_ENV_VAR]!.length > 0 ? env[CLIENT_ID_ENV_VAR] : undefined;
  const clientId = fromArg ?? fromEnv;
  if (!clientId) {
    throw new CliConfigError(
      `No OAuth client id configured. Pass --client-id, or set ${CLIENT_ID_ENV_VAR} to the client_id of an ` +
        `OAuth app registered for this CLI (PLUGFORGE.MD PF-102's app-registration endpoint mints one).`
    );
  }
  return clientId;
}

/**
 * `SHIP_API_BASE_URL` is deliberately reused, not a second CLI-specific
 * variable — `@ship/sdk`'s own `resolveDefaultBaseUrl()` (`client.ts`)
 * already reads this exact name and already falls back to
 * `http://localhost:3000` (`agent/src/config.ts`'s own established default)
 * when unset. Returning `undefined` here (rather than resolving the default
 * ourselves) lets that one piece of fallback logic stay owned by the SDK —
 * this function's job is only to thread `--base-url` ahead of it when given.
 */
export function resolveBaseUrl(argBaseUrl: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (argBaseUrl && argBaseUrl.length > 0) return argBaseUrl;
  const fromEnv = env.SHIP_API_BASE_URL;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

export const CREDENTIALS_PATH_ENV_VAR = 'SHIP_CLI_CREDENTIALS_PATH';

/**
 * `~/.ship/credentials.json` (PF-600's own AC, verbatim) — overridable via
 * `SHIP_CLI_CREDENTIALS_PATH` so tests never touch a real `$HOME`.
 */
export function resolveCredentialsPath(env: NodeJS.ProcessEnv): string {
  const override = env[CREDENTIALS_PATH_ENV_VAR];
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), '.ship', 'credentials.json');
}
