import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { useInboxQuery, type InboxItem, type InboxItemType } from '@/hooks/useInboxQuery';

/**
 * The ranked "what needs you" inbox (TRO-323 / FG-10).
 *
 * Lives inside the existing Icon Rail + Contextual Sidebar — the ticket's
 * own constraint: "the Icon Rail plus contextual sidebar is the natural
 * home. No fifth panel." `AppLayout` (pages/App.tsx) toggles this in as an
 * overlay of the Contextual Sidebar's normal mode-based content when the
 * Inbox rail icon is active; it is not a routed page of its own.
 *
 * Renders exactly what `useInboxQuery` returns, in the order it returns it
 * — `itemStore.list()` (agent/src/itemStore.ts) is already fully ranked
 * (FG-5/FG-6: blocking_approval first, highest blockedCount first within
 * that, ties broken by longest-waiting; then mention oldest-first; then
 * standup_draft oldest-first). This component does no sorting of its own —
 * FLEETGRAPH.MD Test Case 2's four-item list, approval first, is proven by
 * NOT reordering what the server already ranked.
 *
 * Every item's action is a real `<Link>` (react-router, renders a native
 * `<a href>`) — not a `<div>`/`<li>` with an onClick bolted on. That is the
 * exact shape of A11Y-1 (`DocumentTreeItem.tsx`'s missing `tabIndex`/
 * `onKeyDown`, undetected for a full audit cycle), which this does not
 * repeat: native anchor semantics mean Tab reaches it and Enter/click
 * activates it with no custom keyboard handling to get wrong.
 *
 * `blockedCount`/`blockedSince` are optional on `InboxItem` and rendered
 * defensively — a person with no manager recorded (`reports_to` unset, the
 * common case: 10 of 20 people in the DB) still gets a usable list, since
 * this component never assumes escalation context exists. There is no
 * escalation UI here at all; that is out of this ticket's scope.
 */

const TYPE_LABELS: Record<InboxItemType, string> = {
  blocking_approval: 'Blocking approval',
  mention: 'Mention',
  standup_draft: 'Draft ready',
};

const TYPE_BADGE_CLASSES: Record<InboxItemType, string> = {
  blocking_approval: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  mention: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  standup_draft: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
};

function InboxItemRow({ item, onNavigate }: { item: InboxItem; onNavigate?: () => void }) {
  const hasBlockedCount = typeof item.blockedCount === 'number' && item.blockedCount > 0;

  return (
    <li>
      <Link
        to={item.action.href}
        onClick={onNavigate}
        className="block rounded-md px-2 py-2 text-sm transition-colors hover:bg-border/30"
      >
        <span
          className={cn(
            'inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
            TYPE_BADGE_CLASSES[item.type]
          )}
        >
          {TYPE_LABELS[item.type]}
        </span>
        <p className="mt-1 text-foreground">{item.summary}</p>
        {/* Defensive: blockedCount/blockedSince are optional on InboxItem —
          * absent for mention/standup_draft always, and absent for a
          * blocking_approval item too if the store never set it. Rendering
          * nothing here (rather than "undefined blocked") is the point. */}
        {hasBlockedCount && (
          <p className="mt-0.5 text-xs text-muted">
            Blocking {item.blockedCount} {item.blockedCount === 1 ? 'other person' : 'other people'}
          </p>
        )}
        <span className="mt-1 inline-block text-xs font-medium text-accent-text">
          {item.action.label} →
        </span>
      </Link>
    </li>
  );
}

export interface InboxSidebarProps {
  /** Called after the user follows an item's action link — AppLayout uses
   * this to close the inbox overlay so the sidebar doesn't keep showing
   * "Inbox" once the user has navigated somewhere else entirely. */
  onNavigate?: () => void;
}

export function InboxSidebar({ onNavigate }: InboxSidebarProps) {
  const { data, isLoading } = useInboxQuery();

  return (
    <div className="px-2">
      {/* Two sibling live regions, each with a role FIXED for the lifetime
        * of the element — same reasoning as AgentChatPanel.tsx: a region
        * whose politeness changes with its own content is unreliably
        * announced by assistive technology. */}
      <div role="status">
        {isLoading && <p className="px-2 py-2 text-sm italic text-muted">Loading your inbox…</p>}
      </div>
      <div role="alert">
        {data?.status === 'degraded' && (
          // text-red-400, matching AgentChatPanel.tsx's own degraded text —
          // measured here (InboxSidebar.contrast.test.tsx), not assumed:
          // `web/tailwind.config.js`'s `background` token is `#0d0d0d`
          // (Ship's palette is a single dark theme, not light-with-a-
          // dark-variant — most `dark:*` classes elsewhere in this codebase
          // are inert against it). A DARKER red like red-600 (#dc2626)
          // measures only 4.02:1 against that background and fails AA;
          // red-400 (#f87171), lighter, clears it.
          <p className="px-2 py-2 text-sm text-red-400">{data.message}</p>
        )}
      </div>

      {data?.status === 'ok' && (
        data.items.length === 0 ? (
          <p className="px-2 py-2 text-sm text-muted">Nothing needs you right now.</p>
        ) : (
          <ul aria-label="Inbox" className="space-y-1">
            {data.items.map((item) => (
              <InboxItemRow key={item.id} item={item} onNavigate={onNavigate} />
            ))}
          </ul>
        )
      )}
    </div>
  );
}

export default InboxSidebar;
