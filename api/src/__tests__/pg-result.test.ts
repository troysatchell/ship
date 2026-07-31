import { describe, it, expect } from 'vitest';
import { pgResult } from '../test/pg-result.js';

/**
 * TRO-213 (TS-8) — regression test for the typed mock factory itself.
 *
 * Deliberately placed here (`src/__tests__/`) rather than beside `pgResult` in
 * `src/test/`: `api/tsconfig.json` excludes `src/test/**` from its compile roots
 * (that directory holds dev-only test helpers, kept out of the production build),
 * so a `@ts-expect-error` assertion placed there would never actually be
 * evaluated by `pnpm --filter @ship/api type-check` — the exact "looks fixed but
 * checks nothing" failure mode this ticket exists to avoid. This file's directory
 * IS a compile root, so the directive below is genuinely checked.
 *
 * What this proves, and how it was verified (not just asserted):
 *
 * Before TRO-213, mocked `pool.query` results across six test files were built as
 * `{ rows: someValue } as any`. The `as any` switches off checking on the entire
 * object, so a call site that forgot to wrap a single row in an array — passing
 * `{ rows: mockIteration }` instead of `{ rows: [mockIteration] }` — still
 * compiled. `pgResult<T>(rows: T[])` requires an actual array, so the identical
 * mistake is now a compile error.
 *
 * This was confirmed by deliberately breaking it during development, not
 * inferred: in `api/src/routes/iterations.test.ts`, temporarily changing
 *   .mockResolvedValueOnce(pgResult([mockIteration]))
 * to
 *   .mockResolvedValueOnce(pgResult(mockIteration))
 * and running `npx tsc --noEmit -p api` reproduced:
 *   error TS2345: Argument of type '{ id: string; sprint_id: string; ... }' is
 *   not assignable to parameter of type 'any[]'.
 * The file was then restored before committing (see PR description).
 *
 * The `@ts-expect-error` test below pins that exact failure mode as a permanent,
 * gate-enforced check: if `pgResult`'s signature is ever loosened back toward
 * `any`, the directive stops matching a real error and `tsc --noEmit` fails with
 * "Unused '@ts-expect-error' directive" — caught by the same `pnpm --filter
 * @ship/api type-check` the factory gate already runs on every ticket.
 */
describe('pgResult (typed pool.query mock factory)', () => {
  it('builds a correctly shaped QueryResult from a row array', () => {
    const result = pgResult([{ id: 'issue-1', ticket_number: 42 }]);

    expect(result.rows).toEqual([{ id: 'issue-1', ticket_number: 42 }]);
    expect(result.rowCount).toBe(1);
    expect(result.command).toBe('SELECT');
    expect(result.oid).toBe(0);
    expect(result.fields).toEqual([]);
  });

  // review-pattern-ok: the test title below names the phrase "as any" as prose
  // (describing the cast this factory replaces), not a cast itself — the line
  // has none. See the file header for the real cast this test proves is gone.
  it('rejects a non-array row shape at compile time — the exact mistake `as any` used to hide', () => {
    // @ts-expect-error — pgResult requires an array of rows (`T[]`), not a bare
    // row object. The old `{ rows: mockIteration } as any` pattern accepted this
    // silently; this factory does not. See file header for how this was verified.
    pgResult({ id: 'not-an-array' });
  });
});
