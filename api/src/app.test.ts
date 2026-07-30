/**
 * TF-7 / TRO-278 — the `trust proxy` hop count vs. the real reverse-proxy chain.
 *
 * MAINTAINER-CONFIRMED FOLLOW-UP (2026-07-30): the terraform in this repo
 * describes an AWS deployment (CloudFront -> ALB, TWO hops) that is not what
 * is actually live. The real live deployment is **Render**
 * (`terraform/render/web_service.tf`, `auto_deploy = true` from this repo's
 * `main`), sitting directly in front of Express with no CDN layer — ONE hop.
 * A single hard-coded hop count cannot be correct for both, so `app.ts` now
 * reads it from `TRUST_PROXY_HOPS` (`resolveTrustProxyHops`), defaulting to 1
 * (safe for Render and local dev, and exactly today's live behavior) when the
 * env var is unset. `terraform/elastic-beanstalk.tf` sets it to `"2"` for the
 * AWS blueprint, which is repo hygiene only — that environment is not planned
 * to be applied. The analysis below (originally written against a hard-coded
 * `trust proxy 2`) still describes the AWS chain's mechanics correctly; only
 * the mechanism for reaching that value changed.
 *
 * `terraform/s3-cloudfront.tf` puts the ALB behind CloudFront as a custom origin
 * (the `EB-API` origin, `path_pattern = "/api/*"` and friends), so the real chain
 * for every request under that (non-live) AWS blueprint is:
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
import { resolveTrustProxyHops } from './app.js';

/**
 * Load a fresh copy of the app with NODE_ENV forced to production, because
 * `trust proxy` is only set in that branch (`app.ts` — `if (process.env.NODE_ENV
 * === 'production')`). CAIA startup discovery is stubbed: it reaches AWS Secrets
 * Manager when NODE_ENV=production and is irrelevant to trust-proxy behavior.
 *
 * `trustProxyHopsEnv` controls `TRUST_PROXY_HOPS` for the duration of the load:
 * a string sets it, `undefined` (the default) deletes it so the test exercises
 * the real unset-env default rather than whatever the ambient shell happens to
 * export. Always restored afterward either way.
 */
