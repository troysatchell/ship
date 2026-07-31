import pg from 'pg';
import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveDatabaseSsl } from './ssl.js';
import { resolvePoolTiming } from './poolConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables before creating pool
config({ path: join(__dirname, '../../.env.local') });
config({ path: join(__dirname, '../../.env') });

const { Pool } = pg;

// Connection timeout and pool size are operator-tunable via env (TRO-248 /
// RULE-7) — see poolConfig.ts for the failure mode this protects against and
// why statement_timeout is deliberately not part of it. Defaults match the
// previous hardcoded values, so behaviour is unchanged unless overridden.
const { connectionTimeoutMillis, max: poolMax } = resolvePoolTiming(process.env);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // TLS decision shared with migrate.ts and seed.ts — see ./ssl.ts. Omitting this
  // is what made the app pool connect in plaintext while those two scripts, which
  // run either side of it, negotiated TLS (DB-11 / TRO-240).
  ssl: resolveDatabaseSsl(),
  // Production-ready pool configuration
  max: poolMax, // DB_POOL_MAX (production) / DB_POOL_MAX_DEV (else); default 20/10
  idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
  connectionTimeoutMillis, // DB_POOL_CONNECTION_TIMEOUT_MS; default 2000ms — fail fast if can't connect
  maxUses: 7500, // Recycle connections after 7500 queries to prevent memory leaks
  // DDoS protection: Terminate queries running longer than 30 seconds. Not
  // env-configurable by design — see poolConfig.ts's file header.
  statement_timeout: 30000, // 30 seconds max query duration
});

// Graceful shutdown - close pool connections on process termination
//
// These listeners must be plain (non-async) functions: `process.on()` does not
// await its listener's return value, so an `async` listener whose promise
// rejects becomes an unhandled rejection during shutdown — previously true
// here if `pool.end()` ever failed (e.g. already-dead connections), which
// would have surfaced as a raw unhandled-rejection stack trace instead of the
// clean, logged exit this is supposed to be. `.then`/`.catch` route both
// outcomes through an explicit exit code instead.
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing database pool...');
  pool
    .end()
    .then(() => {
      console.log('Database pool closed');
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error('Error closing database pool on SIGTERM:', error);
      process.exit(1);
    });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing database pool...');
  pool
    .end()
    .then(() => {
      console.log('Database pool closed');
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error('Error closing database pool on SIGINT:', error);
      process.exit(1);
    });
});

export { pool };
