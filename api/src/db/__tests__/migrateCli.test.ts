/**
 * Regression test for the `migrate.ts` CLI wrapper's exit code (TRO-245's
 * verification pass on DB-1 / TRO-178).
 *
 * SCOPE, STATED PRECISELY (claim-provenance rule in .claude/CLAUDE.md):
 * migrationRunner.test.ts and verifyMigrations.test.ts already exercise
 * `runMigrations()` exhaustively — including the exact DB-1 shape (a
 * numbered-migration failure previously swallowed as benign) — by calling it
 * directly as a function, and are confirmed (by temporarily reintroducing the
 * historical swallow) to fail for that reason. What none of that coverage
 * touches is `migrate.ts` itself: the CLI entry point that turns a
 * `runMigrations()` rejection into `process.exit(1)` (migrate.ts:46-55). A
 * caller that forgot the `if (failed) process.exit(1)` line, or dropped the
 * surrounding try/catch, would still pass every existing test in this
 * directory while `pnpm db:migrate` silently exited 0 on a real failure.
 *
 * This test closes THAT gap — the CLI-wrapper conversion — not DB-1's
 * original defect directly. It was checked against the real pre-DB-1-fix
 * `migrate.ts` (git show <pre-TRO-178 commit>:api/src/db/migrate.ts, swapped
 * in locally, never committed) and STAYS GREEN there: the historical bug only
 * swallowed errors whose message contains "already exists", and a refused
 * database connection does not match that string, so it was never the
 * swallowed case. That old bug is what migrationRunner.test.ts's
 * revert-and-watch already proves red at the `runMigrations()` level. This
 * test instead proves the independent, previously-unverified fact that the
 * CLI wrapper forwards ANY `runMigrations()` failure — not just DB-1's
 * specific shape — into a non-zero process exit, which is what the audit
 * table's "non-zero exit on failure" phrase requires end-to-end and which no
 * prior test spawned the real CLI to check.
 *
 * Spawns the real `tsx src/db/migrate.ts` process (exactly what
 * `api/package.json`'s `db:migrate` script runs) against a DATABASE_URL that
 * cannot be reached, and asserts on the real process exit code — not a mock
 * of `process.exit`.
 */
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = join(__dirname, '../../..');
const TSX_BIN = join(API_ROOT, 'node_modules/.bin/tsx');

describe('migrate.ts CLI wrapper (DB-1 / TRO-178, verified by TRO-245)', () => {
  it(
    'exits non-zero when the migration run fails, rather than reporting success',
    () => {
      // Port 1 on loopback refuses immediately (nothing can bind a privileged
      // port without root) — a fast, deterministic "unreachable database"
      // rather than a slow connection-timeout race.
      const unreachableDatabaseUrl = 'postgresql://ship:ship@127.0.0.1:1/tro245_unreachable';

      const result = spawnSync(TSX_BIN, ['src/db/migrate.ts'], {
        cwd: API_ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'test', // skips loadProductionSecrets()'s SSM path entirely
          DATABASE_URL: unreachableDatabaseUrl,
        },
        encoding: 'utf-8',
        timeout: 30_000,
      });

      expect(
        result.error,
        `spawning tsx failed outright (not a migration failure): ${result.error?.message}`
      ).toBeUndefined();
      expect(
        result.status,
        `migrate.ts must exit non-zero on failure. stderr:\n${result.stderr}`
      ).not.toBe(0);
      expect(
        result.stderr,
        'the failure must be reported, not swallowed silently'
      ).toMatch(/Database migration failed/);
    },
    35_000
  );
});
