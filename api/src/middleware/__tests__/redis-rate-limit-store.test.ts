/**
 * TRO-280 / API-7 — regression tests for the rate limiter's Redis-backed
 * storage: the fallback/wiring decision, the fail-open behavior when Redis is
 * configured but unreachable, and (the actual point of this ticket) proof
 * that two independently-constructed limiter instances pointed at the SAME
 * Redis share one counter, unlike the pre-fix `MemoryStore` default.
 *
 * Three groups, with different environment requirements:
 *
 *  1. "wiring" — no Redis needed at all. Pure unit tests of
 *     `createRedisClientFromEnv`/`createRedisRateLimitStore`.
 *  2. "fail-open" — no Redis needed either. Points a real ioredis client at a
 *     TCP port nothing listens on (`127.0.0.1:1`, a privileged port normal
 *     processes cannot bind), which fails fast and deterministically with
 *     ECONNREFUSED, and proves the request is still served.
 *  3. "shared state across instances" — needs a REAL local Redis, started in
 *     this file's `beforeAll` via Docker. If `docker info` fails in the
 *     environment running this suite (no Docker / no daemon access), this
 *     group is skipped with a console warning explaining exactly why, rather
 *     than either failing the whole gate or silently reporting a pass with no
 *     assertions run.
 *
 * A companion, Docker-free "contrast" group documents the defect itself: two
 * `MemoryStore`-backed instances do NOT share a budget for the same identity
 * — that gap (N instances x configured limit, not the configured limit) is
 * exactly what API-7 reports and what group 3 proves is fixed.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import rateLimit from 'express-rate-limit'
import { Redis } from 'ioredis'
import { RedisStore } from 'rate-limit-redis'
import {
  createRedisClient,
  createRedisClientFromEnv,
  createRedisRateLimitStore,
} from '../redis-rate-limit-store.js'
import { createApiRateLimiters } from '../rate-limit.js'

const execFileAsync = promisify(execFile)

function buildPingApp(limiter: express.RequestHandler): express.Express {
  const app = express()
  app.use(limiter)
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }))
  return app
}

describe('TRO-280: wiring (createRedisClientFromEnv / createRedisRateLimitStore)', () => {
  const clients: Redis[] = []
  afterEach(() => {
    while (clients.length > 0) clients.pop()?.disconnect()
  })

  it('creates no client when REDIS_URL is unset — this is the pre-TRO-280 fallback path', () => {
    expect(createRedisClientFromEnv({})).toBeUndefined()
  })

  it('creates a client when REDIS_URL is set, without requiring Redis to be reachable yet', () => {
    // ioredis connects in the background; constructing the client does not
    // wait for (or require) a successful connection. A bogus host is enough
    // to prove the wiring decision ("REDIS_URL present -> build a client")
    // without this test depending on any real Redis.
    const client = createRedisClientFromEnv({ REDIS_URL: 'redis://127.0.0.1:1' })
    expect(client).toBeInstanceOf(Redis)
    if (client) clients.push(client)
  })

  it('builds a RedisStore with the given key prefix', () => {
    const client = createRedisClient('redis://127.0.0.1:1')
    clients.push(client)

    const store = createRedisRateLimitStore(client, 'rl:test-prefix:')
    expect(store).toBeInstanceOf(RedisStore)
    expect(store.prefix).toBe('rl:test-prefix:')
  })

  it('createApiRateLimiters still returns exactly 2 handlers with no REDIS_URL configured (unchanged from API-1)', () => {
    expect(createApiRateLimiters({ NODE_ENV: 'production' })).toHaveLength(2)
  })
})

describe('TRO-280: fail-open when Redis is configured but unreachable', () => {
  const clients: Redis[] = []
  afterEach(() => {
    while (clients.length > 0) clients.pop()?.disconnect()
    vi.restoreAllMocks()
  })

  /**
   * Port 1 is a privileged TCP port ordinary processes cannot bind, so a
   * connection attempt to it on localhost gets an immediate, deterministic
   * ECONNREFUSED — no real Redis, no race with anything else on the machine,
   * no reliance on a timeout to prove "unreachable."
   */
  const unreachableUrl = 'redis://127.0.0.1:1'

  it('serves the request (200), not a 500 or a false 429, when the store errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = createRedisClient(unreachableUrl)
    clients.push(client)

    const limiter = rateLimit({
      windowMs: 60_000,
      limit: 3,
      standardHeaders: true,
      legacyHeaders: false,
      store: createRedisRateLimitStore(client, `rl:test-failopen:${randomUUID()}:`),
      // The decision under test — see redis-rate-limit-store.ts's top-of-file
      // doc for the full reasoning (rule 7): fail OPEN, not closed.
      passOnStoreError: true,
    })
    const app = buildPingApp(limiter)

    const res = await request(app).get('/ping')

    expect(res.status).toBe(200)
    // The failure must be observable (rule 7: a swallowed failure is not the
    // same as a handled one) — express-rate-limit's own passOnStoreError path
    // logs via console.error, and/or the ioredis client's own 'error' handler
    // does (redis-rate-limit-store.ts's attachErrorLogging).
    expect(errorSpy).toHaveBeenCalled()
  })

  it('would fail CLOSED (block, not 200) if passOnStoreError were left at its express-rate-limit default of false', async () => {
    // Pin to the library default so a future refactor can't silently flip the
    // decision documented in redis-rate-limit-store.ts without this test
    // changing shape — this is the "before" this ticket's fail-open choice
    // deliberately overrides.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = createRedisClient(unreachableUrl)
    clients.push(client)

    const limiter = rateLimit({
      windowMs: 60_000,
      limit: 3,
      standardHeaders: true,
      legacyHeaders: false,
      store: createRedisRateLimitStore(client, `rl:test-failclosed:${randomUUID()}:`),
      // No passOnStoreError here — proves express-rate-limit's own default
      // really is fail-closed, i.e. that TRO-280's choice is an explicit
      // override of that default, not a no-op.
    })
    const app = buildPingApp(limiter)
    // A thrown store error with no passOnStoreError propagates to Express's
    // default error handler as a 500 — this is "closed" in the sense that the
    // request is never served normally, which is exactly the outcome TRO-280
    // decided against for a rate limiter's storage dependency.
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: 'store unreachable' })
      }
    )

    const res = await request(app).get('/ping')

    expect(res.status).toBe(500)
  })
})

