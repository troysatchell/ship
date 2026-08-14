import { describe, it, expect } from 'vitest';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { createRateLimitMiddleware } from '../middleware.js';
import type { Clock } from '../tokenBucket.js';
import type { Principal } from '../../oauth/principal.js';
import { ApiError } from '../../api/v1/errors.js';

/**
 * PF-500 (Linear TRO-427). Exercises `rateLimitDefaults` / `rateLimitBuckets`
 * over real HTTP (supertest) against a small standalone Express app — NOT
 * the full `createApp()` (that needs Postgres; nothing here does). A stub
 * `bearerAuth`-shaped middleware sets `req.principal` directly, matching the
 * exact contract `rateLimitBuckets` depends on
 * (`platform/oauth/bearerAuth.ts` — never calls `next()` without it).
 *
 * Injected clock throughout — no real `setTimeout` waits, same discipline as
 * `tokenBucket.test.ts`.
 */

class FakeClock implements Clock {
  private currentMs: number;
  constructor(startMs = 0) {
    this.currentMs = startMs;
  }
  now(): number {
    return this.currentMs;
  }
  advance(ms: number): void {
    this.currentMs += ms;
  }
}

const PERSONAL_PRINCIPAL: Principal = {
  app: null,
  user: { id: 'user-1', email: 'user1@example.com', name: 'User One' },
  scopes: ['documents:read'],
};

function oauthPrincipal(clientId: string): Principal {
  return {
    app: { id: `app-${clientId}`, clientId, name: `App ${clientId}`, isFirstParty: false },
    user: { id: 'user-2', email: 'user2@example.com', name: 'User Two' },
    scopes: ['documents:read'],
  };
}

/** Maps a bearer token string to a principal — lets one app instance serve
 *  requests "as" different apps/tokens without a real bearerAuth/DB. */
function buildApp(
  env: { RATE_LIMIT_APP_RPM?: string; RATE_LIMIT_TOKEN_RPM?: string },
  clock: Clock,
  principalForToken: (token: string) => Principal | null
): express.Express {
  const { rateLimitDefaults, rateLimitBuckets } = createRateLimitMiddleware(env, clock);

  const app = express();
  app.use(rateLimitDefaults);

  app.get('/public', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  function stubBearerAuth(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ code: 'unauthorized', message: 'missing token', request_id: 'test' });
      return;
    }
    const token = header.slice('Bearer '.length);
    const principal = principalForToken(token);
    if (!principal) {
      res.status(401).json({ code: 'unauthorized', message: 'invalid token', request_id: 'test' });
      return;
    }
    req.principal = principal;
    next();
  }

  app.get('/protected', stubBearerAuth, rateLimitBuckets, (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // Minimal stand-in for platform/api/v1/errorMiddleware.ts — enough to
  // prove headers set upstream (by rateLimitBuckets) survive through to an
  // error response, without pulling in the whole v1 router.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.httpStatus).json(err.toJSON());
      return;
    }
    res.status(500).json({ code: 'server_error', message: 'unexpected', request_id: 'test' });
  });

  return app;
}

