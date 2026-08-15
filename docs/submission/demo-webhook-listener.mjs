#!/usr/bin/env node
// Reference webhook subscriber — PF-801 / TRO-447's subscriber-dedupe fixture,
// and (unchanged from before) the PF-602 (`ship webhooks tail`) CLI stand-in
// (PLUGFORGE-DEMO-SCRIPT.md's own gap list; delete this file once PF-602
// lands and use the real `ship webhooks tail` in the demo instead).
//
// `createReferenceSubscriber()` below is the actual copyable reference
// implementation of the subscriber-dedupe contract documented in
// `docs/architecture.md`'s "Subscriber dedupe contract" section: verify
// `Ship-Signature`, track every `Idempotency-Key` header seen, and respond
// 200 either way — fresh delivery or a recognized duplicate — so the sender
// never sees a reason to retry a delivery this subscriber has already
// handled. It is exercised three ways in this repo, all built on the exact
// same `createReferenceSubscriber` function (one implementation, not three):
//
//   1. HERE, as a CLI (`node docs/submission/demo-webhook-listener.mjs`) — a
//      human demo, printing `✓ verified (fresh)` / `✓ verified (DUPLICATE)` /
//      `✗ rejected` per inbound delivery.
//   2. `e2e/webhook-idempotency-key-drill.spec.ts` — a real, listening
//      instance of it, driven by an actual deliver -> replay round trip
//      through the live API and deliverer, over a real loopback socket.
//   3. `api/src/platform/api/v1/resources/__tests__/webhooks.test.ts`'s
//      "PF-801" describe block — the same fixture again, this time proving
//      the dedupe contract at the vitest tier the factory gate actually
//      executes (`ship-qa`'s own rule: an e2e-only regression test passes
//      the gate's "test added" check without ever being run by it).
//
// `verify` is injected rather than hardcoded because two byte-identical
// implementations of the Ship-Signature algorithm exist in this repo, on
// purpose (see `sdk/src/verifyWebhook.ts`'s own header: "Port of
// `signer.ts`'s `verify()` — same algorithm, byte-identical"):
//   - The SDK's `verifyWebhook()` — what a REAL external integrator actually
//     has available, and what the CLI block below uses. Requires
//     `pnpm --filter @ship/sdk build` first (documented below, unchanged
//     from before this ticket).
//   - `signer.ts`'s own `verify()` — what this repo's OWN tests inject
//     instead, so neither the e2e suite nor `pnpm test` need an SDK build as
//     a hidden prerequisite just to prove the dedupe contract.
// Both accept `(signatureHeaderValue: string, rawBody: string, secret: string) => boolean`
// once wrapped to that shape (see the CLI block's own small adapter below).
//
// Build the SDK once first (only needed for the CLI below, not for the
// tests that import `createReferenceSubscriber` directly):
//   pnpm --filter @ship/sdk build
// Run:  SECRET=whsec_... PORT=8787 node docs/submission/demo-webhook-listener.mjs
// Point a subscription's target_url at http://localhost:8787/ (or a tunnel
// URL if demoing against a deployed, non-local Ship instance).

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * Creates a reference webhook-subscriber request handler implementing the
 * subscriber-dedupe contract (`docs/architecture.md`): verify the inbound
 * `Ship-Signature`, then check-then-store on `Idempotency-Key` — a key seen
 * before is recognized as a duplicate and NOT reprocessed, but the response
 * is still 200 either way (the whole point: a webhook sender treats 2xx as
 * "handled, don't retry" and 5xx/timeout as "retry per schedule" — see
 * `api/src/platform/webhooks/deliverer.ts`'s own retry-schedule doc comment
 * — so a subscriber that 4xx'd or 5xx'd a duplicate would either get it
 * dead-lettered as a permanent failure or endlessly retried, neither of
 * which is what "already handled" should mean).
 *
 * Returns an object rather than starting a server immediately — the CLI
 * block at the bottom of this file `.listen()`s it; a caller importing this
 * function for a test binds it to whatever port THAT test needs (often `0`,
 * for an OS-assigned ephemeral port) and never gets an unsolicited live
 * server or a `process.exit` side effect just by importing this module (see
 * the `import.meta.url` guard below).
 */
