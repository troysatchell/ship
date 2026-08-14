/**
 * PF-405 (Linear TRO-422) — bidirectional `/api/v1` <-> `@ship/sdk` parity
 * fitness test. The closest existing precedent in this codebase is PF-203's
 * `api/src/platform/api/v1/__tests__/route-fitness.test.ts` (walk a live
 * registry/router and assert coverage, structurally, not off a
 * hand-maintained route list) — read in full before writing this file. That
 * test checks routes <-> OpenAPI; this one checks OpenAPI <-> SDK. Same
 * discipline, one layer over.
 *
 * THE ONE DELIBERATE CROSS-PACKAGE IMPORT IN THIS FILE (same exception
 * `client.liveServer.test.ts` already makes in this package, for the same
 * reason — see that file's own header): this suite's whole job is comparing
 * `@ship/sdk` against api's REAL, GENERATED `/api/v1` OpenAPI document, so it
 * has to import that document directly rather than a copy/fixture of it. It
 * is safe to import with no server and no database: `v1OpenApiDocument` is
 * computed once, at module load, purely from `v1Registry`'s zod-schema
 * registrations (`api/src/platform/openapi/index.ts` — read in full) — the
 * exact same import `route-fitness.test.ts` already makes with no DB setup
 * of its own. `sdk/tsconfig.json` excludes `src/__tests__/**` from
 * `tsc`/`tsc --noEmit` for exactly this reason (that file's own comment);
 * `sdk/vitest.config.ts`'s `include` still covers this file, so it runs and
 * asserts real behavior — it just isn't part of `pnpm --filter @ship/sdk
 * type-check`.
 *
 * ─── THE MAPPING RULE (stated explicitly, per this ticket's own brief —
 * "work out the right mapping rule ... don't hand-wave it") ───────────────
 *
 * WHAT COUNTS AS "AN SDK METHOD": every own (non-inherited, non-constructor)
 * instance method on `ShipClient.prototype` plus every resource client's
 * prototype (`DocumentsClient`, `IssuesClient`, `SprintsClient`,
 * `WebhooksClient`) — discovered by walking `Object.getOwnPropertyNames`,
 * NOT a hand-maintained method list, so a new method added to any of these
 * five classes is picked up automatically the next time this suite runs.
 * `ShipClient`'s STATIC methods (`deviceLogin`, `authorizationCodeFlow`) are
 * deliberately excluded from the walk (not exempted from it — they are not
 * instance methods on a prototype, so `Object.getOwnPropertyNames(prototype)`
 * never finds them at all) because they call `/oauth/*` endpoints, which are
 * NOT `/api/v1/*` operations: verified directly — `api/src/openapi/schemas/
 * auth.ts` registers those paths on the SEPARATE internal registry
 * (`api/src/openapi/registry.ts`), never on `v1Registry`, so they never
 * appear in `v1OpenApiDocument` at all. Out of scope by construction, not by
 * exemption.
 *
 * WHAT COUNTS AS "AN OPENAPI OPERATION": every (method, path) pair actually
 * present on `v1OpenApiDocument.paths` — discovered by walking that object's
 * real keys, not a hand-maintained endpoint list.
 *
 * WHAT COUNTS AS "CORRESPONDENCE": a SINGLE hand-maintained table,
 * `SDK_TO_OPERATION` below, is the one non-structural piece of this file —
 * inferring correspondence from naming alone (`get` -> GET .../{id}`?
 * `rotateSecret` -> POST .../rotate`?) is exactly the kind of hand-waving
 * this ticket's brief warns against; `webhooks.rotateSecret()` has no
 * naming convention that would derive `POST /webhooks/{id}/rotate` from it
 * reliably. So the correspondence itself is stated, explicitly, once, per
 * method. What is NOT hand-maintained is whether that table is still
 * TRUE: every assertion below cross-checks `SDK_TO_OPERATION` against the
 * two LIVE discovered sets, in both directions, so:
 *   - a table entry naming a method that no longer exists (renamed/removed)
 *     fails ("stale keys" checks below);
 *   - a table entry naming an operation that no longer exists
 *     (renamed/removed server-side) fails (the orphan-method AC this ticket
 *     names explicitly);
 *   - a newly added method or operation with no table entry and no
 *     exemption fails (the missing-coverage AC).
 * The table can drift from reality; the SUITE cannot silently tolerate that
 * drift.
 *
 * EXEMPTIONS — two small, reasoned, table-driven carve-outs (same mechanism
 * as `route-fitness.test.ts`'s `KNOWN_EXEMPTIONS`), each checked for
 * staleness the same way `SDK_TO_OPERATION` is:
 *   - `SDK_EXEMPTIONS`: an SDK method that deliberately has no OpenAPI
 *     operation. Two reasons appear today — `iterate()` (PF-402) is a
 *     client-side pagination convenience wrapping `list()`'s cursor in an
 *     async generator, not a second HTTP call shape (this ticket's own brief
 *     names this exact case); and `webhooks.listDeliveries`/
 *     `webhooks.replayDelivery`, which target `/webhooks/deliveries*` routes
 *     PF-305/PF-306 have not built yet (verified absent from the real,
 *     merged PF-302 registration — see `resources/webhooks.ts`'s header).
 *     This second kind should SHRINK over time, not grow: the day PF-305/
 *     PF-306 land, delete those two lines and add real `SDK_TO_OPERATION`
 *     entries instead.
 *   - `OPENAPI_EXEMPTIONS`: an operation that deliberately has no typed SDK
 *     method — `GET /health` and `GET /openapi.json`, both infra/meta
 *     endpoints rather than typed domain resources (the identical two
 *     routes `route-fitness.test.ts`'s own `KNOWN_EXEMPTIONS` carves out,
 *     for the identical reason).
 *
 * WHAT THIS TEST DELIBERATELY DOES NOT CHECK: response BODY/field-level
 * shape (e.g. whether `WebhookSubscription`'s TS interface matches the real
 * server's `{app_id, event_type, target_url, active, created_at}` row shape
 * — it currently does NOT; see `resources/webhooks.ts`'s "KNOWN, NOT FIXED
 * BY PF-405" note). This ticket's own brief scopes the fitness test to
 * "every OpenAPI operation ... a corresponding typed method exists" —
 * operation (method+path) existence, the same granularity
 * `route-fitness.test.ts` checks at (routes <-> registration), not a
 * schema-equivalence checker. Flagged, not silently expanded into scope.
 */
