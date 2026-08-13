/**
 * PF-003 (TRO-399) — boundary lint, AC-1: "api/src/platform/api/v1/** cannot
 * import api/src/routes/**" (PLUGFORGE.MD §2.1 / §4).
 *
 * Test design source: Linear TRO-399 comment "Test design (pre-implementation
 * — ship-test-designer, 2026-08-10)". Loads the api package's REAL flat
 * `eslint.config.mjs` (root of the repo) via the `ESLint` class — not a
 * hand-rolled duplicate of the rule — and lints two fixtures: one importing
 * from `api/src/routes/**`, one importing from an unrelated sibling
 * (`api/src/services/**`), to prove the rule is scoped to `routes/**` and not
 * a blanket import ban.
 *
 * DEVIATION from the test design's "virtually at api/src/platform/api/v1/scratch.ts"
 * wording: confirmed empirically (before writing this test) that
 * `ESLint#lintText()` with a virtual/non-existent `filePath` fails under this
 * repo's type-aware parser config (`parserOptions.projectService: true`) —
 * "Parsing error: ... was not found by the project service. Consider either
 * including it in the tsconfig.json or including it in allowDefaultProject."
 * `no-restricted-imports` itself needs no type information, so instead of a
 * virtual file this test writes REAL, temporary fixture files to
 * `api/src/platform/api/v1/__pf003_test_fixtures__/` (inside the exact
 * directory the rule targets, so api/tsconfig.json's broad `src` include
 * picks them up) and removes them in `finally` — including on assertion
 * failure — so a deliberately rule-violating fixture never sits committed in
 * the tree for a normal `pnpm lint` run to trip over. The import depth
 * (`../../../../routes/...`, one level deeper than the ticket's literal
 * example) reflects the extra `__pf003_test_fixtures__` directory level; the
 * rule's `no-restricted-imports` pattern (`**\/routes/**`) matches on the
 * import string regardless of how many `../` segments precede it — verified
 * directly against the real config before this test was written.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { ESLint } from 'eslint';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// api/src/platform/__tests__ -> api/src/platform/api/v1/__pf003_test_fixtures__
const FIXTURE_DIR = resolve(__dirname, '../api/v1/__pf003_test_fixtures__');
// api/src/platform/__tests__ -> up 4 (platform, src, api, <repo root>)
const REPO_ROOT = resolve(__dirname, '../../../..');
const FIXTURE_DIR_RELATIVE = 'api/src/platform/api/v1/__pf003_test_fixtures__';

async function lintFixture(fileName: string, source: string): Promise<ESLint.LintResult> {
  await mkdir(FIXTURE_DIR, { recursive: true });
  const absolutePath = resolve(FIXTURE_DIR, fileName);
  await writeFile(absolutePath, source, 'utf-8');
  try {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const results = await eslint.lintFiles([`${FIXTURE_DIR_RELATIVE}/${fileName}`]);
    // Explicit destructure + check (review-pattern rule 16) rather than a
    // non-null assertion: ESLint's own typings return LintResult[], so an
    // empty array (fixture write failed silently, or the glob matched
    // nothing) must fail the test loudly, not produce an `undefined` that a
    // `!` would paper over.
    const [result] = results;
    if (!result) {
      throw new Error(`ESLint#lintFiles produced no result for fixture '${fileName}' — expected exactly one.`);
    }
    return result;
  } finally {
    await rm(absolutePath, { force: true });
  }
}

describe('PF-003: boundary lint — platform/api/v1/** must not import api/src/routes/**', () => {
  afterAll(async () => {
    // Belt and braces: lintFixture already removes each file it writes in its
    // own `finally`, but a directory left empty by successive runs is still
    // worth sweeping, and this guards against a future fixture that errors
    // before writeFile completes.
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('fixture (a): importing from api/src/routes/** fails no-restricted-imports', async () => {
    const result = await lintFixture(
      'routes-import.ts',
      "import { foo } from '../../../../routes/documents';\nexport { foo };\n",
    );
    const restrictedImportErrors = result.messages.filter((m) => m.ruleId === 'no-restricted-imports');
    expect(restrictedImportErrors.length).toBeGreaterThan(0);
    // Explicit destructure + check, not a non-null assertion (review-pattern
    // rule 16) — the length check above is a separate assertion from TS's
    // point of view and does not narrow the indexed-access type.
    const [firstError] = restrictedImportErrors;
    expect(firstError).toBeDefined();
    expect(firstError?.message).toContain('routes');
  }, 30000);

  it('fixture (b): importing from api/src/services/** (a sibling, non-routes path) produces ZERO no-restricted-imports errors', async () => {
    const result = await lintFixture(
      'services-import.ts',
      "import { foo } from '../../../../services/foo';\nexport { foo };\n",
    );
    const restrictedImportErrors = result.messages.filter((m) => m.ruleId === 'no-restricted-imports');
    expect(restrictedImportErrors).toEqual([]);
  }, 30000);
});
