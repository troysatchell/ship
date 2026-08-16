import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '@/lib/cn';

/**
 * PF-502 (TRO-436) AC: "shown-once UX: modal, copy button, never
 * re-fetchable; warn before close." Shared by app registration and secret
 * rotation — both mint a plaintext secret the server will never return
 * again, so the warn-before-close behavior has to hold for both callers, not
 * just one screen.
 *
 * Every dismissal path (Escape, overlay click, the explicit dismiss button)
 * routes through `attemptClose`, which always confirms first — this reads as
 * over-cautious for the case where the user already clicked Copy, but a
 * clipboard write isn't proof the value ended up somewhere durable, and the
 * AC asks for "warn before close" unconditionally, not "warn if not copied."
 */

interface ShownOnceSecretModalProps {
  open: boolean;
  title: string;
  description: string;
  secret: string;
  /** Called only once the user has explicitly confirmed the close. */
  onDismiss: () => void;
}

export function ShownOnceSecretModal({
  open,
  title,
  description,
  secret,
  onDismiss,
}: ShownOnceSecretModalProps) {
  const [copied, setCopied] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);

  function handleCopy() {
    navigator.clipboard
      .writeText(secret)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((err: unknown) => {
        console.error('Failed to copy secret:', err);
      });
  }

  function attemptClose() {
    setConfirmingClose(true);
  }

  function cancelClose() {
    setConfirmingClose(false);
  }

  function confirmClose() {
    setConfirmingClose(false);
    onDismiss();
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) attemptClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[101] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-6 shadow-xl focus:outline-none"
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            attemptClose();
          }}
          onPointerDownOutside={(e) => {
            e.preventDefault();
            attemptClose();
          }}
          onInteractOutside={(e) => {
            e.preventDefault();
          }}
        >
          {confirmingClose ? (
            <div data-testid="shown-once-close-confirm">
              <Dialog.Title className="text-lg font-semibold text-foreground">
                Close without saving?
              </Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-muted">
                This secret will not be shown again after you close this dialog.
                {copied ? ' You copied it, but make sure it landed somewhere safe.' : ' You have not copied it yet.'}
              </Dialog.Description>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  onClick={cancelClose}
                  className="rounded-md bg-border px-4 py-2 text-sm font-medium text-foreground hover:bg-border/80 focus:outline-none focus:ring-2 focus:ring-border focus:ring-offset-2 focus:ring-offset-background"
                  autoFocus
                >
                  Go back
                </button>
                <button
                  onClick={confirmClose}
                  className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-2 focus:ring-offset-background"
                >
                  Close anyway
                </button>
              </div>
            </div>
          ) : (
            <>
              <Dialog.Title className="text-lg font-semibold text-foreground">
                {title}
              </Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-muted">
                {description}
              </Dialog.Description>

              <div className="mt-4 flex gap-2">
                <code className="flex-1 overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground">
                  {secret}
                </code>
                <button
                  onClick={handleCopy}
                  className={cn(
                    'rounded-md px-3 py-2 text-sm transition-colors',
                    copied ? 'bg-green-500/20 text-green-500' : 'bg-border/50 text-foreground hover:bg-border'
                  )}
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>

              <div className="mt-6 flex justify-end">
                <button
                  onClick={attemptClose}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background"
                >
                  I've saved it — close
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