describe('rateLimitDefaults (global, pre-auth headers)', () => {
  it('sets X-RateLimit-* on a route with no auth at all, using the configured token RPM', async () => {
    const app = buildApp({ RATE_LIMIT_APP_RPM: '120', RATE_LIMIT_TOKEN_RPM: '60' }, new FakeClock(), () => null);
    const res = await request(app).get('/public');
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('60');
    expect(res.headers['x-ratelimit-remaining']).toBe('60');
    expect(Number(res.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
  });

  it('sets X-RateLimit-* on a 401 (no Authorization header) for a protected route', async () => {
    const app = buildApp({ RATE_LIMIT_APP_RPM: '120', RATE_LIMIT_TOKEN_RPM: '60' }, new FakeClock(), () => null);
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.headers['x-ratelimit-limit']).toBe('60');
    expect(res.headers['x-ratelimit-remaining']).toBe('60');
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('does not decrement across repeated unauthenticated calls (stateless default, not a real bucket)', async () => {
    const app = buildApp({ RATE_LIMIT_APP_RPM: '120', RATE_LIMIT_TOKEN_RPM: '3' }, new FakeClock(), () => null);
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get('/public');
      expect(res.headers['x-ratelimit-remaining']).toBe('3');
    }
  });
});

describe('rateLimitBuckets (per-route, post-auth enforcement)', () => {
  it('sets real, decrementing headers on a successful authenticated response', async () => {
    const app = buildApp(
      { RATE_LIMIT_APP_RPM: '120', RATE_LIMIT_TOKEN_RPM: '5' },
      new FakeClock(),
      (token) => (token === 'tok-a' ? PERSONAL_PRINCIPAL : null)
    );
    const first = await request(app).get('/protected').set('Authorization', 'Bearer tok-a');
    expect(first.status).toBe(200);
    expect(first.headers['x-ratelimit-limit']).toBe('5');
    expect(first.headers['x-ratelimit-remaining']).toBe('4');

    const second = await request(app).get('/protected').set('Authorization', 'Bearer tok-a');
    expect(second.headers['x-ratelimit-remaining']).toBe('3');
  });

  it('429s with Retry-After once the per-token bucket is exhausted, headers included', async () => {
    const clock = new FakeClock();
    const app = buildApp(
      { RATE_LIMIT_APP_RPM: '1000', RATE_LIMIT_TOKEN_RPM: '2' },
      clock,
      (token) => (token === 'tok-a' ? PERSONAL_PRINCIPAL : null)
    );

    const ok1 = await request(app).get('/protected').set('Authorization', 'Bearer tok-a');
    expect(ok1.status).toBe(200);
    const ok2 = await request(app).get('/protected').set('Authorization', 'Bearer tok-a');
    expect(ok2.status).toBe(200);
    expect(ok2.headers['x-ratelimit-remaining']).toBe('0');

    const blocked = await request(app).get('/protected').set('Authorization', 'Bearer tok-a');
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited');
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
    expect(blocked.headers['x-ratelimit-limit']).toBe('2');
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('a third request succeeds again once the fake clock advances past one refill interval', async () => {
    const clock = new FakeClock(0);
    // capacity 2 over 60_000ms -> 1 token every 30_000ms.
    const app = buildApp(
      { RATE_LIMIT_APP_RPM: '1000', RATE_LIMIT_TOKEN_RPM: '2' },
      clock,
      (token) => (token === 'tok-a' ? PERSONAL_PRINCIPAL : null)
    );
    await request(app).get('/protected').set('Authorization', 'Bearer tok-a');
    await request(app).get('/protected').set('Authorization', 'Bearer tok-a');
    const blocked = await request(app).get('/protected').set('Authorization', 'Bearer tok-a');
    expect(blocked.status).toBe(429);

    clock.advance(30_000);
    const recovered = await request(app).get('/protected').set('Authorization', 'Bearer tok-a');
    expect(recovered.status).toBe(200);
  });

  it('a personal token (principal.app === null) is governed by the token bucket alone, never the app bucket', async () => {
    const clock = new FakeClock();
    // App RPM tiny; if personal-token traffic touched it, this would 429 fast.
    const app = buildApp(
      { RATE_LIMIT_APP_RPM: '1', RATE_LIMIT_TOKEN_RPM: '50' },
      clock,
      (token) => (token === 'tok-a' ? PERSONAL_PRINCIPAL : null)
    );
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get('/protected').set('Authorization', 'Bearer tok-a');
      expect(res.status, `request ${i + 1} should not be blocked by the app bucket`).toBe(200);
    }
  });

  it('two different tokens issued to the SAME app share one app bucket but keep independent token buckets', async () => {
    const clock = new FakeClock();
    const principal = oauthPrincipal('client-shared');
    const app = buildApp(
      { RATE_LIMIT_APP_RPM: '2', RATE_LIMIT_TOKEN_RPM: '50' },
      clock,
      (token) => (token === 'tok-x' || token === 'tok-y' ? principal : null)
    );

    // Spend the app bucket's entire budget (2) using token X alone.
    const x1 = await request(app).get('/protected').set('Authorization', 'Bearer tok-x');
    expect(x1.status).toBe(200);
    const x2 = await request(app).get('/protected').set('Authorization', 'Bearer tok-x');
    expect(x2.status).toBe(200);

    // Token Y has plenty of its OWN token-bucket budget left (50), but the
    // shared app bucket (capacity 2) is already exhausted by token X.
    const y1 = await request(app).get('/protected').set('Authorization', 'Bearer tok-y');
    expect(y1.status).toBe(429);
    expect(y1.body.code).toBe('rate_limited');
  });

  it('does not partially debit the app bucket when the token bucket is the one that denies', async () => {
    const clock = new FakeClock();
    const principal = oauthPrincipal('client-partial');
    const app = buildApp(
      { RATE_LIMIT_APP_RPM: '100', RATE_LIMIT_TOKEN_RPM: '1' },
      clock,
      (token) => (token === 'tok-z' ? principal : null)
    );

    const first = await request(app).get('/protected').set('Authorization', 'Bearer tok-z');
    expect(first.status).toBe(200); // token bucket: 1 -> 0, app bucket: 100 -> 99

    const second = await request(app).get('/protected').set('Authorization', 'Bearer tok-z');
    expect(second.status).toBe(429); // token bucket denies; app bucket must NOT be touched again
    expect(second.headers['x-ratelimit-limit']).toBe('1'); // reports the binding (token) bucket
  });
});
