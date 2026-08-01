/**
 * Redis-backed storage for the rate limiters — TRO-280 / API-7.
 *
 * The defect: `express-rate-limit`'s default `MemoryStore` (used by every
 * limiter in `rate-limit.ts` and by `loginLimiter` in `app.ts`) lives in one
 * Node process's heap. Elastic Beanstalk's auto-scaling group runs 1-4
 * instances (`terraform/elastic-beanstalk.tf`'s `aws:autoscaling:asg`
 * `MinSize`/`MaxSize`) behind a load balancer with no session affinity, so a
 * client's requests are distributed across instances round-robin-ish. A
 * limit configured as "600 requests/minute per identity" is actually "600 x
 * N instances requests/minute", where N silently changes under autoscaling
 * load — precisely when the limiter matters most. This file makes the
 * counters live in one place (Redis) that every instance shares, so the
 * configured ceiling is the real ceiling regardless of N.
 *
 * CONCURRENCY (rule 6 — this ticket IS the concurrency argument): the naive
 * fix for a distributed counter — "GET the count, add one, SET it back" — is
 * a read-then-write race: two instances can both read the same count and
 * both write back the same incremented value, silently under-counting and
 * defeating the limiter under exactly the concurrent load it exists to
 * survive. `rate-limit-redis`'s `RedisStore` does not do that: it loads a Lua
 * script (`loadIncrementScript`) and runs it with `EVALSHA`, so the
 * read-increment-expire sequence executes atomically on the Redis server
 * itself — Redis is single-threaded for command execution, so two concurrent
 * `EVALSHA` calls for the same key are serialized by the server, never
 * interleaved. That atomicity is the entire fix; nothing in this file
 * reimplements it, it only wires a client to the library that provides it.
 *
 * FAIL-OPEN DECISION (rule 7 — failure mode of the new outbound dependency):
 * when Redis is configured (`REDIS_URL` set) but unreachable at runtime, this
 * fails OPEN — the request is allowed through and the error is logged,
 * rather than failing CLOSED (blocking all traffic). Reasoning:
 *
 *   - A rate limiter's job is anti-abuse, not availability. Failing closed
 *     turns a Redis blip into a full API outage for every user, which is a
 *     worse outcome than temporarily un-throttled traffic.
 *   - `perSourceIpLimiter`/`perIdentityLimiter` are one layer of defense, not
 *     the only one (helmet, CSRF, session auth, the login limiter's own
 *     5-attempts/15-min ceiling are all independent of this store).
 *   - The blast radius of "briefly un-throttled" is bounded and recoverable;
 *     the blast radius of "the whole API 500s because the rate limiter's
 *     backing store hiccuped" is not.
 *
 * Implemented three ways, deliberately redundant:
 *   1. Every limiter built with a Redis store also sets
 *      `passOnStoreError: true` (a first-class `express-rate-limit` option —
 *      see its `dist/index.cjs`: on a rejected `store.increment()` it logs
 *      and calls `next()` instead of propagating the error to Express's error
 *      handler).
 *   2. The ioredis client itself is configured to fail a given command FAST
 *      (`maxRetriesPerRequest: 1`, a bounded `retryStrategy`, a
 *      `connectTimeout`) rather than queuing it indefinitely — a fail-open
 *      policy is worthless if the "open" path still blocks the request for
 *      seconds waiting on a queued command that will never succeed.
 *   3. CIRCUIT BREAKER (TRO-311, RULE-7 follow-up): (1) and (2) bound the
 *      cost of any ONE failed command, but do nothing to stop every
 *      subsequent request from paying that same bounded cost again during a
 *      sustained outage. `sendRedisCommand` below routes every call through a
 *      `CircuitBreaker` (`utils/circuitBreaker.ts`), one per underlying
 *      `Redis` client instance: after `REDIS_CIRCUIT_FAILURE_THRESHOLD`
 *      consecutive failures it trips OPEN and every subsequent call fails
 *      immediately with `CircuitOpenError` — Redis is not contacted at all —
 *      until `REDIS_CIRCUIT_COOLDOWN_MS` has elapsed, at which point exactly
 *      one trial call is allowed through to check for recovery. A
 *      `CircuitOpenError` is just another rejection from the store's
 *      perspective, so it flows into the exact same `passOnStoreError`
 *      fail-open path as any other Redis error — this is additive latency/
 *      load protection on top of (1) and (2), not a replacement for either.
 */
import { Redis } from 'ioredis';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { CircuitBreaker } from '../utils/circuitBreaker.js';

/** Any environment-like object; deliberately loose so callers can pass `process.env` directly. */
export interface RedisEnv {
  REDIS_URL?: string;
  [key: string]: string | undefined;
}

/**
 * ioredis emits an `'error'` event on every failed connection attempt and
 * every command-level socket error. An `EventEmitter` with no `'error'`
 * listener re-throws on the next tick and crashes the process — on Node,
 * that is the default behavior for the `'error'` event specifically. Without
 * this handler, the very first Redis outage this file exists to survive
 * would instead take the whole API process down, which is the opposite of
 * "fail open." Logged once per event, not accumulated — a flapping
 * connection logs repeatedly, which is intentional (visible in ops, not
 * silently swallowed).
 */
function attachErrorLogging(client: Redis): Redis {
  client.on('error', (err: Error) => {
    console.error('[rate-limit] Redis client error (falling back to allowing requests):', err.message);
  });
  return client;
}

