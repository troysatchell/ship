/**
 * `ship whoami` (PF-600, PLUGFORGE.MD §4). AC, verbatim: "`ship whoami`
 * works" — reads whatever `FileTokenStore` has persisted (normally via a
 * prior `ship login`) and prints the identity `GET /api/v1/me` reports for
 * it.
 *
 * Reads the store directly first (rather than just constructing a
 * `ShipClient({ tokenStore })` and letting `RequestClient.hydrate()` do it
 * lazily on the first request) so "never logged in" gets its own clear
 * message instead of surfacing as a generic 401 from the server — a real
 * behavioral difference a user should see, not just an implementation
 * detail.
 */
import { FileTokenStore, ShipClient } from '@ship/sdk';
import { resolveBaseUrl, resolveClientId, resolveCredentialsPath } from '../config.js';
import { formatError } from '../errors.js';
import { formatIdentity } from '../identity.js';
import type { Io } from '../io.js';

export interface RunWhoamiOptions {
  io: Io;
  env: NodeJS.ProcessEnv;
  clientId?: string;
  baseUrl?: string;
  credentialsPath?: string;
}

export async function runWhoami(opts: RunWhoamiOptions): Promise<number> {
  const { io } = opts;

  const credentialsPath = opts.credentialsPath ?? resolveCredentialsPath(opts.env);
  const baseUrl = resolveBaseUrl(opts.baseUrl, opts.env);
  const tokenStore = new FileTokenStore(credentialsPath);

  let tokens;
  try {
    tokens = await tokenStore.get();
  } catch (err) {
    // A corrupt/unreadable credentials file (FileTokenStore's own doc
    // comment: this is deliberately NOT the same as "no token yet").
    io.stderr(formatError(err));
    return 1;
  }

  if (!tokens) {
    io.stderr(`Not logged in. Run \`ship login\` first (looked for credentials at ${credentialsPath}).`);
    return 1;
  }

  // clientId is only required for refresh-on-401 to have somewhere to send
  // `POST /oauth/token` (RequestClient's own doc comment) — resolved
  // best-effort here so a whoami with an unexpired token still works even
  // when SHIP_CLI_CLIENT_ID isn't set, matching `ShipClient`'s own
  // "no clientId means refresh-on-401 is simply never attempted" contract.
  let clientId: string | undefined;
  try {
    clientId = resolveClientId(opts.clientId, opts.env);
  } catch {
    clientId = undefined;
  }

  try {
    const client = new ShipClient({
      baseUrl,
      token: tokens.accessToken,
      clientId,
      tokenStore,
    });
    const me = await client.me();
    io.stdout(formatIdentity(me));
    return 0;
  } catch (err) {
    io.stderr(formatError(err));
    return 1;
  }
}