describe('TRO-280: two MemoryStore instances do NOT share a budget (documents the defect this ticket fixes; no Redis needed)', () => {
  it('gives instance B a fresh budget even after instance A is exhausted for the same identity', async () => {
    const sharedKey = `contrast-${randomUUID()}`
    const limiterA = rateLimit({
      windowMs: 60_000,
      limit: 3,
      keyGenerator: () => sharedKey,
      standardHeaders: true,
      legacyHeaders: false,
    })
    const limiterB = rateLimit({
      windowMs: 60_000,
      limit: 3,
      keyGenerator: () => sharedKey,
      standardHeaders: true,
      legacyHeaders: false,
    })
    const appA = buildPingApp(limiterA)
    const appB = buildPingApp(limiterB)

    for (let i = 0; i < 3; i++) {
      const res = await request(appA).get('/ping')
      expect(res.status).toBe(200)
    }
    // Instance A is now at its limit for `sharedKey`. Per-process MemoryStore
    // means instance B has never seen this key, so — despite the SAME
    // configured limit and the SAME logical identity — B is not throttled.
    // This is API-7's defect: the real ceiling for one identity is
    // (configured limit) x (number of instances), not the configured limit.
    const resB = await request(appB).get('/ping')
    expect(resB.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Group 3: the actual proof. Needs a real, local Redis — started here via
// Docker. Skipped cleanly (with an explanation) if Docker isn't usable in the
// environment running this suite.
// ---------------------------------------------------------------------------

function isDockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

const dockerAvailable = isDockerAvailable()

if (!dockerAvailable) {
  console.warn(
    'TRO-280: skipping the Redis multi-instance proof (`docker info` failed in this environment — ' +
    'no local Docker daemon reachable). This does NOT verify the shared-state fix; it only means this ' +
    'particular run could not construct the local proof. See api/src/middleware/redis-rate-limit-store.ts ' +
    'and CHANGES.md for the mechanism and how it was verified elsewhere.'
  )
}

/**
 * `docker run -d` returns as soon as the container is created, which can be
 * before Docker has finished publishing its port mapping — `docker port`
 * called immediately after can return empty output (observed directly while
 * building this test, not assumed). Poll the actual state (`docker port`'s
 * own output) instead of adding a fixed sleep before the first call — rule 5.
 */
async function waitForPublishedPort(containerName: string, containerPort: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastOutput = ''
  while (Date.now() < deadline) {
    const { stdout } = await execFileAsync('docker', ['port', containerName, containerPort]).catch(
      () => ({ stdout: '' })
    )
    lastOutput = stdout.trim()
    const hostPort = lastOutput.split(':').pop()
    if (hostPort) return hostPort
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `docker port ${containerName} ${containerPort} did not publish a host port within ${timeoutMs}ms (last output: "${lastOutput}")`
  )
}

/**
 * Poll the actual ready state (a real PING round trip) instead of a fixed
 * sleep — rule 5. Returns once the container answers, or throws after
 * `timeoutMs` of genuine unreadiness.
 */
async function waitForRedisReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1000 })
    probe.on('error', () => {
      /* expected during startup polling; the catch block below records it */
    })
    try {
      await probe.connect()
      const pong = await probe.ping()
      probe.disconnect()
      if (pong === 'PONG') return
    } catch (err) {
      lastErr = err
      probe.disconnect()
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Redis at ${url} did not become ready within ${timeoutMs}ms (last error: ${String(lastErr)})`)
}

describe.skipIf(!dockerAvailable)(
  'TRO-280: Redis-backed store shares counts across independent instances (real local Redis via Docker)',
  () => {
    let containerName: string
    let redisUrl: string
    const clients: Redis[] = []

    beforeAll(async () => {
      containerName = `ship-wt-tro280-redis-test-${randomUUID().slice(0, 8)}`
      await execFileAsync('docker', [
        'run',
        '-d',
        '--rm',
        '--name',
        containerName,
        '-p',
        '127.0.0.1::6379',
        'redis:7-alpine',
      ])
      const hostPort = await waitForPublishedPort(containerName, '6379/tcp', 10_000)
      redisUrl = `redis://127.0.0.1:${hostPort}`
      await waitForRedisReady(redisUrl, 20_000)
    }, 30_000)

    afterAll(async () => {
      for (const client of clients.splice(0)) client.disconnect()
      if (containerName) {
        // `--rm` above means `stop` alone removes the container too.
        await execFileAsync('docker', ['stop', containerName]).catch(() => {})
      }
    }, 15_000)

    it('blocks instance B once instance A alone has exhausted the shared limit for one identity', async () => {
      // Isolated per-test-run key namespace (rule 10) — a random prefix per
      // run means concurrent/rerun executions of this suite against the same
      // Redis (or a Redis that happens to still hold keys from a previous
      // crashed run) can never collide with each other.
      const prefix = `rl:tro280-test:${randomUUID()}:`
      const sharedIdentityKey = 'shared-user'
      const limit = 3

      const clientA = createRedisClient(redisUrl)
      const clientB = createRedisClient(redisUrl)
      clients.push(clientA, clientB)

      const limiterA = rateLimit({
        windowMs: 60_000,
        limit,
        keyGenerator: () => sharedIdentityKey,
        standardHeaders: true,
        legacyHeaders: false,
        store: createRedisRateLimitStore(clientA, prefix),
        passOnStoreError: true,
      })
      const limiterB = rateLimit({
        windowMs: 60_000,
        limit,
        keyGenerator: () => sharedIdentityKey,
        standardHeaders: true,
        legacyHeaders: false,
        store: createRedisRateLimitStore(clientB, prefix),
        passOnStoreError: true,
      })

      const appA = buildPingApp(limiterA)
      const appB = buildPingApp(limiterB)

      // Exhaust the limit entirely through instance A.
      const statusesFromA: number[] = []
      for (let i = 0; i < limit; i++) {
        const res = await request(appA).get('/ping')
        statusesFromA.push(res.status)
      }
      expect(statusesFromA, `expected all ${limit} requests through A to succeed`).toEqual(
        Array(limit).fill(200)
      )

      // Instance B has never served a request for this identity. Two
      // independent Redis connections (clientA, clientB), two independent
      // Express apps, one shared counter: this is the actual claim under
      // test, observed here, not assumed from rate-limit-redis's docs.
      const resB = await request(appB).get('/ping')
      expect(
        resB.status,
        'instance B should be blocked because the limit is shared via Redis, not per-process'
      ).toBe(429)
    })

    it('createApiRateLimiters itself works end-to-end against a real Redis (smoke test of the production wiring)', async () => {
      const client = createRedisClient(redisUrl)
      clients.push(client)

      const limiters = createApiRateLimiters({ NODE_ENV: 'test' }, client)
      const app = express()
      app.use(...limiters)
      app.get('/ping', (_req, res) => res.status(200).json({ ok: true }))

      const res = await request(app).get('/ping')
      expect(res.status).toBe(200)
    })
  }
)
