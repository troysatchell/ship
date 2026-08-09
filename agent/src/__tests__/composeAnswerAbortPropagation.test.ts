/**
 * TRO-379: the /chat handler's abort signal never reached the Anthropic
 * call, and the retry+timeout budget (`config.ts`'s
 * `anthropicWorstCaseCallMs`) bounded the model call in isolation, ignoring
 * how long `resolveSeed`/`expandFrontier` (the pre-model Ship reads) took.
 *
 * IMPORTANT, OBSERVED finding this test is built around (see `graph.ts`'s
 * `composeAnswer` for the full citation): a first version of this test used
 * a REAL `ChatAnthropic` pointed at a local hanging server, the same
 * pattern `server.test.ts`'s TRO-368 tests use — and it passed even against
 * the UNFIXED `composeAnswer` (no `{ signal }` forwarded to `model.invoke`).
 * That is not this test being wrong; it is a real, separately-verified fact
 * about `@langchain/langgraph`: `RunnableCallable.invoke` (`utils.cjs`) runs
 * every node function inside `AsyncLocalStorageProviderSingleton.
 * runWithConfig(mergedConfig, ...)`, and `ChatAnthropic.invoke()` — being a
 * LangChain `Runnable` — picks up that AMBIENT config (via `ensureConfig()`,
 * `@langchain/core`'s `runnables/config.cjs`) even when `composeAnswer`
 * passes no options at all. `ChatAnthropic` was already, silently,
 * protected by a side channel this file never asked for.
 *
 * That is exactly why THIS test uses a plain-object `AnthropicModel`
 * implementation instead — `invoke: (input, options) => fetch(hangingUrl,
 * { signal: options?.signal })` — structurally identical to what
 * `graph.ts`'s own narrow interface requires, but NOT a LangChain
 * `Runnable`, so it gets none of `ChatAnthropic`'s ambient help. This is
 * the version of the bug that is real, reproducible, and specific to THIS
 * file's own code (`composeAnswer` failing to forward `config.signal` into
 * `model.invoke()`) rather than to which model implementation happens to be
 * wired in. No live Anthropic or Ship call is made anywhere in this file —
 * the "model" is a fetch to a local `node:http` server that never responds.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { loadConfig } from '../config.js';
import { createServer as createAgentServer } from '../server.js';
import { buildGraph, type AnthropicModel } from '../graph.js';
import type { OnDemandShipClientLike, ShipDocument } from '../shipClient.js';

describe('POST /chat — composeAnswer forwards the handler AbortSignal to ANY conforming AnthropicModel (TRO-379)', () => {
  const SECRET = 'test-internal-secret';
  let hangingServer: HttpServer;
  let hangingServerUrl: string;
  let attemptCount: number;
  let requestClosed: boolean;

  beforeEach(async () => {
    attemptCount = 0;
    requestClosed = false;
    hangingServer = createHttpServer((req) => {
      attemptCount += 1;
      // Deliberately never call res.end()/res.write() — this request only
      // ever ends if the CLIENT tears down the connection (an abort), which
      // is exactly the behaviour under test. We never complete it
      // normally, so 'close' firing can only mean "the client gave up."
      req.on('close', () => {
        requestClosed = true;
      });
    });
    await new Promise<void>((resolve) => hangingServer.listen(0, '127.0.0.1', resolve));
    const address = hangingServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('unreachable — listen(0, "127.0.0.1") always yields an AddressInfo');
    }
    hangingServerUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
  });

  const SEED_DOC_ID = 'seed-doc-tro-379';

  function seedDoc(): ShipDocument {
    return {
      id: SEED_DOC_ID,
      title: 'Delayed seed',
      document_type: 'issue',
      content: null,
      visibility: 'workspace',
      created_by: null,
      properties: {},
    };
  }

  /** A seed document with no associations/backlinks/comments — resolveSeed's
   * own frontier ends up empty, so expandFrontier does not loop and the
   * graph goes straight resolveSeed -> expandFrontier -> finalizeExpansion
   * -> composeAnswer, keeping the timing in this test attributable to ONE
   * delay: getDocument, resolveSeed's own first Ship read. */
  function delayedSeedClient(delayMs: number): OnDemandShipClientLike {
    return {
      getDocument: async (id: string) => {
        // Simulates resolveSeed's real Ship read taking real, non-trivial
        // wall time — the exact "pre-model work" TRO-379's problem #1 says
        // the old budget (anthropicWorstCaseCallMs alone) never accounted
        // for.
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (id !== SEED_DOC_ID) throw new Error(`404: ${id}`);
        return seedDoc();
      },
      getAssociations: async () => [],
      getReverseAssociations: async () => [],
      getBacklinks: async () => [],
      getComments: async () => [],
      getIssuesByAssignee: async () => [],
    };
  }

  /** Conforms to `graph.ts`'s own `AnthropicModel` interface, structurally —
   * the same narrow shape `buildAnthropicModel` produces — but is NOT a
   * LangChain `Runnable` and gets none of `ChatAnthropic`'s ambient
   * AsyncLocalStorage signal propagation (see this file's module docstring).
   * Whether `composeAnswer` genuinely forwards `config.signal` into
   * `model.invoke()` is the ENTIRE thing this fake can observe. */
  function fetchBackedModel(url: string): AnthropicModel {
    return {
      invoke: async (input: string, options?: { signal?: AbortSignal }) => {
        const res = await fetch(url, { signal: options?.signal });
        return { content: await res.text() };
      },
    };
  }

  it(
    'aborts the in-flight model request once the handler times out, even though the model call only started AFTER most of the budget was already spent on resolveSeed',
    async () => {
      // 500ms total handler budget; resolveSeed alone takes 300ms — by the
      // time composeAnswer calls the model, only ~200ms of the ORIGINAL
      // budget is left. Nothing in this test gives the fake model its own
      // internal timeout, so if `composeAnswer` never forwards a signal,
      // NOTHING ever cancels this request — it would stay open
      // indefinitely, not just for some large-but-finite window.
      const config = loadConfig({
        ANTHROPIC_API_KEY: 'sk-test',
        SHIP_API_BASE_URL: 'https://ship.example.gov',
        SHIP_API_TOKEN: 'token-abc',
        AGENT_INTERNAL_SECRET: SECRET,
        CHAT_HANDLER_TIMEOUT_MS: '500',
      });

      const model = fetchBackedModel(hangingServerUrl);

      const graph = buildGraph(model, undefined, {
        shipClientFactory: () => delayedSeedClient(300),
        documentCap: 4,
      });

      const app = createAgentServer(config, { graph });

      const start = Date.now();
      const res = await request(app)
        .post('/chat')
        .set('X-Internal-Secret', SECRET)
        .send({
          seedDocumentId: SEED_DOC_ID,
          question: 'why is this stalled?',
          askingUserId: 'user-1',
          askingUserToken: 'user-1-token',
        });
      const elapsed = Date.now() - start;

      // The handler gave up close to its own configured deadline (500ms) —
      // server.test.ts's existing 504 tests already cover this half;
      // asserted here only to establish the timing this test's own "still
      // in flight" check depends on.
      expect(res.status).toBe(504);
      expect(elapsed).toBeLessThan(2_000);

      // The model call DID start (the pre-model delay, 300ms, is less than
      // the 500ms handler budget) — this is genuinely testing cancellation
      // of an in-flight request, not merely a request that never began.
      expect(attemptCount).toBe(1);

      // Give the abort a little room to propagate, then assert the
      // underlying connection to the model was actually torn down. This is
      // the DoD's own "no Anthropic request remains in flight after the
      // handler timeout" — and, per this file's module docstring, the ONE
      // proof that genuinely depends on composeAnswer's own code rather
      // than on ChatAnthropic's unrelated ambient behaviour.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(requestClosed).toBe(true);
    },
    10_000
  );
});
