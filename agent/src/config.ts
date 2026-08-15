/**
 * Environment-only configuration for the agent service (TRO-313 / FG-2;
 * extended by TRO-315 / FG-4 with the resilient-client knobs below).
 *
 * No secrets have defaults. Everything is read from `process.env` (or an
 * injected env map, for tests) — see `.env.example` for the documented shape.
 */

export interface AgentConfig {
  /** Port the HTTP server listens on. */
  port: number;
  /** Anthropic API key for the model provider. Required for /ready to pass. */
  anthropicApiKey: string | undefined;
  /** Base URL of the Ship API this agent reads from and acts on. */
  shipApiBaseUrl: string;
  /** Per-user Ship API token the agent runs under (FLEETGRAPH.MD: "no service account"). */
  shipApiToken: string | undefined;
  /** `internal` (default) | `sdk` — PF-702 (TRO-428). In `internal` mode
   *  `ShipClient`'s 10 read methods call Ship's internal `/api/*` routes
   *  directly, exactly as before this ticket. In `sdk` mode they delegate to
   *  `@ship/sdk`'s typed `/api/v1/*` resource clients instead — see
   *  `shipClient.ts`'s module docstring for the per-method mapping and the
   *  fields that structurally cannot carry over (documented there, not
   *  silently dropped). Stays `internal` by default until PF-704 (the full
   *  flag-matrix + audit-proof ticket) makes `sdk` graduation-ready — this
   *  ticket's own scope is READ delegation behind a flag defaulting OFF, not
   *  flipping the default. An unrecognized value falls back to `internal`
   *  (fail to the long-established, already-audited behavior, not to the
   *  newer one). */
  agentPlatformMode: 'internal' | 'sdk';
  /** Client secret for the first-party `ship_app_fleetgraph` OAuth app
   *  (PF-701, seeded by `seedFirstPartyApp.ts`; terraform variable
   *  `fleetgraph_oauth_client_secret`) — required only in `sdk` mode, to mint
   *  an app-identity Client Credentials token via `@ship/sdk`'s
   *  `ShipClient.clientCredentials()` (PF-702) rather than impersonating a
   *  human user for the shared/proactive `ShipClient` instance. No default:
   *  `undefined` in `internal` mode is normal and expected (this var is
   *  genuinely unused there); `undefined` while `agentPlatformMode === 'sdk'`
   *  is a misconfiguration `index.ts`'s boot path rejects loudly, same
   *  fail-closed posture `seedFirstPartyApp.ts` already uses for the
   *  identical env var on the api/ side. */
  fleetgraphOauthClientSecret: string | undefined;
  /** Whether LangSmith tracing is enabled (`LANGCHAIN_TRACING_V2=true`). */
  langchainTracingV2: boolean;
  /** LangSmith project name traces are grouped under. */
  langchainProject: string | undefined;
  /** Connect/read timeout, in ms, for outbound calls to Ship. */
  shipRequestTimeoutMs: number;
  /** Consecutive Ship failures before the circuit breaker trips open (FG-4). */
  shipBreakerFailureThreshold: number;
  /** How long the breaker stays open before a half-open trial, in ms (FG-4). */
  shipBreakerCooldownMs: number;
  /** Max attempts (including the first) for idempotent Ship GET reads (FG-4). */
  shipRetryMaxAttempts: number;
  /** Self-throttle ceiling, requests/minute, well under Ship's shared per-IP limit (FG-4). */
  shipSelfThrottleRpm: number;
  /** Steady-tier proactive poll cadence, in ms (TRO-317 / FG-5) — the
   * ticket's own trigger table names 60s; see FLEETGRAPH.MD's Trigger Model. */
  proactivePollIntervalMs: number;
  /** How far back the FIRST proactive poll (no cursor carried forward yet —
   * a fresh start/redeploy) looks, in ms (FG-5). */
  proactiveInitialLookbackMs: number;
  /** Hard cap on documents pulled into context per on-demand answer,
   * counting the seed itself (TRO-318 / FG-7) — "the single most important
   * implementation constraint in the whole design" (FLEETGRAPH.MD's Cost
   * Analysis: on-demand is already 64% of projected spend). `graph.ts`'s
   * `OnDemandDeps.documentCap` has no default of its own on purpose (see
   * that interface's docstring) — this is the one place a concrete number
   * is chosen, so it can be reasoned about and changed in one spot. DERIVED,
   * not measured: FLEETGRAPH.MD's cost model estimates ~9,000 input tokens
   * per on-demand answer with no cap stated; 12 documents at a few hundred
   * tokens of title/snippet/comment context each is consistent with that
   * figure without re-deriving it from scratch. There is no production
   * traffic yet to measure a better number against. */
  onDemandDocumentCap: number;
  /** Shared secret `POST /chat` requires on the `X-Internal-Secret` header
   * (TRO-320 / FG-9). This agent's HTTP surface is reachable from the public
   * internet (a Render service, no private networking configured) — without
   * this check, anyone could spend the configured Anthropic API budget and
   * query the graph as an arbitrary `askingUserId`. No default: `undefined`
   * means `/chat` fails closed (every request rejected), never open. Must
   * match the value `api/`'s `AGENT_API_BASE_URL`-calling route sends —
   * see `api/.env.example`. */
  agentInternalSecret: string | undefined;
  /** How long `POST /chat` (server.ts) waits on `graph.invoke(...)` before
   * giving up on ITS OWN response, in ms (CodeRabbit review, PR #120). The
   * `api/` proxy that calls this route aborts its own outbound fetch after
   * `AGENT_REQUEST_TIMEOUT_MS` (30s, `api/src/routes/agent.ts`) — but that
   * only stops api/'s wait; it does nothing to this Express handler, which
   * would otherwise keep awaiting a hung graph/model/Ship call indefinitely,
   * consuming a request slot for a caller that already received a 502.
   * Deliberately shorter than api/'s 30s bound so this process gives up
   * first, while the caller is still there to receive something other than
   * a connection reset. */
  chatHandlerTimeoutMs: number;
  /** Per-request timeout, in ms, for the raw Anthropic HTTP call underneath
   * every `ChatAnthropic.invoke()` in this package (TRO-368). Passed as
   * `clientOptions.timeout` — the only place `@langchain/anthropic` exposes
   * it (`AnthropicInput` has no top-level `timeout` field; it forwards
   * `clientOptions` straight into the `@anthropic-ai/sdk` client, verified
   * by reading `chat_models.cjs` directly, not assumed). The SDK's own
   * unconfigured default is 10 MINUTES — appropriate for a batch job, not
   * for a call sitting inside `server.ts`'s `/chat` handler, whose own
   * `chatHandlerTimeoutMs` above races `graph.invoke()` against an abort
   * signal that (per that handler's own comment) does NOT reach this
   * call once it is in flight, so an unbounded model call keeps running to
   * completion server-side even after the handler has already responded.
   *
   * CodeRabbit review, PR #156 (finding 1): TRO-368's first cut left this at
   * 20s with `anthropicMaxRetries` at 2 (three total attempts) — individually
   * "under chatHandlerTimeoutMs (25s)", but the WORST CASE is all three
   * attempts running their full timeout plus backoff between them
   * (`3 * 20_000 = 60_000ms`, before backoff), which is nowhere near 25s. A
   * per-attempt timeout under the handler deadline does not bound the
   * *retried* call; only the sum of every attempt plus every backoff delay
   * does. See `anthropicWorstCaseCallMs` below for the exact arithmetic this
   * value and `anthropicMaxRetries` are chosen to satisfy, checked against
   * `chatHandlerTimeoutMs` by `config.test.ts` (`anthropicWorstCaseCallMs`
   * describe block) so a future edit to any of the three values can't
   * silently reopen this gap. Comfortably covers a real haiku completion
   * under normal network conditions (low single-digit seconds observed in
   * this sprint's own traced runs — see FLEETGRAPH.MD's Execution Traces
   * section). Matters even more for `composeStandupDraft`/
   * `composeBlockerEscalation`/`composeRetroDraft`/`composePlanChangeDraft`,
   * which share this same `ChatAnthropic` instance (`index.ts`) but run
   * outside any HTTP handler at all once a scheduler exists to trigger
   * them — nothing bounds those today except this value (and unlike the
   * `/chat` path, there is no handler deadline they need to fit inside, so
   * the budget arithmetic below is a `/chat`-specific constraint, not a
   * universal one). */
  anthropicRequestTimeoutMs: number;
  /** Max retry attempts (`ChatAnthropic`'s own `maxRetries` field, which
   * `@langchain/core`'s `AsyncCaller` applies with exponential backoff and
   * jitter via `p-retry` — verified by reading `async_caller.cjs`, not
   * assumed from the option's name) for a failed Anthropic call. The raw
   * `@anthropic-ai/sdk` client's own retry logic is hardcoded OFF inside
   * `@langchain/anthropic` ("Prefer LangChain built-in retries",
   * `chat_models.cjs`) specifically so this is the one number in effect —
   * an unset value here would silently fall back to `AsyncCallerParams`'
   * documented default of 6, which is unexamined library behavior, not a
   * chosen one.
   *
   * CodeRabbit review, PR #156 (finding 1): originally 2 (three total
   * attempts), chosen to MATCH `resilientClient.ts`'s own
   * `DEFAULT_RETRY_MAX_ATTEMPTS` for Ship's idempotent reads — a reasonable
   * instinct that ignored a real constraint Ship's own retries don't have:
   * this call sits inside `/chat`'s `chatHandlerTimeoutMs` budget, and three
   * attempts at any timeout large enough to cover a real completion don't
   * fit inside it (see `anthropicRequestTimeoutMs` above). Lowered to 1 (two
   * total attempts) — still enough to absorb a single transient network blip
   * or 429 without paying for a third attempt the handler deadline has no
   * room for. `0` is a legitimate, intentional value (disables retries
   * entirely — see `loadConfig`'s `nonNegativeInt` parser below) and must
   * not be confused with "not configured". */
  anthropicMaxRetries: number;
  /** Assumed upper bound, in ms, on how long the on-demand path's PRE-model
   * work (`graph.ts`'s `resolveSeed`/`expandFrontier` Ship reads, run
   * BEFORE `composeAnswer` ever calls the model) takes — the number
   * `assertAnthropicBudgetFitsHandlerDeadline` below checks against, so
   * `chatHandlerTimeoutMs`'s margin over `anthropicWorstCaseCallMs` is a
   * named, checked constant rather than prose (TRO-379; previously this was
   * an UNSTATED assumption — `anthropicWorstCaseCallMs`'s own docstring
   * said "about 7s of margin" without that number being anything code
   * looked at). Naming it does not, by itself, bound pre-model work at
   * runtime — nothing stops `resolveSeed`/`expandFrontier` from taking
   * longer than this on any given request. What actually protects a run
   * that exceeds it is `graph.ts`'s `composeAnswer` receiving the SAME
   * `AbortSignal` the `/chat` handler races `graph.invoke()` against
   * (`server.ts`) and forwarding it into `model.invoke()` — so the model
   * call is cut off at whatever time is genuinely left when it starts,
   * regardless of whether pre-model work respected this allowance. This
   * field is the STARTUP check that the configured numbers are plausible
   * in the first place. */
  anthropicPreModelWorkAllowanceMs: number;
}

