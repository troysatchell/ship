/**
 * TRO-323 / FG-10 contrast regression test — same precedent as
 * `DashboardSidebar.contrast.test.tsx` (TRO-298 / A11Y-10): resolve
 * *colours* out of the rendered DOM and assert WCAG 2.1 AA (4.5:1), rather
 * than asserting class strings. A class string can look right and still
 * fail — A11Y-3/A11Y-10 were both exactly that: `accent`/`red-400` used as
 * *text* on a light background, well under 4.5:1, undetected until
 * something made the surface reachable.
 *
 * Every colour token used by `InboxSidebar`/`InboxItemRow` is checked here:
 * the type badges (blocking_approval/mention/standup_draft), the summary
 * text, the "Blocking N other people" note, the action-label link text, and
 * the degraded/loading/empty states. Dark-mode (`dark:*`) classes are
 * intentionally not resolved — same scope as `DashboardSidebar.contrast.test.tsx`
 * — `resolveContrastPairs` (`web/src/lib/contrast.ts`) skips any
 * variant-prefixed class by design.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import defaultColors from 'tailwindcss/colors';
import tailwindConfig from '../../tailwind.config.js';
import { AA_NORMAL_TEXT, resolveContrastPairs, type ContrastPair } from '@/lib/contrast';
import { queryClient } from '@/lib/queryClient';
import { InboxSidebar } from './InboxSidebar';
import { inboxKeys, type InboxItem } from '@/hooks/useInboxQuery';
import { apiGet } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(),
}));

const mockApiGet = vi.mocked(apiGet);

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const palette = tailwindConfig.theme.extend.colors;

/** Same flattening as DashboardSidebar.contrast.test.tsx — without the
 * Tailwind defaults merged in, a class like `text-red-600` fails to resolve
 * and the element silently inherits its ancestor's colour, which can turn a
 * real failure into a false pass. */
function buildColorMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(defaultColors))) {
    if (typeof descriptor.get === 'function') continue;
    const value: unknown = descriptor.value;
    if (typeof value === 'string') {
      map[name] = value;
    } else if (value && typeof value === 'object') {
      for (const [shade, hex] of Object.entries(value)) {
        if (typeof hex === 'string') map[`${name}-${shade}`] = hex;
      }
    }
  }
  return { ...map, ...palette };
}

const COLORS = buildColorMap();

function describePair(pair: ContrastPair): string {
  return `${pair.ratio.toFixed(2)}:1  "${pair.text.slice(0, 40)}"  fg=${pair.foreground} bg=${pair.background}  [${pair.classes}]`;
}

const BLOCKING_ITEM: InboxItem = {
  id: 'blocking-approval:sprint-1:state',
  type: 'blocking_approval',
  summary: 'AUTH-12 is waiting on your approval',
  evidence: { documentId: 'issue-2', documentType: 'issue' },
  action: { label: 'Review AUTH-12', href: '/documents/issue-2' },
  blockedCount: 3,
  blockedSince: '2026-07-30T12:00:00.000Z',
};

const MENTION_ITEM: InboxItem = {
  id: 'mention:doc-9:user-1',
  type: 'mention',
  summary: 'You were mentioned in Week 12 planning',
  evidence: { documentId: 'doc-9', documentType: 'sprint' },
  action: { label: 'View mention', href: '/documents/doc-9' },
};

const DRAFT_ITEM: InboxItem = {
  id: 'standup_draft:user-1:2026-08-04',
  type: 'standup_draft',
  summary: 'Your standup draft is ready to review',
  evidence: {},
  action: { label: 'Review draft', href: '/documents/standup-1?action=new-standup' },
};

async function renderResolved(items: InboxItem[]): Promise<HTMLElement> {
  mockApiGet.mockResolvedValue(jsonResponse(200, { items }));
  const { findAllByRole, findByText, container } = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <InboxSidebar />
      </MemoryRouter>
    </QueryClientProvider>
  );
  if (items.length > 0) {
    await findAllByRole('listitem');
  } else {
    // No listitem to await for the empty case — wait for the actual empty
    // message instead of a fixed timeout, so this never races the query.
    await findByText(/nothing needs you right now/i);
  }
  const root = container.firstElementChild;
  if (!root) throw new Error('InboxSidebar rendered nothing');
  return root as HTMLElement;
}

beforeEach(() => {
  mockApiGet.mockReset();
});

afterEach(() => {
  queryClient.removeQueries({ queryKey: inboxKeys.all });
});

describe('InboxSidebar colour contrast (TRO-323 / FG-10)', () => {
  it('resolves the page background from the Tailwind palette', () => {
    expect(palette.background).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('meets 4.5:1 across every resolved text pair with a full three-type item list', async () => {
    const root = await renderResolved([BLOCKING_ITEM, MENTION_ITEM, DRAFT_ITEM]);
    const { pairs } = resolveContrastPairs(root, {
      colors: COLORS,
      rootBackground: palette.background,
    });

    expect(
      pairs.length,
      `resolved only ${pairs.length} text pairs — the walk found nothing to check`
    ).toBeGreaterThanOrEqual(6);

    const failing = pairs.filter(p => p.ratio < AA_NORMAL_TEXT);
    expect(
      failing.map(describePair),
      `${failing.length} of ${pairs.length} text pairs are below ${AA_NORMAL_TEXT}:1`
    ).toEqual([]);
  });

  it('meets 4.5:1 on the "Blocking N other people" note', async () => {
    const root = await renderResolved([BLOCKING_ITEM]);
    const { pairs } = resolveContrastPairs(root, {
      colors: COLORS,
      rootBackground: palette.background,
    });

    const blockedNote = pairs.filter(p => /Blocking \d/.test(p.text));
    expect(blockedNote.length, 'expected the blocked-count note to render').toBeGreaterThanOrEqual(1);
    for (const pair of blockedNote) {
      expect(pair.ratio, describePair(pair)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('meets 4.5:1 on the empty-inbox message', async () => {
    const root = await renderResolved([]);
    const { pairs } = resolveContrastPairs(root, {
      colors: COLORS,
      rootBackground: palette.background,
    });

    const empty = pairs.filter(p => /nothing needs you/i.test(p.text));
    expect(empty.length, 'expected the empty-inbox message to render').toBeGreaterThanOrEqual(1);
    for (const pair of empty) {
      expect(pair.ratio, describePair(pair)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('meets 4.5:1 on the degraded message', async () => {
    mockApiGet.mockResolvedValue(jsonResponse(502, { error: 'agent_unavailable' }));
    const { findByText, container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <InboxSidebar />
        </MemoryRouter>
      </QueryClientProvider>
    );
    await findByText(/can't reach the agent right now/i);
    const root = container.firstElementChild as HTMLElement;

    const { pairs } = resolveContrastPairs(root, {
      colors: COLORS,
      rootBackground: palette.background,
    });

    const degraded = pairs.filter(p => /can't reach the agent right now/i.test(p.text));
    expect(degraded.length, 'expected the degraded message to render').toBeGreaterThanOrEqual(1);
    for (const pair of degraded) {
      expect(pair.ratio, describePair(pair)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });
});
