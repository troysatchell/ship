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
 * Shape of Postgres's own `timestamptz::text` cast — `YYYY-MM-DD
 * HH:MI:SS[.f{1,6}]+TZ[:TZ]` — verified directly against this DB (not
 * assumed): the fractional part is trimmed of trailing zeros and OMITTED
 * entirely when it's exactly zero (`05:33:23+00`, not `05:33:23.000000+00`),
 * so a fixed-six-digit requirement would reject a large fraction of
 * genuinely precise real timestamps. This regex catches gross shape
 * mismatches (starting with: anything from `Date#toISOString()`, which uses
 * a `T` separator, a `Z` suffix, and fixed 3-digit milliseconds —
 * structurally disjoint from Postgres's own text format) but is purely
 * lexical: `2026-02-31 ...` matches it despite February never having a
 * 31st. `isPreciseTimestampShape` below adds the calendar/offset check this
 * regex alone can't do.
 */
const POSTGRES_TIMESTAMPTZ_TEXT_RE =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?([+-])(\d{2})(?::(\d{2}))?$/;

/**
 * `POSTGRES_TIMESTAMPTZ_TEXT_RE`'s lexical match PLUS calendar/offset
 * validity (CodeRabbit, TRO-602 follow-up review: a lexically-matching but
 * impossible value like `"2026-02-31 05:33:23+00"` or an offset like
 * `"+99:99"` was passed through unrejected, reaching the resource's SQL
 * query as a bind parameter — verified directly that Postgres then throws
 * "date/time field value out of range", an *uncaught* error from that
 * `pool.query()` call. `errorMiddleware.ts` already sanitizes that into a
 * generic `server_error` 500 with no leaked detail — so there was never an
 * information-disclosure or crash risk — but the status code is wrong: a
 * malformed `?cursor=` should get `validation_failed` like every other
 * malformed-cursor case, not a 500). Uses `Date.UTC`'s own field-overflow
 * behavior as the calendar check (constructing a UTC date from the
 * matched fields and comparing them back catches Feb 31 — `Date.UTC`
 * silently normalizes it to March 3 — without hand-rolling a
 * days-per-month table), plus an explicit UTC-offset bound (`00`-`14`
 * hours, `00`-`59` minutes) since `Date.UTC` has no offset concept to
 * overflow-check.
 */
function isPreciseTimestampShape(raw: string): boolean {
  const match = POSTGRES_TIMESTAMPTZ_TEXT_RE.exec(raw);
  if (!match) {
    return false;
  }
  const [, yStr, moStr, dStr, hStr, miStr, sStr, , offHStr, offMStr] = match;
  const year = Number(yStr);
  const month = Number(moStr);
  const day = Number(dStr);
  const hour = Number(hStr);
  const minute = Number(miStr);
  const second = Number(sStr);
  const offsetHours = Number(offHStr);
  const offsetMinutes = offMStr ? Number(offMStr) : 0;

  const asUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const calendarValid =
    asUtc.getUTCFullYear() === year &&
    asUtc.getUTCMonth() === month - 1 &&
    asUtc.getUTCDate() === day &&
    asUtc.getUTCHours() === hour &&
    asUtc.getUTCMinutes() === minute &&
    asUtc.getUTCSeconds() === second;

  return calendarValid && offsetHours <= 14 && offsetMinutes <= 59;
}

/**
 * Brands a `created_at::text`-selected column value as a `PreciseTimestamp`,
 * asserting it is at least shaped like Postgres's own `timestamptz::text`
 * output (see `isPreciseTimestampShape`'s comment for exactly what that
 * does and does not guarantee). Deliberately the ONLY function in this
 * module that produces one — never call this on `Date#toISOString()` or
 * any other Date-derived string. Throws rather than degrading, because
 * every call site passes a value this module's own SQL selected — a
 * mismatch here means a call site changed what it selects, not bad client
 * input; `decodeCursor` below validates the client-supplied case separately
 * and degrades to `null` instead of throwing.
 */
export function preciseTimestamp(raw: string): PreciseTimestamp {
  if (!isPreciseTimestampShape(raw)) {
    throw new Error(
      `preciseTimestamp: "${raw}" is not shaped like a Postgres timestamptz::text cast — ` +
        `did a call site pass a Date#toISOString() value instead of a created_at::text column?`
    );
  }
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
 * `validation_failed` `ApiError` rather than a raw parse exception (or
 * `preciseTimestamp`'s throw) reaching the client as a 500. `created_at` is
 * checked against `isPreciseTimestampShape` here, before `preciseTimestamp`
 * — including its calendar/offset validity check, not just the lexical
 * shape — specifically so a hand-crafted `?cursor=` with a garbled or
 * calendar-impossible `created_at` (e.g. `"2026-02-31 ..."`, which would
 * otherwise reach the resource's SQL query and make Postgres itself throw)
 * degrades to `null` like every other malformed-cursor case instead of
 * throwing or 500ing.
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
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.created_at !== 'string' ||
    !isPreciseTimestampShape(candidate.created_at)
  ) {
    return null;
  }
  return { id: candidate.id, created_at: preciseTimestamp(candidate.created_at) };
}
