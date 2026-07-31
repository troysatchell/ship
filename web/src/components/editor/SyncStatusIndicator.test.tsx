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

/**
 * TRO-190 / ERR-3 — a rejected or gone document write is a DIFFERENT failure
 * mode than the one ERR-1 fixed above: it happens on the title/property REST
 * PATCH path, which is entirely independent of the Yjs body-content socket
 * `isSynced` tracks. Before this fix the indicator had no input at all for
 * that path, so a socket that was fully synced (`isSynced: true`) still read
 * "Saved" while a rename/property write had been rejected.
 *
 * Observed in the audit's raw artifacts:
 *   - probe6-mixed.json (6.1/6.2): forced 429 then 500 on a rename; DB title
 *     unchanged both times, indicator still read "Saved".
 *   - probe7-retry-and-revocation.json (7a): 14 PATCH attempts, a transient
 *     "Failed to update document" toast fires, but "sync indicator says:
 *     Saved" throughout.
 *
 * These tests were confirmed red against the pre-fix `deriveSyncIndicator`
 * (which did not accept `hasFailedWrite` at all): with `isSynced: true` and
 * `hasFailedWrite: true`, the pre-fix component ignored the unknown prop and
 * rendered "Saved" - the exact ERR-3 lie - failing
 * `expect(text).not.toMatch(/\bSaved\b/)` with an actual value of "Saved".
 */
describe('SyncStatusIndicator (TRO-190 / ERR-3)', () => {
  function statusText(): string {
    return screen.getByTestId('sync-status').textContent ?? '';
  }

  it('does NOT claim "Saved" when a direct write failed, even with a fully synced socket', () => {
    // probe6.1/6.2: the collaboration socket can be perfectly synced while a
    // rename PATCH was rejected with 429/500 - these are independent paths.
    render(
      <SyncStatusIndicator
        syncStatus="synced"
        isSynced
        isInitialConnect={false}
        isBrowserOnline
        hasFailedWrite
      />
    );

    const text = statusText();
    expect(
      text,
      'a rejected title/property write must not be masked by an unrelated synced socket - the ERR-3 lie'
    ).not.toMatch(/\bSaved\b/);
    expect(text, 'the user must be told the write did not persist').toMatch(/not saved/i);
  });

  it('marks the failed-write state as an error, not a neutral state', () => {
    const { container } = render(
      <SyncStatusIndicator
        syncStatus="synced"
        isSynced
        isInitialConnect={false}
        isBrowserOnline
        hasFailedWrite
      />
    );

    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot?.className, 'a rejected write must not read as fine (green/blue)').not.toMatch(/bg-(green|blue)-/);
    expect(dot?.className).toMatch(/bg-red-/);
  });

  it('returns to "Saved" once hasFailedWrite clears and the socket is synced', () => {
    // A later write succeeding (e.g. after the 429 backoff window rolls over)
    // must un-stick the indicator - it is not a one-way, permanent trip.
    render(
      <SyncStatusIndicator
        syncStatus="synced"
        isSynced
        isInitialConnect={false}
        isBrowserOnline
        hasFailedWrite={false}
      />
    );

    expect(statusText()).toContain('Saved');
  });

  it('defaults to the ERR-1 behavior when hasFailedWrite is omitted', () => {
    // Backward compatibility: every other caller of this component does not
    // know about the write-status path yet and must be unaffected.
    render(
      <SyncStatusIndicator syncStatus="synced" isSynced isInitialConnect={false} isBrowserOnline />
    );

    expect(statusText()).toContain('Saved');
  });
});

/**
 * TRO-194 / ERR-7 - the indicator had no in-flight state at all: probe5
 * (`audit/error-handling/raw/probe5-slow-network.json`) typed for 6s under
 * Fast 3G and the indicator held on "Saved" the entire time - "false (false
 * = no in-flight/unsaved feedback at all)". A synced-but-idle document and a
 * synced-document-mid-keystroke were indistinguishable to the user.
 *
 * These tests were confirmed red against the pre-fix `deriveSyncIndicator`
 * (which did not accept `isSaving` at all): with `isSynced: true` and
 * `isSaving: true`, the pre-fix component ignored the unknown prop and
 * rendered "Saved" - failing `expect(text).not.toMatch(/\bSaved\b/)` with an
 * actual value of "Saved".
 */
describe('SyncStatusIndicator (TRO-194 / ERR-7 — in-flight saving state)', () => {
  function statusText(): string {
    return screen.getByTestId('sync-status').textContent ?? '';
  }

  it('shows a distinct "Saving" state while a synced socket has an unflushed local edit', () => {
    render(
      <SyncStatusIndicator
        syncStatus="synced"
        isSynced
        isInitialConnect={false}
        isBrowserOnline
        isSaving
      />
    );

    const text = statusText();
    expect(text, 'a save in flight must not still read as the settled "Saved" state').not.toMatch(
      /\bSaved\b/
    );
    expect(text).toMatch(/saving/i);
  });

  it('is distinct from the error ("Not saved") state', () => {
    render(
      <SyncStatusIndicator
        syncStatus="synced"
        isSynced
        isInitialConnect={false}
        isBrowserOnline
        isSaving
      />
    );

    expect(statusText(), '"Saving" must not be confused with the failure state').not.toMatch(
      /not saved/i
    );
  });

  it('marks the saving state as pending (in-progress), not ok or error', () => {
    const { container } = render(
      <SyncStatusIndicator
        syncStatus="synced"
        isSynced
        isInitialConnect={false}
        isBrowserOnline
        isSaving
      />
    );

    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot?.className, 'in-flight must not read as fully settled (green)').not.toMatch(
      /bg-green-/
    );
    expect(dot?.className, 'in-flight is not a failure (red)').not.toMatch(/bg-red-/);
    expect(dot?.className).toMatch(/bg-yellow-/);
  });

  it('returns to "Saved" once the local edit has flushed (isSaving clears)', () => {
    const { rerender } = render(
      <SyncStatusIndicator
        syncStatus="synced"
        isSynced
        isInitialConnect={false}
        isBrowserOnline
        isSaving
      />
    );
    expect(statusText()).toMatch(/saving/i);

    rerender(
      <SyncStatusIndicator
        syncStatus="synced"
        isSynced
        isInitialConnect={false}
        isBrowserOnline
        isSaving={false}
      />
    );
    expect(statusText()).toContain('Saved');
  });

  it('never claims "Saving" over a connection that is not actually synced', () => {
    // isSaving reflects an unflushed local edit, not "the user is typing" in
    // isolation - if the socket itself has no completed sync, the existing
    // ERR-1 "Not saved" truth must still win.
    render(
      <SyncStatusIndicator
        syncStatus="cached"
        isSynced={false}
        isInitialConnect={false}
        isBrowserOnline
        isSaving
      />
    );

    const text = statusText();
    expect(text).not.toMatch(/saving/i);
    expect(text).toMatch(/not saved/i);
  });

  it('lets a failed direct write override an in-flight body save', () => {
    render(
      <SyncStatusIndicator
        syncStatus="synced"
        isSynced
        isInitialConnect={false}
        isBrowserOnline
        isSaving
        hasFailedWrite
      />
    );

    const text = statusText();
    expect(text).not.toMatch(/saving/i);
    expect(text).toMatch(/not saved/i);
  });

  it('defaults to the pre-ERR-7 behavior when isSaving is omitted', () => {
    render(
      <SyncStatusIndicator syncStatus="synced" isSynced isInitialConnect={false} isBrowserOnline />
    );

    expect(statusText()).toContain('Saved');
  });
});
