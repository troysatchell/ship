/**
 * RFC 8628 Device Authorization Grant — client side (PF-404, PLUGFORGE.MD
 * §2.8's `ShipClient.deviceLogin`). Talks to the exact server contract
 * `api/src/routes/oauth-device.ts` (PF-106) and the `device_code` branch of
 * `api/src/routes/oauth-token.ts` implement — read from those files
 * directly before writing this, not inferred from RFC 8628's prose alone:
 *
 *   - `POST /oauth/device/code` -> 200
 *     `{ device_code, user_code, verification_uri, verification_uri_complete,
 *        expires_in, interval }` (RFC 8628 §3.2 shape, `oauth-device.ts`'s
 *     own comment), or `{ error, error_description }` (400/401) on failure.
 *   - `POST /oauth/token` with
 *     `grant_type=urn:ietf:params:oauth:grant-type:device_code` ->
 *     the same `{ access_token, token_type, expires_in, scope,
 *     refresh_token? }` success shape every other `/oauth/token` grant
 *     returns, or `{ error, error_description }` with `error` one of
 *     `authorization_pending | slow_down | access_denied | expired_token |
 *     invalid_grant | invalid_request | server_error`
 *     (`device.ts`'s `pollDeviceCode`, `oauth-token.ts`'s dispatch).
 *
 * §2.8's own abbreviated pseudocode signature —
 * `deviceLogin(opts: { onUserCode, tokenStore? })` — omits `clientId` and
 * `baseUrl`, the same way that section's one-line `ShipClient` constructor
 * signature omits `baseUrl` despite `ShipClientOptions.baseUrl` genuinely
 * existing. Both are required here for the identical reason: RFC 8628's
 * device-code request IS a request "as" a specific registered OAuth app
 * (`POST /oauth/device/code` 400s with `invalid_request` with no
 * `client_id`, 401s with `invalid_client` for an unrecognized one —
 * `createDeviceCode`'s own checks), and nothing else tells this client which
 * server to talk to. Stated explicitly here, not silently assumed —
 * CLAUDE.md's claim-provenance rule.
 */

import { ShipSdkError } from './errors.js';
import type { TokenSet } from './tokenStore.js';

export interface DeviceLoginFlowOptions {
  baseUrl: string;
  clientId: string;
  scope?: string;
  /** Called exactly once, as soon as the device code is issued, with the
   * human-facing `user_code` and the plain `verification_uri` the RFC 8628
   * UX describes ("go to this URL and enter this code") — matching §2.8's
   * two-argument `(code, verifyUrl)` callback shape. The server's
   * `verification_uri_complete` (code pre-filled as a query param) is
   * available on the raw device-code response for a caller who wants it,
   * but isn't threaded through this narrower callback. */
  onUserCode: (userCode: string, verificationUri: string) => void;
  /** Injectable clock/wait — same convention this repo already uses for
   * every time-reasoning function (`api/src/platform/oauth/device.ts`'s
   * `now?: () => Date`, `utils/circuitBreaker.ts`'s `now?: () => number`):
   * tests can assert real backoff behavior (esp. `slow_down` honoring) with
   * no real `setTimeout` wait. Both default to the real clock / a real
   * `setTimeout`-based wait. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** RFC 8628 §3.5: "the client MUST increase the interval by 5 seconds for
 * this and all subsequent requests." Same value as
 * `api/src/platform/oauth/device.ts`'s `DEVICE_SLOW_DOWN_INCREMENT_SECONDS`
 * — independently declared here since this module has no (and should have
 * no) server-side import; the RFC, not that constant, is the shared source
 * of truth. */
const SLOW_DOWN_INCREMENT_MS = 5000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

function isDeviceCodeResponse(data: unknown): data is DeviceCodeResponse {
  if (typeof data !== 'object' || data === null) return false;
  const r = data as Record<string, unknown>;
  return (
    typeof r.device_code === 'string' &&
    typeof r.user_code === 'string' &&
    typeof r.verification_uri === 'string' &&
    typeof r.verification_uri_complete === 'string' &&
    typeof r.expires_in === 'number' &&
    typeof r.interval === 'number'
  );
}

/** RFC 6749 §5.2 error shape — what BOTH `/oauth/device/code` and
 * `/oauth/token` return on failure (`{ error, error_description }`), NOT
 * `/api/v1`'s `ApiErrorBody` (`{ code, message, request_id }`) — `errors.ts`'s
 * own header comment makes the identical distinction for why `ShipClient`'s
 * `/api/v1` error parsing doesn't apply here. */
interface OAuthErrorBody {
  error: string;
  error_description?: string;
}

function isOAuthErrorBody(data: unknown): data is OAuthErrorBody {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).error === 'string';
}

