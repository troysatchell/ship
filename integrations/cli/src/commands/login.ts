/**
 * `ship login` (PF-600, PLUGFORGE.MD §4). AC, verbatim: "prints user_code +
 * verify URL, polls to success." All of the actual RFC 8628 mechanics
 * (request device code, poll `/oauth/token`, honor `slow_down` by genuinely
 * increasing the wait) live in `@ship/sdk`'s `ShipClient.deviceLogin()` —
 * this command is deliberately thin: resolve config, wire the SDK's
 * `onUserCode` callback to this CLI's own `Io`, persist via
 * `FileTokenStore`, and render the result/failure. See `deviceLogin.ts`'s
 * own header (sdk/) for why re-implementing any polling/backoff logic here
 * would be a real regression, not a convenience — this ticket's brief says
 * so explicitly.
 */
import { FileTokenStore, ShipClient, type DeviceLoginFlowOptions } from '@ship/sdk';
import { resolveBaseUrl, resolveClientId, resolveCredentialsPath } from '../config.js';
import { formatError } from '../errors.js';
import { formatIdentity } from '../identity.js';
import type { Io } from '../io.js';

export interface RunLoginOptions {
  io: Io;
  env: NodeJS.ProcessEnv;
  clientId?: string;
  baseUrl?: string;
  scope?: string;
  credentialsPath?: string;
  /** Test-only injection points, threaded straight through to
   *  `ShipClient.deviceLogin` -> `runDeviceLoginFlow` (sdk/src/deviceLogin.ts) —
   *  the exact same "injectable clock/wait, defaults to the real ones"
   *  convention that module's own options already establish, so the fully
   *  mocked-`fetch` tests in `login.test.ts` never need a real `setTimeout`
   *  wait to prove the polling loop actually ran. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Exit code convention for every command in this package: 0 success,
 *  1 any failure (config problem, denied/expired code, network error, or a
 *  non-2xx from the server) — this ticket's AC only requires "non-zero", and
 *  a single failure code keeps `bin.ts` trivial; the printed message (via
 *  `formatError`) is what actually distinguishes the cause for a human. */
export async function runLogin(opts: RunLoginOptions): Promise<number> {
  const { io } = opts;

  let clientId: string;
  let credentialsPath: string;
  let baseUrl: string | undefined;
  try {
    clientId = resolveClientId(opts.clientId, opts.env);
    baseUrl = resolveBaseUrl(opts.baseUrl, opts.env);
    credentialsPath = opts.credentialsPath ?? resolveCredentialsPath(opts.env);
  } catch (err) {
    io.stderr(formatError(err));
    return 1;
  }

  const tokenStore = new FileTokenStore(credentialsPath);

  const onUserCode: DeviceLoginFlowOptions['onUserCode'] = (userCode, verificationUri) => {
    io.stdout(`To authorize this CLI, open: ${verificationUri}`);
    io.stdout(`And enter the code: ${userCode}`);
    io.stdout('Waiting for authorization...');
  };

  try {
    const client = await ShipClient.deviceLogin({
      baseUrl,
      clientId,
      scope: opts.scope,
      tokenStore,
      onUserCode,
      now: opts.now,
      sleep: opts.sleep,
    });

    const me = await client.me();
    io.stdout(`Logged in as ${formatIdentity(me)}.`);
    io.stdout(`Credentials saved to ${credentialsPath}.`);
    return 0;
  } catch (err) {
    io.stderr(formatError(err));
    return 1;
  }
}
