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

describe('migrate.ts CLI wrapper — top-level call site (TRO-297 / TS-10)', () => {
  it(
    'catches and reports a rejection from BEFORE its own try/catch, instead of an unhandled rejection',
    () => {
      // The test above (TRO-245) proves the try/catch inside migrate() converts a
      // runMigrations() failure into a clean non-zero exit. It does NOT exercise
      // `await loadProductionSecrets()` (migrate.ts:27), which runs BEFORE that
      // try/catch — a rejection there used to escape migrate()'s own error
      // handling entirely and reach the bare top-level `migrate();` call
      // (migrate.ts's last line) as an unhandled promise rejection. That is a
      // `@typescript-eslint/no-floating-promises` violation TRO-297 fixes by
      // adding `.catch(...)` to that call site.
      //
      // Forces exactly that path, deterministically and fast:
      //  - NODE_ENV=production: loadProductionSecrets() is a no-op for any other
      //    value (ssm.ts), so production is the only way to reach its SSM call.
      //  - DATABASE_URL='' / SESSION_SECRET='': dotenv's `config()` only fills in
      //    keys that are NOT already present in process.env (even an empty
      //    string counts as present), so this blocks migrate.ts's own
      //    `config({ path: '.env.local' })` from repopulating them from this
      //    worktree's real dev secrets — which would otherwise let
      //    loadProductionSecrets()'s catch-block fallback swallow the SSM
      //    failure instead of rethrowing it (ssm.ts: `if (DATABASE_URL &&
      //    SESSION_SECRET) { ...; return; }`).
      //  - AWS_ENDPOINT_URL_SSM=http://127.0.0.1:1: the SDK v3 endpoint override
      //    env var, pointed at a port that refuses instantly (same trick as the
      //    unreachable-Postgres case above) — verified directly (a standalone
      //    script against this exact endpoint) to reject in single-digit
      //    milliseconds via ECONNREFUSED, so ssm.ts's own retry loop (up to 3
      //    attempts with jittered backoff) still finishes in well under a
      //    second and never touches real AWS.
      //
      // Both the pre-fix and post-fix code exit non-zero here (Node's default
      // for an unhandled rejection is also a non-zero exit), so exit code alone
      // does not distinguish them. What differs is whether the failure is
      // reported through this file's own "Database migration failed:" log line
      // (only reachable via the added `.catch`) or escapes as an actual
      // unhandled rejection — confirmed directly by temporarily reverting
      // migrate.ts's top-level `.catch` back to a bare `migrate();` call
      // locally and re-running this exact test: it goes red, with stderr
      // instead containing Node's own fatal unhandled-rejection trace
      // (`node:internal/process/promises ... triggerUncaughtException`, on
      // this repo's Node 23) followed by the raw `ECONNREFUSED` error — never
      // the "Database migration failed:" line, because that line lives inside
      // the `.catch` this test is proving exists.
      const result = spawnSync(TSX_BIN, ['src/db/migrate.ts'], {
        cwd: API_ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          DATABASE_URL: '',
          SESSION_SECRET: '',
          AWS_ENDPOINT_URL_SSM: 'http://127.0.0.1:1',
          AWS_ACCESS_KEY_ID: 'tro297-test-key',
          AWS_SECRET_ACCESS_KEY: 'tro297-test-secret',
          AWS_REGION: 'us-east-1',
          ENVIRONMENT: 'tro297test',
        },
        encoding: 'utf-8',
        timeout: 15_000,
      });

      expect(
        result.error,
        `spawning tsx failed outright (not a migration failure): ${result.error?.message}`
      ).toBeUndefined();
      expect(
        result.status,
        `migrate.ts must exit non-zero when secrets cannot load. stderr:\n${result.stderr}`
      ).not.toBe(0);
      expect(
        result.stderr,
        'a rejection from loadProductionSecrets() (before migrate()\'s own try/catch) must be caught and ' +
        'reported through the same "Database migration failed:" path as an in-try failure — not surface as ' +
        "Node's generic unhandled-rejection warning"
      ).toMatch(/Database migration failed/);
      expect(
        result.stderr,
        'must not reach the process as an unhandled rejection'
      ).not.toMatch(/unhandled ?rejection/i);
    },
    20_000
  );
});
