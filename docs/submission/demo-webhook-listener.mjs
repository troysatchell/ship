#!/usr/bin/env node
// Stand-in for PF-602 (`ship webhooks tail`), which isn't merged yet (see
// PLUGFORGE-DEMO-SCRIPT.md's gap list). Same UX PF-602's own AC specifies —
// a local listener that prints `✓ verified` / `✗ rejected` per inbound
// delivery — built directly on the real, already-merged `@ship/sdk`
// `verifyWebhook()` (PF-403), not a mock. Delete this file once PF-602 lands
// and use the real `ship webhooks tail` in the demo instead.
//
// Build the SDK once first: pnpm --filter @ship/sdk build
// Run:  SECRET=whsec_... PORT=8787 node docs/submission/demo-webhook-listener.mjs
// Point a subscription's target_url at http://localhost:8787/ (or a tunnel
// URL if demoing against a deployed, non-local Ship instance).

import { createServer } from 'node:http';
import { verifyWebhook } from '../../sdk/dist/index.js';

const port = Number(process.env.PORT ?? 8787);
const secret = process.env.SECRET;

if (!secret) {
  console.error('Set SECRET=whsec_... (the signing secret from webhooks.create()).');
  process.exit(1);
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const ok = verifyWebhook(req.headers, rawBody, secret);
    const payload = ok ? JSON.parse(rawBody) : null;
    const stamp = new Date().toISOString();

    if (ok) {
      console.log(`✓ verified  ${stamp}  ${payload.type}  idempotency-key=${req.headers['idempotency-key'] ?? '(none)'}`);
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`✗ rejected  ${stamp}  signature check failed`);
    }
    console.log('');

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ received: ok }));
  });
}).listen(port, () => {
  console.log(`listening on http://localhost:${port} — point a webhook subscription's target_url here`);
});