import { describe, it, expect } from 'vitest';

import { v1OpenApiDocument } from '../../../api/src/platform/openapi/index.js';

import { ShipClient } from '../client.js';
import { DocumentsClient } from '../resources/documents.js';
import { IssuesClient } from '../resources/issues.js';
import { SprintsClient } from '../resources/sprints.js';
import { WebhooksClient } from '../resources/webhooks.js';

// ─── Structural discovery #1: every /api/v1 operation ─────────────────────

type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'patch' | 'head' | 'options';
const HTTP_METHODS: readonly HttpMethod[] = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

interface OpenApiOperation {
  method: HttpMethod;
  path: string;
}

function operationLabel(op: OpenApiOperation): string {
  return `${op.method.toUpperCase()} ${op.path}`;
}

function operationKey(op: OpenApiOperation): string {
  return `${op.method} ${op.path}`;
}

/** Walks `v1OpenApiDocument.paths`' real keys — not a hand-maintained
 *  endpoint list, so a new `registerPath` call anywhere under
 *  `api/src/platform/openapi/schemas/*.ts` is picked up automatically. */
function discoverOpenApiOperations(): OpenApiOperation[] {
  const paths = (v1OpenApiDocument.paths ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const ops: OpenApiOperation[] = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      if (pathItem[method] !== undefined) {
        ops.push({ method, path });
      }
    }
  }
  return ops;
}

// ─── Structural discovery #2: every SDK method ─────────────────────────────

interface SdkMethod {
  /** Dotted call-site name a human would write: 'me' (bare ShipClient
   *  method) or 'documents.list' (resource-client method). */
  qualifiedName: string;
}

/** Own (non-inherited), non-constructor, function-valued property names on
 *  a class prototype — reflection, not a hand-maintained method list. */
function ownInstanceMethodNames(prototype: object): string[] {
  return Object.getOwnPropertyNames(prototype).filter((name) => {
    if (name === 'constructor') return false;
    return typeof (prototype as Record<string, unknown>)[name] === 'function';
  });
}

