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

export interface KeysetCursor {
  readonly id: string;
  /** ISO 8601 string — the exact form `Date#toISOString()` produces. */
  readonly created_at: string;
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
 * the client as a 500.
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
  return { id: candidate.id, created_at: candidate.created_at };
}
