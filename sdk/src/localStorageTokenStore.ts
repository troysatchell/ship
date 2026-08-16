/**
 * `LocalStorageTokenStore` (TRO-617, ruling I-06; brief p.4 "Pluggable
 * ITokenStore (in-memory, file, browser localStorage)") — the SDK's third
 * built-in `ITokenStore`, moved here from `integrations/browser-demo/src/
 * localStorageTokenStore.ts` so the package actually ships all three stores
 * the brief names rather than leaving the browser one as demo-private code.
 *
 * Browser-safe by construction (zero deps, no Node built-ins, no top-level
 * `localStorage` access): it lives in this file, not `fileTokenStore.ts`,
 * for the same reason that file is separate from `tokenStore.ts` — see the
 * TRO-449 note in `tokenStore.ts`. It is exported from the main barrel
 * (`index.ts`), which Node tests import too, so the module MUST be
 * importable where `localStorage` does not exist: only `get`/`set`/`clear`
 * touch it, and each throws a clear Error naming the missing global rather
 * than a bare `ReferenceError`.
 *
 * `localStorage`, not `sessionStorage`: `authorizationCodeFlow` already uses
 * `sessionStorage` internally for the in-flight PKCE verifier (cleared the
 * moment the round trip completes); this store is for the ACCESS/REFRESH
 * token that should survive a closed tab — "stay signed in".
 */
import type { ITokenStore, TokenSet } from './tokenStore.js';

export interface LocalStorageTokenStoreOptions {
  /** `localStorage` key the JSON-serialised `TokenSet` is written under.
   * Default `'ship_sdk_tokens'`. Consumers with an existing key (e.g. the
   * browser demo's `'ship_browser_demo_tokens'`) pass their own so previous
   * logins survive the switch to the SDK-shipped store. */
  readonly storageKey?: string;
}

export const DEFAULT_LOCAL_STORAGE_KEY = 'ship_sdk_tokens';

function isTokenSet(value: unknown): value is TokenSet {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.accessToken === 'string';
}

/** Minimal structural view of the Web Storage API — declared locally so
 * this file type-checks under `sdk/tsconfig.json` (no `dom` lib) and so the
 * class only depends on the three methods it actually calls. */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function requireLocalStorage(): StorageLike {
  const candidate = (globalThis as { localStorage?: unknown }).localStorage;
  if (typeof candidate === 'undefined' || candidate === null) {
    throw new Error(
      'LocalStorageTokenStore: `localStorage` is not available in this environment ' +
        '(it exists in browsers only). Use MemoryTokenStore, or FileTokenStore from ' +
        '@ship/sdk/node, outside a browser.',
    );
  }
  return candidate as StorageLike;
}

export class LocalStorageTokenStore implements ITokenStore {
  private readonly storageKey: string;

  constructor(options: LocalStorageTokenStoreOptions = {}) {
    this.storageKey = options.storageKey ?? DEFAULT_LOCAL_STORAGE_KEY;
  }

  // `async` (unlike MemoryTokenStore's Promise.resolve style) so that the
  // missing-`localStorage` Error surfaces as a REJECTED promise, matching how
  // every `ITokenStore` caller already handles failure — a synchronous throw
  // from a Promise-returning method would bypass `.catch()`/`await` sites.
  async get(): Promise<TokenSet | null> {
    const storage = requireLocalStorage();
    const raw = storage.getItem(this.storageKey);
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt storage is treated as "never signed in": drop the bad value
      // so the next get() is clean and let the caller re-authenticate.
      storage.removeItem(this.storageKey);
      return null;
    }

    return isTokenSet(parsed) ? parsed : null;
  }

  async set(tokens: TokenSet): Promise<void> {
    requireLocalStorage().setItem(this.storageKey, JSON.stringify(tokens));
  }

  async clear(): Promise<void> {
    requireLocalStorage().removeItem(this.storageKey);
  }
}
