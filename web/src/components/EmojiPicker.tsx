import { useState, useRef, useEffect, lazy, Suspense } from 'react';
import { cn } from '@/lib/cn';

/**
 * BUN-4 / TRO-200: the picker itself is behind a click in a properties
 * sidebar, so there is no reason for every page load — including /login — to
 * carry it. See EmojiPickerBody.tsx for why the package import lives there.
 */
const EmojiPickerBody = lazy(() => import('./EmojiPickerBody'));

interface EmojiPickerPopoverProps {
  value?: string | null;
  onChange: (emoji: string | null) => void;
  children: React.ReactNode;
  className?: string;
}

export function EmojiPickerPopover({ value, onChange, children, className }: EmojiPickerPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  const handleEmojiSelect = (emoji: string) => {
    onChange(emoji);
    setIsOpen(false);
  };

  const handleClear = () => {
    onChange(null);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background rounded"
      >
        {children}
      </button>

      {isOpen && (
        <div className="absolute z-50 mt-2 left-0">
          <div className="rounded-lg border border-border bg-background shadow-lg overflow-hidden">
            {value && (
              <button
                type="button"
                onClick={handleClear}
                className="w-full px-3 py-2 text-sm text-left text-muted hover:bg-border/50 border-b border-border"
              >
                Remove emoji
              </button>
            )}
            {/*
              The fallback is sized to the picker (300x350) so the popover does
              not resize under the cursor when the chunk arrives.
            */}
            <Suspense
              fallback={
                <div
                  role="status"
                  aria-live="polite"
                  style={{ height: 350, width: 300 }}
                  className="flex items-center justify-center text-sm text-muted"
                >
                  Loading emoji…
                </div>
              }
            >
              <EmojiPickerBody onSelect={handleEmojiSelect} />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}
