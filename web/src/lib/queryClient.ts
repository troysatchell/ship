import { QueryClient, MutationCache, QueryCache } from '@tanstack/react-query';
import { get, set, del, createStore } from 'idb-keyval';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';

// ===========================================
// Cache Schema Versioning
// ===========================================

// Increment this when cache schema changes to auto-clear old data
// v2: Removed local-first architecture (sync queues, pending mutations)
export const CACHE_SCHEMA_VERSION = 2;

// IndexedDB store for query cache
const queryStore = createStore('ship-query-cache', 'queries');

// IndexedDB store for metadata (schema version, etc)
const metaStore = createStore('ship-meta', 'meta');

// ===========================================
// Schema Migration
// ===========================================

async function checkAndMigrateSchema(): Promise<void> {
  try {
    const storedVersion = await get<number>('schema_version', metaStore);

    if (storedVersion === undefined) {
      // First time - just set version
      await set('schema_version', CACHE_SCHEMA_VERSION, metaStore);
      console.log('[Schema] Initialized schema version:', CACHE_SCHEMA_VERSION);
      return;
    }

    if (storedVersion !== CACHE_SCHEMA_VERSION) {
      console.log('[Schema] Version mismatch:', storedVersion, '->', CACHE_SCHEMA_VERSION);
      // Clear old cache data
      await del('tanstack-query', queryStore);
      // Update version
      await set('schema_version', CACHE_SCHEMA_VERSION, metaStore);
      console.log('[Schema] Cache cleared due to schema migration');
    }
  } catch (error) {
    console.warn('[Schema] Migration check failed:', error);
  }
}

// ===========================================
// Cache Corruption Detection & Recovery
// ===========================================

let cacheCorrupted = false;
let corruptionListeners: Array<(corrupted: boolean) => void> = [];

// ===========================================
// Mutation Error Events
// ===========================================

type MutationErrorListener = (error: Error, context: { operation?: string }) => void;
let mutationErrorListeners: MutationErrorListener[] = [];

export function subscribeToMutationErrors(listener: MutationErrorListener): () => void {
  mutationErrorListeners.push(listener);
  return () => {
    mutationErrorListeners = mutationErrorListeners.filter(l => l !== listener);
  };
}

function notifyMutationError(error: Error, context: { operation?: string }) {
  mutationErrorListeners.forEach(l => l(error, context));
}

export function isCacheCorrupted(): boolean {
  return cacheCorrupted;
}

export function subscribeToCacheCorruption(listener: (corrupted: boolean) => void): () => void {
  corruptionListeners.push(listener);
  if (cacheCorrupted) {
    listener(true);
  }
  return () => {
    corruptionListeners = corruptionListeners.filter(l => l !== listener);
  };
}

function notifyCorruptionListeners(corrupted: boolean) {
  cacheCorrupted = corrupted;
  corruptionListeners.forEach(l => l(corrupted));
}

export async function clearAllCacheData(): Promise<void> {
  try {
    await del('tanstack-query', queryStore);
    console.log('[Cache] Cleared all cache data');
    notifyCorruptionListeners(false);
  } catch (error) {
    console.error('[Cache] Failed to clear cache:', error);
    throw error;
  }
}

// Create IndexedDB persister for TanStack Query with corruption detection
export function createIDBPersister(): Persister {
  return {
    persistClient: async (client: PersistedClient) => {
      try {
        await set('tanstack-query', client, queryStore);
      } catch (error) {
        console.error('[Persister] Failed to persist client:', error);
      }
    },
    restoreClient: async () => {
      try {
        const data = await get<PersistedClient>('tanstack-query', queryStore);
        if (data && typeof data !== 'object') {
          throw new Error('Invalid cache data structure');
        }
        return data;
      } catch (error) {
        console.error('[Persister] Cache corruption detected:', error);
        notifyCorruptionListeners(true);
        return undefined;
      }
    },
    removeClient: async () => {
      try {
        await del('tanstack-query', queryStore);
      } catch (error) {
        console.error('[Persister] Failed to remove client:', error);
      }
    },
  };
}

