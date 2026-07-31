import { cn } from '@/lib/cn';

export type SyncStatus = 'connecting' | 'cached' | 'synced' | 'disconnected';

export interface SyncStatusIndicatorProps {
  /** Latest connection state reported by the collaboration WebSocket provider. */
  syncStatus: SyncStatus;
  /** navigator.onLine, tracked via the browser's online/offline events. */
  isBrowserOnline: boolean;
  /**
   * True only while the collaboration socket has a *completed* Yjs sync
   * handshake (y-websocket's `sync` event, last seen as `true`).
   *
   * This is the bit ERR-1 was missing. A socket can be `connected` and never
   * finish the handshake — audit probe2d recorded three `status: connected`
   * events and zero `sync` events, while the editor happily reported "Saved"
   * over text that was never written to the database and was lost on reload.
   */
  isSynced: boolean;
  /** True until the socket has connected for the first time (initial page load). */
  isInitialConnect?: boolean;
  /**
   * True when the most recent direct document write (a title or property
   * PATCH, outside the Yjs body-content socket) was rejected and has not
   * since been superseded by a successful one (TRO-190/ERR-3).
   *
   * `isSynced` only proves the collaborative body content reached the
   * server - probe6.1/6.2 forced a 429/500 on a rename and found the
   * indicator kept reading "Saved" because it never looked at this path at
   * all. A doc can be fully Yjs-synced while its title write was dropped.
   */
  hasFailedWrite?: boolean;
  /**
   * TRO-194/ERR-7 - true while a local edit exists that the collaboration
   * socket has not yet had a chance to flush to the server.
   *
   * `isSynced` only tells you the socket has *ever* completed a full sync
   * handshake (see the ERR-1 doc above) - it does not toggle on every
   * keystroke, because y-websocket only re-emits `sync` on a fresh
   * handshake, not per update. Before this flag existed the audit found
   * the indicator held on "Saved" through 6s of throttled typing with zero
   * in-flight feedback (`audit/error-handling/raw/probe5-slow-network.json`:
   * "during 6s of throttled typing, did the indicator ever leave 'Saved'?
   * false"). This is a real, observable fact (a local Yjs update has not
   * yet been superseded by confirmation the outgoing message queue drained),
   * not a synthetic timer - see `Editor.tsx`'s `ydoc.on('update', ...)`
   * listener for how it is derived.
   */
  isSaving?: boolean;
}

type Tone = 'ok' | 'pending' | 'error';

interface IndicatorView {
  label: string;
  /** Full sentence naming the consequence, surfaced as the element's title. */
  detail: string;
  tone: Tone;
}

const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-green-500',
  pending: 'bg-yellow-500 animate-pulse',
  error: 'bg-red-500',
};

const UNSYNCED: IndicatorView = {
  label: 'Not saved',
  detail:
    'Not syncing to the server. Changes made here are NOT saved and will be lost if you reload or close this tab.',
  tone: 'error',
};

/**
 * TRO-194/ERR-7 - the missing middle state between "no activity" and
 * "Saved". Only ever shown when the socket already has a live, completed
 * sync (see below) - it never claims to be saving on top of a dead
 * connection, that is still `UNSYNCED`'s job.
 */
const SAVING: IndicatorView = {
  label: 'Saving',
  detail: 'Saving your latest changes to the server.',
  tone: 'pending',
};

/**
 * Decide what the indicator is allowed to claim.
 *
 * The single invariant: "Saved" requires a live, completed sync. Everything
 * else says, in words, that the work is not saved.
 */
export function deriveSyncIndicator({
  syncStatus,
  isBrowserOnline,
  isSynced,
  isInitialConnect = false,
  hasFailedWrite = false,
  isSaving = false,
}: SyncStatusIndicatorProps): IndicatorView {
  if (!isBrowserOnline) {
    return {
      label: 'Offline',
      detail: 'You are offline. Changes are held locally and are not saved to the server yet.',
      tone: 'pending',
    };
  }

  // ERR-3/ERR-4: a rejected or gone-document write is independent of the Yjs
  // body-content socket, and overrides it - the socket being `synced` is not
  // evidence that THIS write reached the server.
  if (hasFailedWrite) {
    return UNSYNCED;
  }

  if (isSynced) {
    // TRO-194/ERR-7: a completed sync handshake does not mean the *current*
    // keystroke has left the browser - only that the connection is good.
    // `isSaving` is the in-flight signal for the edit that just happened.
    if (isSaving) {
      return SAVING;
    }
    return { label: 'Saved', detail: 'Changes are synced to the server.', tone: 'ok' };
  }

  // First connection attempt of the page load: not yet a failure, but do not
  // imply anything is saved either.
  if (isInitialConnect && (syncStatus === 'connecting' || syncStatus === 'cached')) {
    return {
      label: 'Connecting',
      detail: 'Connecting to the collaboration server. Changes are not saved yet.',
      tone: 'pending',
    };
  }

  return UNSYNCED;
}

/**
 * The document sync indicator in the editor header.
 *
 * WCAG 4.1.3: a live region so the state change is announced, not just painted.
 */
export function SyncStatusIndicator(props: SyncStatusIndicatorProps) {
  const view = deriveSyncIndicator(props);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="flex items-center gap-1.5"
      data-testid="sync-status"
      title={view.detail}
    >
      <div className={cn('h-2 w-2 rounded-full', TONE_DOT[view.tone])} aria-hidden="true" />
      <span className={cn('text-xs', view.tone === 'error' ? 'text-red-500' : 'text-muted')}>
        {view.label}
      </span>
    </div>
  );
}
