/**
 * `ITokenStore` (PF-404, PLUGFORGE.MD §2.8: "`ITokenStore` (get/set/clear
 * tokens, including refresh) with `MemoryTokenStore` and `FileTokenStore`;
 * browser demo uses localStorage.").
 *
 * `TokenSet` is this package's own persisted shape — deliberately NOT the
 * wire shape `/oauth/token` returns (`access_token`/`refresh_token`/
 * `expires_in`/`scope`, snake_case, `expires_in` a relative seconds count).
 * A relative `expires_in` becomes meaningless the moment it is written to
 * disk and read back later — the whole point of persisting a token set is to
 * survive a process restart, at which point "3600 seconds from when this was
 * written" needs an absolute instant, not a duration. `client.ts`'s
 * `TokenSetFromGrant` helper (private to that file) is the one place that
 * converts a raw `/oauth/token` response into this shape, computing
 * `expiresAt` from `Date.now() + expires_in * 1000` at receipt time.
 */

/** A persisted OAuth token set — what an `ITokenStore` implementation reads
 * and writes as one unit. `refreshToken` is optional because Client
 * Credentials grants never issue one (`oauth-token.ts`'s `sendTokenResult`
 * omits the field entirely in that case — see `token.ts`'s own comment on
 * `issueClientCredentialsToken`). `expiresAt` is an absolute epoch-ms
 * instant, optional for the same reason (a caller that already knows
 * verification is cheap, e.g. relying on refresh-on-401 alone, need not
 * track it). */
export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Absolute epoch-ms expiry of `accessToken`, if known. */
  readonly expiresAt?: number;
  /** Space-delimited scope string, mirroring the wire format's `scope`
   * field, kept verbatim rather than split into an array — this package
   * never needs to reason about individual scopes, only to round-trip and
   * display them. */
  readonly scope?: string;
}

/** PLUGFORGE.MD §2.8, verbatim: "get/set/clear tokens, including refresh".
 * `get()` returns `null` (never throws) when no token set has ever been
 * stored — "no token yet" is an expected, ordinary state for a fresh CLI
 * install or a fresh browser session, not an error. A store whose persisted
 * data exists but is unreadable/corrupt (e.g. `FileTokenStore` finding
 * invalid JSON on disk) DOES throw — see that class's own doc comment for
 * why silently returning `null` there would be worse than a loud failure. */
export interface ITokenStore {
  get(): Promise<TokenSet | null>;
  set(tokens: TokenSet): Promise<void>;
  clear(): Promise<void>;
}

function isTokenSet(value: unknown): value is TokenSet {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.accessToken !== 'string') return false;
  if (record.refreshToken !== undefined && typeof record.refreshToken !== 'string') return false;
  if (record.expiresAt !== undefined && typeof record.expiresAt !== 'number') return false;
  if (record.scope !== undefined && typeof record.scope !== 'string') return false;
  return true;
}

/** In-process only — cleared on exit, never touches disk. The trivial
 * implementation: an agent/test process that constructs a `ShipClient` per
 * call (PF-703's own documented shape) can still share one `MemoryTokenStore`
 * instance across those constructions to get single-flight-refresh benefits
 * without any I/O. */
export class MemoryTokenStore implements ITokenStore {
  private tokens: TokenSet | null = null;

  get(): Promise<TokenSet | null> {
    return Promise.resolve(this.tokens);
  }

  set(tokens: TokenSet): Promise<void> {
    this.tokens = tokens;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.tokens = null;
    return Promise.resolve();
  }
}

// `fs`/`path` are Node built-ins, not a third-party package — this file adds
// nothing to `sdk/package.json`'s `dependencies` (still `{}`). `FileTokenStore`
// is deliberately Node-only (PF-600's `ship login` / `~/.ship/credentials.json`
// is its one named consumer); the browser demo (PF-802) uses `localStorage`
// directly rather than a third `ITokenStore` implementation this package
// would have to ship for an environment with no filesystem.
import { promises as fs } from 'fs';
import path from 'path';

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
      // disk. Loud failure, per this file's own `ITokenStore` doc comment.
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
