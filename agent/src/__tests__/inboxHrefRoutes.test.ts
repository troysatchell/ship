/**
 * TRO-384 — every inbox item's `action.href` must resolve against a route
 * `web/src/main.tsx` actually defines. Before this fix all four
 * href-emitting sites interpolated `document_type` straight into the path
 * (`/${doc.document_type}/${doc.id}`) or hardcoded a singular segment
 * (`/issue/${id}`), while every real route is plural
 * (`issues/:id`, `sprints/:id`, ...) or the catch-all `documents/:id/*`.
 * None of the singular/type-named paths match anything, so every one of
 * these links 404s — `<Route path="*" element={<NotFoundPage />} />` is
 * the only thing that ever matched.
 *
 * This does NOT hardcode the expected string `'/documents/'` — it parses
 * the actual `<Route path="...">` table out of `main.tsx` and asserts each
 * emitted href resolves against a REAL entry. A future rename of the
 * `documents/:id/*` route (or removal of it) fails this test by breaking
 * route resolution, not by string mismatch, which is the failure mode this
 * ticket exists to catch — a hardcoded `'/documents/'` check would keep
 * passing even after the app started 404ing again.
 *
 * Out of scope (TRO-353, left untouched by this ticket): `graph.ts` also
 * emits `/standup-draft/:id`, `/retro-draft/:id`, `/plan-change-draft/:id`.
 * Those pages genuinely do not exist yet and are NOT asserted here — this
 * file only covers the four sites TRO-384 fixed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildMentionItems, buildBlockingApprovalItems } from '../proactive.js';
import type { ShipClientLike, ChangeFeedResponse, ShipDocument, ShipPerson } from '../shipClient.js';
import type { DeepShipClientLike } from '../shipClient.js';
import { buildGraph, type AnthropicModel, type DeepDeps } from '../graph.js';
import { InMemoryItemStore } from '../itemStore.js';
import { InMemoryDraftStore } from '../draftStore.js';

// ---------------------------------------------------------------------------
// Route-table parser — reads web/src/main.tsx off disk, does not trust a
// copy/paste of it.
// ---------------------------------------------------------------------------

function repoRoot(): string {
  // agent/src/__tests__/ -> repo root is four levels up.
  return path.resolve(fileURLToPath(import.meta.url), '../../../../');
}

/** Every `<Route path="...">` value in `main.tsx`, minus the two pure
 * catch-alls (`"*"`, `"/*"`). Those two exist specifically to render
 * "no page available" (`NotFoundPage`) or to delegate to a nested
 * `<Routes>` that has its own such catch-all — including them as "valid"
 * would make every possible href match trivially, defeating the point of
 * this test. Every other wildcard (e.g. `documents/:id/*`) is a real,
 * scoped page and stays in.
 */
function extractRoutePaths(source: string): string[] {
  const matches = [...source.matchAll(/<Route\s[^>]*?\bpath="([^"]+)"/gs)];
  const raw = matches.map((m) => m[1]).filter((p): p is string => typeof p === 'string');
  return raw.filter((p) => p !== '*' && p !== '/*');
}

/** Compiles one react-router path pattern (`documents/:id/*`,
 * `sprints/:id`, `issues`, ...) into a matcher against a fully-qualified
 * href. `:param` segments match any single non-slash segment; a trailing
 * `/*` matches zero or more additional segments (react-router's own
 * splat semantics) — everything else must match literally. */
function routeToMatcher(rawPath: string): RegExp {
  let normalized = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const hasTrailingSplat = normalized.endsWith('/*');
  if (hasTrailingSplat) normalized = normalized.slice(0, -2);

  const segments = normalized.split('/').filter(Boolean);
  const segmentPattern = segments
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  const tail = hasTrailingSplat ? '(?:/.+)?' : '';
  return new RegExp(`^/${segmentPattern}${tail}$`);
}

function loadRouteMatchers(): RegExp[] {
  const source = readFileSync(path.join(repoRoot(), 'web/src/main.tsx'), 'utf8');
  const paths = extractRoutePaths(source);
  // Guards the parser itself: if main.tsx's shape changes so badly that
  // regex extraction finds nothing, fail loudly rather than silently
  // "passing" every href against zero routes (a `.some()` over `[]` is
  // always false, so that failure mode is already safe — this just makes
  // the cause obvious instead of reporting it as "no href resolves").
  if (paths.length === 0) {
    throw new Error('Parsed zero <Route path="..."> entries from web/src/main.tsx — route parser is broken');
  }
  return paths.map(routeToMatcher);
}

function resolvesToARoute(href: string, matchers: readonly RegExp[]): boolean {
  return matchers.some((re) => re.test(href));
}

const routeMatchers = loadRouteMatchers();