const DEFAULT_PORT = 3100;
const DEFAULT_SHIP_API_BASE_URL = 'http://localhost:3000';
const DEFAULT_SHIP_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_BREAKER_FAILURE_THRESHOLD = 5;
const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_SELF_THROTTLE_RPM = 500;
const DEFAULT_PROACTIVE_POLL_INTERVAL_MS = 60_000;
const DEFAULT_PROACTIVE_INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ON_DEMAND_DOCUMENT_CAP = 12;
// Shorter than api/'s own AGENT_REQUEST_TIMEOUT_MS (30_000ms,
// api/src/routes/agent.ts) — see chatHandlerTimeoutMs's own docstring.
const DEFAULT_CHAT_HANDLER_TIMEOUT_MS = 25_000;
// See anthropicRequestTimeoutMs's own docstring for why 8s and not the
// SDK's 10-minute default (CodeRabbit review, PR #156, finding 1: lowered
// from TRO-368's original 20s, which combined with 3 total attempts could
// take nearly a minute — see anthropicWorstCaseCallMs below).
const DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS = 8_000;
// See anthropicMaxRetries's own docstring for why 1 and not AsyncCallerParams'
// default of 6 (CodeRabbit review, PR #156, finding 1: lowered from TRO-368's
// original 2, for the same reason as the timeout above).
const DEFAULT_ANTHROPIC_MAX_RETRIES = 1;
// TRO-379: names the margin anthropicWorstCaseCallMs's own docstring already
// described ("about 7s of margin") as an explicit, checked number instead of
// prose. 7_000 is that same figure, chosen to match what PR #156's own
// arithmetic already assumed — not a new, independently-derived estimate of
// how long resolveSeed/expandFrontier actually take (there is no production
// traffic yet to measure that against, same caveat onDemandDocumentCap's own
// docstring states for its figure).
const DEFAULT_ANTHROPIC_PRE_MODEL_WORK_ALLOWANCE_MS = 7_000;

