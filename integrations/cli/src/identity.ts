/**
 * Renders `@ship/sdk`'s `Me` (the `GET /api/v1/me` shape) into the one line
 * `ship whoami`/`ship login` print for "who is this". `sdk/src/types.ts`'s
 * own header is explicit that `user`/`app` are NOT mutually exclusive —
 * three real shapes exist: a personal-token principal (`user` only), a
 * Client-Credentials principal (`app` only), and an `authorization_code`
 * OAuth principal (both). This CLI's own device-flow login always produces
 * the third shape (a device-flow token is always issued to a specific human
 * AND a specific registered app), but `ship whoami` reads whatever token
 * happens to be on disk — including one written by some other tool — so all
 * three shapes are handled here, not just the one this CLI itself produces.
 */
import type { Me } from '@ship/sdk';

export function formatIdentity(me: Me): string {
  const parts: string[] = [];
  if (me.user) parts.push(`${me.user.name} <${me.user.email}>`);
  if (me.app) parts.push(`app "${me.app.name}" (${me.app.client_id})`);
  const who = parts.length > 0 ? parts.join(' via ') : '(no user or app on this token)';
  const scopes = me.scopes.length > 0 ? me.scopes.slice().sort().join(', ') : '(none)';
  return `${who} — scopes: ${scopes}`;
}