export function createReferenceSubscriber({ secret, verify, onDelivery = () => {} }) {
  if (!secret) {
    throw new Error('createReferenceSubscriber requires { secret }');
  }
  if (typeof verify !== 'function') {
    throw new Error(
      'createReferenceSubscriber requires { verify(signatureHeaderValue, rawBody, secret) => boolean }'
    );
  }

  /** `Idempotency-Key` -> { payload, firstSeenAt, duplicateCount }. In-memory,
   * per-instance, exactly like a real minimal integrator's dedupe store would
   * start out (the contract doc's own "how to implement dedup" section notes
   * a real production subscriber should persist this somewhere durable —
   * this fixture's whole job is to prove the CONTRACT, not to be a
   * production-grade store). */
  const deliveries = new Map();

  /** Caps how much of a request body this fixture will buffer before giving
   * up and responding 413 (CodeRabbit, this ticket's review) — an
   * un-capped `chunks.push(chunk)` loop lets an oversized or malicious
   * sender exhaust this process's memory one delivery at a time. 1 MB is
   * generously larger than any real Ship event payload (a webhook body is
   * one JSON-serialized event envelope, never a bulk export). */
  const MAX_BODY_BYTES = 1_000_000;

  function requestListener(req, res) {
    const chunks = [];
    let totalBytes = 0;
    let aborted = false;

    req.on('data', (chunk) => {
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
      const signatureHeader = req.headers['ship-signature'];
      const idempotencyKeyHeader = req.headers['idempotency-key'];
      const idempotencyKey = typeof idempotencyKeyHeader === 'string' && idempotencyKeyHeader.length > 0
        ? idempotencyKeyHeader
        : undefined;

      // A malformed Ship-Signature value (wrong format, non-hex, etc.) is a
      // real possibility from a misbehaving or malicious sender — `verify`
      // is an INJECTED function (signer.ts's or the SDK's), and this fixture
      // cannot assume either implementation always returns false rather than
      // throwing on malformed input. Treated the same as a failed
      // verification (CodeRabbit, this ticket's review) rather than letting
      // an uncaught exception crash the whole listener process — a signer
      // bug should not take down every future delivery this subscriber
      // would otherwise have accepted.
      let signatureVerified = false;
      if (typeof signatureHeader === 'string') {
        try {
          signatureVerified = verify(signatureHeader, rawBody, secret);
        } catch {
          signatureVerified = false;
        }
      }

      if (!signatureVerified) {
        onDelivery({ kind: 'rejected', idempotencyKey });
        // A signature that doesn't verify is NOT "handled" — a real
        // integrator should reject it (401 here; the exact status doesn't
        // matter to the sender, only that it's outside 2xx/5xx, i.e.
        // "permanent failure, don't retry" per deliverer.ts's own contract).
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: false, reason: 'signature verification failed' }));
        return;
      }

      // The dedupe contract has nothing to key on without this header
      // (CodeRabbit, this ticket's review) — a verified request missing it
      // is a malformed sender, not a delivery this fixture can safely
      // dedupe-or-process. Rejected the same way an unverified signature is:
      // outside 2xx/5xx, so a real sender's retry logic treats it as a
      // permanent failure to fix, not a transient one to retry as-is.
      if (idempotencyKey === undefined) {
        onDelivery({ kind: 'rejected', idempotencyKey: undefined });
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: false, reason: 'missing or empty Idempotency-Key header' }));
        return;
      }

      let payload = null;
      try {
        payload = rawBody.length > 0 ? JSON.parse(rawBody) : null;
      } catch {
        payload = null;
      }

      let isDuplicate = false;
      const existing = deliveries.get(idempotencyKey);
      if (existing) {
        // THE dedupe check: recognized, but deliberately NOT reprocessed —
        // `existing.payload` (the FIRST delivery's payload) is left
        // untouched, and only the duplicate count moves.
        isDuplicate = true;
        existing.duplicateCount += 1;
      } else {
        deliveries.set(idempotencyKey, { payload, firstSeenAt: new Date().toISOString(), duplicateCount: 0 });
      }

      onDelivery({ kind: isDuplicate ? 'duplicate' : 'processed', idempotencyKey, payload });

      // 200 either way — see this function's own doc comment for why.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ received: true, duplicate: isDuplicate }));
    });
  }

  const server = createServer(requestListener);

  return {
    server,
    /** Read-only introspection for tests — never mutated by a caller. */
    deliveries,
    /** True once `key` has been recognized as a duplicate at least once. */
    wasDeduped(key) {
      const entry = deliveries.get(key);
      return entry !== undefined && entry.duplicateCount > 0;
    },
    /** True once `key` has been seen at all (fresh or duplicate). */
    wasProcessed(key) {
      return deliveries.has(key);
    },
    /** Binds and starts listening on `port` (default: an OS-assigned
     * ephemeral port) on loopback only. Resolves with the actual bound
     * port. */
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          resolve(typeof address === 'object' && address !== null ? address.port : port);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ── CLI standalone mode ─────────────────────────────────────────────────
// Only runs when this file is EXECUTED directly (`node
// docs/submission/demo-webhook-listener.mjs`) — never when
// `createReferenceSubscriber` is imported as a module (the e2e spec and the
// vitest describe block above both import only the factory function, and
// neither wants a live server or a `process.exit` side effect merely from
// importing this file).
//
// Deliberately an async IIFE, NOT a top-level `await` — Playwright's e2e
// test loader (and Node's CJS interop generally) cannot `require()` an ESM
// module that contains a top-level `await`, even one that sits inside an
// `if` block that never actually executes when the module is merely
// imported. Confirmed the hard way: the first version of this file used a
// bare top-level `await import(...)` here, and every e2e spec importing
// `createReferenceSubscriber` failed to load with "cannot be used on an ESM
// graph with top-level await" — the mere PRESENCE of the syntax broke
// import, regardless of this branch's runtime condition. Moving every
// `await` inside this IIFE removes the syntax from the module's top level
// entirely.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  void (async () => {
    const port = Number(process.env.PORT ?? 8787);
    const secret = process.env.SECRET;

    if (!secret) {
      console.error('Set SECRET=whsec_... (the signing secret from webhooks.create()).');
      process.exit(1);
    }

    const { verifyWebhook } = await import('../../sdk/dist/index.js');

    const subscriber = createReferenceSubscriber({
      secret,
      // Adapts the SDK's `verifyWebhook(headersObject, rawBody, secret)`
      // down to this module's `verify(signatureHeaderValue, rawBody,
      // secret)` shape (see this file's own header for why two
      // implementations exist).
      verify: (signatureHeaderValue, rawBody, secretArg) =>
        verifyWebhook({ 'ship-signature': signatureHeaderValue }, rawBody, secretArg),
      onDelivery: ({ kind, idempotencyKey, payload }) => {
        const stamp = new Date().toISOString();
        const key = idempotencyKey ?? '(none)';
        if (kind === 'rejected') {
          console.log(`✗ rejected  ${stamp}  signature check failed`);
        } else if (kind === 'duplicate') {
          console.log(
            `✓ verified  ${stamp}  DUPLICATE  idempotency-key=${key}  (recognized, not reprocessed)`
          );
        } else {
          console.log(`✓ verified  ${stamp}  fresh  ${payload?.type ?? ''}  idempotency-key=${key}`);
          if (payload) console.log(JSON.stringify(payload, null, 2));
        }
        console.log('');
      },
    });

    await subscriber.listen(port);
    console.log(`listening on http://localhost:${port} — point a webhook subscription's target_url here`);
  })().catch((error) => {
    console.error('demo-webhook-listener: fatal error', error);
    process.exit(1);
  });
}
