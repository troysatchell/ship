/**
 * `ship webhooks tail` (PF-602, PLUGFORGE.MD §4, Linear TRO-452). AC,
 * verbatim: "Starts a local HTTP listener, registers a subscription
 * targeting it, streams deliveries to stdout with live `verifyWebhook`
 * check (✓ verified / ✗ rejected), cleans up subscription on exit. Works
 * against local/containerized Ship (server can reach the listener); for
 * remote instances document the tunnel requirement." Architect notes add:
 * "probe a free port", "SIGINT handler + best-effort finally" for cleanup.
 * This is the PRD's own "demo-video money shot".
 *
 * Two exported pieces, deliberately separable — this ticket's own brief:
 * "test the listener/verification/cleanup logic as an importable module
 * with a fake delivery POST, separate from the CLI entrypoint's process
 * lifecycle":
 *
 *   - `createTailListener()` — the local HTTP server + live `verifyWebhook()`
 *     check + stdout rendering. No dependency on `@ship/sdk`'s `ShipClient`
 *     or the subscription lifecycle at all — a test drives it with a bare
 *     `http.request()` POST and a hand-computed `Ship-Signature` header, no
 *     server/database/OAuth token needed anywhere.
 *   - `runWebhooksTail()` — the actual CLI command: resolve config, load a
 *     stored token, resolve `app_id`, probe a free port, register the
 *     subscription, hand the listener its secret, wait for a stop signal
 *     (SIGINT/SIGTERM by default, injectable for tests), then best-effort
 *     deactivate the subscription and close the listener.
 *
 * ONE subscription, ONE event type — this ticket's AC says "registers A
 * subscription" (singular), and the real `POST /api/v1/webhooks` schema
 * only ever takes one `event_type` per subscription (`CreateWebhookSubscriptionRequestSchema`,
 * `platform/api/v1/resources/webhooks.ts` — not a list). `--event-type`
 * selects it, defaulting to `document.created`: the simplest real event the
 * "five-line demo story" can trigger (`ship docs create` /
 * `POST /api/v1/documents`).
 *
 * Deliberately NOT reusing `docs/submission/demo-webhook-listener.mjs`'s
 * `createReferenceSubscriber()`. That function's whole job is proving the
 * PF-801 (TRO-447) subscriber-DEDUPE contract (`Idempotency-Key` tracking,
 * "recognized duplicate" bookkeeping) — a different ticket's AC, not this
 * one; `createTailListener()` below is a plain per-request verify-and-print,
 * no dedupe state. That file's own header already says it becomes
 * unnecessary as a DEMO stand-in once this command exists — it stays in the
 * repo regardless, because `e2e/webhook-idempotency-key-drill.spec.ts` and
 * `api/src/platform/api/v1/resources/__tests__/webhooks.test.ts`'s "PF-801"
 * block both import `createReferenceSubscriber` directly for unrelated
 * coverage that has nothing to do with this command.
 *
 * Local/containerized only, by construction (this ticket's own AC): the
 * listener binds `127.0.0.1`, which only a Ship server on the SAME HOST can
 * reach. `--target-url` documents (and enables) the tunnel path for a
 * remote/deployed instance: run a tunnel (e.g. `ngrok http <port>`)
 * forwarding to this listener's local port, then pass the tunnel's public
 * HTTPS URL as `--target-url` and the same local port as `--port` — this
 * command never bundles a tunnel client itself (no such dependency in
 * PLUGFORGE.MD §2.1's allowed CLI dependency list; the PRD's own line only
 * asks that the gap be *documented*, not solved).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ShipClient, type CreatedWebhookSubscription } from '@ship/sdk';
import { FileTokenStore, verifyWebhook } from '@ship/sdk/node';
import { resolveBaseUrl, resolveClientId, resolveCredentialsPath } from '../config.js';
import { formatError } from '../errors.js';
import type { Io } from '../io.js';

/** `platform/webhooks/events.ts`'s `EVENT_TYPES`, verbatim — duplicated
 *  here rather than imported, same zero-runtime-dependency reason
 *  `sdk/src/resources/webhooks.ts`'s own `WebhookEventType` duplicates it
 *  (that file's own header). Used only to fail `--event-type` fast, locally,
 *  before ever calling `fetch` — the same "fails fast on a local
 *  precondition" shape `docs.ts`'s `runDocsCreate` already establishes for
 *  a missing `--title`. */
