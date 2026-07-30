/**
 * Migration runner — the logic behind `pnpm db:migrate`.
 *
 * Extracted from migrate.ts so it can be exercised by tests against a throwaway
 * database. migrate.ts remains the CLI entry point (env loading, pool creation,
 * exit codes); everything that decides *what gets applied* lives here.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Pool, PoolClient } from 'pg';

export interface MigrationRunOptions {
  schemaPath: string;
  migrationsDir: string;
  /** Sink for progress output. Defaults to console.log; tests pass a no-op. */
  log?: (message: string) => void;
}

export interface MigrationRunResult {
  /** Migration versions applied by this run, in the order they were applied. */
  applied: string[];
  /** Migration versions already recorded in schema_migrations before this run. */
  alreadyApplied: string[];
}

/**
 * Postgres SQLSTATE codes meaning "the object you asked me to create is
 * already there". schema.sql is initial-setup DDL that is re-applied on every
 * deploy, so these are expected *there*.
 *
 * They are never expected from a numbered migration: a migration that cannot
 * be applied twice is a migration that has not been made idempotent, and
 * treating that as benign is what let DB-1 abandon 32 files while exiting 0.
 */
const DUPLICATE_OBJECT_SQLSTATES = new Set([
  '42P04', // duplicate_database
  '42P06', // duplicate_schema
  '42P07', // duplicate_table (also index, view, sequence)
  '42701', // duplicate_column
  '42710', // duplicate_object (trigger, constraint, type, operator, ...)
  '42723', // duplicate_function
]);

// Deliberately NOT in that set: 23505 (unique_violation). Concurrent schema
// applies raise it on the system catalog index pg_type_typname_nsp_index, so it
// is tempting to add — but 23505 is the generic "a unique constraint was
// violated", and widening the set to cover a catalog race would also swallow a
// real data conflict. schema.sql contains zero DML today, which is exactly the
// kind of fact that stops being true quietly. TRO-279 still declines to widen
// this set now that the concurrency fix has landed, for the same reason.

/**
 * Session-level advisory lock key for the whole migration run (schema.sql +
 * every pending migration — see runMigrations). Fixed and arbitrary:
 * pg_advisory_lock(bigint) only needs a value every `pnpm db:migrate`
 * invocation agrees on, and it fits in a plain (non-bigint) JS number since
 * the driver sends it as an untyped literal and Postgres resolves it against
 * the bigint overload. Chosen to spell "Ship" in hex (0x53686970 = bytes
 * 'S','h','i','p') so it reads as intentional rather than a stray magic
 * number.
 *
 * Exported so tests can verify the lock is actually released (via
 * `pg_try_advisory_lock` on this exact key) rather than only inferring it
 * from a second run succeeding.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 0x53686970; // 1_399_351_664

function isDuplicateObjectError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && DUPLICATE_OBJECT_SQLSTATES.has(code);
}

/**
 * Required migration filename shape: `NNN_description.sql`, with an optional
 * single-letter suffix for files inserted between existing numbers —
 * `007b_`, `014b_`, `015b_`, `018b_` and `020b_` all exist today.
 */
const MIGRATION_FILENAME = /^\d{3}[a-z]?_[A-Za-z0-9_]+\.sql$/;

/**
 * Migration files in the order they must be applied.
 *
 * Two ways of not knowing what to run are refused rather than papered over,
 * because both are DB-1's failure mode wearing a different hat — a run that
 * applies less than it should and reports success:
 *
 *  - Read errors propagate. A missing or unreadable migrations directory (a
 *    `dist/db/migrations` the build failed to copy, say) would otherwise apply
 *    schema.sql, apply nothing else, and exit 0. "No migrations to run" and
 *    "I could not find out what to run" must not look the same to the caller.
 *  - Filenames are validated. An unnumbered file sorts by its first character
 *    and would run at an arbitrary point in the sequence — `hotfix.sql` sorts
 *    after every numbered file, `a_fix.sql` too, while `!fix.sql` sorts before
 *    all of them. Ordering is the only correctness guarantee a migration
 *    sequence has, so a file that cannot be ordered is an error, not a guess.
 */
export function listMigrationFiles(migrationsDir: string): string[] {
  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));

  const malformed = files.filter(f => !MIGRATION_FILENAME.test(f)).sort();
  if (malformed.length > 0) {
    throw new Error(
      `Migration filenames must match NNN_description.sql (three digits, ` +
        `optionally one letter, e.g. 007b_remove_prefix.sql). Offending file(s) ` +
        `in ${migrationsDir}: ${malformed.join(', ')}. ` +
        `Rename them, or renumber the sequence if it has outgrown three digits.`
    );
  }

  // A plain lexicographic sort IS numeric order here, and only because the
  // pattern above forces a zero-padded three-digit prefix: '009' < '010', and
  // '007' < '007b' < '008'. That equivalence is what the validation buys.
  return files.sort();
}

