/**
 * TRO-617 — `LocalStorageTokenStore` regression tests. vitest env here is
 * `node` (sdk/vitest.config.ts), so `localStorage` is stubbed on
 * `globalThis` with a Map-backed object per test; the "missing localStorage"
 * case runs with the stub removed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalStorageTokenStore, DEFAULT_LOCAL_STORAGE_KEY } from './localStorageTokenStore.js';
import type { TokenSet } from './tokenStore.js';

function makeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

type G = { localStorage?: unknown };

describe('LocalStorageTokenStore (TRO-617)', () => {
  let storage: ReturnType<typeof makeStorage>;
  let original: unknown;
  let hadOriginal: boolean;

  beforeEach(() => {
    hadOriginal = 'localStorage' in globalThis;
    original = (globalThis as G).localStorage;
    storage = makeStorage();
    (globalThis as G).localStorage = storage;
  });

  afterEach(() => {
    if (hadOriginal) (globalThis as G).localStorage = original;
    else delete (globalThis as G).localStorage;
  });

  const tokens: TokenSet = {
    accessToken: 'at_1',
    refreshToken: 'rt_1',
    expiresAt: 1_700_000_000_000,
    scope: 'documents:read',
  };

  it('get() returns null when nothing has been stored', async () => {
    expect(await new LocalStorageTokenStore().get()).toBeNull();
  });

  it('round-trips get/set/clear under the default key', async () => {
    const store = new LocalStorageTokenStore();
    await store.set(tokens);
    expect(storage.map.has(DEFAULT_LOCAL_STORAGE_KEY)).toBe(true);
    expect(DEFAULT_LOCAL_STORAGE_KEY).toBe('ship_sdk_tokens');
    expect(await store.get()).toEqual(tokens);
    await store.clear();
    expect(storage.map.has(DEFAULT_LOCAL_STORAGE_KEY)).toBe(false);
    expect(await store.get()).toBeNull();
  });

  it('corrupt JSON → null and the key is removed', async () => {
    storage.setItem(DEFAULT_LOCAL_STORAGE_KEY, '{not json');
    const store = new LocalStorageTokenStore();
    expect(await store.get()).toBeNull();
    expect(storage.map.has(DEFAULT_LOCAL_STORAGE_KEY)).toBe(false);
  });

  it('valid JSON that is not a TokenSet → null', async () => {
    storage.setItem(DEFAULT_LOCAL_STORAGE_KEY, JSON.stringify({ nope: 1 }));
    expect(await new LocalStorageTokenStore().get()).toBeNull();
  });

  it('honours a custom storageKey', async () => {
    const store = new LocalStorageTokenStore({ storageKey: 'ship_browser_demo_tokens' });
    await store.set(tokens);
    expect(storage.map.has('ship_browser_demo_tokens')).toBe(true);
    expect(storage.map.has(DEFAULT_LOCAL_STORAGE_KEY)).toBe(false);
    expect(await store.get()).toEqual(tokens);
    await store.clear();
    expect(storage.map.has('ship_browser_demo_tokens')).toBe(false);
  });

  it('is constructible without localStorage, but get/set/clear throw a clear Error naming it', async () => {
    delete (globalThis as G).localStorage;
    const store = new LocalStorageTokenStore(); // must not throw — module/ctor are Node-safe
    await expect(store.get()).rejects.toThrow(/localStorage/);
    await expect(store.set(tokens)).rejects.toThrow(/localStorage.*not available/);
    await expect(store.clear()).rejects.toThrow(/localStorage/);
  });
});
