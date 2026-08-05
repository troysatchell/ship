import { describe, expect, it } from 'vitest';
import { findLowestCommonManager, findManagerChain, findManagerUserId, type PersonDirectoryEntry } from '../roles.js';

describe('findManagerUserId', () => {
  const people = [
    { user_id: 'emma-user-id', reportsTo: 'alice-user-id' },
    { user_id: 'alice-user-id', reportsTo: null },
    { user_id: 'no-manager-user-id', reportsTo: null },
  ];

  it('returns the manager user id for someone with reports_to set', () => {
    expect(findManagerUserId('emma-user-id', people)).toBe('alice-user-id');
  });

  it('returns null when the person has no manager on record', () => {
    expect(findManagerUserId('no-manager-user-id', people)).toBeNull();
  });

  it('returns null (degrades gracefully) when the owner is not found in the directory at all', () => {
    expect(findManagerUserId('unknown-user-id', people)).toBeNull();
  });
});

// =============================================================================
// findManagerChain / findLowestCommonManager (TRO-346/TRO-337 / FG-19)
// =============================================================================
//
// Org chart shared by every test below:
//
//   director-1
//    ├── manager-a
//    │    └── engineer-1
//    └── manager-b
//         └── engineer-2
//
//   manager-c (separate line, own root)
//    ├── engineer-3
//    └── engineer-4
//
//   engineer-5 --reports_to--> manager-c   (so manager-c both manages
//                                            engineer-3/4 directly AND is a
//                                            "blocked person" candidate in
//                                            the same-manager-chain test)
//   engineer-6 has NO reports_to at all — the verified normal case
//   (TRO-337: "reports_to is set on only 10 of the 20 people").
const ORG_CHART: PersonDirectoryEntry[] = [
  { user_id: 'director-1', reportsTo: null },
  { user_id: 'manager-a', reportsTo: 'director-1' },
  { user_id: 'manager-b', reportsTo: 'director-1' },
  { user_id: 'engineer-1', reportsTo: 'manager-a' },
  { user_id: 'engineer-2', reportsTo: 'manager-b' },
  { user_id: 'manager-c', reportsTo: null },
  { user_id: 'engineer-3', reportsTo: 'manager-c' },
  { user_id: 'engineer-4', reportsTo: 'manager-c' },
  { user_id: 'engineer-6', reportsTo: null },
];

describe('findManagerChain', () => {
  it('walks the full chain to the root, closest manager first', () => {
    expect(findManagerChain('engineer-1', ORG_CHART)).toEqual(['manager-a', 'director-1']);
  });

  it('is empty for a person with no reports_to on record (the normal case, not an exception)', () => {
    expect(findManagerChain('engineer-6', ORG_CHART)).toEqual([]);
  });

  it('is empty for someone not in the directory at all', () => {
    expect(findManagerChain('nobody', ORG_CHART)).toEqual([]);
  });

  it('does not loop forever on a malformed cyclic reports_to chain', () => {
    const cyclic: PersonDirectoryEntry[] = [
      { user_id: 'a', reportsTo: 'b' },
      { user_id: 'b', reportsTo: 'a' },
    ];
    // Starting from 'a': a -> b (pushed), b -> a again — 'a' is already
    // visited (it's the start), so the walk stops there rather than looping
    // forever. The terminating, bounded result is what matters here.
    expect(findManagerChain('a', cyclic)).toEqual(['b']);
  });
});

describe('findLowestCommonManager', () => {
  it('Test Case 5 shape: two people in different reporting lines resolve to their real lowest common manager', () => {
    // Mirrors FLEETGRAPH.MD Test Case 5 exactly: "An issue in Project A
    // blocking two issues in Project B whose assignees report to different
    // managers." engineer-1 -> manager-a -> director-1; engineer-2 ->
    // manager-b -> director-1 — different direct managers, converging only
    // at director-1.
    const result = findLowestCommonManager(['engineer-1', 'engineer-2'], ORG_CHART);
    expect(result).toEqual({ managerUserId: 'director-1', reason: 'found' });
  });

  it('degrades gracefully (does not throw) when one blocked person has no reports_to at all', () => {
    // engineer-1 has a real chain; engineer-6 has none — no chain can ever
    // fully connect, so this MUST resolve to the explicit degrade path, not
    // throw and not silently invent a manager.
    expect(() => findLowestCommonManager(['engineer-1', 'engineer-6'], ORG_CHART)).not.toThrow();

    const result = findLowestCommonManager(['engineer-1', 'engineer-6'], ORG_CHART);
    expect(result.reason).toBe('no_common_manager');
    expect(result.managerUserId).toBeNull();
    // "Route to the highest reachable point" — the only real data available
    // is engineer-1's own chain, so its root (director-1) is the usable
    // fallback, not a fabricated recipient.
    expect(result.highestReachableUserId).toBe('director-1');
  });

  it('says "no common manager found" with no fallback at all when NEITHER blocked person has any manager on record', () => {
    const result = findLowestCommonManager(['engineer-6', 'another-orphan'], [
      ...ORG_CHART,
      { user_id: 'another-orphan', reportsTo: null },
    ]);
    expect(result).toEqual({ managerUserId: null, reason: 'no_common_manager' });
    expect(result.highestReachableUserId).toBeUndefined();
  });

  it('does NOT escalate two people who share the same direct manager (same reporting line)', () => {
    const result = findLowestCommonManager(['engineer-3', 'engineer-4'], ORG_CHART);
    expect(result).toEqual({ managerUserId: null, reason: 'same_reporting_line' });
  });

  it('does NOT escalate when one blocked person is literally the other\'s manager', () => {
    // engineer-5 reports directly to manager-c, which is itself in this
    // call's blocked set — "one's manager chain contains the other's"
    // (TRO-337's own wording), the other half of the same-line test.
    const chart: PersonDirectoryEntry[] = [...ORG_CHART, { user_id: 'engineer-5', reportsTo: 'manager-c' }];
    const result = findLowestCommonManager(['manager-c', 'engineer-5'], chart);
    expect(result).toEqual({ managerUserId: null, reason: 'same_reporting_line' });
  });

  it('returns single_person for fewer than two distinct blocked people (nothing to compare across lines)', () => {
    expect(findLowestCommonManager(['engineer-1'], ORG_CHART)).toEqual({ managerUserId: null, reason: 'single_person' });
    expect(findLowestCommonManager([], ORG_CHART)).toEqual({ managerUserId: null, reason: 'single_person' });
    // Duplicates of the SAME person collapse to one distinct id.
    expect(findLowestCommonManager(['engineer-1', 'engineer-1'], ORG_CHART)).toEqual({
      managerUserId: null,
      reason: 'single_person',
    });
  });

  it('finds the common ancestor across three people even when only two of them share a line', () => {
    // engineer-3/engineer-4 share manager-c directly; engineer-1 sits in a
    // completely different tree with no common ancestor at all — so the
    // group as a whole has NO common manager, even though a sub-pair does.
    const result = findLowestCommonManager(['engineer-1', 'engineer-3', 'engineer-4'], ORG_CHART);
    expect(result.reason).toBe('no_common_manager');
  });

  it('never throws regardless of input shape', () => {
    expect(() => findLowestCommonManager([], [])).not.toThrow();
    expect(() => findLowestCommonManager(['x', 'y', 'z'], [])).not.toThrow();
  });
});