const EVENT_TYPES = [
  'document.created',
  'document.updated',
  'document.deleted',
  'issue.created',
  'issue.assigned',
  'issue.status_changed',
  'sprint.started',
  'sprint.completed',
] as const;

type EventType = (typeof EVENT_TYPES)[number];

function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

const DEFAULT_EVENT_TYPE: EventType = 'document.created';

/** Caps how much of a delivery body this listener will buffer before giving
 *  up and responding 413 — an unbounded `chunks.push(chunk)` loop lets an
 *  oversized or malicious sender exhaust this process's memory one delivery
 *  at a time. Same cap and reasoning as
 *  `docs/submission/demo-webhook-listener.mjs`'s own `MAX_BODY_BYTES`
 *  (a webhook body is one JSON event envelope, never a bulk export) —
 *  independently applied here rather than imported (see this file's header
 *  for why the two listeners are deliberately separate implementations). */
const MAX_BODY_BYTES = 1_000_000;

export interface TailDeliveryEvent {
  readonly verified: boolean;
  readonly rawBody: string;
  readonly headers: IncomingMessage['headers'];
}

export interface CreateTailListenerOptions {
  readonly io: Io;
  /** Test-only observability hook, fired once per handled request AFTER the
   *  verify decision and the stdout line have already been produced — never
   *  used to change behavior. */
  readonly onDelivery?: (event: TailDeliveryEvent) => void;
}

export interface TailListener {
  /** Binds on `127.0.0.1:port` (default: an OS-assigned ephemeral port,
   *  `port: 0` — "probe a free port", per this ticket's architect notes)
   *  and resolves with the actual bound port. */
  listen(port?: number): Promise<number>;
  /**
   * Sets (or replaces) the signing secret every subsequent delivery is
   * verified against. Deliberately mutable rather than a constructor
   * argument: the real port has to be known BEFORE the subscription (and
   * therefore its secret) can be created, so `runWebhooksTail` below always
   * calls `listen()` first and `setSecret()` once `createSubscription()`
   * resolves. Safe by construction, not just by convention: nothing can
   * cause a REAL delivery to reach this server before the subscription
   * exists server-side (there is nothing yet for the deliverer to match),
   * and `runWebhooksTail` calls `setSecret()` synchronously the moment
   * `createSubscription()`'s promise resolves, with no further `await` in
   * between — so no real delivery can ever observe an unset secret. A
   * request that arrives before `setSecret()` is ever called (only possible
   * from something OTHER than the real deliverer) is treated as `rejected`,
   * same as any other unverifiable request — see the handler below.
   */
  setSecret(secret: string): void;
  close(): Promise<void>;
}

/** Renders one line per delivery, matching `docs/submission/
 *  demo-webhook-listener.mjs`'s `✓ verified` / `✗ rejected` convention
 *  (this ticket's own AC, verbatim) but without that file's dedupe-specific
 *  "(fresh)"/"(DUPLICATE)" qualifiers — not this command's job, see file
 *  header. A verified delivery additionally shows the event's own `type`
 *  field when the body parses as JSON with one (every real Ship event
 *  envelope has it — `platform/webhooks/events.ts`'s `eventSchema()`) —
 *  best-effort only: a verified-but-non-JSON body still gets a plain `✓
 *  verified` line, since the signature already proved integrity/origin. */
function formatDeliveryLine(verified: boolean, rawBody: string): string {
  const stamp = new Date().toISOString();
  if (!verified) {
    return `✗ rejected  ${stamp}`;
  }
  let eventType = '';
  try {
    const parsed: unknown = rawBody.length > 0 ? JSON.parse(rawBody) : null;
    if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).type === 'string') {
      eventType = (parsed as Record<string, unknown>).type as string;
    }
  } catch {
    // Not JSON, or not an object — no event-type label, still verified.
  }
  return `✓ verified  ${stamp}${eventType ? `  ${eventType}` : ''}`;
}