// ===========================================
// Retry policy (TRO-172 / audit finding API-1)
// ===========================================

/** HTTP 429 — the server's rate limiter rejected the request. */
export const THROTTLE_STATUS = 429;

/** Retries for statuses that are not throttling (network blips, 5xx). */
const DEFAULT_MAX_RETRIES = 3;

/**
 * Backoff schedule for HTTP 429, in milliseconds, indexed by failure count.
 *
 * The API's rate-limit window is 60 s (`api/src/middleware/rate-limit.ts`), so a
 * 429 cannot clear until the window rolls over. These delays sum to 75 s, which
 * guarantees at least one attempt lands in a fresh window no matter where in the
 * window the first rejection happened. React Query's default backoff (1/2/4 s)
 * would exhaust itself inside the same window and never recover.
 */
export const THROTTLE_RETRY_DELAYS_MS = [2000, 8000, 20000, 45000];

/** Read the HTTP status off an error, if the thrower attached one. */
export function errorStatus(error: unknown): number | undefined {
  if (error !== null && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/** True when a request failed because the server was rate limiting it. */
export function isThrottleError(error: unknown): boolean {
  return errorStatus(error) === THROTTLE_STATUS;
}

/**
 * Retry predicate shared by queries and mutations.
 *
 * 429 is a 4xx, but unlike every other 4xx it is *transient* — the request was
 * never evaluated and will succeed once the rate-limit window rolls over.
 * Treating it as permanent (the previous behaviour) silently dropped throttled
 * writes: a PATCH of a document title/state/priority failed for good with only
 * a toast.
 */
export function shouldRetryRequest(failureCount: number, error: unknown): boolean {
  const status = errorStatus(error);
  if (status === THROTTLE_STATUS) return failureCount < THROTTLE_RETRY_DELAYS_MS.length;
  // Every other client error is permanent - retrying cannot change the outcome.
  if (status !== undefined && status >= 400 && status < 500) return false;
  return failureCount < DEFAULT_MAX_RETRIES;
}

/** Backoff shared by queries and mutations. */
export function retryDelayMs(failureCount: number, error: unknown): number {
  if (isThrottleError(error)) {
    const index = Math.min(Math.max(failureCount, 0), THROTTLE_RETRY_DELAYS_MS.length - 1);
    const base = THROTTLE_RETRY_DELAYS_MS[index];
    // Jitter is additive only, so a page's worth of throttled requests don't
    // retry in lockstep and re-exhaust the budget the instant the window rolls
    // over - and so the schedule can never come in under the 60 s window.
    return Math.round(base * (1 + Math.random() * 0.5));
  }
  // React Query's default exponential backoff for everything else.
  return Math.min(1000 * 2 ** failureCount, 30000);
}

// Create the query client with stale-while-revalidate caching
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 60 * 24, // 24 hours
      retry: shouldRetryRequest,
      retryDelay: retryDelayMs,
    },
    mutations: {
      retry: shouldRetryRequest,
      retryDelay: retryDelayMs,
    },
  },
  queryCache: new QueryCache({
    onError: (error, query) => {
      console.error(`Query ${query.queryKey} failed:`, error);
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      console.error(`Mutation failed:`, error, mutation);
      // Notify listeners (for toast display)
      const operation = mutation.options.meta?.operation as string | undefined;
      notifyMutationError(error instanceof Error ? error : new Error(String(error)), { operation });
    },
  }),
});

// Persister instance
export const queryPersister = createIDBPersister();

// ===========================================
// Initialization
// ===========================================

if (typeof window !== 'undefined') {
  // Run initialization checks
  const initializeCache = async () => {
    await checkAndMigrateSchema();
  };

  initializeCache();
}