interface OAuthTokenSuccessBody {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

function isOAuthTokenSuccessBody(data: unknown): data is OAuthTokenSuccessBody {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).access_token === 'string';
}

async function postForm(baseUrl: string, path: string, params: URLSearchParams): Promise<{ status: number; data: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch (cause) {
    throw ShipSdkError.fromNetworkError(cause);
  }
  const data: unknown = await res.json().catch(() => undefined);
  return { status: res.status, data };
}

async function requestDeviceCode(baseUrl: string, clientId: string, scope: string | undefined): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams();
  body.set('client_id', clientId);
  if (scope) body.set('scope', scope);

  const { status, data } = await postForm(baseUrl, '/oauth/device/code', body);

  if (isDeviceCodeResponse(data)) return data;

  const description = isOAuthErrorBody(data)
    ? (data.error_description ?? data.error)
    : `POST /oauth/device/code failed (HTTP ${status}).`;
  throw new ShipSdkError('auth', description, { httpStatus: status });
}

type PollOutcome =
  | { kind: 'success'; tokens: OAuthTokenSuccessBody }
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'terminal'; description: string };

async function pollOnce(baseUrl: string, clientId: string, deviceCode: string): Promise<PollOutcome> {
  const body = new URLSearchParams();
  body.set('grant_type', DEVICE_CODE_GRANT_TYPE);
  body.set('device_code', deviceCode);
  body.set('client_id', clientId);

  const { status, data } = await postForm(baseUrl, '/oauth/token', body);

  if (isOAuthTokenSuccessBody(data)) {
    return { kind: 'success', tokens: data };
  }
  if (isOAuthErrorBody(data)) {
    if (data.error === 'authorization_pending') return { kind: 'pending' };
    if (data.error === 'slow_down') return { kind: 'slow_down' };
    return { kind: 'terminal', description: data.error_description ?? data.error };
  }
  return { kind: 'terminal', description: `POST /oauth/token failed (HTTP ${status}).` };
}

/**
 * Runs the full RFC 8628 client to completion: request a device code, hand
 * `user_code`/`verification_uri` to the caller via `onUserCode`, then poll
 * `/oauth/token` until the user approves (resolves with the token set),
 * denies (`access_denied`), the code expires (`expired_token`), or another
 * terminal error occurs. Honors `slow_down` by GENUINELY increasing the wait
 * used for every subsequent poll (this ticket's own AC) — not by catching
 * the error and retrying at the original cadence, which would just keep
 * re-triggering the server's own throttle (`device.ts`'s `pollDeviceCode`
 * increases ITS interval on every early poll too, so a client that doesn't
 * genuinely back off gets pushed back further on each attempt).
 */
export async function runDeviceLoginFlow(opts: DeviceLoginFlowOptions): Promise<TokenSet> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  const deviceCode = await requestDeviceCode(opts.baseUrl, opts.clientId, opts.scope);
  opts.onUserCode(deviceCode.user_code, deviceCode.verification_uri);

  let intervalMs = Math.max(deviceCode.interval, 1) * 1000;
  const deadline = now() + deviceCode.expires_in * 1000;

  for (;;) {
    if (now() >= deadline) {
      throw new ShipSdkError('auth', 'Device code expired before the user completed authorization.');
    }

    const outcome = await pollOnce(opts.baseUrl, opts.clientId, deviceCode.device_code);

    if (outcome.kind === 'success') {
      return {
        accessToken: outcome.tokens.access_token,
        refreshToken: outcome.tokens.refresh_token,
        expiresAt: now() + outcome.tokens.expires_in * 1000,
        scope: outcome.tokens.scope,
      };
    }

    if (outcome.kind === 'pending') {
      await sleep(intervalMs);
      continue;
    }

    if (outcome.kind === 'slow_down') {
      intervalMs += SLOW_DOWN_INCREMENT_MS;
      await sleep(intervalMs);
      continue;
    }

    // terminal: access_denied | expired_token | invalid_grant | ...
    throw new ShipSdkError('auth', outcome.description);
  }
}