/**
 * PF-702 (TRO-428) — the first-party OAuth app's identity, duplicated here
 * (not imported) for the same reason `sdk/src/types.ts` duplicates
 * `DocumentType` rather than importing `@ship/shared`/`api/src`: `agent/`
 * cannot import from `api/src/...` (not a workspace it may reach into), so
 * every consumer independently verifies its own copy of the server's real
 * constant. Source of truth: `api/src/platform/oauth/seedFirstPartyApp.ts`'s
 * `FLEETGRAPH_CLIENT_ID` (`'ship_app_fleetgraph'`) / `FLEETGRAPH_APP_SCOPES`
 * (`['documents:read', 'issues:read', 'sprints:read']`) — read directly
 * before writing this, not guessed. There is no `FLEETGRAPH_OAUTH_CLIENT_ID`
 * terraform var (confirmed by grep, matching that file's own comment): the
 * seed and this agent can only agree on one `client_id` because it is a
 * shared literal, not a value only one side computes.
 */
export const FLEETGRAPH_CLIENT_ID = 'ship_app_fleetgraph';
export const FLEETGRAPH_APP_SCOPES = ['documents:read', 'issues:read', 'sprints:read'] as const;

/** Worst-case backoff (ms) `@langchain/core`'s `AsyncCaller` inserts before
 * the Nth retry attempt (1-indexed), when it is constructed the way this
 * package constructs it. Verified by reading the actual library source, not
 * assumed from the option's name: `async_caller.cjs`'s `AsyncCaller.call`
 * passes `{ retries: maxRetries, randomize: true }` to `p-retry` and
 * overrides nothing else, so the backoff shape falls through to the
 * `retry` package's own defaults (`retry.js`'s `exports.timeouts`:
 * `factor: 2, minTimeout: 1_000, maxTimeout: Infinity`). Its
 * `createTimeout(attempt, opts)` (0-indexed `attempt`) computes
 * `round(rand[1,2) * minTimeout * factor**attempt)` — worst case (rand -> 2)
 * for the Nth retry (`attempt = N - 1`) is `2 * 1_000 * 2**(N-1)`. */
