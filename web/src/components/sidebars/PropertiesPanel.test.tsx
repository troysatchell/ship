/**
 * Regression test for TRO-220 / audit finding A11Y-6.
 *
 * Same root cause as BacklinksPanel.test.tsx (this directory's sibling
 * finding): a document view's only page-level heading is the title `<h1>`
 * (Editor.tsx:888), and `WeeklyDocumentSidebar` — the properties-sidebar
 * chrome rendered for weekly_plan/weekly_retro documents — put its "Weekly
 * Plan"/"Weekly Retro" section header at `<h3>` with no intervening `<h2>`.
 * Same h1 -> h3 skip as the wiki path, just reached through a different
 * document type.
 *
 * `ContentHistoryPanel` is mocked out because it fetches its own data via
 * `useContentHistoryQuery`; this test is only about the heading level
 * `WeeklyDocumentSidebar` itself renders, not that panel's contents.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WeeklyDocumentSidebar } from './PropertiesPanel';

vi.mock('@/components/ContentHistoryPanel', () => ({
  ContentHistoryPanel: () => null,
}));

describe('WeeklyDocumentSidebar — heading level (A11Y-6 / TRO-220)', () => {
  it('renders the weekly-plan section header as h2, not h3', () => {
    render(
      <WeeklyDocumentSidebar
        document={{
          id: 'wp-1',
          title: 'Week 3 Plan',
          document_type: 'weekly_plan',
          properties: { week_number: 3 },
        }}
      />
    );

    expect(screen.getByRole('heading', { level: 2, name: /weekly plan/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
  });

  it('renders the weekly-retro section header as h2, not h3', () => {
    render(
      <WeeklyDocumentSidebar
        document={{
          id: 'wr-1',
          title: 'Week 3 Retro',
          document_type: 'weekly_retro',
          properties: { week_number: 3 },
        }}
      />
    );

    expect(screen.getByRole('heading', { level: 2, name: /weekly retro/i })).toBeInTheDocument();
  });
});
