import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

/**
 * The ranked "what needs you" inbox (TRO-323 / FG-10).
 *
 * Fetches `GET /api/agent/inbox` (api/src/routes/agent.ts), which proxies to
 * the FleetGraph agent's own `GET /inbox` and relays `itemStore.list()`
 * verbatim — already fully ranked server-side (blocking_approval first,
 * highest blockedCount first within that, ties broken by longest-waiting;
 * then mention oldest-first; then standup_draft oldest-first — see
 * agent/src/itemStore.ts's own docstring). This hook does no sorting,
 * filtering, or re-ranking of its own; it is read-only plumbing.
 *
 * Deliberately NOT the same surface as useActionItemsQuery/AccountabilityBanner
 * — those say "you owe a standup"; this is the agent's ranked mentions,
 * blocking approvals, and prepared drafts. Different data, different API,
 * different store.
 *
 * Never throws: queryFn resolves to a discriminated union (`status: 'ok'` or
 * `status: 'degraded'`), the same shape AgentChatPanel.tsx's local ChatState
 * uses — a network failure, a 503 (agent not configured), or a non-OK
 * response all become one visible degraded message rather than an
 * unresolving spinner or a React Query error boundary the caller has to
 * additionally handle.
 */

export type InboxItemType = 'mention' | 'blocking_approval' | 'standup_draft';

export interface InboxItemEvidence {
  documentId?: string;
  documentType?: string;
  commentId?: string;
}

export interface InboxItemAction {
  label: string;
  href: string;
}

export interface InboxItem {
  id: string;
  type: InboxItemType;
  summary: string;
  evidence: InboxItemEvidence;
  action: InboxItemAction;
  /** blocking_approval only. Absent for every other type, and absent even
   * for a blocking_approval item in some cases — a person with no manager
   * recorded (reports_to unset, the common case: 10 of 20 people in the DB)
   * is unrelated to this field, but rendering must not assume it is always
   * present either way. */
  blockedCount?: number;
  blockedSince?: string;
}

export type InboxQueryResult =
  | { status: 'ok'; items: InboxItem[] }
  | { status: 'degraded'; message: string };

const NOT_CONFIGURED_MESSAGE = "The agent isn't set up in this environment yet.";
const UNREACHABLE_MESSAGE = "Can't reach the agent right now. Try again in a bit.";

export const inboxKeys = {
  all: ['agent-inbox'] as const,
};

// Defense-in-depth shape validation on an already-validated boundary:
// api/src/routes/agent.ts's GET /inbox handler already runs
// isAgentInboxSuccessBody (and its own per-field isAgentInboxItem /
// isAgentInboxEvidence / isAgentInboxAction checks) over the agent service's
// response before ever relaying it to the browser, so a malformed item
// cannot actually reach this hook today. Still worth doing cheaply on this
// side too, mirroring that same field-by-field discipline rather than
// trusting `res.json()`'s inferred shape blindly — this file has no
// build-time dependency on api/'s types (same posture agent.ts itself takes
// on agent/'s InboxItemType), so the check is duplicated, not imported.
function isInboxItemEvidence(value: unknown): value is InboxItemEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.documentId === undefined || typeof v.documentId === 'string') &&
    (v.documentType === undefined || typeof v.documentType === 'string') &&
    (v.commentId === undefined || typeof v.commentId === 'string')
  );
}

function isInboxItemAction(value: unknown): value is InboxItemAction {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.label === 'string' && typeof v.href === 'string';
}

function isInboxItem(value: unknown): value is InboxItem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    (v.type === 'mention' || v.type === 'blocking_approval' || v.type === 'standup_draft') &&
    typeof v.summary === 'string' &&
    isInboxItemEvidence(v.evidence) &&
    isInboxItemAction(v.action) &&
    (v.blockedCount === undefined || typeof v.blockedCount === 'number') &&
    (v.blockedSince === undefined || typeof v.blockedSince === 'string')
  );
}

function isInboxSuccessBody(value: unknown): value is { items: InboxItem[] } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.items) && v.items.every(isInboxItem);
}

export function useInboxQuery() {
  return useQuery<InboxQueryResult>({
    queryKey: inboxKeys.all,
    queryFn: async (): Promise<InboxQueryResult> => {
      try {
        const res = await apiGet('/api/agent/inbox');
        if (res.status === 503) {
          return { status: 'degraded', message: NOT_CONFIGURED_MESSAGE };
        }
        if (!res.ok) {
          return { status: 'degraded', message: UNREACHABLE_MESSAGE };
        }
        const data: unknown = await res.json();
        if (!isInboxSuccessBody(data)) {
          return { status: 'degraded', message: UNREACHABLE_MESSAGE };
        }
        return { status: 'ok', items: data.items };
      } catch {
        return { status: 'degraded', message: UNREACHABLE_MESSAGE };
      }
    },
    // Same cadence as useActionItemsQuery — frequent enough that a badge
    // reflects reality without polling aggressively.
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });
}