function anthropicWorstCaseBackoffBeforeRetryMs(retryIndex: number): number {
  return 2 * 1_000 * 2 ** (retryIndex - 1);
}

/** Worst-case total wall time (ms) a single `ChatAnthropic` call can occupy
 * before `@langchain/core`'s `AsyncCaller` gives up and the call finally
 * rejects: every attempt running its full `anthropicRequestTimeoutMs`, plus
 * the worst-case backoff (`anthropicWorstCaseBackoffBeforeRetryMs`) between
 * each pair of attempts. This is the number `chatHandlerTimeoutMs` actually
 * has to be bigger than — a per-attempt timeout smaller than the handler
 * deadline does NOT imply the retried call is (CodeRabbit review, PR #156,
 * finding 1). Exported so `config.test.ts` can check the production
 * defaults against `chatHandlerTimeoutMs` without re-deriving this
 * arithmetic, and so anyone tuning these values by hand has something to
 * run instead of doing the multiplication themselves.
 *
 * With the DEFAULT_* values below: `anthropicWorstCaseCallMs(8_000, 1)` =
 * `2 attempts * 8_000ms + 2_000ms worst-case backoff` = `18_000ms`,
 * comfortably inside `DEFAULT_CHAT_HANDLER_TIMEOUT_MS`'s `25_000ms` — about
 * 7s of margin for the rest of `/chat`'s own work (the Ship reads
 * `resolveSeed`/`expandFrontier`/`ingest` do before the model is ever
 * called).
 *
 * TRO-379: that 7s WAS just this comment's own estimate — nothing checked
 * it, and nothing stopped a slow `resolveSeed`/`expandFrontier` run from
 * eating past it, at which point `composeAnswer`'s `model.invoke()` call
 * (which never received the handler's own `AbortSignal`) kept running to
 * completion server-side after `chatHandlerTimeoutMs` had already given up
 * on it — the exact TRO-368 symptom, reopened in a narrower form. Two
 * changes close that gap: `anthropicPreModelWorkAllowanceMs` (this file)
 * names the assumed margin as a real, checked number —
 * `assertAnthropicBudgetFitsHandlerDeadline` below rejects a configuration
 * where it plus this function's own worst case doesn't fit inside
 * `chatHandlerTimeoutMs`, at startup, before the process serves a request.
 * And `graph.ts`'s `composeAnswer` node now receives that SAME
 * `AbortSignal` and forwards it into `model.invoke()`, so an individual run
 * that exceeds the allowance in practice still gets cut off at the real
 * remaining deadline, not a fresh `anthropicWorstCaseCallMs` window counted
 * from whenever the model call happened to start. */
