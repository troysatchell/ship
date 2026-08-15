/**
 * `FileTokenStore` (PF-404, PLUGFORGE.MD §2.8) — split out of `tokenStore.ts`
 * by TRO-449/PF-802 into its own file, purely so its Node-only (`fs`/`path`)
 * imports never appear in the same module as `MemoryTokenStore`/
 * `ITokenStore`/`TokenSet`. See `tokenStore.ts`'s own header comment and
 * this repo's `CHANGES.md` (TRO-449) for why that split is required, not
 * cosmetic: a bundler resolving `@ship/sdk`'s main barrel has to bind every
 * top-level import of every re-exported file reachable from it, regardless
 * of tree-shaking — so `fs`/`path` living in the SAME file as
 * `MemoryTokenStore` would break any browser consumer of the barrel even if
 * `FileTokenStore` itself is never imported by name.
 *
 * `~/.ship/credentials.json` (PF-600's `ship login`) is this class's one
 * named consumer — deliberately Node-only, never imported by
 * `integrations/browser-demo` (PF-802), which uses `localStorage` directly.
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { ITokenStore, TokenSet } from './tokenStore.js';

function isTokenSet(value: unknown): value is TokenSet {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.accessToken !== 'string') return false;
  if (record.refreshToken !== undefined && typeof record.refreshToken !== 'string') return false;
  if (record.expiresAt !== undefined && typeof record.expiresAt !== 'number') return false;
  if (record.scope !== undefined && typeof record.scope !== 'string') return false;
  return true;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Persists a `TokenSet` as JSON at `filePath`, with **0600 permissions
 * enforced on every write** — a real security requirement (this ticket's
 * own instruction: "verify the mode bits in a test, not decorative"), not a
 * default left to the OS. `~/.ship/credentials.json` (PF-600) holds a live
 * refresh token; anyone else on the machine reading it can impersonate the
 * logged-in user until the refresh token is rotated or revoked.
 *
 * ── Why `chmod` runs after every `writeFile`, not just on first creation ──
 *
 * `fs.writeFile(path, data, { mode })`'s `mode` option is only applied when
 * Node's underlying `open()` call actually CREATES the file (verified
 * against Node's own `fs` docs before relying on it, not assumed) — if
 * `filePath` already exists (the common case: every `set()` after the
 * first), `writeFile` opens it with the `'w'` flag, which truncates content
 * but leaves the existing permission bits untouched. A file that started at
 * a looser mode (created by another process, a different umask, or copied in
 * some other way) would silently keep those looser bits forever if this
 * store only relied on `writeFile`'s `mode` option. An explicit
 * `fs.chmod(filePath, 0o600)` after every write closes that gap
 * unconditionally — see `tokenStore.test.ts`'s
 * "corrects an existing file's permissions, not just a freshly-created one"
 * case, which fails without this line.
 */
export class FileTokenStore implements ITokenStore {
  constructor(private readonly filePath: string) {}

  async get(): Promise<TokenSet | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return null;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      // A corrupted store is NOT the same as "no token yet" — silently
      // returning `null` here would make a caller re-run a full login flow
      // when the real problem is a truncated write or disk corruption, and
      // would silently discard whatever partial content is actually on
      // disk. Loud failure, per `tokenStore.ts`'s own `ITokenStore` doc
      // comment.
      throw new Error(
        `FileTokenStore: ${this.filePath} contains invalid JSON and cannot be read as a token store.`,
        { cause }
      );
    }

    if (!isTokenSet(parsed)) {
      throw new Error(`FileTokenStore: ${this.filePath} does not contain a valid token set.`);
    }
    return parsed;
  }

  async set(tokens: TokenSet): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const data = JSON.stringify(tokens, null, 2);
    await fs.writeFile(this.filePath, data, { mode: 0o600 });
    // See this class's own doc comment: `writeFile`'s `mode` option only
    // takes effect on file CREATION, so an explicit `chmod` is required to
    // guarantee 0600 on every write, including one that truncates an
    // existing, more-permissively-moded file.
    await fs.chmod(this.filePath, 0o600);
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return;
      throw error;
    }
  }
}
