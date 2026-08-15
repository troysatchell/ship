/**
 * TRO-599 — webhooks response-SHAPE fitness test.
 *
 * `sdk/src/__tests__/parity.test.ts` (PF-405) already proves every
 * `/api/v1` operation has a corresponding typed SDK method and vice versa —
 * but explicitly, by its own header's own words, "DOES NOT CHECK response
 * BODY/field-level shape." That gap is exactly how this ticket's bug
 * recurred TWICE without a mechanical check ever catching it (rule 28,
 * `.claude/skills/ship-factory/references/lessons.md`): an SDK response
 * TypeScript interface was hand-written against a PRD's prose description
 * before the real route existed, the real route later landed with a
 * different field set, and nothing but a human re-reading the serializer
 * code ever noticed.
 *
 * THIS FILE closes that gap one layer under parity.test.ts, at the FIELD
 * level, for the two interfaces TRO-599 fixed: `WebhookSubscription`
 * (+ `CreatedWebhookSubscription`, its create/rotate-response extension)
 * and `WebhookDelivery`. It walks the real, generated `/api/v1` OpenAPI
 * document — computed once at module load, purely from `v1Registry`'s
 * Zod-schema registrations (`api/src/platform/openapi/schemas/webhooks.ts`,
 * itself verified against `platform/api/v1/resources/webhooks.ts`'s real
 * `serializeSubscription()`/`serializeDelivery()` in this ticket's own
 * commit) — and cross-checks its declared field NAMES and NULLABILITY
 * against a hand-maintained table mirroring the SDK's TS interfaces. Same
 * "one hand-maintained table, cross-checked structurally against a live
 * discovery" discipline `parity.test.ts` already uses for
 * `SDK_TO_OPERATION`; this table is `*_FIELDS` below. No server, no
 * database — same zero-setup cost as `parity.test.ts` (this file makes the
 * identical cross-package import for the identical reason; see that file's
 * header, and `sdk/tsconfig.json`'s comment on the `src/__tests__` exclude
 * entry, for why this import is safe and why this directory is excluded
 * from `tsc` but still runs and asserts real behavior under vitest).
 *
 * ─── SCOPING CHOICE (per this ticket's own brief: "use your judgment... and
 * explain your scoping choice") ─────────────────────────────────────────
 *
 * This is deliberately the NARROWER of the two options the ticket names,
 * not a generic "every SDK response type vs every serializer" fitness
 * test. Reasons:
 *   1. A fully generic version needs a real, structural way to associate an
 *      arbitrary SDK response TYPE with the SERIALIZER FUNCTION that
 *      produces it — parity.test.ts's own `SDK_TO_OPERATION` table already
 *      demonstrates that even the coarser method<->operation
 *      correspondence isn't reliably inferable from naming and has to be
 *      hand-stated; a field-level version needs that correspondence PLUS a
 *      way to extract "the fields a TS interface declares" at runtime,
 *      which TS interfaces do not carry (they erase completely) — every
 *      resource would need its own hand-written field table anyway, same
 *      as this file's `*_FIELDS` tables, just five times over with no
 *      shared mechanism a generic walker could exploit beyond what's built
 *      here per-resource.
 *   2. TRO-599's named bug instances are exactly these two interfaces.
 *      Building for five resources today to guard against a class that has
 *      recurred on ONE resource (webhooks, twice) risks the guessed-shape
 *      mistake this very ticket is about, aimed at scope instead of a
 *      field: over-building a generic mechanism against requirements this
 *      ticket does not actually have evidence for yet.
 *   3. The pattern this file establishes — hand-maintained expected-field
 *      table + structural walk of the real OpenAPI schema + explicit
 *      required/nullable checks — generalizes directly. Extending it to
 *      `documents`/`issues`/`sprints`/`audit`/`people`/`changes` is
 *      mechanical repetition of this file's own shape, not a redesign, the
 *      moment there's a second data point suggesting it's needed elsewhere
 *      (rule 28's own "if a third instance lands" threshold, applied to
 *      "if a similar instance lands on a different resource").
 *
 * WHAT THIS FILE DOES NOT CHECK: `WebhookEventType`'s 8 literal values
 * (never drifted — not part of TRO-599's two named instances), or anything
 * about the still-broken `CreateWebhookSubscriptionBody` REQUEST shape
 * (`webhooks.ts`'s own header has that disclosure; a request-body schema
 * has no `serializeX()` counterpart to check this file's mechanism against
 * — it would need the inverse comparison, request schema vs request type,
 * which is a distinct, not-yet-built check).
 */
import { describe, it, expect } from 'vitest';

import { v1OpenApiDocument } from '../../../api/src/platform/openapi/index.js';

// ─── Minimal local JSON-Schema-object shape ────────────────────────────────
// Narrow, single-step cast only (never `as any` / `as unknown as`) — same
// style parity.test.ts already uses for `v1OpenApiDocument.paths`.

