import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { cn } from '@/lib/cn';

/**
 * Issue picker for the Blocks/Blocked-by sidebar sections (TRO-334 / FG-16).
 *
 * Adapted from `PersonCombobox.tsx`'s structure (Radix `Popover` + `cmdk`
 * `Command`, trigger button -> searchable list -> `Command.Item` select) per
 * the ticket's own instruction to reuse the existing document-picker
 * pattern rather than build a third one. Deliberately modeled as a
 * "pick-and-fire" single action (`onSelect`, no persisted `value`) rather
 * than `PersonCombobox`'s controlled single-value shape: this picker never
 * represents "the current blocker" — it is the "add a blocker" control,
 * and the current set of blockers is rendered as its own list right above
 * it (IssueBlockingSection.tsx), each row with its own remove button.
 *
 * One deliberate difference from the `PersonCombobox`/`MultiPersonCombobox`
 * pattern being reused: `Popover.Content` here carries an `aria-label`.
 * Read directly: neither of those two components sets one on its own
 * `Popover.Content` (A11Y-4's exact defect — Radix's `Popover.Content`
 * defaults to `role="dialog"` with no accessible name). `ui/Combobox.tsx`
 * was already fixed to carry one (see its own `Popover.Content
 * aria-label={ariaLabel || placeholder}` and `Combobox.test.tsx`'s
 * TRO-218/A11Y-4 regression test); reusing PersonCombobox/MultiPersonCombobox's
 * structure without also reusing their still-unfixed gap is the point here,
 * not scope creep — this ticket's own proof point 4 requires a real
 * keyboard/screen-reader check, and an unnamed dialog fails exactly that
 * kind of check.
 */

export interface IssueOption {
  id: string;
  title: string;
  /** e.g. "AUTH-12" — shown alongside the title when present. */
  displayId?: string | null;
}

interface IssueComboboxProps {
  options: IssueOption[];
  onSelect: (issueId: string) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  'aria-label': string;
}

export function IssueCombobox({
  options,
  onSelect,
  placeholder = 'Add issue…',
  emptyText = 'No matching issues',
  disabled = false,
  className,
  'aria-label': ariaLabel,
}: IssueComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  return (
    <Popover.Root open={open} onOpenChange={disabled ? undefined : setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex w-full items-center gap-2 rounded-md border border-dashed border-border bg-transparent px-2 py-1.5 text-left text-sm',
            'hover:bg-border/30 transition-colors text-muted hover:text-foreground',
            'focus:outline-none focus:ring-1 focus:ring-accent',
            disabled && 'opacity-50 cursor-not-allowed',
            className
          )}
        >
          <PlusIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{placeholder}</span>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          aria-label={ariaLabel}
          className="z-50 w-[260px] rounded-md border border-border bg-background shadow-lg"
          sideOffset={4}
          align="start"
        >
          <Command
            className="flex flex-col"
            filter={(value, search) => {
              const option = options.find((o) => o.id === value);
              if (!option) return 0;
              const title = option.title.toLowerCase();
              const displayId = (option.displayId || '').toLowerCase();
              const s = search.toLowerCase();
              if (title.includes(s) || displayId.includes(s)) return 1;
              return 0;
            }}
          >
            <div className="border-b border-border p-2">
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Search issues..."
                className="w-full bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none"
              />
            </div>

            <Command.List className="max-h-[220px] overflow-auto p-1">
              <Command.Empty className="px-2 py-4 text-center text-sm text-muted">
                {emptyText}
              </Command.Empty>

              {options.map((option) => (
                <Command.Item
                  key={option.id}
                  value={option.id}
                  onSelect={() => {
                    onSelect(option.id);
                    setOpen(false);
                    setSearch('');
                  }}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm',
                    'data-[selected=true]:bg-border/50'
                  )}
                >
                  {option.displayId && (
                    <span className="shrink-0 font-mono text-xs text-muted">{option.displayId}</span>
                  )}
                  <span className="truncate">{option.title}</span>
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}