export function anthropicWorstCaseCallMs(requestTimeoutMs: number, maxRetries: number): number {
  const attempts = maxRetries + 1;
  let worstCaseBackoffMs = 0;
  for (let retryIndex = 1; retryIndex <= maxRetries; retryIndex++) {
    worstCaseBackoffMs += anthropicWorstCaseBackoffBeforeRetryMs(retryIndex);
  }
  return attempts * requestTimeoutMs + worstCaseBackoffMs;
}

/**
 * Startup guard (TRO-379): rejects a configuration where the Anthropic
 * call's own worst case (`anthropicWorstCaseCallMs`) plus the stated
 * pre-model-work allowance (`anthropicPreModelWorkAllowanceMs`) cannot fit
 * inside `chatHandlerTimeoutMs` — i.e. a configuration where even a
 * PERFECTLY on-time pre-model phase would leave no room for the model call
 * at all. This is a static check on four numbers, deliberately independent
 * of the runtime fix (`graph.ts`'s `composeAnswer` now receives the
 * handler's own `AbortSignal`, so an individual slow run is cut off at the
 * real deadline regardless of what this function assumes) — the two are
 * complementary: this catches an impossible configuration before the
 * process ever serves a request; the signal handles a run that goes long
 * despite a plausible one.
 *
 * Called once, at startup (`index.ts`), independent of `isConfigComplete` —
 * all four fields here (`chatHandlerTimeoutMs`, `anthropicRequestTimeoutMs`,
 * `anthropicMaxRetries`, `anthropicPreModelWorkAllowanceMs`) carry real
 * defaults whether or not `ANTHROPIC_API_KEY`/`SHIP_API_TOKEN` are set, so
 * the arithmetic is checkable — and worth checking — regardless of whether
 * `/chat` will otherwise be reachable. Throws rather than warns: this
 * file's existing fail-closed posture for `agentInternalSecret` ("No
 * default: `undefined` means `/chat` fails closed, never open") extends
 * naturally to "a budget that cannot hold should never start serving,"
 * rather than silently degrading until a real request exposes it as a 5xx.
 */
