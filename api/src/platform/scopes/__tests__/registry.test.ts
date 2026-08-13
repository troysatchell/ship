import { describe, it, expect } from 'vitest';
import { ScopeRegistry } from '../registry.js';

/**
 * PF-107 AC-5 (Linear TRO-430, test-design comment 2026-08-10): `ScopeRegistry`
 * enumerability. Asserts the resulting enumerable set, not the extensibility
 * mechanism (module-load registration) — that is a design property, not
 * behavior a unit test can observe.
 */
describe('PF-107 AC-5: ScopeRegistry (§2.3, scopes as data)', () => {
  const SEVEN_SCOPES = [
    'documents:read',
    'documents:write',
    'issues:read',
    'issues:write',
    'sprints:read',
    'sprints:write',
    'webhooks:manage',
  ];

  it('registers exactly the seven §2.3 scopes at module load', () => {
    const names = ScopeRegistry.names();
    expect(new Set(names)).toEqual(new Set(SEVEN_SCOPES));
    expect(names).toHaveLength(7);
  });

  it('has() recognizes every registered scope', () => {
    for (const scope of SEVEN_SCOPES) {
      expect(ScopeRegistry.has(scope)).toBe(true);
    }
  });

  it('has() rejects an unknown scope name', () => {
    expect(ScopeRegistry.has('not:a:real:scope')).toBe(false);
  });

  it('list() returns a definition (with a non-empty description) for every scope', () => {
    const definitions = ScopeRegistry.list();
    expect(definitions).toHaveLength(7);
    for (const def of definitions) {
      expect(SEVEN_SCOPES).toContain(def.name);
      expect(typeof def.description).toBe('string');
      expect(def.description.length).toBeGreaterThan(0);
    }
  });
});
