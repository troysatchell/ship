import { beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { pool } from '../db/client.js'

// Test setup for API integration tests
// This runs before all tests in each test file

// TRO-277 / TEST-12 — why this file takes a database-wide lock.
//
// The TRUNCATE below runs in the beforeAll of EVERY api test file, and every
// file then creates its own workspace/user fixtures and depends on them for the
// rest of the file. That is safe as long as exactly one process is running the
// suite: `fileParallelism: false` keeps files sequential within a run.
//
// It is NOT safe across processes. Two api suites pointed at the same
// DATABASE_URL destroy each other: process B's TRUNCATE deletes the fixtures
// process A is mid-file on, and A then fails somewhere unrelated to whatever it
// was actually testing. Observed failure shapes (2026-07-29, reproduced by
// running two suites against one database):
//   - `expected 401 to be 200`      — the session row was truncated away
//   - `violates foreign key constraint "documents_workspace_id_fkey"` in a
//     nested describe's beforeAll
//   - and, because a failing beforeAll makes vitest report that describe's tests
//     as SKIPPED rather than failed, phantom skip counts (11 and 33 skipped in
//     the two-suite run) with no `.skip` marker anywhere in the codebase.
//
// A session-level Postgres advisory lock, held for the duration of each test
// file, makes concurrent suites serialize at file granularity instead of
// corrupting each other. Advisory lock spaces are per-database, so worktrees
// with their own database never contend. The lock is released on disconnect, so
// a crashed run cannot wedge the next one.
const LOCK_NAMESPACE = 0x53484950 // 'SHIP'
const LOCK_ID = 0x54455354 // 'TEST'

// A whole test file may hold the lock, and the slowest file in this suite runs
// ~15s, so a waiting process needs to tolerate more than one file's duration.
//
// Validated rather than a bare Number(...): an invalid or empty override (e.g.
// API_TEST_LOCK_TIMEOUT_MS="" or "abc") would otherwise produce NaN or 0. NaN
// makes every `Date.now() >= deadline` check below false forever — the "hard
// deadline" this lock depends on silently stops existing and a stuck process
// hangs instead of throwing the diagnosable error below. 0 does the opposite:
// the deadline is already past, so the very first non-acquisition throws
// immediately. Falling back to the default keeps the deadline finite either way.
const DEFAULT_LOCK_TIMEOUT_MS = 120_000
const parsedLockTimeoutMs = Number(process.env.API_TEST_LOCK_TIMEOUT_MS)
const LOCK_TIMEOUT_MS =
  Number.isFinite(parsedLockTimeoutMs) && parsedLockTimeoutMs > 0
    ? parsedLockTimeoutMs
    : DEFAULT_LOCK_TIMEOUT_MS
const LOCK_POLL_MS = 50

let lockClient: pg.Client | null = null

beforeAll(async () => {
  // Ensure test environment
  process.env.NODE_ENV = 'test'

  // Serialize against any other api suite using this same database.
  // Deliberately a dedicated client, not `pool`: advisory locks are scoped to a
  // session, and pooled connections are handed back between queries.
  lockClient = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await lockClient.connect()

  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    const { rows } = await lockClient.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [LOCK_NAMESPACE, LOCK_ID]
    )
    if (rows[0].acquired) break

    if (Date.now() >= deadline) {
      const target = process.env.DATABASE_URL ?? '(DATABASE_URL unset)'
      await lockClient.end()
      lockClient = null
      throw new Error(
        `api test setup: could not acquire the suite lock on ${target} within ` +
          `${LOCK_TIMEOUT_MS}ms.\n` +
          'Another api test process is using this database. These tests TRUNCATE 16 ' +
          'tables on start, so they cannot share one database — run them one at a ' +
          'time, or give this process its own database (source .factory-env).'
      )
    }
    // Poll for release rather than assuming a duration. Not a synchronization
    // sleep: the loop re-checks the real lock state and has a hard deadline.
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
  }

  // Clean up test data from previous runs to prevent duplicate key errors
  // Use TRUNCATE CASCADE which is faster and bypasses row-level triggers
  // (audit_logs has AU-9 compliance triggers preventing DELETE)
  // public_api_audit (migration 049, PF-501/TRO-432) is listed explicitly,
  // not left to CASCADE: it deliberately carries no foreign keys at all
  // (see that migration's header — an audit trail must outlive the
  // app/user it describes), so TRUNCATE ... CASCADE on workspaces/users
  // never reaches it the way it reaches oauth_apps/api_tokens/
  // webhook_subscriptions/etc. Without this it would accumulate rows
  // across every file in a single `pnpm test` run instead of resetting
  // per-file like everything else this hook clears.
  await pool.query(`TRUNCATE TABLE
    workspace_invites, sessions, files, document_links, document_history,
    comments, document_associations, document_snapshots, sprint_iterations,
    issue_iterations, documents, audit_logs, workspace_memberships,
    public_api_audit, users, workspaces
    CASCADE`)
  // vitest's default hook timeout is 10s, which is shorter than the longest file
  // in this suite can hold the lock (~15s). Without this the waiting process
  // fails its hook — and a failing beforeAll reports the whole file as *skipped*,
  // which is the phantom-skip symptom this ticket exists to remove.
}, LOCK_TIMEOUT_MS + 15_000)

afterAll(async () => {
  // Release the suite lock so a waiting process can proceed. Closing the client
  // would release it anyway; unlocking first keeps the intent explicit.
  if (lockClient) {
    try {
      await lockClient.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, LOCK_ID])
    } finally {
      await lockClient.end()
      lockClient = null
    }
  }
  // Close pool only at the very end - vitest handles this via globalTeardown
})