interface JsonSchemaObject {
  readonly type?: string | readonly string[];
  readonly properties?: Record<string, JsonSchemaObject>;
  readonly required?: readonly string[];
  readonly enum?: readonly string[];
  readonly allOf?: ReadonlyArray<JsonSchemaObject | { readonly $ref: string }>;
}

function isRef(node: JsonSchemaObject | { readonly $ref: string }): node is { readonly $ref: string } {
  return '$ref' in node;
}

function refName(ref: string): string {
  const parts = ref.split('/');
  const name = parts[parts.length - 1];
  if (!name) throw new Error(`Malformed $ref (no trailing segment): ${ref}`);
  return name;
}

interface FlattenedSchema {
  readonly properties: Record<string, JsonSchemaObject>;
  readonly required: ReadonlySet<string>;
}

/** Flattens a schema's own `properties`/`required`, resolving one level of
 *  `allOf` (with `$ref` members resolved against the registered component
 *  schemas). Enough to handle `WebhookSubscriptionCreated`'s
 *  `allOf: [{ $ref: '#/components/schemas/WebhookSubscription' }, { properties: { secret, warning } }]`
 *  shape — not a generic JSON-Schema resolver, because nothing registered
 *  under `v1Registry` needs more than this one level (verified by reading
 *  every `.extend(...)` call in `platform/openapi/schemas/webhooks.ts`). */
function flattenSchema(schemas: Record<string, JsonSchemaObject>, schema: JsonSchemaObject): FlattenedSchema {
  if (schema.allOf) {
    const properties: Record<string, JsonSchemaObject> = {};
    const required = new Set<string>();
    for (const member of schema.allOf) {
      const resolved = isRef(member) ? schemas[refName(member.$ref)] : member;
      if (!resolved) {
        throw new Error(`allOf member references an unregistered schema: ${JSON.stringify(member)}`);
      }
      const flattened = flattenSchema(schemas, resolved);
      Object.assign(properties, flattened.properties);
      for (const key of flattened.required) required.add(key);
    }
    return { properties, required };
  }
  return {
    properties: schema.properties ?? {},
    required: new Set(schema.required ?? []),
  };
}

function isNullableProperty(prop: JsonSchemaObject): boolean {
  return Array.isArray(prop.type) && prop.type.includes('null');
}

// ─── The hand-maintained expected-field tables ─────────────────────────────
// Mirrors sdk/src/resources/webhooks.ts's TS interfaces exactly — this is
// this file's one hand-maintained piece, same role SDK_TO_OPERATION plays
// in parity.test.ts. Update it alongside any future, deliberate change to
// those interfaces; a mismatch here means one of the two drifted from the
// other, which is exactly the class of bug this file exists to catch.

interface ExpectedField {
  readonly name: string;
  readonly nullable: boolean;
}

/** `WebhookSubscription` (sdk/src/resources/webhooks.ts). */
const WEBHOOK_SUBSCRIPTION_FIELDS: readonly ExpectedField[] = [
  { name: 'id', nullable: false },
  { name: 'app_id', nullable: false },
  { name: 'event_type', nullable: false },
  { name: 'target_url', nullable: false },
  { name: 'active', nullable: false },
  { name: 'created_at', nullable: false },
];

/** `CreatedWebhookSubscription`'s fields beyond `WebhookSubscription`. */
const CREATED_WEBHOOK_SUBSCRIPTION_EXTRA_FIELDS: readonly ExpectedField[] = [
  { name: 'secret', nullable: false },
  { name: 'warning', nullable: false },
];

/** `WebhookDelivery` (sdk/src/resources/webhooks.ts). */
const WEBHOOK_DELIVERY_FIELDS: readonly ExpectedField[] = [
  { name: 'id', nullable: false },
  { name: 'subscription_id', nullable: false },
  { name: 'event_id', nullable: false },
  { name: 'event_type', nullable: false },
  { name: 'idempotency_key', nullable: false },
  { name: 'attempt_number', nullable: false },
  { name: 'status', nullable: false },
  { name: 'response_status', nullable: true },
  { name: 'response_excerpt', nullable: true },
  { name: 'latency_ms', nullable: true },
  { name: 'next_attempt_at', nullable: true },
  { name: 'replayed_from_id', nullable: true },
  { name: 'created_at', nullable: false },
];

/** `WebhookDelivery['status']`'s literal union, sorted. */
const WEBHOOK_DELIVERY_STATUS_VALUES: readonly string[] = ['dead', 'failed', 'pending', 'success'];

// ─── The shared assertion ──────────────────────────────────────────────────

