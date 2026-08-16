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
import { randomBytes } from 'crypto';
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
 *
 * ── Why `set()` writes to a temp file and `rename()`s, rather than writing
 * `filePath` directly (TRO-600) ──
 *
 * `fs.writeFile(filePath, data)` is not atomic: it truncates the existing
 * file and streams the new content in over the top of it. A crash or power
 * loss between the truncate and the last byte leaves `filePath` holding a
 * truncated/corrupt fragment on disk permanently — `get()`'s "invalid JSON"
 * throw above exists precisely because that state is reachable, not
 * hypothetical. A concurrent `get()` from another process racing that same
 * write can also observe the partial content mid-write, with no error at
 * all — worse than the crash case, because the reader has no signal
 * anything went wrong.
 *
 * `set()` instead serializes to a uniquely-named temp file **in the same
 * directory** as `filePath` (same directory, and therefore guaranteed same
 * filesystem/mount — POSIX `rename(2)`'s atomicity guarantee only holds
 * within one filesystem; a temp dir elsewhere could cross a mount boundary
 * and silently fall back to a non-atomic copy+delete), then `fs.rename()`s
 * it over `filePath`. `rename(2)` atomically replaces the destination: any
 * reader opening `filePath` at any point either gets the complete prior
 * file or the complete new one, never a torn/partial read — this is an
 * ATOMICITY guarantee (what this ticket asks for), not a durability one.
 * It fully covers an ordinary process crash: crash before the rename call
 * leaves `filePath` untouched (still the old content); crash after `rename`
 * returns means the new content was already visible at `filePath` before
 * the crash. What it does NOT independently guarantee is survival of a true
 * OS-level crash or power loss between the `writeFile` above and the
 * `rename` below — POSIX only promises that against unflushed writes if the
 * temp file (and, separately, the containing directory's entry) is
 * `fsync`ed first, which this implementation deliberately does not do
 * (out of this ticket's scope; flagged by CodeRabbit review and corrected
 * here rather than left overclaimed — ext4/APFS/NTFS's own journaling makes
 * losing a just-written few-hundred-byte file across power loss unlikely in
 * practice, but that is a filesystem implementation detail, not something
 * this code guarantees). `rename()` also carries the source file's own mode
 * bits onto the destination (it relinks the same inode; it does not create
 * a new one via the destination's prior permissions), so writing the temp
 * file at 0600 up front — and belt-and-suspenders `chmod`ing it, same
 * umask hazard as the doc comment above — keeps the existing "always 0600,
 * even overwriting a looser-permissioned file" guarantee without needing a
 * second `chmod` on `filePath` after the rename.
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
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const data = JSON.stringify(tokens, null, 2);
    // Unique name, same directory as `filePath` — see this class's own doc
    // comment for why "same directory" is load-bearing (same filesystem,
    // required for `rename()` below to be atomic) and why a random suffix
    // is used rather than a fixed `.tmp` name (a fixed name would let two
    // concurrent `set()` calls on the same store collide mid-write).
    const tempPath = path.join(
      dir,
      `.${path.basename(this.filePath)}.${randomBytes(8).toString('hex')}.tmp`
    );
    try {
      // `mode` DOES take effect here, unlike the direct-write it replaces:
      // `tempPath` is always freshly created (unique name), so Node's
      // `open()` call is always the CREATE case the `mode` option applies
      // to (see this class's doc comment on `writeFile`'s `mode` caveat).
      await fs.writeFile(tempPath, data, { mode: 0o600 });
      // Belt-and-suspenders against the same umask hazard the doc comment
      // above describes for the non-atomic path — cheap, and removes any
      // doubt before this content becomes visible at `filePath`.
      await fs.chmod(tempPath, 0o600);
      // Atomic on the same filesystem (POSIX `rename(2)`): any reader of
      // `filePath`, including a concurrent `get()` in another process, and
      // any ordinary process crash on either side of this call, always
      // observes either the complete prior file or the complete new one —
      // never a torn/partial read. See this class's own doc comment for the
      // narrower claim this is (atomicity, not full power-loss durability —
      // no `fsync` here, deliberately out of scope).
      await fs.rename(tempPath, this.filePath);
    } catch (error) {
      // Best-effort cleanup: don't leave an orphaned `.tmp` file behind in
      // the credentials directory if the write or rename failed partway.
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    }
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
