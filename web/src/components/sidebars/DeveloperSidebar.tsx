import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/cn';

/**
 * PF-502 (TRO-436) — Contextual Sidebar content for the "Developer" mode.
 * Lives inside the existing Icon Rail + Contextual Sidebar, same convention
 * as InboxSidebar.tsx: no fifth panel.
 *
 * Deliberately minimal today (one entry: Apps). PF-503 (TRO-439, in
 * parallel) adds a Webhooks entry here — this list is the shared extension
 * point, kept to a plain array + map specifically so that addition is a
 * one-line diff rather than a structural change either side has to
 * coordinate around.
 */

interface DeveloperNavEntry {
  to: string;
  label: string;
}

const DEVELOPER_NAV: DeveloperNavEntry[] = [
  { to: '/developer/apps', label: 'Apps' },
];

export function DeveloperSidebar() {
  return (
    <nav aria-label="Developer" className="space-y-0.5 px-2">
      {DEVELOPER_NAV.map((entry) => (
        <NavLink
          key={entry.to}
          to={entry.to}
          className={({ isActive }) =>
            cn(
              'block rounded-md px-2 py-1.5 text-sm transition-colors',
              isActive
                ? 'bg-border/50 text-foreground'
                : 'text-muted hover:bg-border/30 hover:text-foreground'
            )
          }
        >
          {entry.label}
        </NavLink>
      ))}
    </nav>
  );
}
