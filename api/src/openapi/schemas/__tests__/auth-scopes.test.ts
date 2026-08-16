/**
 * TRO-491 — the internal OpenAPI doc typed `CreateAPIToken.scopes` and
 * `APIToken.scopes` items as plain `string[]` (no `enum`), even though the
 * runtime only accepts scope names registered in `ScopeRegistry`
 * (`api/src/platform/scopes/registry.ts`, enforced by
 * `api/src/routes/api-tokens.ts`'s `scopeSchema` refine). This proves the
 * generated OpenAPI document's `items.enum` for both schemas is DERIVED
 * from `ScopeRegistry.names()` at module load, not a second hand-copied
 * list that can drift, and that `APIToken.scopes` is required-nullable
 * (both response sites in `api-tokens.ts` always emit it, as array or null).
 */
import { describe, it, expect } from 'vitest';
import type { OpenAPIObject, SchemaObject } from 'openapi3-ts/oas30';
import { generateOpenAPIDocument } from '../../index.js';
import { ScopeRegistry } from '../../../platform/scopes/registry.js';

// Typed accessors instead of an untyped cast (review-patterns gate, TS-7/TS-8):
// `components.schemas[name]` and `properties[prop]` are typed as
// `SchemaObject | ReferenceObject`; a `$ref` here would be a real regression
// (the schemas under test are registered inline), so it fails loudly.
function schemaOf(doc: OpenAPIObject, name: string): SchemaObject {
  const s = doc.components?.schemas?.[name];
  if (!s || '$ref' in s) throw new Error(`components.schemas.${name} missing or a $ref`);
  return s;
}
function propOf(schema: SchemaObject, prop: string): SchemaObject {
  const p = schema.properties?.[prop];
  if (!p || '$ref' in p) throw new Error(`property ${prop} missing or a $ref`);
  return p;
}
function itemsOf(schema: SchemaObject): SchemaObject {
  const i = schema.items;
  if (!i || '$ref' in i) throw new Error('items missing or a $ref');
  return i;
}

describe('TRO-491: OpenAPI scopes enum derived from ScopeRegistry', () => {
  it('CreateAPIToken.scopes items enum equals ScopeRegistry.names()', () => {
    const doc = generateOpenAPIDocument();
    const scopes = propOf(schemaOf(doc, 'CreateAPIToken'), 'scopes');
    expect(itemsOf(scopes).enum).toEqual(ScopeRegistry.names());
    // Guards against a vacuous empty enum trivially satisfying the assertion above.
    expect(ScopeRegistry.names().length).toBeGreaterThanOrEqual(7);
  });

  it('APIToken.scopes items enum equals ScopeRegistry.names() and is required-nullable', () => {
    const doc = generateOpenAPIDocument();
    const apiToken = schemaOf(doc, 'APIToken');
    const scopes = propOf(apiToken, 'scopes');
    expect(itemsOf(scopes).enum).toEqual(ScopeRegistry.names());
    expect(scopes.nullable).toBe(true);
    expect(apiToken.required).toContain('scopes');
  });

  it('enum is derived, not a second copy', () => {
    const doc = generateOpenAPIDocument();
    const scopes = propOf(schemaOf(doc, 'CreateAPIToken'), 'scopes');
    expect(new Set(itemsOf(scopes).enum)).toEqual(
      new Set(ScopeRegistry.list().map((s) => s.name))
    );
  });
});
