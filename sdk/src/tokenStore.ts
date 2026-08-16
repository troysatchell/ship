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

// `FileTokenStore` lives in `fileTokenStore.ts`, a separate file, not here —
// TRO-449/PF-802 split it out: it's the only Node-only (`fs`/`path`) piece
// of this module, and a browser bundler binding `@ship/sdk`'s main barrel
// has to resolve every top-level import of every re-exported file in the
// graph, REGARDLESS of tree-shaking or `sideEffects: false` (verified
// empirically — see CHANGES.md TRO-449 for the full investigation). Keeping
// `fs`/`path` out of this file entirely is what makes `MemoryTokenStore`/
// `ITokenStore`/`TokenSet` genuinely safe for a browser barrel import.
// The third built-in store, `LocalStorageTokenStore` (TRO-617, ruling I-06),
// lives in `localStorageTokenStore.ts` and IS exported from the main barrel:
// it has zero deps and never touches `localStorage` at module load, so it is
// browser-safe and Node-importable alike (only get/set/clear require the
// global). The browser demo (PF-802) consumes it from `@ship/sdk`.
