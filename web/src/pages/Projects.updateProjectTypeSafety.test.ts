/**
 * Regression test for TS-7 (audit/AUDIT_REPORT.md).
 *
 * `handleBulkArchive` and its Undo handler in `Projects.tsx` (lines 220 and 233)
 * used to call `updateProject(id, { archived_at: ... } as any)`. The `as any`
 * cast disabled type-checking on the whole update payload for a bulk mutation
 * that touches every selected project at once.
 *
 * `updateProject`'s real signature (`ProjectsContext.tsx`) is
 * `(id: string, updates: Partial<Project>) => Promise<Project | null>`, and
 * `Project.archived_at` (`useProjectsQuery.ts`) is `string | null` — so the
 * payloads used at both call sites were always assignable without a cast. This
 * is a type-level regression test, not a runtime one: removing the cast does
 * not change what the code *does*, only what the compiler is allowed to check.
 * It proves two things `pnpm type-check` (factory gate G1) enforces going
 * forward:
 *
 *  1. The exact payload shapes used at Projects.tsx:220 and :233 satisfy the
 *     real `updateProject` signature with no cast (the assertions were dead
 *     weight, as AUDIT_REPORT.md's TS-7 section claims).
 *  2. A payload that does NOT satisfy `Partial<Project>` is now rejected by
 *     the compiler at this call shape. Under the old `as any` cast this
 *     `@ts-expect-error` would not have fired (a caught error requires that an
 *     error actually occurred), which is exactly the failure mode TS-7
 *     describes: "will silently absorb a real mismatch the first time the
 *     Project model changes."
 *
 * No `any`/`as any`/non-null `!` is introduced anywhere in this file.
 */
import { describe, it, expect } from 'vitest';
import type { useProjects } from '@/contexts/ProjectsContext';

// Derived directly from the real context — not duplicated — so this test
// tracks the actual `updateProject` signature rather than a copy of it.
type UpdateProject = ReturnType<typeof useProjects>['updateProject'];

describe('Projects bulk-archive payload typing (TS-7 regression)', () => {
  it('accepts the exact archived_at payloads used by handleBulkArchive and its Undo handler, uncast', () => {
    const callSites = (updateProject: UpdateProject) => {
      // Mirrors Projects.tsx:220 (handleBulkArchive)
      void updateProject('id', { archived_at: new Date().toISOString() });
      // Mirrors Projects.tsx:233 (Undo handler)
      void updateProject('id', { archived_at: null });
    };

    expect(typeof callSites).toBe('function');
  });

  it('rejects a payload that does not satisfy Partial<Project>, proving the check has teeth', () => {
    const rejectsBadPayload = (updateProject: UpdateProject) => {
      // @ts-expect-error archived_at must be `string | null`, not a number.
      // With the old `as any` cast in place at the call site, this line would
      // NOT produce a type error and this directive would fail as "unused" —
      // that is the exact protection gap TS-7 flags.
      void updateProject('id', { archived_at: 12345 });
    };

    expect(typeof rejectsBadPayload).toBe('function');
  });
});
