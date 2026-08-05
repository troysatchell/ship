/**
 * Pure, side-effect-free validation for `GET /api/team/people` response rows
 * — split out of `trace-invoke-proactive.ts` (TRO-324 / FG-13) so the guard
 * can be unit-tested directly. `trace-invoke-proactive.ts` (and its two
 * siblings, `trace-invoke.ts` / `trace-invoke-on-demand.ts`) is deliberately
 * excluded from `pnpm test` (CHANGES.md's own documented posture) because
 * its `main()` runs unconditionally at module import time and makes real,
 * live HTTP calls — importing that file from a test would either fire those
 * calls or, if the required env vars are unset, set `process.exitCode = 1`
 * as a side effect of import alone, corrupting the whole test run's exit
 * code. This file has neither hazard: importing it runs nothing, it only
 * exposes a type and a type guard.
 */

/** The one field `trace-invoke-proactive.ts` actually needs from
 * `GET /api/team/people`'s response shape — typed explicitly rather than
 * trusting `unknown` (repo rule: type the boundary a JSON parse hands you,
 * lessons.md #21). */
export interface PersonDirectoryEntry {
  id: string;
  name: string;
  user_id?: string | null;
}

/** `user_id` is declared `string | null | undefined` on `PersonDirectoryEntry`
 * above, but this guard used to never check its type when present — an
 * entry like `{ id: '...', name: '...', user_id: 42 }` passed the guard, and
 * `trace-invoke-proactive.ts` then treats that NUMBER as a person id
 * downstream (real risk in a script whose entire job is correlating a
 * specific recipient: a wrong-typed id can cause a false "not found," or
 * worse, a silent wrong-recipient match). No type assertion — a real
 * runtime check, matching this file's own posture. */
export function isPersonDirectoryEntry(value: unknown): value is PersonDirectoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    (v.user_id === undefined || v.user_id === null || typeof v.user_id === 'string')
  );
}