async function loadAppInProduction(trustProxyHopsEnv?: string): Promise<Express> {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevSecret = process.env.SESSION_SECRET;
  const prevTrustProxyHops = process.env.TRUST_PROXY_HOPS;
  process.env.NODE_ENV = 'production';
  process.env.SESSION_SECRET = prevSecret ?? 'tro-278-regression-only-secret';
  if (trustProxyHopsEnv === undefined) delete process.env.TRUST_PROXY_HOPS;
  else process.env.TRUST_PROXY_HOPS = trustProxyHopsEnv;
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
    if (prevTrustProxyHops === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = prevTrustProxyHops;
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
  // PIN — these two tests characterize the AWS 2-hop chain and are unchanged
  // in outcome by the TRUST_PROXY_HOPS follow-up: the only thing that changed
  // is *how* 2 gets configured (env var, defaulting to `terraform/elastic-
  // beanstalk.tf`'s `TRUST_PROXY_HOPS = "2"` setting) rather than a hard-coded
  // constant in `app.ts`. Both pass before and after this round's change —
  // proven by running them against the prior hard-coded-`2` commit with
  // `TRUST_PROXY_HOPS` unset, where they also pass, since the old code ignored
  // the env var entirely and always behaved as hops=2.
  it('recovers the real client IP through the CloudFront -> ALB chain, not an intermediate hop (TRUST_PROXY_HOPS=2)', async () => {
    const app = withReqIpProbe(await loadAppInProduction('2'));

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
    // Hop-count-invariant (true for any N >= 1), so left on the TRUST_PROXY_HOPS
    // default deliberately — it is a PIN under both the old hard-coded value and
    // every value this ticket's change can produce.
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
   *
   * PIN, same reasoning as the first test above: passes before and after this
   * round's change, now reached via `TRUST_PROXY_HOPS=2` instead of a hard-coded
   * constant.
   */
  it('would trust a forged entry if a client ever reached the ALB directly (why the security-group fix is required) (TRUST_PROXY_HOPS=2)', async () => {
    const app = withReqIpProbe(await loadAppInProduction('2'));

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

  /**
   * RED BEFORE this round's change / GREEN AFTER. Against the commit this
   * round started from (`app.set('trust proxy', 2)` unconditionally, no env
   * var support at all), this exact assertion fails: with TRUST_PROXY_HOPS
   * unset, the old code still hard-coded 2, so it walks past the render
   * proxy's honest append and lands on the attacker's decoy
   * (`res.body.ip` would be `decoyForgedIp`, not `renderProxyObservedIp`).
   *
   * This is the maintainer-confirmed live topology (2026-07-30): Render sits
   * directly in front of Express with no CDN layer in between
   * (`client -> Render's proxy -> Express`), so the correct hop count is 1,
   * not 2 — see `terraform/render/web_service.tf`, which sets no
   * TRUST_PROXY_HOPS override, and `Dockerfile:68`'s `ENV NODE_ENV=production`,
   * which is what actually ships to Render's docker runtime.
   */
  it('defaults to trusting exactly one hop when TRUST_PROXY_HOPS is unset — the live Render/local-dev topology', async () => {
    const app = withReqIpProbe(await loadAppInProduction());

    // A client-forged front entry, followed by Render's own honest append of
    // the peer it actually observed (the real client, since Render is the
    // only proxy in this chain).
    const decoyForgedIp = '192.0.2.150';
    const renderProxyObservedIp = '203.0.113.77';

    const res = await request(app)
      .get('/api/__test/req-ip')
      .set('X-Forwarded-For', `${decoyForgedIp}, ${renderProxyObservedIp}`);

    expect(res.status).toBe(200);
    expect(res.body.ip).toBe(renderProxyObservedIp);
  });

  /**
   * RED BEFORE / GREEN AFTER, same mechanism as the test above: the old code
   * had no TRUST_PROXY_HOPS validation at all (the env var did not exist), so
   * an invalid value could never be exercised through it — the closest prior
   * behavior is "always 2", which falls for the decoy (`decoyForgedIp`) here
   * exactly as the previous test's before-state does. Proves the fallback is
   * safe (resolves to the same hop=1 behavior as the unset case) rather than
   * crashing the process or silently trusting a bogus/attacker-influenced
   * count.
   */
  it('falls back to one trusted hop when TRUST_PROXY_HOPS is not a positive integer, rather than crashing', async () => {
    const app = withReqIpProbe(await loadAppInProduction('0'));

    const decoyForgedIp = '192.0.2.151';
    const renderProxyObservedIp = '203.0.113.78';

    const res = await request(app)
      .get('/api/__test/req-ip')
      .set('X-Forwarded-For', `${decoyForgedIp}, ${renderProxyObservedIp}`);

    expect(res.status).toBe(200);
    expect(res.body.ip).toBe(renderProxyObservedIp);
  });
});

describe('resolveTrustProxyHops', () => {
  // New function this round of TF-7 added — there is no prior behavior to
  // regress against, so these are new-capability tests, not red-before/pin.
  // They cover the validation matrix the integration tests above only sample
  // (unset and one invalid value each).
  it('defaults to 1 when unset or empty', () => {
    expect(resolveTrustProxyHops(undefined)).toBe(1);
    expect(resolveTrustProxyHops('')).toBe(1);
    expect(resolveTrustProxyHops('   ')).toBe(1);
  });

  it('accepts a positive integer string, trimming surrounding whitespace', () => {
    expect(resolveTrustProxyHops('1')).toBe(1);
    expect(resolveTrustProxyHops('2')).toBe(2);
    expect(resolveTrustProxyHops(' 3 ')).toBe(3);
  });

  it('falls back to 1 for zero, negative, non-integer, and non-numeric values, without throwing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const invalid of ['0', '-1', '1.5', 'abc', 'NaN', 'Infinity']) {
        expect(() => resolveTrustProxyHops(invalid)).not.toThrow();
        expect(resolveTrustProxyHops(invalid)).toBe(1);
      }
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
