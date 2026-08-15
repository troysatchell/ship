import type { ITokenStore, TokenSet } from '@ship/sdk';

/**
 * `ITokenStore` backed by `localStorage` — PLUGFORGE.MD §4's PF-802 AC names
 * this explicitly ("localStorage token store"), and `@ship/sdk`'s own
 * `tokenStore.ts` deliberately ships neither this nor a third built-in
 * implementation for it (see that file's header): `MemoryTokenStore` doesn't
 * survive a page reload, `FileTokenStore` is Node-only (no filesystem in a
 * browser). This is the one place in the whole demo that owns persistence.
 *
 * `localStorage`, not `sessionStorage`: the SDK's own `authorizationCodeFlow`
 * already uses `sessionStorage` internally for the in-flight PKCE verifier
 * (cleared the moment the round trip completes); this store is for the
 * ACCESS/REFRESH token that should survive a closed tab, matching how a real
 * user expects "stay signed in" to behave.
 */
const STORAGE_KEY = 'ship_browser_demo_tokens';

function isTokenSet(value: unknown): value is TokenSet {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.accessToken === 'string';
}

export class LocalStorageTokenStore implements ITokenStore {
  get(): Promise<TokenSet | null> {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return Promise.resolve(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt local storage is not worth failing loudly over in a demo —
      // treat it the same as "never signed in" and let the user reconnect.
      localStorage.removeItem(STORAGE_KEY);
      return Promise.resolve(null);
    }

    return Promise.resolve(isTokenSet(parsed) ? parsed : null);
  }

  set(tokens: TokenSet): Promise<void> {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
    return Promise.resolve();
  }

  clear(): Promise<void> {
    localStorage.removeItem(STORAGE_KEY);
    return Promise.resolve();
  }
}
