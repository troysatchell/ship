/**
 * Extract the SQL text from a `pool.query(...)` call's first argument.
 *
 * DB-3 / TRO-180 named a handful of hot statements via `pool.query({ name, text,
 * values })` instead of `pool.query(text, values)`. Several tests inspected
 * `pool.query`'s first argument directly (`String(call[0])`, `call[0] as string`)
 * on the assumption it was always the raw SQL string — true for every call site
 * except the ones this ticket converted. Route through this helper instead of
 * re-deriving the same `typeof arg === 'string' ? arg : arg.text` check per file.
 *
 * Usage: `sqlOf(pool.query.mock.calls[i][0])`.
 */
export function sqlOf(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object' && 'text' in arg && typeof arg.text === 'string') {
    return arg.text;
  }
  return '';
}
