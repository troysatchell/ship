/**
 * PF-601's own AC, end to end against a REAL running Ship API — same
 * "subprocess, not an import" posture `login.liveServer.test.ts` documents
 * for itself (this file's own header has the full rationale: `integrations/
 * cli` may depend on `@ship/sdk` and nothing else, never `api/src`, in
 * source OR in tests, PLUGFORGE.MD §2.1/PF-003). A SEPARATE file rather than
 * an addition to `login.liveServer.test.ts`: that file's own scope is
 * `ship login`/`ship whoami` specifically (its `describe` block says so
 * verbatim), and it already carries real complexity (RFC 8628 device-flow
 * polling against wall-clock time). Bolting a third, unrelated proof onto it
 * would widen what one file is responsible for proving; a second live-server
 * file, spawning its own child `api/` process, keeps each file's scope equal
 * to one ticket's AC.
 *
 * Proves the `create` -> `get` round trip specifically (this ticket's own
 * instruction): `ship docs create --title <title>` against the real server,
 * then `ship docs get <id>` with the id it printed, confirming the two
 * commands agree about the same real document — not just that each one
 * individually parses a mocked response shape (`docs.test.ts` already proves
 * that). `ship docs ls` is exercised here too (finding the just-created
 * document in a real listing), the same "prove it end-to-end, not just unit
 * by unit" bar `login.liveServer.test.ts` sets for `login`/`whoami`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { FileTokenStore } from '@ship/sdk/node';
import { runDocsCreate, runDocsGet, runDocsLs } from '../commands/docs.js';
import { createCapturingIo } from '../io.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// src/__tests__ -> src -> cli -> integrations -> repo root.
const REPO_ROOT = resolve(__dirname, '../../../..');

function requireRow<T>(row: T | undefined, label: string): T {
  if (row === undefined) throw new Error(`INSERT ... RETURNING id for ${label} returned no row`);
  return row;
}

/** Asks the OS for an unused ephemeral port — same technique
 *  `login.liveServer.test.ts` uses (see that file's own comment for why this
 *  package inlines it rather than depending on the `get-port` package). */
function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        srv.close(() => resolvePort(port));
      } else {
        srv.close(() => reject(new Error('failed to acquire a free port')));
      }
    });
  });
}

/** Resolves once the child's stdout has printed `index.ts`'s own readiness
 *  line — an observable event, not a fixed sleep (lessons.md rule 17). Same
 *  buffering-across-chunks and 'close'-not-'exit' handling as
 *  `login.liveServer.test.ts`'s own `waitForReady` — duplicated rather than
 *  imported (that file exports nothing; this test earns its own copy the
 *  same way it earns its own child process). */
function waitForReady(child: ChildProcessByStdio<null, Readable, Readable>, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`api server did not report ready within ${timeoutMs}ms`));
    }, timeoutMs);

    let buffered = '';
    const onData = (chunk: Buffer) => {
      if (settled) return;
      buffered += chunk.toString('utf8');
      if (buffered.includes('API server running on')) {
        settled = true;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolvePromise();
      }
    };
    child.stdout.on('data', onData);

    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`api server exited early with code ${exitCode} before reporting ready`));
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Spawns the real `api/` package bound to a fresh ephemeral port, retrying
 *  with a NEW port on the TOCTOU EADDRINUSE race `login.liveServer.test.ts`'s
 *  own `spawnApiChild` documents. */
async function spawnApiChild(
  databaseUrl: string,
  onStderr: (chunk: Buffer) => void
): Promise<{ child: ChildProcessByStdio<null, Readable, Readable>; port: number }> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const port = await getFreePort();
    const attemptStderr: Buffer[] = [];
    const child = spawn('pnpm', ['--filter', '@ship/api', 'exec', 'tsx', 'src/index.ts'], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        PORT: String(port),
        DATABASE_URL: databaseUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk: Buffer) => {
      attemptStderr.push(chunk);
      onStderr(chunk);
    });

    try {
      await waitForReady(child, 30_000);
      return { child, port };
    } catch (err) {
      if (child.exitCode === null) {
        await new Promise<void>((resolveKill) => {
          child.once('exit', () => resolveKill());
          child.kill('SIGTERM');
        });
      }
      const isPortRace = Buffer.concat(attemptStderr).toString('utf8').includes('EADDRINUSE');
      if (!isPortRace || attempt === MAX_ATTEMPTS) throw err;
    }
  }
  /* istanbul ignore next -- unreachable: the loop above always returns or throws */
  throw new Error('spawnApiChild: exhausted retries without returning or throwing');
}

