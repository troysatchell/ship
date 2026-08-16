/**
 * PF-502 (TRO-436) — the shown-once secret UX is the ticket's own AC:
 * "modal, copy button, never re-fetchable; warn before close." These tests
 * cover the part that's easy to get silently wrong: every dismissal path
 * (Escape, the explicit dismiss button) has to route through a confirmation
 * step rather than closing straight away.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ShownOnceSecretModal } from './ShownOnceSecretModal';

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

function renderModal(onDismiss = vi.fn()) {
  render(
    <ShownOnceSecretModal
      open={true}
      title="Save your client secret"
      description="This is the only time it will be shown."
      secret="whsec_super_secret_value"
      onDismiss={onDismiss}
    />
  );
  return onDismiss;
}

describe('ShownOnceSecretModal', () => {
  it('renders the secret and a working copy button', async () => {
    renderModal();
    expect(screen.getByText('whsec_super_secret_value')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^copy$/i }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('whsec_super_secret_value');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /copied!/i })).toBeInTheDocument();
    });
  });

  it('does not call onDismiss when Escape is pressed — it asks for confirmation first', () => {
    const onDismiss = renderModal();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' });

    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId('shown-once-close-confirm')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go back/i })).toBeInTheDocument();
  });

  it('going back from the confirmation returns to the secret, still visible', () => {
    const onDismiss = renderModal();

    fireEvent.click(screen.getByRole('button', { name: /i've saved it/i }));
    expect(screen.getByTestId('shown-once-close-confirm')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /go back/i }));

    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByText('whsec_super_secret_value')).toBeInTheDocument();
  });

  it('only calls onDismiss after the close is explicitly confirmed', () => {
    const onDismiss = renderModal();

    fireEvent.click(screen.getByRole('button', { name: /i've saved it/i }));
    fireEvent.click(screen.getByRole('button', { name: /close anyway/i }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