/**
 * Build an ioredis client tuned so a command fails fast when Redis is
 * unreachable, instead of sitting in ioredis's offline queue.
 *
 *  - `maxRetriesPerRequest: 1` — a queued command gets one reconnect attempt
 *    before rejecting, rather than the client default of 20.
 *  - `retryStrategy` — bounds the delay before that one reconnect attempt
 *    (200ms x attempt number, capped at 2s), so "one retry" cannot itself
 *    become a multi-second stall.
 *  - `connectTimeout: 2000` — the initial TCP+handshake attempt also fails
 *    fast rather than hanging on a black-holed connection.
 */
export function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
  });
  return attachErrorLogging(client);
}

/** `createRedisClient`, gated on `REDIS_URL` being configured at all. */
export function createRedisClientFromEnv(env: RedisEnv): Redis | undefined {
  return env.REDIS_URL ? createRedisClient(env.REDIS_URL) : undefined;
}

/**
 * One breaker per underlying `Redis` client instance, not per limiter/prefix
 * — `app.ts` shares a single `rateLimitRedisClient` across every limiter it
 * builds, and an outage of that connection is a property of the connection,
 * not of any one limiter's key namespace. A `WeakMap` means a client that
 * goes out of scope (e.g. in tests, which construct many short-lived clients)
 * doesn't leak breaker instances.
 */
const redisCircuitBreakers = new WeakMap<Redis, CircuitBreaker>();

/** Trip after this many consecutive failures. */
export const REDIS_CIRCUIT_FAILURE_THRESHOLD = 3;
/** Stay OPEN this long before allowing a HALF_OPEN trial call. */
export const REDIS_CIRCUIT_COOLDOWN_MS = 10_000;

function getCircuitBreaker(client: Redis): CircuitBreaker {
  let breaker = redisCircuitBreakers.get(client);
  if (!breaker) {
    breaker = new CircuitBreaker({
      failureThreshold: REDIS_CIRCUIT_FAILURE_THRESHOLD,
      cooldownMs: REDIS_CIRCUIT_COOLDOWN_MS,
    });
    redisCircuitBreakers.set(client, breaker);
  }
  return breaker;
}

/**
 * ioredis' `call()` returns `Promise<unknown>` (rule 8: it hands us
 * `unknown`, not a lie dressed as `any`) — it can't know ahead of time which
 * of Redis's many reply shapes a given command produces. `rate-limit-redis`
 * only ever issues the commands its own bundled Lua scripts need (EVALSHA /
 * SCRIPT LOAD / DEL), which resolve to its own `RedisReply` union
 * (`boolean | number | string`, or an array of those). This is the single
 * narrow boundary cast, matching `rate-limit-redis`'s own documented ioredis
 * integration (its readme's "To use it with an `ioredis` client" example
 * casts the same way).
 */
async function sendRedisCommand(client: Redis, command: string, args: string[]): Promise<RedisReply> {
  const breaker = getCircuitBreaker(client);
  const reply = await breaker.execute(() => client.call(command, ...args));
  return reply as RedisReply;
}

/**
 * Build a `RedisStore` for one limiter. `prefix` MUST be distinct per
 * limiter that shares a client/server — Redis has one flat keyspace, and
 * `perSourceIpLimiter`, `perIdentityLimiter`, and `loginLimiter` must not be
 * able to collide with (or silently share counts with) each other.
 *
 * FOUND WHILE BUILDING THIS TICKET'S OWN tests, not from `rate-limit-redis`'s
 * docs: its `RedisStore` constructor eagerly kicks off *two* Lua
 * `SCRIPT LOAD` calls — `incrementScriptSha` and `getScriptSha` — and stores
 * each as a bare promise field, before this function (or `express-rate-limit`)
 * ever calls `.increment()`. `incrementScriptSha` gets awaited later, inside
 * `retryableIncrement`, so its rejection is eventually handled. `getScriptSha`
 * backs `.get()`, which none of this app's limiters call — so if Redis is
 * unreachable at the moment a store is constructed, that promise rejects with
 * nothing ever awaiting it: an unhandled rejection, which crashes a modern
 * Node process by default. That is the exact opposite of this file's
 * fail-open design, and it would fire at boot (or at the next reconnect
 * attempt) rather than during a request, which is why the fail-open tests
 * (`__tests__/redis-rate-limit-store.test.ts`) construct a store against an
 * unreachable Redis directly, not just through a running limiter.
 *
 * The `.catch(() => {})` calls below attach an additional (not exclusive)
 * handler to each promise — they do not consume or replace the promise
 * object `retryableIncrement` still awaits, so the real rejection is still
 * observed and still drives `passOnStoreError`'s fail-open path. This only
 * stops the redundant, nobody-else-awaits-it copy from reaching Node's
 * unhandled-rejection handler.
 */
export function createRedisRateLimitStore(client: Redis, prefix: string): RedisStore {
  const store = new RedisStore({
    prefix,
    sendCommand: (command: string, ...args: string[]) => sendRedisCommand(client, command, args),
  });
  store.incrementScriptSha.catch(() => {});
  store.getScriptSha.catch(() => {});
  return store;
}

/** Key prefixes — one per limiter, see `createRedisRateLimitStore`'s doc. */
export const REDIS_KEY_PREFIX_SOURCE_IP = 'rl:ip:';
export const REDIS_KEY_PREFIX_IDENTITY = 'rl:id:';
export const REDIS_KEY_PREFIX_LOGIN = 'rl:login:';
/**
 * TRO-308: the static-SPA/catch-all limiter (`createSpaStaticLimiter` in
 * `rate-limit.ts`) gets its own prefix — a separate bucket from
 * `REDIS_KEY_PREFIX_SOURCE_IP` — so an anonymous page-load flood and an
 * `/api/*` flood from the same source IP can't exhaust each other's budget.
 */
export const REDIS_KEY_PREFIX_SPA_STATIC = 'rl:spa:';
