import express, { type Express, type Request, type Response } from 'express';
import type { WebClient } from '@slack/web-api';
import { verifyWebhook } from '@ship/sdk/node';
import { parseHandledEvent } from './eventEnvelope.js';
import { formatSlackMessage } from './slackMessage.js';

export interface CreateAppOptions {
  /** The `whsec_...` signing secret for the Ship webhook subscription this
   *  receiver is registered under (`POST /api/v1/webhooks`'s response,
   *  shown exactly once — see README.md). */
  webhookSecret: string;
  /** A constructed `@slack/web-api` `WebClient` — production code passes a
   *  real one (bot token from env); tests pass one pointed at a local mock
   *  server via `slackApiUrl`, matching this package's own AC ("e2e with a
   *  mocked Slack API"). Injected rather than constructed here so this
   *  module never reads `process.env` itself — see `index.ts`. */
  slackClient: Pick<WebClient, 'chat'>;
  /** The Slack channel ID (`C0123...`) or name to post to. */
  channel: string;
  /** Path the Ship webhook subscription's `url` points at. Defaults to the
   *  PLUGFORGE.MD §4 convention (`integrations/slack`'s own receiver path). */
  webhookPath?: string;
}

const DEFAULT_WEBHOOK_PATH = '/webhooks/ship';

/**
 * Builds the Express app — a function, not a side-effecting module-level
 * `app.listen()`, so `index.ts` (real deployment) and `server.test.ts`
 * (supertest) construct it identically with different injected dependencies.
 *
 * The webhook route uses `express.raw()`, not `express.json()`, on purpose:
 * `verifyWebhook`'s HMAC is computed over the exact bytes Ship signed
 * (`sdk/src/verifyWebhook.ts`'s own header — a lossy UTF-8 decode before
 * hashing was a real, fixed bug in the server-side signer's own history).
 * `express.json()` would have already parsed (and structurally normalized)
 * the body before this route ever saw it, silently breaking signature
 * verification for any payload whose re-serialized JSON differs
 * byte-for-byte from what Ship actually sent (key order, whitespace).
 */
export function createApp(options: CreateAppOptions): Express {
  const webhookPath = options.webhookPath ?? DEFAULT_WEBHOOK_PATH;
  const app = express();

  app.post(webhookPath, express.raw({ type: 'application/json', limit: '1mb' }), async (req: Request, res: Response) => {
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

    if (!verifyWebhook(req.headers, rawBody, options.webhookSecret)) {
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }

    const event = parseHandledEvent(parsedBody);
    if (!event) {
      // A verified, well-formed delivery this receiver doesn't act on (e.g.
      // the subscription also covers document.updated) — a silent no-op,
      // not an error. Still 200s: a non-2xx here would make Ship's
      // deliverer retry a delivery that was never going to be handled
      // differently on retry (platform/webhooks/deliverer.ts's own retry
      // schedule is for transient failures, not "we don't want this type").
      res.status(200).json({ status: 'ignored' });
      return;
    }

    const message = formatSlackMessage(event);
    try {
      await options.slackClient.chat.postMessage({ channel: options.channel, ...message });
    } catch (error) {
      // Slack being unreachable IS a transient failure worth a retry — a
      // 5xx here lets Ship's deliverer's own backoff schedule handle it,
      // rather than this receiver inventing its own retry logic.
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).json({ error: 'slack_post_failed', message });
      return;
    }

    res.status(200).json({ status: 'posted' });
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  return app;
}
