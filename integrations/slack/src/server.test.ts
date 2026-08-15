/**
 * PF-803's own AC, verbatim: "e2e with a mocked Slack API." No live Slack
 * workspace in CI — a local Express server standing in for
 * `https://slack.com/api`, and `@slack/web-api`'s real `WebClient` pointed
 * at it via `slackApiUrl` (verified against the installed package's own
 * `WebClientOptions` type, not assumed). This drives the REAL Express
 * receiver (`createApp()`) with `supertest`, through the REAL Slack SDK,
 * against a REAL (mock) HTTP server — the only thing not real is which
 * `https://slack.com` responds.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { WebClient } from '@slack/web-api';
import { createApp } from './server.js';

const WEBHOOK_SECRET = 'whsec_test_secret_value';
const CHANNEL = 'C0TEST0001';

/** Builds a real `Ship-Signature` header value the same way
 *  `api/src/platform/webhooks/signer.ts`'s `sign()` does — duplicated here
 *  rather than imported, same trade-off `sdk/src/verifyWebhook.test.ts`'s own
 *  header documents (this package cannot depend on `api/src` at all, and
 *  even the SDK's own test suite makes this exact call for the identical
 *  reason). */
function shipSignatureHeader(t: number, rawBody: string, secret: string): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** A minimal mock of Slack's `POST /chat.postMessage` — records every call
 *  it receives and replies with the real success shape
 *  (`{ ok: true, channel, ts }`) so `@slack/web-api`'s own response
 *  validation doesn't reject it. */
function startMockSlack(): {
  server: Server;
  url: string;
  calls: Array<{ channel?: unknown; text?: unknown; blocks?: unknown }>;
  failNext: () => void;
} {
  const calls: Array<{ channel?: unknown; text?: unknown; blocks?: unknown }> = [];
  let shouldFailNext = false;
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.post('/chat.postMessage', (req, res) => {
    if (shouldFailNext) {
      shouldFailNext = false;
      res.status(500).json({ ok: false, error: 'internal_error' });
      return;
    }
    calls.push(req.body as Record<string, unknown>);
    res.status(200).json({ ok: true, channel: CHANNEL, ts: '1234567890.123456' });
  });

  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    server,
    url: `http://127.0.0.1:${port}/`,
    calls,
    failNext: () => {
      shouldFailNext = true;
    },
  };
}

describe('Slack integration receiver (PF-803, mocked Slack API)', () => {
  let mockSlack: ReturnType<typeof startMockSlack>;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    mockSlack = startMockSlack();
    // retries: 0 — @slack/web-api's WebClient retries transient (5xx)
    // failures internally by default, which would silently swallow
    // startMockSlack()'s single-shot failNext() on its own retry and make
    // the 502 test below flaky-green. Disabled so this test suite exercises
    // exactly the one request it sends, deterministically.
    const slackClient = new WebClient('xoxb-fake-test-token', { slackApiUrl: mockSlack.url, retryConfig: { retries: 0 } });
    app = createApp({ webhookSecret: WEBHOOK_SECRET, slackClient, channel: CHANNEL });
  });

  beforeEach(() => {
    mockSlack.calls.length = 0;
  });

  afterAll(() => {
    mockSlack.server.close();
  });

  it('a verified document.created delivery posts to the mocked Slack channel', async () => {
    const body = JSON.stringify({
      id: '11111111-1111-1111-1111-111111111111',
      type: 'document.created',
      created_at: '2026-08-15T00:00:00.000Z',
      workspace_id: '22222222-2222-2222-2222-222222222222',
      data: {
        id: '33333333-3333-3333-3333-333333333333',
        document_type: 'issue',
        title: 'Fix the flaky test',
        created_by: '44444444-4444-4444-4444-444444444444',
      },
    });
    const t = Math.floor(Date.now() / 1000);

    const res = await request(app)
      .post('/webhooks/ship')
      .set('Content-Type', 'application/json')
      .set('Ship-Signature', shipSignatureHeader(t, body, WEBHOOK_SECRET))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'posted' });
    expect(mockSlack.calls).toHaveLength(1);
    expect(mockSlack.calls[0]?.channel).toBe(CHANNEL);
    expect(String(mockSlack.calls[0]?.text)).toContain('Fix the flaky test');
  });

  it('a verified issue.assigned delivery posts to the mocked Slack channel', async () => {
    const body = JSON.stringify({
      id: '55555555-5555-5555-5555-555555555555',
      type: 'issue.assigned',
      created_at: '2026-08-15T00:01:00.000Z',
      workspace_id: '22222222-2222-2222-2222-222222222222',
      data: {
        id: '66666666-6666-6666-6666-666666666666',
        assignee_id: '77777777-7777-7777-7777-777777777777',
        previous_assignee_id: null,
      },
    });
    const t = Math.floor(Date.now() / 1000);

    const res = await request(app)
      .post('/webhooks/ship')
      .set('Content-Type', 'application/json')
      .set('Ship-Signature', shipSignatureHeader(t, body, WEBHOOK_SECRET))
      .send(body);

    expect(res.status).toBe(200);
    expect(mockSlack.calls).toHaveLength(1);
    expect(String(mockSlack.calls[0]?.text)).toContain('assigned to');
  });

  it('an invalid signature is rejected 401 and Slack is never called', async () => {
    const body = JSON.stringify({ type: 'document.created' });
    const t = Math.floor(Date.now() / 1000);

    const res = await request(app)
      .post('/webhooks/ship')
      .set('Content-Type', 'application/json')
      .set('Ship-Signature', shipSignatureHeader(t, body, 'wrong-secret'))
      .send(body);

    expect(res.status).toBe(401);
    expect(mockSlack.calls).toHaveLength(0);
  });

  it('a verified delivery of an unhandled event type is silently ignored, 200, Slack never called', async () => {
    const body = JSON.stringify({
      id: '88888888-8888-8888-8888-888888888888',
      type: 'document.updated',
      created_at: '2026-08-15T00:02:00.000Z',
      workspace_id: '22222222-2222-2222-2222-222222222222',
      data: { id: '99999999-9999-9999-9999-999999999999', document_type: 'issue', title: 'x', changed_fields: ['title'] },
    });
    const t = Math.floor(Date.now() / 1000);

    const res = await request(app)
      .post('/webhooks/ship')
      .set('Content-Type', 'application/json')
      .set('Ship-Signature', shipSignatureHeader(t, body, WEBHOOK_SECRET))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ignored' });
    expect(mockSlack.calls).toHaveLength(0);
  });

  it('a Slack API failure surfaces as a 502, so Ship\'s own deliverer retry schedule handles it', async () => {
    mockSlack.failNext();
    const body = JSON.stringify({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      type: 'document.created',
      created_at: '2026-08-15T00:03:00.000Z',
      workspace_id: '22222222-2222-2222-2222-222222222222',
      data: { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', document_type: 'wiki', title: 'y', created_by: null },
    });
    const t = Math.floor(Date.now() / 1000);

    const res = await request(app)
      .post('/webhooks/ship')
      .set('Content-Type', 'application/json')
      .set('Ship-Signature', shipSignatureHeader(t, body, WEBHOOK_SECRET))
      .send(body);

    expect(res.status).toBe(502);
  });
});
