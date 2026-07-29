import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SyncStatusIndicator } from './SyncStatusIndicator';

/**
 * TRO-188 / ERR-1 — the editor's sync indicator reported "Saved"/"Cached" while
 * the collaboration socket had never completed its initial Yjs sync, so edits
 * that were never persisted looked persisted and were lost on reload.
 *
 * Observed in the audit's own artifacts (audit/error-handling/raw/):
 *   - probe2d-ws-unavailable.json — three `WebSocket status: connected` events
 *     and ZERO `WebSocket sync` events; the indicator read "Saved" for 60s while
 *     `inDb=false`, and the document's final content was "".
 *   - probe2-ws-drop.json — indicator read "Cached" throughout while `inDb=false`.
 *   - probe2e — even in the case that DID recover, the indicator read "Cached"
 *     while `in DB = false`.
 *
 * The rule these tests pin down: the indicator may only claim the document is
 * saved when the collaboration socket has an actually-completed sync handshake.
 */
describe('SyncStatusIndicator (TRO-188 / ERR-1)', () => {
  function statusText(): string {
    return screen.getByTestId('sync-status').textContent ?? '';
  }

  it('reports "Saved" only when the collaboration socket has completed a sync', () => {
    render(
      <SyncStatusIndicator
        syncStatus="synced"
        isSynced
        isInitialConnect={false}
        isBrowserOnline
      />
    );

    expect(statusText()).toContain('Saved');
  });

  it('does NOT claim "Saved" when the socket is connected but has never synced', () => {
    // probe2d: WebSocket status "connected", sync event never fired, nothing in
    // the database. This is the state that read "Saved" and lost the document.
    render(
      <SyncStatusIndicator
        syncStatus="synced"
        isSynced={false}
        isInitialConnect={false}
        isBrowserOnline
      />
    );

    const text = statusText();
    expect(
      text,
      'a connected-but-never-synced socket must not be reported as "Saved" — that is the ERR-1 data-loss lie'
    ).not.toMatch(/\bSaved\b/);
    expect(text, 'the user must be told their changes are not saved').toMatch(/not saved/i);
  });

  it('does NOT claim "Cached" when the socket has never synced', () => {
    // probe2-ws-drop / probe2e: indicator read "Cached" while inDb=false.
    // "Cached" reassures; the content is local-only and unsaved.
    render(
      <SyncStatusIndicator
        syncStatus="cached"
        isSynced={false}
        isInitialConnect={false}
        isBrowserOnline
      />
    );

    const text = statusText();
    expect(text, '"Cached" reads as safe; unsynced content is not').not.toMatch(/\bCached\b/);
    expect(text).toMatch(/not saved/i);
  });

  it('marks the unsynced state as an error, not a neutral state', () => {
    const { container } = render(
      <SyncStatusIndicator
        syncStatus="synced"
        isSynced={false}
        isInitialConnect={false}
        isBrowserOnline
      />
    );

    // The dot is the at-a-glance signal. Blue/green read as "fine".
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot?.className, 'unsynced must not be painted green or blue').not.toMatch(/bg-(green|blue)-/);
    expect(dot?.className).toMatch(/bg-red-/);
  });

  it('explains the consequence, not just the state', () => {
    render(
      <SyncStatusIndicator
        syncStatus="synced"
        isSynced={false}
        isInitialConnect={false}
        isBrowserOnline
      />
    );

    const region = screen.getByTestId('sync-status');
    expect(
      region.getAttribute('title'),
      'the indicator must say what happens to the work, not just that sync failed'
    ).toMatch(/lost|not saved/i);
  });

  it('shows a neutral "Connecting" state during the first connection attempt', () => {
    render(
      <SyncStatusIndicator
        syncStatus="connecting"
        isSynced={false}
        isInitialConnect
        isBrowserOnline
      />
    );

    const text = statusText();
    expect(text).toMatch(/connecting/i);
    expect(text).not.toMatch(/\bSaved\b/);
  });

  it('reports offline without claiming the work is saved', () => {
    render(
      <SyncStatusIndicator
        syncStatus="synced"
        isSynced
        isInitialConnect={false}
        isBrowserOnline={false}
      />
    );

    const text = statusText();
    expect(text).toMatch(/offline/i);
    expect(text, 'browser offline means nothing is reaching the server').not.toMatch(/\bSaved\b/);
  });

  it('stops reporting "Saved" the moment an established sync is lost', () => {
    // A socket that synced, then dropped. y-websocket emits sync(false) here.
    // Before this fix the indicator fell back to "Cached" and kept looking safe.
    render(
      <SyncStatusIndicator
        syncStatus="cached"
        isSynced={false}
        isInitialConnect={false}
        isBrowserOnline
      />
    );

    expect(statusText()).not.toMatch(/\bSaved\b/);
    expect(statusText()).toMatch(/not saved/i);
  });

  it('keeps the status region announceable to assistive tech', () => {
    render(
      <SyncStatusIndicator
        syncStatus="synced"
        isSynced={false}
        isInitialConnect={false}
        isBrowserOnline
      />
    );

    const region = screen.getByTestId('sync-status');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
  });
});
