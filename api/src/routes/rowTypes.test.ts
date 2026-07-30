// Regression test for TRO-207 / audit finding TS-2:
// "the entire database-to-HTTP response path is implicitly `any`".
//
// Before this fix, every `extract*FromRow` mapper was declared `(row: any)`,
// so nothing about a row's shape was checked by the compiler — a column
// rename or a `properties->>'x'` typo would silently produce `undefined` in
// a live API response. This test pins two things for two of the seven
// mappers named in the audit (`extractProgramFromRow`, `extractFeedbackFromRow`):
//
//   1. A compile-time assertion that the mapper's parameter and return types
//      are not `any` (via vitest's `expectTypeOf`, checked by `tsc --noEmit`
//      as part of `pnpm type-check` / the gate).
//   2. A runtime assertion pinning the mapper's output shape for a
//      representative row, so a shape regression still fails even for
//      someone running only `vitest run` without a full type-check.
//
// Verified red before the fix: with `extractProgramFromRow`'s parameter
// annotation temporarily reverted to `(row: any)` (the pre-fix code at
// `programs.ts:12`), `pnpm --filter @ship/api exec tsc --noEmit -p tsconfig.json`
// fails with:
//   src/routes/rowTypes.test.ts(28,60): error TS2349: This expression is not
//   callable. Type 'Inverted<ExpectAny<any>>' has no call signatures.
// — a real type error on this file's own `expectTypeOf(...).not.toBeAny()`
// line, not an import error or a typo. `vitest run` alone does NOT catch this
// regression (`expectTypeOf` is a runtime no-op); the signal comes from
// `tsc --noEmit` / `pnpm type-check`, which is why that command is part of
// the gate alongside the test suite. Re-applying the real parameter type
// (`ProgramRow`) makes both commands pass again.
import { describe, it, expect, expectTypeOf } from 'vitest';
import { extractProgramFromRow, type ProgramRow } from './programs.js';
import { extractFeedbackFromRow, type FeedbackRow } from './feedback.js';

describe('TRO-207 — DB row mappers are not implicitly `any`', () => {
  describe('extractProgramFromRow', () => {
    it('has a non-`any` parameter and return type', () => {
      expectTypeOf(extractProgramFromRow).parameter(0).not.toBeAny();
      expectTypeOf(extractProgramFromRow).returns.not.toBeAny();
    });

    it('maps a representative program row to the expected shape', () => {
      const row: ProgramRow = {
        id: 'program-1',
        title: 'Onboarding',
        properties: {
          color: '#6366f1',
          emoji: '\u{1F680}',
          owner_id: 'user-1',
          accountable_id: 'user-2',
          consulted_ids: ['user-3'],
          informed_ids: ['user-4'],
        },
        archived_at: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-02T00:00:00.000Z'),
        owner_id: 'user-1',
        owner_name: 'Ada Lovelace',
        owner_email: 'ada@example.com',
        // COUNT(*) aggregates come back from node-postgres as strings.
        issue_count: '3',
        sprint_count: '1',
      };

      expect(extractProgramFromRow(row)).toEqual({
        id: 'program-1',
        name: 'Onboarding',
        color: '#6366f1',
        emoji: '\u{1F680}',
        archived_at: null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        issue_count: '3',
        sprint_count: '1',
        owner: {
          id: 'user-1',
          name: 'Ada Lovelace',
          email: 'ada@example.com',
        },
        owner_id: 'user-1',
        accountable_id: 'user-2',
        consulted_ids: ['user-3'],
        informed_ids: ['user-4'],
      });
    });

    it('defaults RACI/owner fields when the row has no owner and bare properties', () => {
      const row: ProgramRow = {
        id: 'program-2',
        title: 'Untitled',
        properties: { color: '#6366f1' },
        archived_at: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
        // Create/update queries don't select owner_*/issue_count/sprint_count.
      };

      expect(extractProgramFromRow(row)).toEqual({
        id: 'program-2',
        name: 'Untitled',
        color: '#6366f1',
        emoji: null,
        archived_at: null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        issue_count: undefined,
        sprint_count: undefined,
        owner: null,
        owner_id: null,
        accountable_id: null,
        consulted_ids: [],
        informed_ids: [],
      });
    });
  });

  describe('extractFeedbackFromRow', () => {
    it('has a non-`any` parameter and return type', () => {
      expectTypeOf(extractFeedbackFromRow).parameter(0).not.toBeAny();
      expectTypeOf(extractFeedbackFromRow).returns.not.toBeAny();
    });

    it('maps a representative feedback-detail join row to the expected shape', () => {
      const row: FeedbackRow = {
        id: 'issue-1',
        title: 'Button is broken',
        properties: {
          state: 'triage',
          priority: 'medium',
          source: 'external',
          assignee_id: null,
        },
        ticket_number: 42,
        content: { type: 'doc', content: [] },
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
        created_by: null,
        program_id: 'program-1',
        program_name: 'Support',
        program_prefix: 'SUP',
        program_color: '#ff0000',
        created_by_name: null,
      };

      expect(extractFeedbackFromRow(row)).toEqual({
        id: 'issue-1',
        title: 'Button is broken',
        state: 'triage',
        priority: 'medium',
        source: 'external',
        rejection_reason: null,
        assignee_id: null,
        ticket_number: 42,
        program_id: 'program-1',
        content: { type: 'doc', content: [] },
        created_at: row.created_at,
        updated_at: row.updated_at,
        created_by: null,
        program_name: 'Support',
        program_prefix: 'SUP',
        program_color: '#ff0000',
        created_by_name: null,
        display_id: '#42',
      });
    });

    it('handles a bare `RETURNING *` insert row, which has no program_*/created_by_name columns', () => {
      const row: FeedbackRow = {
        id: 'issue-2',
        title: 'New feedback',
        properties: { state: 'triage', priority: 'medium', source: 'external' },
        ticket_number: 43,
        content: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
        created_by: null,
        // program_id/program_name/program_prefix/program_color/created_by_name
        // are absent, matching a bare `documents` row from `RETURNING *`.
      };

      expect(extractFeedbackFromRow(row, 'SUP')).toEqual({
        id: 'issue-2',
        title: 'New feedback',
        state: 'triage',
        priority: 'medium',
        source: 'external',
        rejection_reason: null,
        assignee_id: null,
        ticket_number: 43,
        program_id: null,
        content: null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        created_by: null,
        program_name: null,
        program_prefix: 'SUP',
        program_color: null,
        created_by_name: null,
        display_id: '#43',
      });
    });
  });
});