describe('route parser sanity — proves the matcher is discriminating, not a tautology', () => {
  it('accepts a real documents/:id/* href', () => {
    expect(resolvesToARoute('/documents/abc-123', routeMatchers)).toBe(true);
  });

  it('rejects the pre-fix singular /issue/:id href (no such route — only plural "issues/:id" exists)', () => {
    expect(resolvesToARoute('/issue/abc-123', routeMatchers)).toBe(false);
  });

  it('rejects the pre-fix singular /sprint/:id href (no such route — only plural "sprints/:id" exists)', () => {
    expect(resolvesToARoute('/sprint/abc-123', routeMatchers)).toBe(false);
  });

  it('rejects a document_type interpolated straight into the path (e.g. /weekly_plan/:id — no such route at all)', () => {
    expect(resolvesToARoute('/weekly_plan/abc-123', routeMatchers)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixtures — minimal, mirrors proactive.test.ts / graph.test.ts's own
// conventions (never a live Ship API call).
// ---------------------------------------------------------------------------

function emptyFeed(overrides: Partial<ChangeFeedResponse> = {}): ChangeFeedResponse {
  return {
    next_cursor: '2026-01-01T00:01:00.000Z',
    documents: [],
    documents_truncated: false,
    history: [],
    history_truncated: false,
    comments: [],
    comments_truncated: false,
    ...overrides,
  };
}

function person(overrides: Partial<ShipPerson> = {}): ShipPerson {
  return {
    id: 'person-alice',
    user_id: 'user-alice',
    name: 'Alice Chen',
    email: 'alice@example.gov',
    isArchived: false,
    isPending: false,
    reportsTo: null,
    role: null,
    ...overrides,
  };
}

function doc(overrides: Partial<ShipDocument> = {}): ShipDocument {
  return {
    id: 'issue-1',
    document_type: 'issue',
    title: 'Some Issue',
    content: { type: 'doc', content: [] },
    visibility: 'workspace',
    created_by: 'user-someone-else',
    properties: {},
    ...overrides,
  };
}

function fakeShipClient(overrides: Partial<ShipClientLike> = {}): ShipClientLike {
  return {
    getChangeFeed: vi.fn(),
    getDocument: vi.fn(),
    getPeople: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The four fixed sites — each invoked for real, capturing the ACTUAL
// runtime href rather than re-deriving what it "should" be.
// ---------------------------------------------------------------------------

describe('proactive.ts — buildMentionItems (site 1: comment mention, site 2: document-body mention)', () => {
  it("site 1 — a comment mention's href resolves to a real route, using a non-'issue' document_type (weekly_plan)", async () => {
    const feed = emptyFeed({
      comments: [
        {
          id: 'comment-1',
          document_id: 'plan-1',
          comment_id: 'thread-1',
          parent_id: null,
          author_id: 'user-emma',
          content: '@Alice Chen can you weigh in on this?',
          resolved_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          dedupe_key: 'x',
        },
      ],
    });
    // weekly_plan — one of the ten real document_type values (verified
    // against the live dev DB per this ticket's own diagnosis), deliberately
    // NOT 'issue', to prove this isn't accidentally passing only for the one
    // type whose singular happens to look route-shaped.
    const client = fakeShipClient({
      getDocument: vi.fn().mockResolvedValue(doc({ id: 'plan-1', document_type: 'weekly_plan', title: 'Week 6 plan' })),
    });

    const items = await buildMentionItems(client, feed, [person()]);

    expect(items).toHaveLength(1);
    const href = items[0]?.action.href;
    expect(href).toBe('/documents/plan-1');
    expect(resolvesToARoute(href ?? '', routeMatchers)).toBe(true);
  });

  it('site 2 — a document-body mention href resolves to a real route', async () => {
    const feed = emptyFeed({
      documents: [
        { id: 'wiki-1', document_type: 'wiki', title: 'Design doc', updated_at: '2026-01-01T00:00:00.000Z', created_by: 'user-emma', dedupe_key: 'x' },
      ],
    });
    const bodyWithMention = doc({
      id: 'wiki-1',
      document_type: 'wiki',
      title: 'Design doc',
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'person-alice', mentionType: 'person' } }] },
        ],
      },
    });
    const client = fakeShipClient({ getDocument: vi.fn().mockResolvedValue(bodyWithMention) });

    const items = await buildMentionItems(client, feed, [person()]);

    expect(items).toHaveLength(1);
    const href = items[0]?.action.href;
    expect(href).toBe('/documents/wiki-1');
    expect(resolvesToARoute(href ?? '', routeMatchers)).toBe(true);
  });
});

describe('proactive.ts — buildBlockingApprovalItems (site 3: blocked-approval href)', () => {
  it("a blocked sprint's href resolves to a real route", async () => {
    const feed = emptyFeed({
      history: [
        {
          id: 1,
          document_id: 'sprint-1',
          field: 'plan_approval',
          old_value: null,
          new_value: JSON.stringify({ state: 'changes_requested', approved_by: 'user-alice' }),
          changed_by: 'user-alice',
          automated_by: null,
          created_at: '2026-01-01T00:00:00.000Z',
          dedupe_key: 'x',
        },
      ],
    });
    const client = fakeShipClient({
      getDocument: vi.fn().mockResolvedValue(
        doc({ id: 'sprint-1', document_type: 'sprint', title: "Emma's Week 6", properties: { owner_id: 'user-emma' } })
      ),
    });

    const { items } = await buildBlockingApprovalItems(client, feed, [person({ id: 'person-emma', user_id: 'user-emma' })]);

    expect(items).toHaveLength(1);
    const href = items[0]?.action.href;
    expect(href).toBe('/documents/sprint-1');
    expect(resolvesToARoute(href ?? '', routeMatchers)).toBe(true);
  });
});

describe('graph.ts — commitBlockerEscalation (site 4: blocker-escalation href)', () => {
  // Mirrors graph.test.ts's own "blocker escalation fan-out" Test Case 5
  // fixture exactly (org chart: engineer-a/b report to different managers,
  // both under director-1) — the minimum shape that reaches
  // `commitBlockerEscalation` and actually writes an item with an href.
  const BLOCKER_ISSUE_ID = 'blocker-issue-1';
  const PROJECT_A_ID = 'project-a';
  const PROJECT_B_ID = 'project-b';
  const BLOCKED_ISSUE_1 = 'blocked-issue-1';
  const BLOCKED_ISSUE_2 = 'blocked-issue-2';
  const ENGINEER_A = 'user-engineer-a';
  const ENGINEER_B = 'user-engineer-b';
  const MANAGER_X = 'user-manager-x';
  const MANAGER_Y = 'user-manager-y';
  const DIRECTOR_1 = 'user-director-1';

  function fanoutDoc(overrides: Partial<ShipDocument> & Pick<ShipDocument, 'id' | 'title'>): ShipDocument {
    return { document_type: 'issue', content: null, visibility: 'workspace', created_by: null, properties: {}, ...overrides };
  }

  function fanoutPerson(userId: string, reportsTo: string | null) {
    return { id: `person-doc:${userId}`, user_id: userId, name: userId, email: null, isArchived: false, isPending: false, reportsTo, role: null };
  }

  function fanoutClient(): DeepShipClientLike {
    return {
      getIssuesByAssignee: vi.fn().mockResolvedValue([]),
      getChangeFeed: vi.fn().mockResolvedValue(emptyFeed()),
      listDocuments: vi.fn().mockResolvedValue([]),
      getPeople: vi.fn().mockResolvedValue([
        fanoutPerson(ENGINEER_A, MANAGER_X),
        fanoutPerson(ENGINEER_B, MANAGER_Y),
        fanoutPerson(MANAGER_X, DIRECTOR_1),
        fanoutPerson(MANAGER_Y, DIRECTOR_1),
        fanoutPerson(DIRECTOR_1, null),
      ]),
      getDocument: vi.fn(async (id: string) => {
        if (id === BLOCKER_ISSUE_ID) return fanoutDoc({ id: BLOCKER_ISSUE_ID, title: 'Vendor API is down' });
        if (id === PROJECT_A_ID) return fanoutDoc({ id: PROJECT_A_ID, title: 'Project A', document_type: 'project' });
        if (id === PROJECT_B_ID) return fanoutDoc({ id: PROJECT_B_ID, title: 'Project B', document_type: 'project' });
        if (id === BLOCKED_ISSUE_1) return fanoutDoc({ id: BLOCKED_ISSUE_1, title: 'Ship the checkout flow', properties: { assignee_id: ENGINEER_A } });
        if (id === BLOCKED_ISSUE_2) return fanoutDoc({ id: BLOCKED_ISSUE_2, title: 'Wire up billing', properties: { assignee_id: ENGINEER_B } });
        throw new Error(`404: ${id}`);
      }),
      getAssociations: vi.fn(async (id: string, type?: string) => {
        if (id === BLOCKER_ISSUE_ID && type === 'project') return [{ related_id: PROJECT_A_ID, relationship_type: 'project' }];
        if (id === BLOCKER_ISSUE_ID && type === 'blocks') {
          return [
            { related_id: BLOCKED_ISSUE_1, relationship_type: 'blocks' },
            { related_id: BLOCKED_ISSUE_2, relationship_type: 'blocks' },
          ];
        }
        if ((id === BLOCKED_ISSUE_1 || id === BLOCKED_ISSUE_2) && type === 'project') {
          return [{ related_id: PROJECT_B_ID, relationship_type: 'project' }];
        }
        return [];
      }),
    };
  }

  function fakeModel(response: string): AnthropicModel {
    return { invoke: vi.fn().mockResolvedValue({ content: response }) };
  }

  it("a blocker-escalation draft's href resolves to a real route", async () => {
    const itemStore = new InMemoryItemStore();
    const deps: DeepDeps = {
      shipClient: fanoutClient(),
      itemStore,
      draftStore: new InMemoryDraftStore(),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
    };
    const compiled = buildGraph(fakeModel('DRAFT: "Vendor API is down" is blocking checkout and billing work...'), undefined, undefined, deps);

    await compiled.invoke({ trigger: 'proactive_escalation', blockingIssueId: BLOCKER_ISSUE_ID });

    const items = itemStore.list(DIRECTOR_1);
    expect(items).toHaveLength(1);
    const href = items[0]?.action.href;
    expect(href).toBe(`/documents/${BLOCKER_ISSUE_ID}`);
    expect(resolvesToARoute(href ?? '', routeMatchers)).toBe(true);
  });
});
