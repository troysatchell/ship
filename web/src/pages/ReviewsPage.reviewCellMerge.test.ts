import { describe, it, expect } from 'vitest';
import { emptyReviewCell, mergeReviewCellPatch } from './ReviewsPage';

/**
 * TRO-206 / TS-1 regression test.
 *
 * `web/tsconfig.json` didn't extend the root config, so it silently ran
 * without `noUncheckedIndexedAccess`. Restoring that flag surfaced (among 155
 * others) three sites in `ReviewsPage.tsx`'s optimistic-update handlers
 * (`approvePlan`, `requestChanges`, `rateRetro`) that did:
 *
 *   updated.reviews[personId][weekNumber] = {
 *     ...updated.reviews[personId][weekNumber],  // ReviewCell | undefined
 *     planApproval: { ... },
 *   };
 *
 * Spreading `undefined` is legal JS and type-checked before this fix, but for
 * a person/week pair with no prior review row it silently produced a
 * `ReviewCell` with every field *except the one just patched* missing —
 * `hasPlan`, `hasRetro`, `sprintId`, `planDocId`, `retroDocId` all `undefined`
 * instead of the type's contract (`boolean` / `string | null`).
 *
 * Reachability caveat (observed, not assumed): tracing the call sites that
 * invoke `approvePlan`/`requestChanges`/`rateRetro` from the rendered UI
 * (`ReviewsPage.tsx:919-935`, `:1115`), every one is gated on
 * `cell.hasPlan`/`cell.hasRetro` already being `true` — which requires a
 * pre-existing, already-fetched `ReviewCell`. So the corrupting branch was
 * not reachable through today's UI; this pins a real type-safety gap the
 * compiler could not previously see, not a demonstrated production crash.
 * Recorded here rather than overclaimed, per this repo's provenance rule.
 */
describe('mergeReviewCellPatch (TRO-206 / TS-1)', () => {
  it('emptyReviewCell fills every ReviewCell field, none left undefined', () => {
    const cell = emptyReviewCell('sprint-1');
    expect(cell).toEqual({
      planApproval: null,
      reviewApproval: null,
      reviewRating: null,
      hasPlan: false,
      hasRetro: false,
      sprintId: 'sprint-1',
      planDocId: null,
      retroDocId: null,
    });
    expect(Object.values(cell)).not.toContain(undefined);
  });

  it('patching a person/week with no existing cell produces a fully-defined ReviewCell', () => {
    const patched = mergeReviewCellPatch(undefined, 'sprint-7', {
      planApproval: { state: 'approved', approved_by: null, approved_at: '2026-07-30T00:00:00Z', comment: null },
    });

    // The regression: before the fix, spreading `undefined` dropped every
    // field but the one just patched, so these would be `undefined` instead
    // of their real defaults.
    expect(patched.hasPlan).toBe(false);
    expect(patched.hasRetro).toBe(false);
    expect(patched.sprintId).toBe('sprint-7');
    expect(patched.planDocId).toBeNull();
    expect(patched.retroDocId).toBeNull();
    expect(patched.reviewApproval).toBeNull();
    expect(patched.reviewRating).toBeNull();
    // ...and the actual patch still applied.
    expect(patched.planApproval?.state).toBe('approved');

    expect(Object.values(patched)).not.toContain(undefined);
  });

  it('patching an existing cell preserves its other fields', () => {
    const existing = {
      planApproval: null,
      reviewApproval: null,
      reviewRating: null,
      hasPlan: true,
      hasRetro: true,
      sprintId: 'sprint-7',
      planDocId: 'doc-1',
      retroDocId: 'doc-2',
    };

    const patched = mergeReviewCellPatch(existing, 'sprint-7', {
      reviewApproval: { state: 'approved', approved_by: null, approved_at: '2026-07-30T00:00:00Z', comment: null },
    });

    expect(patched.hasPlan).toBe(true);
    expect(patched.hasRetro).toBe(true);
    expect(patched.planDocId).toBe('doc-1');
    expect(patched.retroDocId).toBe('doc-2');
    expect(patched.reviewApproval?.state).toBe('approved');
  });
});
