/**
 * Regression for the demo's reference subscriber
 * (`docs/submission/demo-webhook-listener.mjs`, run standalone by PF-908's demo
 * script and by anyone following the README): after TRO-449 moved
 * `verifyWebhook` to the Node-only entry, the standalone path still imported it
 * from the browser barrel, got `undefined`, and rejected EVERY delivery as a
 * signature failure (observed 2026-08-16). Two cheap invariants keep that from
 * regressing: the Node entry actually exports the function, and the listener
 * source imports it from there — never from `dist/index.js`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('reference webhook listener ↔ @ship/sdk node entry', () => {
  it('sdk/src/node.ts exports verifyWebhook (the standalone listener imports it from dist/node.js)', async () => {
    const mod = await import('../node.js');
    expect(typeof mod.verifyWebhook).toBe('function');
  });

  it('demo-webhook-listener.mjs imports verifyWebhook from sdk/dist/node.js, not the browser barrel', () => {
    const src = readFileSync(resolve(__dirname, '../../../docs/submission/demo-webhook-listener.mjs'), 'utf8');
    expect(src).toMatch(/await import\('\.\.\/\.\.\/sdk\/dist\/node\.js'\)/);
    expect(src).not.toMatch(/await import\('\.\.\/\.\.\/sdk\/dist\/index\.js'\)/);
  });
});