/**
 * Applies schema.sql, the initial-setup DDL.
 *
 * `pool.query` sends the whole file as ONE simple query, so Postgres runs it as
 * a single implicit transaction. A duplicate-object error at statement k
 * therefore rolls back statements 1..k-1 as well — **nothing** in the file was
 * applied. Catching that and returning normally is DB-1 exactly: applied
 * nothing, reported success. It was in this function until now.
 *
 * So the error is no longer swallowed, it is *re-tested*. schema.sql is
 * idempotent — 17/17 `CREATE TABLE` and 59/59 `CREATE INDEX` use
 * `IF NOT EXISTS`, both `CREATE TYPE`s sit in guarded `DO` blocks, the function
 * is `OR REPLACE`, and the trigger is preceded by `DROP TRIGGER IF EXISTS` —
 * so a second pass must succeed. Re-apply and let the outcome decide:
 *
 *  - it succeeds: every object the file creates is now present, verified by the
 *    file itself rather than by a hardcoded list that could drift from it;
 *  - it fails again: the file is genuinely not idempotent, or the conflict is
 *    real, and the run must fail rather than log a reassuring line.
 *
 * The tolerance is kept rather than deleted because the error *is* reachable,
 * just not sequentially: two `pnpm db:migrate` runs at once race in the
 * catalog, and `CREATE TABLE IF NOT EXISTS` is not atomic. Measured on
 * PostgreSQL 15, 6 simultaneous applies of this file: 5 failed, mostly SQLSTATE
 * 23505 on `pg_type_typname_nsp_index` and sometimes 42710.
 *
 * TRO-279 closes the race itself with a session-level advisory lock around
 * the whole run (see runMigrations) — a second runner now blocks before it
 * ever calls applySchema, rather than racing it and recovering here. That
 * makes this retry **unreachable in the concurrent case it was added for**:
 * with the lock held, only one process is ever inside applySchema at a time,
 * so there is no other session to race in the catalog. It is left in place
 * deliberately rather than deleted — it is still the correct response to a
 * genuine non-concurrent duplicate-object error (a stray manual `psql`
 * session, a lock bypassed by a future caller), and removing a defensive
 * retry that is merely believed-unreachable is not this ticket's job.
 *
 * Takes a single PoolClient, not a Pool: this function is only ever called
 * from inside runMigrations' locked section, on the same connection that
 * holds the advisory lock. See runMigrations for why that matters.
 */
export async function applySchema(
  client: PoolClient,
  schemaPath: string,
  log: (message: string) => void = console.log
): Promise<void> {
  const schema = readFileSync(schemaPath, 'utf-8');
  try {
    await client.query(schema);
    log('✅ Schema applied');
    return;
  } catch (error) {
    if (!isDuplicateObjectError(error)) {
      throw error;
    }
    log('ℹ️  Duplicate object while applying schema; the batch rolled back — re-applying');
  }

  // Deliberately outside the catch: a second failure propagates.
  await client.query(schema);
  log('✅ Schema applied on the second attempt');
}

/** Creates the schema_migrations bookkeeping table if it does not exist. */
export async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);
}

/**
 * Applies every migration file not yet recorded in schema_migrations.
 * Each file runs in its own transaction, together with the row that records it.
 *
 * Takes the single PoolClient runMigrations already holds the advisory lock
 * on, and runs each migration's transaction directly on it — sequential
 * BEGIN/COMMIT pairs on one connection, rather than checking out a fresh
 * connection per file. That is a change from the pre-TRO-279 shape (which
 * called `pool.connect()` here), made so the entire run — the
 * schema_migrations read included — executes on the exact session that holds
 * the lock, with no dependency on the pool having a second connection free
 * to give out while the first is pinned holding the lock.
 */
