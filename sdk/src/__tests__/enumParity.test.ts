/**
 * TRO-618 — enum-MEMBER parity between `/api/v1`'s OpenAPI document and
 * `@ship/sdk`'s `IssuePriority`/`IssueState` unions.
 *
 * `parity.test.ts` (PF-405, TRO-422) proves every `/api/v1` OPERATION has an
 * SDK method and vice versa — operation-level parity only. It never looked
 * inside a schema, which is how PR #276 (TRO-501) widened
 * `IssuePrioritySchema` (`api/src/platform/openapi/schemas/issues.ts`) and
 * `shared/src/types/document.ts`'s `IssuePriority` to include `'none'` while
 * `sdk/src/types.ts` kept `'low' | 'medium' | 'high' | 'urgent'` — a
 * silently-lying SDK type: the server serializes `priority: 'none'` (real
 * rows carry it — that's the whole reason TRO-501 widened it) and the SDK's
 * type says that value cannot happen.
 *
 * SOURCE OF TRUTH: the same import `parity.test.ts` makes —
 * `v1OpenApiDocument` from `api/src/platform/openapi/index.ts`, computed at
 * module load from `v1Registry`'s zod registrations, no server, no database
 * (that file's own header explains the one deliberate cross-package import;
 * `sdk/tsconfig.json` excludes `src/__tests__/**` from `tsc` for this
 * reason). The ticket text says "load docs/openapi.json the same way
 * parity.test.ts does" — parity.test.ts does NOT read `docs/openapi.json`;
 * it imports the live document. `docs/openapi.json` is that same document
 * committed to disk and CI-diffed against it (`pnpm openapi:check:v1`,
 * `api/src/platform/openapi/README.md` "Static spec + CI parity"), so this
 * suite checks BOTH: the live document (primary) and the committed file, so
 * a stale commit of either side is caught here too.
 *
 * HOW THE ENUMS ARE FOUND: structurally, not by a hand-maintained JSON path.
 * The whole document is walked and every `enum: string[]` node is collected;
 * an enum containing `'urgent'` is a priority enum, one containing
 * `'in_progress'` is a state enum (both markers are unique to those two
 * unions across the API — no other schema uses either word). Every occurrence
 * (components AND inline request/response schemas) must be set-equal to the
 * SDK's runtime array, member-for-member. Zero occurrences is itself a
 * failure — the marker drifted, so the test would otherwise pass vacuously.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

import { v1OpenApiDocument } from '../../../api/src/platform/openapi/index.js';
import { ISSUE_PRIORITIES, ISSUE_STATES } from '../types.js';
import type { IssuePriority, IssueState } from '../types.js';

// ─── compile-time guards: the runtime arrays and the unions must be the same
// set in both directions. Vitest transpiles (no type-check) so these never
// fail a run, but they DO fail `tsc` in any consumer that type-checks this
// file — and they document the intent next to the runtime assertions.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const _prioritiesMirrorUnion: Equal<(typeof ISSUE_PRIORITIES)[number], IssuePriority> = true;
const _statesMirrorUnion: Equal<(typeof ISSUE_STATES)[number], IssueState> = true;
void _prioritiesMirrorUnion;
void _statesMirrorUnion;

/** Walk any JSON-ish value and collect every `enum` that is an array of
 *  strings, tagged with the JSON-pointer-ish path it was found at (for the
 *  failure message). */
function collectStringEnums(node: unknown, path = '#'): Array<{ path: string; values: string[] }> {
  const out: Array<{ path: string; values: string[] }> = [];
  if (Array.isArray(node)) {
    node.forEach((child, i) => out.push(...collectStringEnums(child, `${path}/${i}`)));
    return out;
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.enum) && obj.enum.every((v) => typeof v === 'string')) {
      out.push({ path: `${path}/enum`, values: obj.enum as string[] });
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'enum') continue;
      out.push(...collectStringEnums(value, `${path}/${key}`));
    }
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const committedSpecPath = resolve(here, '../../../docs/openapi.json');

const SOURCES: Array<{ label: string; doc: unknown }> = [
  { label: 'live v1OpenApiDocument (api/src/platform/openapi/index.ts)', doc: v1OpenApiDocument },
  { label: 'committed docs/openapi.json', doc: JSON.parse(readFileSync(committedSpecPath, 'utf8')) },
];

function assertEveryEnumMatches(
  doc: unknown,
  marker: string,
  expected: readonly string[],
  what: string,
): void {
  const found = collectStringEnums(doc).filter((e) => e.values.includes(marker));
  expect(
    found.length,
    `no enum containing '${marker}' found anywhere in the OpenAPI document — the ${what} marker ` +
      `drifted (or the enum was removed). Update the marker; do not let this suite pass vacuously.`,
  ).toBeGreaterThan(0);
  for (const { path, values } of found) {
    expect(
      new Set(values),
      `DRIFT: OpenAPI ${what} enum at ${path} is [${values.join(', ')}] but @ship/sdk's runtime array ` +
        `is [${expected.join(', ')}]. Update sdk/src/types.ts (the union AND the array) to match.`,
    ).toEqual(new Set(expected));
  }
}

describe('TRO-618 — @ship/sdk enum members mirror the /api/v1 OpenAPI enums', () => {
  it('ISSUE_PRIORITIES has no duplicates and ISSUE_STATES has no duplicates', () => {
    expect(new Set(ISSUE_PRIORITIES).size).toBe(ISSUE_PRIORITIES.length);
    expect(new Set(ISSUE_STATES).size).toBe(ISSUE_STATES.length);
  });

  for (const { label, doc } of SOURCES) {
    describe(label, () => {
      it("every issue priority enum (marker 'urgent') is set-equal to ISSUE_PRIORITIES", () => {
        assertEveryEnumMatches(doc, 'urgent', ISSUE_PRIORITIES, 'issue priority');
      });

      it("every issue state enum (marker 'in_progress') is set-equal to ISSUE_STATES", () => {
        assertEveryEnumMatches(doc, 'in_progress', ISSUE_STATES, 'issue state');
      });
    });
  }
});