function assertFieldsMatchRealSchema(
  interfaceLabel: string,
  schemaName: string,
  schemas: Record<string, JsonSchemaObject>,
  expected: readonly ExpectedField[]
): void {
  const schema = schemas[schemaName];
  expect(
    schema,
    `'${schemaName}' is not registered on v1OpenApiDocument.components.schemas — has it been renamed or ` +
      `removed in platform/openapi/schemas/webhooks.ts? Update this test's schemaName to match.`
  ).toBeDefined();
  if (!schema) return;

  const { properties, required } = flattenSchema(schemas, schema);
  const actualNames = new Set(Object.keys(properties));
  const expectedNames = new Set(expected.map((f) => f.name));

  // Direction 1: the SDK's TS interface (mirrored in `expected`) claims a
  // field the real schema no longer has — a stale/renamed field on the SDK
  // side.
  const staleOnSdk = expected.filter((f) => !actualNames.has(f.name)).map((f) => f.name);
  expect(
    staleOnSdk,
    `${interfaceLabel}: declares field(s) the real, generated '${schemaName}' schema does NOT have: ` +
      `${staleOnSdk.join(', ')}. The server-side field was renamed or removed — update the SDK interface ` +
      `in sdk/src/resources/webhooks.ts and this test's expected-field table together.`
  ).toEqual([]);

  // Direction 2: the real schema has a field the SDK's TS interface does
  // not declare — exactly TRO-599's bug class (rule 28): a response field
  // the real server returns that the SDK's declared type silently drops.
  const undeclaredOnSdk = [...actualNames].filter((name) => !expectedNames.has(name));
  expect(
    undeclaredOnSdk,
    `DRIFT (TRO-599's bug class, rule 28): the real, generated '${schemaName}' schema has field(s) the ` +
      `SDK's ${interfaceLabel} TS interface does NOT declare: ${undeclaredOnSdk.join(', ')}. Add the ` +
      `missing field(s) to the interface in sdk/src/resources/webhooks.ts AND to this test's expected-field ` +
      `table — both must change together or this check is not actually locking anything in.`
  ).toEqual([]);

  for (const field of expected) {
    const prop = properties[field.name];
    if (!prop) continue; // already reported by staleOnSdk above

    expect(
      required.has(field.name),
      `${interfaceLabel}.${field.name}: not in '${schemaName}'.required — the SDK interface declares it as ` +
        `always-present (never optional/absent), but the real schema allows it to be missing entirely.`
    ).toBe(true);

    const nullable = isNullableProperty(prop);
    expect(
      nullable,
      `${interfaceLabel}.${field.name}: nullability mismatch — the real '${schemaName}' schema is ` +
        `${nullable ? '' : 'NOT '}nullable, but the SDK interface declares it as ` +
        `${field.nullable ? '`X | null`' : 'never null'}.`
    ).toBe(field.nullable);
  }
}

// ─── The suite ──────────────────────────────────────────────────────────────

describe('TRO-599: webhooks response-SHAPE fitness test (field names + nullability, not just method+path)', () => {
  const schemas = (v1OpenApiDocument.components?.schemas ?? {}) as Record<string, JsonSchemaObject>;

  it('sanity: the OpenAPI document actually registers the three schemas this suite checks', () => {
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining(['WebhookSubscription', 'WebhookSubscriptionCreated', 'WebhookDelivery'])
    );
  });

  it("WebhookSubscription's field set + nullability matches the real, generated OpenAPI schema", () => {
    assertFieldsMatchRealSchema('WebhookSubscription', 'WebhookSubscription', schemas, WEBHOOK_SUBSCRIPTION_FIELDS);
  });

  it("CreatedWebhookSubscription's field set + nullability matches the real WebhookSubscriptionCreated schema", () => {
    assertFieldsMatchRealSchema('CreatedWebhookSubscription', 'WebhookSubscriptionCreated', schemas, [
      ...WEBHOOK_SUBSCRIPTION_FIELDS,
      ...CREATED_WEBHOOK_SUBSCRIPTION_EXTRA_FIELDS,
    ]);
  });

  it("WebhookDelivery's field set + nullability matches the real, generated OpenAPI schema", () => {
    assertFieldsMatchRealSchema('WebhookDelivery', 'WebhookDelivery', schemas, WEBHOOK_DELIVERY_FIELDS);
  });

  it("WebhookDelivery['status']'s literal values match the real schema's enum exactly (catches the 'dead_letter' vs 'dead' class of bug)", () => {
    const schema = schemas['WebhookDelivery'];
    expect(schema, `'WebhookDelivery' is not registered on v1OpenApiDocument.components.schemas`).toBeDefined();
    if (!schema) return;

    const { properties } = flattenSchema(schemas, schema);
    const statusProp = properties['status'];
    expect(statusProp, `'WebhookDelivery' schema has no 'status' property`).toBeDefined();

    const actualValues = [...(statusProp?.enum ?? [])].sort();
    expect(
      actualValues,
      `WebhookDelivery.status's real enum values (${actualValues.join(', ')}) do not match ` +
        `WEBHOOK_DELIVERY_STATUS_VALUES in this test (${WEBHOOK_DELIVERY_STATUS_VALUES.join(', ')}) — update ` +
        `both this table and the 'status' union in sdk/src/resources/webhooks.ts's WebhookDelivery interface.`
    ).toEqual([...WEBHOOK_DELIVERY_STATUS_VALUES].sort());
  });
});
