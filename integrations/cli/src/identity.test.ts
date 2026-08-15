import { describe, expect, it } from 'vitest';
import type { Me } from '@ship/sdk';
import { formatIdentity } from './identity.js';

describe('formatIdentity', () => {
  it('renders a personal-token principal (user only)', () => {
    const me: Me = { user: { id: 'u1', email: 'a@example.com', name: 'Ada' }, app: null, scopes: ['documents:read'] };
    expect(formatIdentity(me)).toBe('Ada <a@example.com> — scopes: documents:read');
  });

  it('renders a Client-Credentials principal (app only)', () => {
    const me: Me = {
      user: null,
      app: { id: 'app1', client_id: 'ship_app_x', name: 'Zapier', is_first_party: false },
      scopes: [],
    };
    expect(formatIdentity(me)).toBe('app "Zapier" (ship_app_x) — scopes: (none)');
  });

  it('renders an authorization_code-grant principal (both user and app), scopes sorted', () => {
    const me: Me = {
      user: { id: 'u1', email: 'a@example.com', name: 'Ada' },
      app: { id: 'app1', client_id: 'ship_app_cli', name: 'Ship CLI', is_first_party: true },
      scopes: ['issues:read', 'documents:read'],
    };
    expect(formatIdentity(me)).toBe(
      'Ada <a@example.com> via app "Ship CLI" (ship_app_cli) — scopes: documents:read, issues:read'
    );
  });

  it('handles the degenerate case of neither user nor app (should not throw)', () => {
    const me: Me = { user: null, app: null, scopes: [] };
    expect(formatIdentity(me)).toBe('(no user or app on this token) — scopes: (none)');
  });
});
