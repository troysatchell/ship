/**
 * TF-7 / TRO-278 — the `trust proxy` hop count vs. the real reverse-proxy chain.
 *
 * `terraform/s3-cloudfront.tf` puts the ALB behind CloudFront as a custom origin
 * (the `EB-API` origin, `path_pattern = "/api/*"` and friends), so the real chain
 * for every request is:
 *
 *   client -> CloudFront (1st proxy) -> ALB (2nd proxy) -> this Express app
 *
 * That is TWO reverse-proxy hops, not one. `app.set('trust proxy', N)` tells
 * `req.ip` (via the `proxy-addr` package) how many `X-Forwarded-For` entries,
 * counting from the socket, were appended by proxies it should trust — it does
 * NOT mean "trust everything in the header". Each honest proxy in the chain
 * appends exactly one entry to the end of the header (verified against the
 * installed `proxy-addr`/`forwarded` packages — see `alladdrs`/`parse` in
 * `node_modules/.pnpm/proxy-addr@2.0.7/.../index.js` and
 * `node_modules/.pnpm/forwarded@0.2.0/.../index.js`), so with N trusted hops,
 * `req.ip` resolves to the (N+1)-th entry counting from the end.
 *
 * DERIVED, not verified against live traffic (no AWS credentials, no apply):
 * AWS's documented ALB behavior is to append the IP it directly observed on its
 * own socket to `X-Forwarded-For` (creating the header if the request had none),
 * never trusting or removing what was already there. CloudFront's documented
 * behavior for a custom origin is to set `X-Forwarded-For` itself with the real
 * viewer IP it observed, regardless of the origin request policy's header
 * allow-list (this repo's `aws_cloudfront_origin_request_policy.api` forwards
 * "all viewer headers", but that does not override CloudFront's own XFF
 * insertion — AWS treats XFF as a header it computes, not one it merely relays).
 * Both of these are the load-bearing assumptions behind trusting exactly 2 hops;
 * a human with AWS access should confirm them against a real request (see the
 * PR's post-deploy checklist) before relying on this further.
 *
 * `trust proxy 1` (the value before this fix) under-counts by one hop: it only
 * peels the ALB's own honest append and stops, so `req.ip` for ALL legitimate,
 * CloudFront-routed traffic resolved to CloudFront's own edge-server IP, never
 * the real client. That is a correctness bug independent of TF-7's security-group
 * finding — it would be true even if the ALB had never been reachable directly.
 *
 * `trust proxy 2` (the fix) is only SAFE paired with this same PR's
 * `terraform/security-groups.tf` change restricting the ALB's ingress to
 * CloudFront's origin-facing managed prefix list. Raising the trusted hop count
 * to 2 while the ALB security group still accepted 0.0.0.0/0 would have let a
 * client that bypasses CloudFront and connects to the ALB directly plant a
 * decoy entry that gets trusted as the "CloudFront hop" — see the last test
 * below, which characterizes exactly that shape. The two changes land together
 * in this PR for that reason; neither is safe alone.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * Load a fresh copy of the app with NODE_ENV forced to production, because
 * `trust proxy` is only set in that branch (`app.ts` — `if (process.env.NODE_ENV
 * === 'production')`). CAIA startup discovery is stubbed: it reaches AWS Secrets
 * Manager when NODE_ENV=production and is irrelevant to trust-proxy behavior.
 */