function discoverSdkMethods(): SdkMethod[] {
  const groups: ReadonlyArray<{ prefix: string; prototype: object }> = [
    // ShipClient's own instance methods (today: just `me`). Static methods
    // (deviceLogin/authorizationCodeFlow) are never seen here — see this
    // file's header for why that's out-of-scope-by-construction, not a hole.
    { prefix: '', prototype: ShipClient.prototype },
    { prefix: 'documents.', prototype: DocumentsClient.prototype },
    { prefix: 'issues.', prototype: IssuesClient.prototype },
    { prefix: 'sprints.', prototype: SprintsClient.prototype },
    { prefix: 'webhooks.', prototype: WebhooksClient.prototype },
  ];
  const methods: SdkMethod[] = [];
  for (const { prefix, prototype } of groups) {
    for (const name of ownInstanceMethodNames(prototype)) {
      methods.push({ qualifiedName: `${prefix}${name}` });
    }
  }
  return methods;
}

// ─── The one hand-maintained table: correspondence ─────────────────────────
// See this file's header ("WHAT COUNTS AS CORRESPONDENCE") for why this
// exists as an explicit table rather than a naming-convention inference.

const SDK_TO_OPERATION: Readonly<Record<string, OpenApiOperation>> = {
  me: { method: 'get', path: '/me' },
  'documents.list': { method: 'get', path: '/documents' },
  'documents.get': { method: 'get', path: '/documents/{id}' },
  'documents.create': { method: 'post', path: '/documents' },
  'issues.list': { method: 'get', path: '/issues' },
  'sprints.list': { method: 'get', path: '/sprints' },
  'webhooks.listSubscriptions': { method: 'get', path: '/webhooks' },
  'webhooks.createSubscription': { method: 'post', path: '/webhooks' },
  'webhooks.getSubscription': { method: 'get', path: '/webhooks/{id}' },
  'webhooks.deleteSubscription': { method: 'delete', path: '/webhooks/{id}' },
  'webhooks.rotateSecret': { method: 'post', path: '/webhooks/{id}/rotate' },
};

const SDK_EXEMPTIONS: Readonly<Record<string, string>> = {
  'documents.iterate':
    'Client-side pagination convenience over documents.list() (PF-402) — an async-generator wrapper around list()\'s cursor, not a distinct HTTP call shape.',
  'issues.iterate':
    'Client-side pagination convenience over issues.list() (PF-402) — same reasoning as documents.iterate.',
  'sprints.iterate':
    'Client-side pagination convenience over sprints.list() (PF-402) — same reasoning as documents.iterate.',
  'webhooks.listDeliveries':
    'Targets GET /webhooks/deliveries — PF-305 (delivery log API) has not landed; the route does not exist in v1OpenApiDocument yet (resources/webhooks.ts header, verified against the real, merged PF-302 registration). Remove this exemption and add a SDK_TO_OPERATION entry once PF-305 lands.',
  'webhooks.replayDelivery':
    'Targets POST /webhooks/deliveries/:id/replay — PF-306 (replay) has not landed; same verification as listDeliveries above. Remove this exemption once PF-306 lands.',
};

const OPENAPI_EXEMPTIONS: Readonly<Record<string, string>> = {
  'get /health':
    'Public liveness probe, not a typed domain resource — identical exemption to route-fitness.test.ts\'s KNOWN_EXEMPTIONS entry for the same route.',
  'get /openapi.json':
    'Returns the OpenAPI document itself, not a typed domain resource — identical exemption to route-fitness.test.ts\'s KNOWN_EXEMPTIONS entry for the same route.',
};

// ─── The suite ──────────────────────────────────────────────────────────────