export function createTailListener(opts: CreateTailListenerOptions): TailListener {
  const { io, onDelivery } = opts;
  let secret: string | undefined;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(JSON.stringify({ received: false, reason: 'method not allowed' }));
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: false, reason: 'request body too large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      const rawBody = Buffer.concat(chunks).toString('utf8');

      // verifyWebhook() is documented never to throw (see its own header),
      // but a malformed header this listener cannot anticipate the shape of
      // is treated the same as "did not verify" rather than crashing the
      // whole listener over one bad delivery — same defensive posture
      // demo-webhook-listener.mjs's own reference implementation takes.
      let verified = false;
      if (secret !== undefined) {
        try {
          verified = verifyWebhook(req.headers, rawBody, secret);
        } catch {
          verified = false;
        }
      }

      io.stdout(formatDeliveryLine(verified, rawBody));

      res.writeHead(verified ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ received: verified }));

      onDelivery?.({ verified, rawBody, headers: req.headers });
    });

    // A client that aborts mid-body must not crash the listener for the
    // NEXT delivery.
    req.on('error', () => {
      aborted = true;
    });
  });

  return {
    listen(port = 0) {
      return new Promise((resolvePort, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const address = server.address() as AddressInfo;
          resolvePort(address.port);
        });
      });
    },
    setSecret(newSecret: string) {
      secret = newSecret;
    },
    close() {
      return new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

// ── The CLI command itself ──────────────────────────────────────────────

export interface RunWebhooksTailOptions {
  io: Io;
  env: NodeJS.ProcessEnv;
  clientId?: string;
  baseUrl?: string;
  credentialsPath?: string;
  /** Overrides the `app_id` a subscription is created under. Defaults to
   *  the current token's own app (`client.me()`'s `app.id`) — the natural
   *  default for a device-flow token, which always carries one (see
   *  `principal.ts`'s own doc comment: "An OAuth access token — `app` is
   *  always present"). Required explicitly for a personal token, which has
   *  no associated app at all. */
  appId?: string;
  /** Raw, unvalidated — matches `runDocsCreate`'s `title?: string` shape.
   *  Validated against the real 8-value enum inside `runWebhooksTail`,
   *  before any network call, rather than typed as the narrower union at
   *  the CLI boundary (commander hands this function a plain string either
   *  way; typing it narrower here would be a false sense of safety). */
  eventType?: string;
  /** Local port to bind. Default: an OS-assigned ephemeral port (0). */
  port?: number;
  /** Overrides the registered `target_url` (default:
   *  `http://127.0.0.1:<port>/`) — set this to a tunnel's public HTTPS URL
   *  when tailing against a remote/deployed Ship instance (see file
   *  header). */
  targetUrl?: string;
  /** Resolves when the command should stop and clean up. Defaults to a
   *  promise that resolves on the process's first SIGINT/SIGTERM — the real
   *  "hit Ctrl+C to stop tailing" contract a human running this gets.
   *  Test-injectable, per this ticket's own brief: prove listener/verify/
   *  cleanup without driving the CLI entrypoint's real process-signal
   *  lifecycle. */
  stopSignal?: Promise<void>;
  /** Test-only hook: fired once the listener is bound AND the subscription
   *  is created — the earliest point at which a test can safely POST a fake
   *  delivery, or assert the registered `app_id`/`event_type`/`target_url`.
   *  Never used by production code. */
  onReady?: (info: { port: number; subscription: CreatedWebhookSubscription }) => void;
  /** Test-only, threaded straight through to `createTailListener`. */
  onDelivery?: (event: TailDeliveryEvent) => void;
}

/** Same default `SHIP_API_BASE_URL` fallback `client.ts`'s own
 *  `resolveDefaultBaseUrl()` uses (that constant is not exported, so it is
 *  named again here, only for the "does this look local" check below —
 *  never passed to `ShipClient` itself, which resolves its own default). */
const DEFAULT_BASE_URL_FOR_TUNNEL_CHECK = 'http://localhost:3000';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function isLocalUrl(rawUrl: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

/** Resolves on this process's first SIGINT or SIGTERM — the production
 *  default for `stopSignal` above. Removes its own listeners once fired, so
 *  a second signal falls through to Node's default handling (an immediate
 *  exit) rather than being silently swallowed if cleanup itself hangs. */
function createProcessStopSignal(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = (): void => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

export async function runWebhooksTail(opts: RunWebhooksTailOptions): Promise<number> {
  const { io } = opts;

  if (opts.eventType !== undefined && !isEventType(opts.eventType)) {
    io.stderr(`Error: --event-type must be one of: ${EVENT_TYPES.join(', ')} (got "${opts.eventType}").`);
    return 1;
  }
  const eventType: EventType = (opts.eventType as EventType | undefined) ?? DEFAULT_EVENT_TYPE;

  let credentialsPath: string;
  let baseUrl: string | undefined;
  try {
    credentialsPath = opts.credentialsPath ?? resolveCredentialsPath(opts.env);
    baseUrl = resolveBaseUrl(opts.baseUrl, opts.env);
  } catch (err) {
    io.stderr(formatError(err));
    return 1;
  }

  const tokenStore = new FileTokenStore(credentialsPath);

  let tokens;
  try {
    tokens = await tokenStore.get();
  } catch (err) {
    io.stderr(formatError(err));
    return 1;
  }
  if (!tokens) {
    io.stderr(`Not logged in. Run \`ship login\` first (looked for credentials at ${credentialsPath}).`);
    return 1;
  }

  let clientId: string | undefined;
  try {
    clientId = resolveClientId(opts.clientId, opts.env);
  } catch {
    clientId = undefined;
  }

  const client = new ShipClient({ baseUrl, token: tokens.accessToken, clientId, tokenStore });

  let appId = opts.appId;
  if (!appId) {
    let me;
    try {
      me = await client.me();
    } catch (err) {
      io.stderr(formatError(err));
      return 1;
    }
    appId = me.app?.id;
    if (!appId) {
      io.stderr(
        'This token has no associated app_id — a personal token acts only as a user, not an app, and a ' +
          'webhook subscription must belong to one. Pass --app-id explicitly, or use a token from `ship ' +
          'login` (the OAuth device flow always issues one tied to a specific app).'
      );
      return 1;
    }
  }

  const listener = createTailListener({ io, onDelivery: opts.onDelivery });
  let port: number;
  try {
    port = await listener.listen(opts.port ?? 0);
  } catch (err) {
    io.stderr(formatError(err));
    return 1;
  }

  const targetUrl = opts.targetUrl ?? `http://127.0.0.1:${port}/`;

  let subscription: CreatedWebhookSubscription;
  try {
    subscription = await client.webhooks.createSubscription({ app_id: appId, event_type: eventType, target_url: targetUrl });
  } catch (err) {
    io.stderr(formatError(err));
    await listener.close();
    return 1;
  }
  // Synchronous, no `await` in between — see `TailListener.setSecret`'s own
  // doc comment for why this ordering is what makes the mutable secret safe.
  listener.setSecret(subscription.secret);

  io.stdout(`Listening on http://127.0.0.1:${port}/ for "${eventType}" deliveries.`);
  io.stdout(`Registered subscription ${subscription.id} (target_url: ${targetUrl}).`);
  if (!isLocalUrl(baseUrl ?? DEFAULT_BASE_URL_FOR_TUNNEL_CHECK)) {
    io.stdout(
      `Note: ${String(baseUrl)} does not look like a local address. This listener only binds 127.0.0.1, so a ` +
        'REMOTE Ship server cannot reach it directly. Start a tunnel (e.g. `ngrok http ' +
        String(port) +
        '`) forwarding to this listener\'s local port, then re-run with --target-url <tunnel-https-url> ' +
        `--port ${port} so the subscription points at a URL the server can actually reach.`
    );
  }
  io.stdout('Waiting for deliveries. Press Ctrl+C to stop and clean up.');

  opts.onReady?.({ port, subscription });

  const stopSignal = opts.stopSignal ?? createProcessStopSignal();
  try {
    await stopSignal;
  } finally {
    // Best-effort finally, per this ticket's own architect notes: cleanup
    // must run on the way out regardless of how `stopSignal` settled, and a
    // failed deactivate must not prevent the listener from closing.
    io.stdout('Cleaning up...');
    try {
      await client.webhooks.deleteSubscription(subscription.id);
    } catch (err) {
      io.stderr(`Warning: failed to clean up subscription ${subscription.id}: ${formatError(err)}`);
    }
    await listener.close();
  }

  return 0;
}
