/**
 * Regression tests for TRO-610.
 *
 * The action button was wired unconditionally to `onClick={onStayLoggedIn}`
 * regardless of `warningType`, even though the absolute-warning copy says
 * "This timeout cannot be extended." Clicking "I Understand" on an absolute
 * warning silently extended the session anyway — the exact opposite of what
 * the modal told the user. Fixed by routing the click through `warningType`:
 * `onStayLoggedIn` for inactivity, `onDismissAbsolute` for absolute.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionTimeoutModal } from './SessionTimeoutModal';

describe('SessionTimeoutModal', () => {
  it('absolute warning: clicking "I Understand" calls onDismissAbsolute, NOT onStayLoggedIn', () => {
    const onStayLoggedIn = vi.fn();
    const onDismissAbsolute = vi.fn();

    render(
      <SessionTimeoutModal
        open={true}
        timeRemaining={300}
        warningType="absolute"
        onStayLoggedIn={onStayLoggedIn}
        onDismissAbsolute={onDismissAbsolute}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /I Understand/i }));

    expect(onDismissAbsolute).toHaveBeenCalledTimes(1);
    // The one behavior this ticket exists to prevent: an absolute-timeout
    // acknowledgement must never extend the session.
    expect(onStayLoggedIn).not.toHaveBeenCalled();
  });

  it('inactivity warning: clicking "Stay Logged In" calls onStayLoggedIn, NOT onDismissAbsolute', () => {
    const onStayLoggedIn = vi.fn();
    const onDismissAbsolute = vi.fn();

    render(
      <SessionTimeoutModal
        open={true}
        timeRemaining={60}
        warningType="inactivity"
        onStayLoggedIn={onStayLoggedIn}
        onDismissAbsolute={onDismissAbsolute}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Stay Logged In/i }));

    expect(onStayLoggedIn).toHaveBeenCalledTimes(1);
    expect(onDismissAbsolute).not.toHaveBeenCalled();
  });
});
