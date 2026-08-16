import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/cn';

/**
 * PF-502 (TRO-436) — Contextual Sidebar content for the "Developer" mode.
 * Lives inside the existing Icon Rail + Contextual Sidebar, same convention
 * as InboxSidebar.tsx: no fifth panel.
 *
 * Started with one entry (Apps, PF-502/TRO-436). PF-503/TRO-439 added the
 * Webhooks entry below — this list is the shared extension point, kept to a
 * plain array + map specifically so that addition was a one-line diff
 * rather than a structural change either side had to coordinate around.
 */

interface DeveloperNavEntry {
  to: string;
  label: string;
}

const DEVELOPER_NAV: DeveloperNavEntry[] = [
  { to: '/developer/apps', label: 'Apps' },
  // PF-503 (TRO-439) — delivery log, DLQ, replay, subscription CRUD.
  { to: '/developer/webhooks', label: 'Webhooks' },
  // TRO-616 — public_api_audit, queryable per app via GET /api/v1/audit.
  { to: '/developer/audit', label: 'Audit' },
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