describe('PF-405: /api/v1 <-> @ship/sdk bidirectional parity fitness test (Linear TRO-422)', () => {
  const operations = discoverOpenApiOperations();
  const sdkMethods = discoverSdkMethods();

  it('sanity: both structural walks discovered something (not silently empty)', () => {
    expect(
      operations.length,
      `discovered /api/v1 operations: ${operations.map(operationLabel).join(', ') || '(none)'}`
    ).toBeGreaterThanOrEqual(8);
    expect(
      sdkMethods.length,
      `discovered SDK methods: ${sdkMethods.map((m) => m.qualifiedName).join(', ') || '(none)'}`
    ).toBeGreaterThanOrEqual(8);
  });

  it('SDK_TO_OPERATION has no stale keys (every key names a method this walk actually discovered)', () => {
    const discovered = new Set(sdkMethods.map((m) => m.qualifiedName));
    const stale = Object.keys(SDK_TO_OPERATION).filter((name) => !discovered.has(name));
    expect(
      stale,
      `SDK_TO_OPERATION names method(s) that no longer exist on the SDK (renamed or removed?): ${stale.join(', ')}. Update or remove the entry.`
    ).toEqual([]);
  });

  it('SDK_EXEMPTIONS has no stale keys', () => {
    const discovered = new Set(sdkMethods.map((m) => m.qualifiedName));
    const stale = Object.keys(SDK_EXEMPTIONS).filter((name) => !discovered.has(name));
    expect(
      stale,
      `SDK_EXEMPTIONS names method(s) that no longer exist on the SDK: ${stale.join(', ')}. Remove the stale exemption.`
    ).toEqual([]);
  });

  it('OPENAPI_EXEMPTIONS has no stale keys', () => {
    const discovered = new Set(operations.map(operationKey));
    const stale = Object.keys(OPENAPI_EXEMPTIONS).filter((key) => !discovered.has(key));
    expect(
      stale,
      `OPENAPI_EXEMPTIONS names operation(s) no longer registered on v1OpenApiDocument: ${stale.join(', ')}. Remove the stale exemption.`
    ).toEqual([]);
  });

  it('no SDK method name appears in both SDK_TO_OPERATION and SDK_EXEMPTIONS', () => {
    const overlap = Object.keys(SDK_TO_OPERATION).filter((name) => name in SDK_EXEMPTIONS);
    expect(overlap, `method(s) both mapped AND exempted — pick one: ${overlap.join(', ')}`).toEqual([]);
  });

  describe.each(operations)('OpenAPI operation $method $path', (op) => {
    it('has a corresponding typed SDK method, or is a documented exemption', () => {
      const key = operationKey(op);
      if (OPENAPI_EXEMPTIONS[key]) return;

      const covered = Object.values(SDK_TO_OPERATION).some(
        (target) => target.method === op.method && target.path === op.path
      );
      expect(
        covered,
        `DRIFT: ${operationLabel(op)} is registered in the generated /api/v1/openapi.json document, ` +
          'but no SDK_TO_OPERATION entry targets it and it is not in OPENAPI_EXEMPTIONS. Add a typed ' +
          'method to the right resource client under sdk/src/resources/*.ts (or ShipClient itself for ' +
          "a platform-level operation like /me) and a SDK_TO_OPERATION entry naming it — or, if this " +
          'operation deliberately warrants no typed method (an infra/meta endpoint, e.g. /health), add ' +
          'a reasoned entry to OPENAPI_EXEMPTIONS in this file.'
      ).toBe(true);
    });
  });

  describe.each(sdkMethods)('SDK method $qualifiedName', ({ qualifiedName }) => {
    it('maps to a real, currently-registered /api/v1 operation, or is a documented exemption', () => {
      if (SDK_EXEMPTIONS[qualifiedName]) return;

      const target = SDK_TO_OPERATION[qualifiedName];
      expect(
        target,
        `DRIFT: SDK method '${qualifiedName}' has no SDK_TO_OPERATION entry and is not in SDK_EXEMPTIONS. ` +
          'Every exported resource-client (or ShipClient) method must either name the real /api/v1 ' +
          "operation it calls, or be an explicitly reasoned exemption (e.g. iterate())."
      ).toBeDefined();
      if (!target) return; // unreachable after the assertion above (narrows without a `!`)

      const exists = operations.some((o) => o.method === target.method && o.path === target.path);
      expect(
        exists,
        `DRIFT (ORPHAN METHOD): SDK method '${qualifiedName}' is mapped, in SDK_TO_OPERATION, to ` +
          `${operationLabel(target)} — but that operation is NOT registered in the generated ` +
          '/api/v1/openapi.json document. It was renamed, removed, or never existed server-side. This ' +
          'is exactly the orphan-method drift PF-405 exists to catch — fix the mapping, fix the route, ' +
          'or add a reasoned SDK_EXEMPTIONS entry if the method is a deliberate forward-declaration ' +
          '(see webhooks.listDeliveries/replayDelivery above for that pattern).'
      ).toBe(true);
    });
  });
});