export async function runPendingMigrations(
  client: PoolClient,
  migrationsDir: string,
  log: (message: string) => void = console.log
): Promise<MigrationRunResult> {
  // Reading schema_migrations here, on the session that already holds
  // MIGRATION_ADVISORY_LOCK_KEY (acquired by runMigrations before this is
  // called), is the point of TRO-279: a second runner blocked on the same
  // lock cannot reach this query until the first runner's whole run —
  // schema.sql and every migration below — has committed or failed.
  const appliedResult = await client.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version'
  );
  const alreadyApplied = appliedResult.rows.map(r => r.version);
  const alreadyAppliedSet = new Set(alreadyApplied);

  const files = listMigrationFiles(migrationsDir);
  if (files.length === 0) {
    log('ℹ️  No migration files found');
  }

  const applied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (alreadyAppliedSet.has(version)) {
      continue; // Already applied
    }

    log(`  Running migration: ${file}`);
    const migrationSql = readFileSync(join(migrationsDir, file), 'utf-8');

    try {
      await client.query('BEGIN');
      await client.query(migrationSql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      log(`  ✅ ${file} applied`);
      applied.push(version);
    } catch (err) {
      await client.query('ROLLBACK');
      // Name the file in the message. The old handler reported every migration
      // failure as "Database schema already exists", which is why this bug went
      // unnoticed through 32 skipped files.
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration ${file} failed: ${detail}`, { cause: err });
    }
  }

  return { applied, alreadyApplied };
}

/**
 * Full migration sequence: schema.sql, then every pending numbered migration.
 *
 * Errors propagate. The only error tolerated anywhere in this sequence is a
 * duplicate-object error from schema.sql, handled inside applySchema. Anything
 * else reaches the caller, which is what makes `pnpm db:migrate` exit non-zero
 * rather than reporting a success it did not achieve.
 *
 * TRO-279 — CONCURRENCY ARGUMENT
 *
 * The whole sequence above runs under one Postgres session-level advisory
 * lock (`pg_advisory_lock` / `pg_advisory_unlock` on MIGRATION_ADVISORY_LOCK_KEY),
 * held on a single PoolClient checked out for the entire run and threaded
 * through to applySchema/ensureMigrationsTable/runPendingMigrations, rather
 * than left as `pool.query(...)` calls that could each land on a different
 * pooled connection.
 *
 * Why the lock is taken here, before anything else:
 *
 *  - The lock is acquired BEFORE the schema_migrations read inside
 *    runPendingMigrations, and before applySchema runs. Locking after that
 *    read would preserve exactly the race this closes — both runners could
 *    still both see "nothing pending" or both see "schema.sql needs to be
 *    (re)created" and both act on it. The blocking call is the very first
 *    thing this function does after checking out its connection.
 *  - A second `pnpm db:migrate` process, run concurrently, calls
 *    `pg_advisory_lock` on its own connection and blocks at the Postgres
 *    level until the first process calls `pg_advisory_unlock` (or its
 *    session ends). It cannot reach applySchema or the schema_migrations
 *    read until then, so the two runs' critical sections cannot overlap in
 *    time — regardless of how many connections either process's own pool
 *    happens to have free. That is what makes this a closed window rather
 *    than a narrowed one: `CREATE TABLE IF NOT EXISTS`'s check-then-create
 *    gap still exists in Postgres, but only one session is ever inside it.
 *  - By the time the second runner acquires the lock and reads
 *    schema_migrations, the first runner's changes are committed (or the
 *    first runner failed and rolled back cleanly) — so the second runner
 *    always sees an accurate table and finds nothing left to do.
 *
 * What happens if a runner dies while holding the lock: session-level
 * advisory locks are scoped to the backend connection and are released
 * automatically when that session ends, whether it ends cleanly or the
 * process is killed — this is documented Postgres behaviour
 * (https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS),
 * confirmed here by forcing a session to end while holding the lock and
 * observing a second session acquire it immediately after (see
 * `migrationLock.test.ts`). That is the backstop, not the primary mechanism:
 * the explicit `pg_advisory_unlock` below runs in a `finally` on every exit
 * path, including a thrown migration error. A failure of the unlock call
 * itself (as opposed to a failure of the migration work) is handled by
 * force-destroying the connection instead of returning it to the pool —
 * destroying the connection ends the session, which releases the lock even
 * if the explicit unlock command could not be sent.
 */
export async function runMigrations(
  pool: Pool,
  options: MigrationRunOptions
): Promise<MigrationRunResult> {
  const log = options.log ?? console.log;

  log('Running database migrations...');

  const client = await pool.connect();
  let unlockSucceeded = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);

    try {
      await applySchema(client, options.schemaPath, log);
      await ensureMigrationsTable(client);

      const result = await runPendingMigrations(client, options.migrationsDir, log);

      if (result.applied.length === 0) {
        log('✅ All migrations already applied');
      } else {
        log(`✅ ${result.applied.length} migration(s) applied successfully`);
      }
      return result;
    } finally {
      // Released on every exit path, success or failure. Wrapped in its own
      // try/catch so that if the unlock call itself fails, it cannot mask a
      // real error already propagating out of the try block above.
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
        unlockSucceeded = true;
      } catch (unlockError) {
        const detail = unlockError instanceof Error ? unlockError.message : String(unlockError);
        log(`⚠️  Failed to release migration advisory lock explicitly: ${detail}`);
      }
    }
  } finally {
    // If the explicit unlock above didn't run, or ran and failed, force this
    // connection closed instead of returning it to the pool for reuse. A
    // session-level advisory lock is released when its session ends, so
    // destroying the connection is the backstop that keeps the lock from
    // outliving this run even when the explicit unlock command itself could
    // not be sent (e.g. the connection dropped mid-run).
    client.release(!unlockSucceeded);
  }
}
