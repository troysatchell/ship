/**
 * TRO-240 / DB-11 — the database SSL decision must be made in exactly one place.
 *
 * The defect was drift, not a wrong value. `migrate.ts` and `seed.ts` each
 * carried their own copy of `NODE_ENV === 'production' ? {...} : false`, and
 * `client.ts` — the pool the whole application runs on — carried no `ssl` key at
 * all, so pg fell back to `defaults.ssl = false` and connected in plaintext.
 *
 * So this file tests three things, and it needs all three:
 *
 *   1. the decision itself, per NODE_ENV;
 *   2. that the application pool actually applies it (the original bug);
 *   3. that no pool under `api/src/db/` re-derives the rule (the drift).
 *
 * (3) is the one that stops recurrence. A future file that adds `new Pool(...)`
 * without the shared helper fails this test rather than quietly reintroducing
 * a fourth policy.
 *
 * WHAT THIS FILE CANNOT PROVE: that TLS actually negotiates against a managed
 * Postgres that requires it. That needs a real TLS-terminating endpoint, which
 * no test in this repo has. These assertions cover the decision logic and its
 * propagation to every call site — everything up to the socket.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveDatabaseSsl, type DatabaseSslConfig } from '../ssl.js';

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('resolveDatabaseSsl — the decision', () => {
  it('encrypts without chain verification in production', () => {
    // Carried over verbatim from migrate.ts/seed.ts. Managed Postgres providers
    // sign with their own CA, absent from Node's trust store.
    expect(resolveDatabaseSsl('production')).toEqual({ rejectUnauthorized: false });
  });

  it('disables TLS outside production', () => {
    // Local Postgres and the CI container speak plaintext and will refuse a
    // TLS handshake, so this must be `false`, not merely "unset".
    expect(resolveDatabaseSsl('development')).toBe(false);
    expect(resolveDatabaseSsl('test')).toBe(false);
    expect(resolveDatabaseSsl('staging')).toBe(false);
  });

  it('disables TLS when NODE_ENV is unset', () => {
    expect(resolveDatabaseSsl(undefined)).toBe(false);
  });

  it('matches "production" exactly and is not fooled by near-misses', () => {
    // Guards the failure mode where a deploy sets NODE_ENV=Production and the
    // pool silently drops to plaintext. Documents current behaviour: exact match.
    expect(resolveDatabaseSsl('Production')).toBe(false);
    expect(resolveDatabaseSsl('production ')).toBe(false);
    expect(resolveDatabaseSsl('productionx')).toBe(false);
  });

  it('reads process.env.NODE_ENV when called with no argument', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(resolveDatabaseSsl()).toEqual({ rejectUnauthorized: false });
    vi.stubEnv('NODE_ENV', 'development');
    expect(resolveDatabaseSsl()).toBe(false);
  });

  it('returns a fresh object each call so pools cannot share a mutable config', () => {
    const a = resolveDatabaseSsl('production');
    const b = resolveDatabaseSsl('production');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });
});

describe('the application pool applies the decision', () => {
  /**
   * Re-import `client.ts` under a chosen NODE_ENV and report the `ssl` option it
   * handed to pg. `client.ts` builds its pool at module scope, so the env has to
   * be stubbed before the import and the module registry reset between them.
   *
   * Constructing a pg Pool opens no socket — connection is lazy — so this never
   * touches a database.
   */
  async function poolSslUnder(nodeEnv: string): Promise<DatabaseSslConfig> {
    vi.stubEnv('NODE_ENV', nodeEnv);
    vi.resetModules();
    const mod = await import('../client.js');
    const ssl = mod.pool.options.ssl;
    await mod.pool.end();
    return ssl;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('configures TLS in production (the DB-11 bug: it configured nothing)', async () => {
    await expect(poolSslUnder('production')).resolves.toEqual(resolveDatabaseSsl('production'));
  });

  it('configures no TLS outside production', async () => {
    await expect(poolSslUnder('development')).resolves.toBe(resolveDatabaseSsl('development'));
  });

  it('survives pg config resolution instead of being overridden by the URL', async () => {
    // pg's ConnectionParameters does
    //   config = Object.assign({}, config, parse(config.connectionString))
    // then
    //   this.ssl = typeof config.ssl === 'undefined' ? <env/defaults> : config.ssl
    // so an explicit `ssl` only survives because `parse()` omits the key entirely
    // when the URL has no `sslmode`. If that ever changes, the fix becomes a
    // silent no-op — hence a test on the resolved value, not the passed one.
    const url = 'postgresql://u:p@db.example.com:5432/ship';
    const client = new pg.Client({ connectionString: url, ssl: resolveDatabaseSsl('production') });
    // `connectionParameters` is real and stable on pg's Client but absent from
    // @types/pg. Reflect.get returns `any`, so this reads the property without a
    // type assertion (`as any` / `as unknown as` are both banned here, rightly).
    const params: { ssl?: unknown } = Reflect.get(client, 'connectionParameters');
    expect(params.ssl, 'explicit ssl option must survive pg config resolution').toEqual({
      rejectUnauthorized: false,
    });
  });
});

describe('no pool under api/src/db re-derives the SSL rule', () => {
  /** Every non-test `.ts` file under `api/src/db`, recursively. */
  function dbSourceFiles(dir: string = DB_DIR): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'migrations') continue;
        found.push(...dbSourceFiles(full));
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        found.push(full);
      }
    }
    return found;
  }

  const files = dbSourceFiles().map((path) => ({
    path,
    rel: relative(DB_DIR, path),
    source: readFileSync(path, 'utf-8'),
  }));

  const poolSites = files.filter((f) => f.source.includes('new Pool('));

  it('finds the pool sites it is supposed to police', () => {
    // Without this, a broken walk turns the assertions below into silent passes.
    expect(files.length, 'expected to walk some api/src/db sources').toBeGreaterThan(3);
    expect(
      poolSites.map((f) => f.rel).sort(),
      'pool sites known at the time of TRO-240 — add new ones deliberately'
    ).toEqual(['client.ts', 'migrate.ts', 'scripts/orphan-diagnostic.ts', 'seed.ts']);
  });

  // Looked up rather than passed as an `it.each` parameter: whole source files as
  // test parameters get echoed into the failure header, which buries the reason.
  const sourceByRel = new Map(poolSites.map((f) => [f.rel, f.source]));

  it.each(poolSites.map((f) => f.rel))(
    '%s takes its ssl option from the shared helper',
    (rel) => {
      const source = sourceByRel.get(rel) ?? '';
      expect(source, `${rel} must import resolveDatabaseSsl`).toMatch(
        /import\s+\{[^}]*resolveDatabaseSsl[^}]*\}\s+from\s+'[./]*ssl\.js'/
      );
      expect(source, `${rel} must set ssl from the helper`).toMatch(
        /ssl:\s*resolveDatabaseSsl\(\)/
      );
    }
  );

  it('leaves no hand-rolled ssl value anywhere under api/src/db', () => {
    // Read the token following every `ssl:` and compare it, rather than using a
    // negative lookahead — `ssl:\s*(?!helper)` matches even the correct code,
    // because `\s*` can consume nothing and then the lookahead sees a space.
    const offenders = files
      .flatMap((f) =>
        [...f.source.matchAll(/ssl:\s*([^\s,]+)/g)].map((m) => ({ rel: f.rel, value: m[1] }))
      )
      .filter((hit) => hit.value !== 'resolveDatabaseSsl()')
      .map((hit) => `${hit.rel}: ssl: ${hit.value}`);
    expect(offenders, 'ssl must only ever be set via resolveDatabaseSsl()').toEqual([]);
  });
});
