/**
 * `ScopeRegistry` — scopes as data (PLUGFORGE.MD §2.3, §2.1; Epic E1 — PF-107).
 *
 * The registry is the single source of truth for which scope strings exist.
 * A new scope is added by calling `ScopeRegistry.register(...)` once, at
 * module load, in the block at the bottom of this file — no other file in
 * `api/src/platform/oauth/` (the bearer middleware, the `require(scope)`
 * factory) ever needs to change to support it. That is the OCP property
 * PLUGFORGE.MD §2.3 asks for: "New scopes register at module load; middleware
 * is never edited to add one."
 *
 * Red-before-green evidence (TRO-430): this file was first committed with no
 * registrations at the bottom, so `registry.test.ts`'s "exactly the seven
 * scopes" assertion failed for a real reason (an empty set, not an import
 * error) — 3 of 4 cases red — before the registrations below were added.
 */

export interface ScopeDefinition {
  readonly name: string;
  readonly description: string;
}

class ScopeRegistryImpl {
  private readonly scopes = new Map<string, ScopeDefinition>();

  /**
   * Registers a scope. Re-registering an existing name overwrites its
   * description rather than creating a duplicate entry — registration is
   * idempotent by name, which matters because this module can be imported
   * more than once across test files in the same process.
   */
  register(definition: ScopeDefinition): void {
    this.scopes.set(definition.name, definition);
  }

  /** True if `name` is a scope this registry knows about. */
  has(name: string): boolean {
    return this.scopes.has(name);
  }

  /** All registered scope names, in registration order. */
  names(): string[] {
    return [...this.scopes.keys()];
  }

  /** All registered scope definitions, in registration order. */
  list(): ScopeDefinition[] {
    return [...this.scopes.values()];
  }
}

export const ScopeRegistry = new ScopeRegistryImpl();

// §2.3's seven scopes, registered at module load. Adding an eighth scope
// (or a ninth, ...) means adding one more `register(...)` call here — no
// other file changes, per the OCP rationale in the file header above.
ScopeRegistry.register({
  name: 'documents:read',
  description: 'Read documents (wiki/issue/project/program/sprint/person content and properties).',
});
ScopeRegistry.register({
  name: 'documents:write',
  description: 'Create and update documents.',
});
ScopeRegistry.register({
  name: 'issues:read',
  description: 'Read issue-typed documents, including their typed state/priority/assignee fields.',
});
ScopeRegistry.register({
  name: 'issues:write',
  description: 'Create and update issue-typed documents.',
});
ScopeRegistry.register({
  name: 'sprints:read',
  description: 'Read sprint-typed documents, including cadence/week-dates data.',
});
ScopeRegistry.register({
  name: 'sprints:write',
  description: 'Create and update sprint-typed documents.',
});
ScopeRegistry.register({
  name: 'webhooks:manage',
  description: 'Create, list, and delete webhook subscriptions; view and replay deliveries.',
});
