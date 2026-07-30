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
