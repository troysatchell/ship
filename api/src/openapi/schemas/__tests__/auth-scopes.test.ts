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
import { generateOpenAPIDocument } from '../../index.js';
import { ScopeRegistry } from '../../../platform/scopes/registry.js';

describe('TRO-491: OpenAPI scopes enum derived from ScopeRegistry', () => {
  it('CreateAPIToken.scopes items enum equals ScopeRegistry.names()', () => {
    const doc = generateOpenAPIDocument() as any;
    expect(doc.components.schemas.CreateAPIToken.properties.scopes.items.enum).toEqual(
      ScopeRegistry.names()
    );
    // Guards against a vacuous empty enum trivially satisfying the assertion above.
    expect(ScopeRegistry.names().length).toBeGreaterThanOrEqual(7);
  });

  it('APIToken.scopes items enum equals ScopeRegistry.names() and is required-nullable', () => {
    const doc = generateOpenAPIDocument() as any;
    expect(doc.components.schemas.APIToken.properties.scopes.items.enum).toEqual(
      ScopeRegistry.names()
    );
    expect(doc.components.schemas.APIToken.properties.scopes.nullable).toBe(true);
    expect(doc.components.schemas.APIToken.required).toContain('scopes');
  });

  it('enum is derived, not a second copy', () => {
    const doc = generateOpenAPIDocument() as any;
    expect(new Set(doc.components.schemas.CreateAPIToken.properties.scopes.items.enum)).toEqual(
      new Set(ScopeRegistry.list().map((s) => s.name))
    );
  });
});