async function loadAppInProduction(): Promise<Express> {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevSecret = process.env.SESSION_SECRET;
  process.env.NODE_ENV = 'production';
  process.env.SESSION_SECRET = prevSecret ?? 'tro-278-regression-only-secret';
  vi.resetModules();
  vi.doMock('./services/caia.js', () => ({
    initializeCAIA: async () => {},
    isCAIAConfigured: async () => false,
  }));
  try {
    const { createApp } = await import('./app.js');
    return createApp();
  } finally {
    process.env.NODE_ENV = prevNodeEnv;
    if (prevSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSecret;
    vi.doUnmock('./services/caia.js');
    vi.resetModules();
  }
}

/**
 * Attach a diagnostic route to observe what `req.ip` resolved to. Added to the
 * already-built app instance rather than to `app.ts` itself — Express matches
 * routes in registration order at request time, so a route added after
 * `createApp()` returns still works, and production gains no new endpoint.
 *
 * Mounted under `/api/` deliberately, not e.g. `/__test/req-ip`. `app.ts`'s SPA
 * catch-all (`app.get('*', ...)`) only registers when `web/dist` exists on disk
 * (`existsSync(webDist)`) — absent right after a fresh checkout, but present
 * once `pnpm build`/`pnpm build:web` has run in this worktree (as `gate.sh`
 * does), and it is registered *before* this probe route. `'*'` matches every
 * path, including a bare `/__test/req-ip`, and the catch-all only calls
 * `next()` — falling through to routes registered after it, like this one —
 * for paths starting with `/api/` or `/collaboration`. Without the prefix this
 * test passed with `web/dist` absent and silently returned `undefined` (the
 * catch-all's HTML response has no `.ip`) the moment `web/dist` existed —
 * caught by running it after `gate.sh`'s own build step populated `web/dist`.
 */
function withReqIpProbe(app: Express): Express {
  app.get('/api/__test/req-ip', (req, res) => {
    res.json({ ip: req.ip });
  });
  return app;
}

describe('TF-7: trust proxy hop count', () => {
  it('recovers the real client IP through the CloudFront -> ALB chain, not an intermediate hop', async () => {
    const app = withReqIpProbe(await loadAppInProduction());

    // Header shape produced by the real chain once the ALB security group is
    // locked to CloudFront's origin-facing prefix list (this PR's terraform
    // change): CloudFront's own honest insertion of the real viewer IP as the
    // first entry, then the ALB's honest append of the peer it directly
    // observed — CloudFront's own edge server — as the second/outer entry.
    const realClientIp = '198.51.100.42';
    const cloudFrontEdgeIp = '203.0.113.10';

    const res = await request(app)
      .get('/api/__test/req-ip')
      .set('X-Forwarded-For', `${realClientIp}, ${cloudFrontEdgeIp}`);

    expect(res.status).toBe(200);
    // Before this fix (trust proxy 1): resolves to `cloudFrontEdgeIp` instead —
    // every real user collapses onto whichever CloudFront edge node served them.
    expect(res.body.ip).toBe(realClientIp);
  });

  it('still resolves correctly when only one proxy hop is present', async () => {
    const app = withReqIpProbe(await loadAppInProduction());

    // Shape produced by a single real proxy hop with nothing upstream of it
    // (e.g. no XFF header reaching CloudFront at all, so CloudFront and the ALB
    // both see a request with no prior entries and each would create a fresh
    // one — collapsed here to the single honest append the ALB contributes).
    const onlyHonestHop = '203.0.113.55';

    const res = await request(app).get('/api/__test/req-ip').set('X-Forwarded-For', onlyHonestHop);

    expect(res.status).toBe(200);
    expect(res.body.ip).toBe(onlyHonestHop);
  });

  /**
   * Characterizes a known, accepted limitation rather than a defect: trusting 2
   * hops is only safe because this PR's `security-groups.tf` change makes the
   * ALB unreachable except from CloudFront's own IP ranges. This test proves
   * why that network-layer control is load-bearing and not merely
   * defense-in-depth — it cannot itself verify the security group (that needs
   * live AWS, see the PR's post-deploy checklist), so it fixes the header shape
   * a direct-to-ALB bypass would produce and shows the consequence.
   */
  it('would trust a forged entry if a client ever reached the ALB directly (why the security-group fix is required)', async () => {
    const app = withReqIpProbe(await loadAppInProduction());

    // Shape produced by a client that bypasses CloudFront and connects to the
    // ALB directly, having forged its own `X-Forwarded-For` entry: the ALB
    // still honestly appends the real socket peer (the attacker's own IP) as
    // the outer entry, but with 2 hops trusted and only 1 real proxy present,
    // Express walks one entry too far and lands on the attacker's decoy.
    const attackerForgedIp = '192.0.2.99';
    const attackerRealIp = '203.0.113.200';

    const res = await request(app)
      .get('/api/__test/req-ip')
      .set('X-Forwarded-For', `${attackerForgedIp}, ${attackerRealIp}`);

    expect(res.status).toBe(200);
    expect(res.body.ip).toBe(attackerForgedIp);
  });
});
