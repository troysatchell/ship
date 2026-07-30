import { useEffect, useRef, useState } from 'react';
import { subscribeToDocumentWriteOutcome } from '@/lib/queryClient';

export interface UseDocumentWriteStatusResult {
  /**
   * True while the most recent direct document write (a title/property PATCH,
   * outside the Yjs body-content socket) for this document has failed and no
   * later write has succeeded since.
   */
  hasFailedWrite: boolean;
}

/**
 * TRO-190/ERR-3, TRO-191/ERR-4 — tracks whether this document's own direct
 * write mutation (tagged via `meta.documentId` — see `queryClient.ts`) has
 * failed, and calls `onDocumentGone` exactly once per `documentId` if a
 * failure means the document itself no longer exists (HTTP 404 — probe4c:
 * another user deleted it while this user kept typing).
 *
 * Pulled out of `Editor.tsx` into its own hook — same reason ERR-1 pulled
 * `SyncStatusIndicator` into its own component: the "notify once, reset per
 * document" logic is then testable with `renderHook` instead of requiring
 * the full TipTap/Yjs editor tree to be mounted.
 */
export function useDocumentWriteStatus(
  documentId: string,
  onDocumentGone: () => void
): UseDocumentWriteStatusResult {
  const [hasFailedWrite, setHasFailedWrite] = useState(false);
  const goneNotifiedRef = useRef(false);
  // Ref so callers don't need to memoize `onDocumentGone` for this effect to
  // stay scoped to `documentId` changes only.
  const onDocumentGoneRef = useRef(onDocumentGone);
  onDocumentGoneRef.current = onDocumentGone;

  useEffect(() => {
    setHasFailedWrite(false);
    goneNotifiedRef.current = false;

    return subscribeToDocumentWriteOutcome((outcome) => {
      if (outcome.documentId !== documentId) return;

      if (outcome.status === 'success') {
        setHasFailedWrite(false);
        return;
      }

      setHasFailedWrite(true);
      if (outcome.documentGone && !goneNotifiedRef.current) {
        goneNotifiedRef.current = true;
        onDocumentGoneRef.current();
      }
    });
  }, [documentId]);

  return { hasFailedWrite };
}
