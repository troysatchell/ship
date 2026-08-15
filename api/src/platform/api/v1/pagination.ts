/**
 * Opaque keyset-cursor pagination (PLUGFORGE.MD §2.5, §4 PF-200):
 *
 *   cursor := base64url({ id, created_at })
 *   WHERE (created_at, id) < ($cursor.created_at, $cursor.id)
 *   ORDER BY created_at DESC, id DESC
 *
 * Shared across every `/api/v1` list endpoint (PF-200 is the first;
 * PF-201/PF-205 add more resources over the same `documents` table and the
 * same cursor shape), so this lives at the `api/v1` level rather than inside
 * `resources/documents.ts`.
 *
 * Keyset pagination (as opposed to OFFSET/LIMIT) is what makes the cursor
 * STABLE across concurrent inserts: a row inserted anywhere other than
 * exactly at the cursor boundary can never shift an already-returned row out
 * of, or an unreturned row into, a page the caller has already seen, because
 * every page boundary is anchored to a real row's own `(created_at, id)`
 * rather than to a row *count* that a concurrent insert changes out from
 * under it.
 */

/**
 * A `created_at` value guaranteed to carry Postgres's full microsecond
 * precision — the ONLY thing `encodeCursor` will accept for its
 * `created_at` field (TRO-602). A plain `string` cannot make that
 * guarantee (a JS `Date#toISOString()` result is a `string` too, and is
 * exactly the lossy value that caused TRO-602's silent-row-drop bug: `pg`'s
 * default parser truncates `timestamptz` to millisecond precision, so two
 * rows landing in the same millisecond can put a not-yet-fetched row on the
 * wrong side of the cursor boundary, permanently and silently). This
 * nominal brand makes that mistake a compile error instead of a bug that
 * only shows up under a same-millisecond collision in production.
 *
 * The one sanctioned way to produce one is `preciseTimestamp()` below,
 * called on a `created_at::text` SQL alias (Postgres's own text
 * serialization of `timestamptz` preserves full precision — no lossy
 * round-trip through a JS `Date`) — see `resources/audit.ts`'s
 * `AUDIT_COLUMNS`/`created_at_precise` for the pattern this generalizes
 * from, and any resource file under `resources/` for the same convention
 * applied via this shared type.
 */
export type PreciseTimestamp = string & { readonly __brand: 'PreciseTimestamp' };

/**
 * Brands a `created_at::text`-selected column value as a `PreciseTimestamp`.
 * Deliberately the ONLY function in this module that produces one — never
 * call this on `Date#toISOString()` or any other Date-derived string; there
 * is nothing this function can check at runtime that distinguishes a
 * precise value from a lossy one (both are plain strings by the time they
 * reach here), so the guarantee is enforced entirely by convention at this
 * one call site plus the type system everywhere downstream of it.
 */
export function preciseTimestamp(raw: string): PreciseTimestamp {
  return raw as PreciseTimestamp;
}

export interface KeysetCursor {
  readonly id: string;
  readonly created_at: PreciseTimestamp;
}

/**
 * Encodes a cursor. Deliberately opaque to callers (PF-200's test design:
 * "the test never decodes/parses its contents, only passes it back
 * verbatim") — base64url is an implementation detail, not a contract.
 */
export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor produced by `encodeCursor`. Returns `null` for anything
 * that isn't a validly-shaped cursor — a garbled, truncated, or
 * hand-crafted `?cursor=` value — so the caller can turn that into a
 * `validation_failed` `ApiError` rather than a raw parse exception reaching
 * the client as a 500. The decoded `created_at` is re-branded via
 * `preciseTimestamp()` without a fresh precision check — safe because it
 * can only ever have been produced by this module's own `encodeCursor`
 * (which itself only ever accepted a `PreciseTimestamp`), not supplied
 * directly by a caller.
 */
export function decodeCursor(raw: string): KeysetCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || typeof candidate.created_at !== 'string') {
    return null;
  }
  return { id: candidate.id, created_at: preciseTimestamp(candidate.created_at) };
}
