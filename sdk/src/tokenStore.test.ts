/**
 * `ITokenStore` implementations (PF-404). `MemoryTokenStore` is a trivial
 * round-trip; `FileTokenStore`'s suite is where the real work is — this
 * ticket's own instruction: "0600 permissions — this is a real security
 * requirement, not decorative; verify the mode bits in a test."
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { FileTokenStore, MemoryTokenStore, type TokenSet } from './tokenStore.js';

const SAMPLE: TokenSet = {
  accessToken: 'ship_at_abc123',
  refreshToken: 'ship_rt_def456',
  expiresAt: 1_800_000_000_000,
  scope: 'documents:read issues:read',
};

describe('MemoryTokenStore', () => {
  it('get() returns null before anything is set', async () => {
    const store = new MemoryTokenStore();
    expect(await store.get()).toBeNull();
  });

  it('round-trips whatever was last set()', async () => {
    const store = new MemoryTokenStore();
    await store.set(SAMPLE);
    expect(await store.get()).toEqual(SAMPLE);

    const updated: TokenSet = { accessToken: 'ship_at_new' };
    await store.set(updated);
    expect(await store.get()).toEqual(updated);
  });

  it('clear() removes the stored token set', async () => {
    const store = new MemoryTokenStore();
    await store.set(SAMPLE);
    await store.clear();
    expect(await store.get()).toBeNull();
  });
});

describe('FileTokenStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ship-sdk-tokenstore-'));
    filePath = path.join(dir, 'credentials.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('get() returns null when the file does not exist yet', async () => {
    const store = new FileTokenStore(filePath);
    expect(await store.get()).toBeNull();
  });

  it('round-trips a token set through set()/get()', async () => {
    const store = new FileTokenStore(filePath);
    await store.set(SAMPLE);
    expect(await store.get()).toEqual(SAMPLE);
  });

  it('clear() removes the file; get() afterward returns null, not an error', async () => {
    const store = new FileTokenStore(filePath);
    await store.set(SAMPLE);
    await store.clear();
    expect(await store.get()).toBeNull();
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('clear() on a file that never existed is a no-op, not an error', async () => {
    const store = new FileTokenStore(filePath);
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('set() creates parent directories that do not exist yet', async () => {
    const nestedPath = path.join(dir, 'nested', 'deeper', 'credentials.json');
    const store = new FileTokenStore(nestedPath);
    await store.set(SAMPLE);
    expect(await store.get()).toEqual(SAMPLE);
  });

  it('get() throws a clear error on a corrupted (non-JSON) store, rather than silently treating it as "no token"', async () => {
    await fs.writeFile(filePath, 'this is not json{{{', 'utf8');
    const store = new FileTokenStore(filePath);
    await expect(store.get()).rejects.toThrow(/invalid JSON/);
  });

  it('get() throws on well-formed JSON that is not a valid token set', async () => {
    await fs.writeFile(filePath, JSON.stringify({ notATokenSet: true }), 'utf8');
    const store = new FileTokenStore(filePath);
    await expect(store.get()).rejects.toThrow(/does not contain a valid token set/);
  });

  // The ticket's own instruction, verbatim: "0600 permissions — this is a
  // real security requirement, not decorative; verify the mode bits in a
  // test."
  it('set() writes the file with exactly 0600 permissions', async () => {
    const store = new FileTokenStore(filePath);
    await store.set(SAMPLE);

    const stats = await fs.stat(filePath);
    // Mask to the permission bits only (mode also encodes the file-type
    // bits, e.g. S_IFREG) — same masking every other permission check in
    // this repo's own test suite would use.
    expect(stats.mode & 0o777).toBe(0o600);
  });

  // Node's `fs.writeFile(path, data, { mode })` only applies `mode` when the
  // underlying `open()` call CREATES the file — an existing file opened with
  // the 'w' flag is truncated but keeps its prior permission bits (verified
  // against Node's docs before writing `tokenStore.ts`'s implementation, not
  // assumed). This test proves the class corrects that on every write, not
  // just the first — see `FileTokenStore`'s own doc comment for why an
  // explicit `chmod` after `writeFile` is required.
  it('corrects an existing file\'s permissions on set(), not just a freshly-created one', async () => {
    // Pre-create the file at a deliberately loose mode, bypassing the store
    // entirely (simulating a file left over from another process/umask).
    await fs.writeFile(filePath, '{}', { mode: 0o644 });
    const preStats = await fs.stat(filePath);
    expect(preStats.mode & 0o777).toBe(0o644); // sanity check on the setup itself

    const store = new FileTokenStore(filePath);
    await store.set(SAMPLE);

    const postStats = await fs.stat(filePath);
    expect(postStats.mode & 0o777).toBe(0o600);
  });

  it('a second set() also stays at 0600 (not just the first write)', async () => {
    const store = new FileTokenStore(filePath);
    await store.set(SAMPLE);
    await store.set({ accessToken: 'ship_at_rotated' });

    const stats = await fs.stat(filePath);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(await store.get()).toEqual({ accessToken: 'ship_at_rotated' });
  });
});