describe('PF-601: ship docs ls|get|create end-to-end against a real running Ship API', () => {
  const databaseUrl = process.env.DATABASE_URL;

  let pool: pg.Pool | undefined;
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let credentialsDir: string;
  let credentialsPath: string;
  let baseUrl: string;
  let workspaceId: string | undefined;
  let userId: string | undefined;
  let tokenId: string | undefined;

  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const childStderrChunks: Buffer[] = [];

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL must be set to run this live-server test — source .factory-env in this worktree first.'
      );
    }
    pool = new pg.Pool({ connectionString: databaseUrl });

    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-601 CLI live-server test ${runId}`]
    );
    workspaceId = requireRow(workspaceResult.rows[0], 'workspace insert').id;

    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'CLI Docs Live Server Test User') RETURNING id`,
      [`pf601-cli-${runId}@ship.local`]
    );
    userId = requireRow(userResult.rows[0], 'user insert').id;

    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [
      workspaceId,
      userId,
    ]);

    // `resolvePrincipalWorkspaceId` (`platform/api/v1/resources/
    // workspaceContext.ts`) resolves a PERSONAL-token principal's workspace
    // from `users.last_workspace_id`, not from `api_tokens.workspace_id` —
    // that module's own header explains why (`api_tokens.workspace_id` isn't
    // visible from `Principal` at all today). Every `documents` route this
    // ticket's commands call would otherwise 404 with "No workspace is
    // associated with this credential." for a user who has never set this.
    await pool.query(`UPDATE users SET last_workspace_id = $1 WHERE id = $2`, [workspaceId, userId]);

    // A personal access token, not a device-flow session — `docs.ts`'s
    // `loadClient()` only needs *some* valid token in `FileTokenStore`;
    // manufacturing one directly here (rather than driving a full device-flow
    // login like `login.liveServer.test.ts` does) keeps this file's own
    // fixture setup scoped to what PF-601 itself needs to prove, not
    // re-proving PF-600's login flow. `documents:read` + `documents:write`
    // (both scopes this ticket's three commands actually call) — verified
    // against `bearerAuth.ts`/`requireScope.ts`'s real token-lookup query
    // before writing this insert, not guessed at. `token_prefix` is
    // `NOT NULL` (`schema.sql:260`) — the first 8 characters of the raw
    // token, same convention `routes/api-tokens.ts` uses when it mints one.
    const rawToken = `ship_at_test_${runId}`;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const tokenResult = await pool.query<{ id: string }>(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
       VALUES ($1, $2, 'PF-601 CLI Live Server Test Token', $3, $4, $5) RETURNING id`,
      [userId, workspaceId, tokenHash, rawToken.slice(0, 8), ['documents:read', 'documents:write']]
    );
    tokenId = requireRow(tokenResult.rows[0], 'api token insert').id;

    const started = await spawnApiChild(databaseUrl, (chunk) => childStderrChunks.push(chunk));
    child = started.child;
    baseUrl = `http://127.0.0.1:${started.port}`;

    credentialsDir = await mkdtemp(join(tmpdir(), 'ship-cli-docs-liveserver-test-'));
    credentialsPath = join(credentialsDir, 'credentials.json');
    await new FileTokenStore(credentialsPath).set({ accessToken: rawToken });
  }, 45_000);

  afterAll(async () => {
    try {
      if (child && child.exitCode === null) {
        const exited = new Promise<void>((resolvePromise) => child?.once('exit', () => resolvePromise()));
        child.kill('SIGTERM');
        await exited;
      }
    } finally {
      try {
        if (pool && tokenId) {
          await pool.query('DELETE FROM api_tokens WHERE id = $1', [tokenId]);
        }
        if (pool && workspaceId) {
          await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId]);
        }
        if (pool && userId) {
          await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [userId]);
          await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        }
        if (pool && workspaceId) {
          await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
        }
      } finally {
        await pool?.end();
        if (credentialsDir) await rm(credentialsDir, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it(
    'ship docs create prints the new document, ship docs get finds it by id, and ship docs ls lists it',
    async () => {
      const title = `PF-601 live-server doc ${runId}`;

      const createIo = createCapturingIo();
      const createCode = await runDocsCreate({ io: createIo, env: {}, baseUrl, credentialsPath, title });
      expect(createCode, `stderr: ${createIo.stderrLines.join('\n')}`).toBe(0);
      expect(createIo.stdoutLines[0]).toBe('Created document.');

      const detail = createIo.stdoutLines[1];
      if (detail === undefined) {
        throw new Error('runDocsCreate printed no document detail line');
      }
      const idLine = detail.split('\n').find((line) => line.startsWith('id: '));
      if (idLine === undefined) {
        throw new Error(`runDocsCreate's detail output had no "id:" line: ${detail}`);
      }
      const createdId = idLine.slice('id: '.length);
      expect(detail).toContain(`title: ${title}`);
      expect(detail).toContain('document_type: wiki');

      const getIo = createCapturingIo();
      const getCode = await runDocsGet({ io: getIo, env: {}, baseUrl, credentialsPath, id: createdId });
      expect(getCode, `stderr: ${getIo.stderrLines.join('\n')}`).toBe(0);
      expect(getIo.stdoutLines).toHaveLength(1);
      const getDetail = getIo.stdoutLines[0];
      if (getDetail === undefined) {
        throw new Error('runDocsGet printed no document detail line');
      }
      expect(getDetail).toContain(`id: ${createdId}`);
      expect(getDetail).toContain(`title: ${title}`);

      const lsIo = createCapturingIo();
      const lsCode = await runDocsLs({ io: lsIo, env: {}, baseUrl, credentialsPath });
      expect(lsCode, `stderr: ${lsIo.stderrLines.join('\n')}`).toBe(0);
      expect(lsIo.stdoutLines.some((line) => line.startsWith(`${createdId}\t`))).toBe(true);
    },
    30_000
  );

  it('ship docs get on a nonexistent id renders a rendered ApiError and exits non-zero', async () => {
    const io = createCapturingIo();
    const code = await runDocsGet({
      io,
      env: {},
      baseUrl,
      credentialsPath,
      id: '00000000-0000-0000-0000-000000000000',
    });

    expect(code).toBe(1);
    expect(io.stderrLines).toHaveLength(1);
    expect(io.stderrLines[0]).toMatch(/^Error \[not_found\]:/);
  });
});
