import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PropertyRow } from '@/components/ui/PropertyRow';
import { IssueCombobox, type IssueOption } from '@/components/IssueCombobox';
import { useIssuesQuery } from '@/hooks/useIssuesQuery';
import {
  useBlocksQuery,
  useBlockedByQuery,
  useInvalidateBlockingAssociations,
  addBlocksEdge,
  removeBlocksEdge,
  type BlockingAssociation,
} from '@/hooks/useBlockingAssociations';

/**
 * "Blocks" / "Blocked by" sections in the issue properties sidebar (TRO-334
 * / FG-16). Self-contained — takes only `issueId`, matching the precedent
 * `AgentChatPanel documentId={document.id}` (TRO-320) set for a sidebar
 * section that owns its own data fetching rather than threading new props
 * through `PropertiesPanel`/`UnifiedEditor`. Mounted from `IssueSidebar.tsx`
 * only (this is issue-sidebar scoped per the ticket, not universal like the
 * chat panel).
 *
 * "Blocked by" is never a second, separately-stored relationship — see
 * `useBlockingAssociations.ts`'s own docstring for the exact reverse-query
 * endpoint and the add/remove direction handling.
 */

interface IssueBlockingSectionProps {
  issueId: string;
}

function toIssueOption(issue: { id: string; title: string; display_id: string }): IssueOption {
  return { id: issue.id, title: issue.title || 'Untitled', displayId: issue.display_id };
}

function BlockingList({
  ariaLabel,
  items,
  emptyText,
  removingId,
  onRemove,
}: {
  ariaLabel: string;
  items: BlockingAssociation[];
  emptyText: string;
  removingId: string | null;
  onRemove: (documentId: string, title: string) => void;
}) {
  if (items.length === 0) {
    return <p className="text-xs text-muted italic">{emptyText}</p>;
  }

  return (
    <ul aria-label={ariaLabel} className="space-y-1">
      {items.map((item) => (
        <li key={item.associationId} className="flex items-center gap-1.5 rounded bg-border/30 px-2 py-1">
          <Link
            to={`/documents/${item.documentId}`}
            className="min-w-0 flex-1 truncate text-sm text-foreground hover:text-accent hover:underline"
          >
            {item.title || 'Untitled'}
          </Link>
          <button
            type="button"
            onClick={() => onRemove(item.documentId, item.title || 'Untitled')}
            disabled={removingId === item.documentId}
            aria-label={`Remove ${item.title || 'Untitled'} from ${ariaLabel}`}
            className="shrink-0 rounded p-0.5 text-muted hover:bg-border hover:text-red-400 disabled:opacity-50 transition-colors"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function IssueBlockingSection({ issueId }: IssueBlockingSectionProps) {
  const { data: allIssues = [] } = useIssuesQuery();
  const blocksQuery = useBlocksQuery(issueId);
  const blockedByQuery = useBlockedByQuery(issueId);
  const invalidate = useInvalidateBlockingAssociations(issueId);

  const [blocksError, setBlocksError] = useState<string | null>(null);
  const [blockedByError, setBlockedByError] = useState<string | null>(null);
  const [addingBlocks, setAddingBlocks] = useState(false);
  const [addingBlockedBy, setAddingBlockedBy] = useState(false);
  const [removingBlocksId, setRemovingBlocksId] = useState<string | null>(null);
  const [removingBlockedById, setRemovingBlockedById] = useState<string | null>(null);

  const blocks = useMemo(() => blocksQuery.data ?? [], [blocksQuery.data]);
  const blockedBy = useMemo(() => blockedByQuery.data ?? [], [blockedByQuery.data]);

  // Options for each picker: every other issue, minus this one and whatever
  // is already listed in that specific direction (the API upserts on
  // conflict rather than erroring on a re-add, but hiding an already-listed
  // issue from its own picker is clearer UX regardless).
  const blocksOptions = useMemo<IssueOption[]>(() => {
    const excluded = new Set([issueId, ...blocks.map((b) => b.documentId)]);
    return allIssues.filter((i) => !excluded.has(i.id)).map(toIssueOption);
  }, [allIssues, issueId, blocks]);

  const blockedByOptions = useMemo<IssueOption[]>(() => {
    const excluded = new Set([issueId, ...blockedBy.map((b) => b.documentId)]);
    return allIssues.filter((i) => !excluded.has(i.id)).map(toIssueOption);
  }, [allIssues, issueId, blockedBy]);

  async function handleAddBlocks(selectedId: string) {
    setBlocksError(null);
    setAddingBlocks(true);
    const result = await addBlocksEdge(issueId, selectedId);
    setAddingBlocks(false);
    if (result.ok) {
      invalidate();
    } else {
      setBlocksError(result.message);
    }
  }

  async function handleAddBlockedBy(selectedId: string) {
    setBlockedByError(null);
    setAddingBlockedBy(true);
    // This issue is BLOCKED BY the selected one: the edge's source is the
    // selected issue, its target is this one — see useBlockingAssociations's
    // docstring on why the POST is not addressed to this issue's own id.
    const result = await addBlocksEdge(selectedId, issueId);
    setAddingBlockedBy(false);
    if (result.ok) {
      invalidate();
    } else {
      setBlockedByError(result.message);
    }
  }

  async function handleRemoveBlocks(targetId: string) {
    setBlocksError(null);
    setRemovingBlocksId(targetId);
    const ok = await removeBlocksEdge(issueId, targetId);
    setRemovingBlocksId(null);
    if (ok) {
      invalidate();
    } else {
      setBlocksError('Could not remove this blocking relationship. Please try again.');
    }
  }

  async function handleRemoveBlockedBy(sourceId: string) {
    setBlockedByError(null);
    setRemovingBlockedById(sourceId);
    const ok = await removeBlocksEdge(sourceId, issueId);
    setRemovingBlockedById(null);
    if (ok) {
      invalidate();
    } else {
      setBlockedByError('Could not remove this blocking relationship. Please try again.');
    }
  }

  return (
    <>
      <PropertyRow label="Blocks">
        <div className="space-y-1.5">
          <BlockingList
            ariaLabel="Blocks"
            items={blocks}
            emptyText="Not blocking any issues"
            removingId={removingBlocksId}
            onRemove={handleRemoveBlocks}
          />
          <IssueCombobox
            options={blocksOptions}
            onSelect={handleAddBlocks}
            disabled={addingBlocks}
            placeholder="Add issue this blocks…"
            aria-label="Add issue this blocks"
          />
          {/* Fixed role="alert" for the lifetime of the element — same
            * reasoning as AgentChatPanel.tsx/InboxSidebar.tsx: a live
            * region's politeness should not switch role with its content. */}
          <div role="alert">
            {blocksError && <p className="text-xs text-red-400">{blocksError}</p>}
          </div>
        </div>
      </PropertyRow>

      <PropertyRow label="Blocked by">
        <div className="space-y-1.5">
          <BlockingList
            ariaLabel="Blocked by"
            items={blockedBy}
            emptyText="Not blocked by any issues"
            removingId={removingBlockedById}
            onRemove={handleRemoveBlockedBy}
          />
          <IssueCombobox
            options={blockedByOptions}
            onSelect={handleAddBlockedBy}
            disabled={addingBlockedBy}
            placeholder="Add issue blocking this…"
            aria-label="Add issue blocking this"
          />
          <div role="alert">
            {blockedByError && <p className="text-xs text-red-400">{blockedByError}</p>}
          </div>
        </div>
      </PropertyRow>
    </>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

export default IssueBlockingSection;