export function assertAnthropicBudgetFitsHandlerDeadline(config: AgentConfig): void {
  const worstCaseModelMs = anthropicWorstCaseCallMs(config.anthropicRequestTimeoutMs, config.anthropicMaxRetries);
  const requiredMs = worstCaseModelMs + config.anthropicPreModelWorkAllowanceMs;
  if (requiredMs > config.chatHandlerTimeoutMs) {
    throw new Error(
      `[agent] chatHandlerTimeoutMs (${config.chatHandlerTimeoutMs}ms) cannot hold the configured Anthropic ` +
        `budget: anthropicWorstCaseCallMs(anthropicRequestTimeoutMs=${config.anthropicRequestTimeoutMs}ms, ` +
        `anthropicMaxRetries=${config.anthropicMaxRetries}) = ${worstCaseModelMs}ms + ` +
        `anthropicPreModelWorkAllowanceMs (${config.anthropicPreModelWorkAllowanceMs}ms) = ${requiredMs}ms, ` +
        'which exceeds chatHandlerTimeoutMs. Raise CHAT_HANDLER_TIMEOUT_MS, lower ' +
        'ANTHROPIC_REQUEST_TIMEOUT_MS/ANTHROPIC_MAX_RETRIES, or lower ANTHROPIC_PRE_MODEL_WORK_ALLOWANCE_MS.'
    );
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Same contract as `positiveInt`, except `0` is a valid, meaningful result
 * rather than a rejected one (CodeRabbit review, PR #156, finding 2):
 * `ANTHROPIC_MAX_RETRIES=0` is the documented way to disable
 * `@langchain/core`'s `AsyncCaller` retries entirely (its own `maxRetries`
 * field genuinely accepts 0 — verified by reading `async_caller.cjs`: it is
 * passed straight through to `p-retry`'s `retries` option with no
 * special-casing), and `positiveInt`'s `parsed > 0` check would silently
 * discard that choice and fall back to the default instead. Also stricter
 * than `positiveInt` about malformed input: `Number.parseInt` alone accepts
 * a leading-numeric string like `"2abc"` (`parseInt("2abc", 10) === 2`), so
 * this validates the WHOLE trimmed string is digits before parsing it,
 * rejecting negatives (a leading `-` fails the digits-only test) and
 * anything non-numeric back to the fallback rather than a partially-parsed
 * value. */
/** PF-702 — parses `AGENT_PLATFORM_MODE`. Falls back to `'internal'` for
 *  anything other than the literal string `'sdk'` (unset, empty, or a typo)
 *  — same "fail to the established behavior" reasoning as `AgentConfig
 *  .agentPlatformMode`'s own docstring. */
function parsePlatformMode(value: string | undefined): 'internal' | 'sdk' {
  return value === 'sdk' ? 'sdk' : 'internal';
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Load config from an env map. Defaults to `process.env`; tests inject a fake map. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return {
    port: positiveInt(env.PORT, DEFAULT_PORT),
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    shipApiBaseUrl: env.SHIP_API_BASE_URL ?? DEFAULT_SHIP_API_BASE_URL,
    shipApiToken: env.SHIP_API_TOKEN,
    agentPlatformMode: parsePlatformMode(env.AGENT_PLATFORM_MODE),
    fleetgraphOauthClientSecret: env.FLEETGRAPH_OAUTH_CLIENT_SECRET,
    langchainTracingV2: env.LANGCHAIN_TRACING_V2 === 'true',
    langchainProject: env.LANGCHAIN_PROJECT,
    shipRequestTimeoutMs: positiveInt(env.SHIP_REQUEST_TIMEOUT_MS, DEFAULT_SHIP_REQUEST_TIMEOUT_MS),
    shipBreakerFailureThreshold: positiveInt(
      env.SHIP_BREAKER_FAILURE_THRESHOLD,
      DEFAULT_BREAKER_FAILURE_THRESHOLD
    ),
    shipBreakerCooldownMs: positiveInt(env.SHIP_BREAKER_COOLDOWN_MS, DEFAULT_BREAKER_COOLDOWN_MS),
    shipRetryMaxAttempts: positiveInt(env.SHIP_RETRY_MAX_ATTEMPTS, DEFAULT_RETRY_MAX_ATTEMPTS),
    shipSelfThrottleRpm: positiveInt(env.SHIP_SELF_THROTTLE_RPM, DEFAULT_SELF_THROTTLE_RPM),
    proactivePollIntervalMs: positiveInt(
      env.PROACTIVE_POLL_INTERVAL_MS,
      DEFAULT_PROACTIVE_POLL_INTERVAL_MS
    ),
    proactiveInitialLookbackMs: positiveInt(
      env.PROACTIVE_INITIAL_LOOKBACK_MS,
      DEFAULT_PROACTIVE_INITIAL_LOOKBACK_MS
    ),
    // `positiveInt` also guarantees >= 1 here — a misconfigured "0" cannot
    // silently disable expansion (`OnDemandDeps.documentCap`'s own docstring:
    // "required, not a nice-to-have").
    onDemandDocumentCap: positiveInt(env.ON_DEMAND_DOCUMENT_CAP, DEFAULT_ON_DEMAND_DOCUMENT_CAP),
    agentInternalSecret: env.AGENT_INTERNAL_SECRET,
    chatHandlerTimeoutMs: positiveInt(env.CHAT_HANDLER_TIMEOUT_MS, DEFAULT_CHAT_HANDLER_TIMEOUT_MS),
    anthropicRequestTimeoutMs: positiveInt(
      env.ANTHROPIC_REQUEST_TIMEOUT_MS,
      DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS
    ),
    // `nonNegativeInt`, not `positiveInt` (CodeRabbit review, PR #156,
    // finding 2) — `0` is the documented way to disable retries and must
    // survive, not fall back to the default.
    anthropicMaxRetries: nonNegativeInt(env.ANTHROPIC_MAX_RETRIES, DEFAULT_ANTHROPIC_MAX_RETRIES),
    // TRO-379 — see AgentConfig.anthropicPreModelWorkAllowanceMs's own
    // docstring for what this is checked against and why.
    anthropicPreModelWorkAllowanceMs: positiveInt(
      env.ANTHROPIC_PRE_MODEL_WORK_ALLOWANCE_MS,
      DEFAULT_ANTHROPIC_PRE_MODEL_WORK_ALLOWANCE_MS
    ),
  };
}

/**
 * "Config loaded" half of /ready (TRO-313's proof section). The other half —
 * Ship reachability — is a live check, not a static one; see `health.ts`.
 *
 * Deliberately does NOT include `agentInternalSecret`: that field gates one
 * route (`POST /chat`, TRO-320 / FG-9) and is checked there directly — folding
 * it in here would make `/ready` (and the proactive poller's start condition,
 * `index.ts`) depend on a value that has nothing to do with either. A missing
 * secret makes `/chat` fail closed on its own; it does not make the process
 * "not ready."
 */
export function isConfigComplete(config: AgentConfig): boolean {
  return (
    Boolean(config.anthropicApiKey) &&
    config.shipApiBaseUrl.length > 0 &&
    Boolean(config.shipApiToken)
  );
}
